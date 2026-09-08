import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { aggregate, dayKeyOf, monthKeyOf, scanUsage, weekKeyOf } from "./usage-log.js";

/**
 * DeepSeek 账户余额查询（host 半）。
 *
 * 用**函数形式**的插件（`inject` + `apply`），不是 `Service` 子类：本插件不向任何
 * 人提供能力，浏览器半是 fetch 一条 HTTP 路由拿数据的。`Service` 会往 cordis 的
 * 全局服务表里塞一个名字，而 `ctx.provide` 撞名是**直接抛异常**的
 * （cordis `service "x" has been registered at <...>`）—— 那等于在 boot 阶段
 * 杀掉内核、桌面端黑屏。和 loader 的 `duplicate loader entry id` 是同一类事故，
 * 只是命名空间不同。不需要的名字就不要占。
 */

/** 路由前缀。同理由：webServer 的 `register` 对重复 (kind, path) 也是直接抛。
 * 上游随时可能加 `/api/balance` 这种通用路径，所有桌面端插件统一挤在
 * `/api/dsdesktop/` 下面，把撞车面收敛成一个我们自己说了算的命名空间。 */
const ROUTE = "/api/dsdesktop/balance";
/**
 * 单价路由：优先返回自动同步来的 DeepSeek 官方价，同步失败时回退本地配置。
 * 单独开一条路由，跟真查余额（会打一次真实 DeepSeek API）分开。浏览器半每条
 * 历史回合都要算一次花费（读单价），全部挤到 `/api/dsdesktop/balance` 上会让
 * 翻一次旧会话打出去一整串真实 DeepSeek 请求，这正是 `originAllowed` 那条注释
 * 想防的放大效应。
 */
const PRICING_ROUTE = "/api/dsdesktop/balance/pricing";
/**
 * 用量与花费统计路由：直接从 dsh 的会话事件日志汇总，见 `usage-log.js` 开头
 * 那段说明。浏览器半不再自己记账，只负责把这条路由返回的数字摊到界面上。
 */
const USAGE_ROUTE = "/api/dsdesktop/balance/usage";
/**
 * 「重置」写下的清零下限。统计既然是每次从日志重算的，清零就不能靠删账本——
 * 删了下次照样算回来。改成记一个时间下限：汇总时早于它的记录一律跳过。
 * 下限按周期各记一份，并带上当时的周期键，跨天/跨周/跨月自动失效。
 */
const RESET_ROUTE = "/api/dsdesktop/balance/reset";

// 官方定价页与同步缓存。价格页是 Docusaurus 静态 HTML，解析规则见
// `parseOfficialPricing`；缓存落在 dsh home 的 plugins 目录，TTL 半天，
// 超过 7 天才彻底放弃旧缓存。启动时后台抓一次，之后请求触发 + TTL 刷新。
const PRICING_PAGE_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/";
const PRICING_CACHE_FILE = "dsh-ui-balance-pricing-cache.json";
const PRICING_TTL_MS = 12 * 60 * 60 * 1000;
const PRICING_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const PRICING_FETCH_TIMEOUT_MS = 10 * 1000;

export const name = "dsh-ui-balance";

export const inject = ["webServer"];

/**
 * `baseURL` 必须可配：dsh 自己的 DeepSeek provider 就把它放在 Config 里
 * （`dsh-llm-deepseek` 的 `baseURL: z.string()`），设置页有对应输入框。写死
 * 意味着用户把 dsh 指向兼容代理之后，余额面板不但查错了 host，还会把他填在
 * `DEEPSEEK_API_KEY` 里的**别家 key** 发到 api.deepseek.com 去。
 */
const ModelPrice = z.object({
  cacheHitPerMillion: z.number(),
  cacheMissPerMillion: z.number(),
  outputPerMillion: z.number()
});

/**
 * 花费预估用的单价表，键是 `${provider}:${model}`——浏览器半按会话当前选中
 * 的模型（`ctx.modelDirectories`，见 client.js 的注释）去查这张表，不是按
 * 每条历史消息精确归因（provenance 字段目前不可用，同一条理由）。
 *
 * 官方价通过 `getEffectivePricing` 自动同步：优先用从官方定价页解析出来的
 * 空闲时段基准价（DeepSeek 官方 provider），同步失败/校验不过时回退到下面这
 * 份默认值；非 DeepSeek 官方的第三方模型仍以本地配置为准。高峰时段的倍率
 * 也由解析结果统一给出（当前官方是 2 倍）；高峰时段判定在 client.js，纯本地
 * 时间计算，不查网。
 */
export const Config = z.object({
  baseURL: z.string().default("https://api.deepseek.com"),
  currency: z.string().default("CNY"),
  peakMultiplier: z.number().default(2),
  modelPricing: z.dict(ModelPrice).default({
    "deepseek-official:deepseek-v4-flash": { cacheHitPerMillion: 0.05, cacheMissPerMillion: 1.5, outputPerMillion: 4.5 },
    "deepseek-official:deepseek-v4-pro": { cacheHitPerMillion: 0.15, cacheMissPerMillion: 4.5, outputPerMillion: 13.5 },
    "deepseek-official:deepseek-v4-flash-vision-exp": { cacheHitPerMillion: 0.05, cacheMissPerMillion: 1.5, outputPerMillion: 4.5 }
  })
});

/**
 * Origin 校验：存在且不等于本服务自身 origin（同端口的 http://127.0.0.1 /
 * http://localhost）就拒绝。
 *
 * 本插件只有 GET，跨源页面既拿不到响应体（我们从不发 CORS 头）也改不了状态，
 * 所以这条不是在防数据泄漏 —— 防的是**放大**：每次 GET 都会真打一次 DeepSeek
 * API，跨源页面可以拿它反复刷用户的上游调用。四个插件用同一份防线也让「有没有
 * 漏掉一个」变成一眼能看出来的事。
 */
function originAllowed(req, port) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  return url.host === `127.0.0.1:${port}` || url.host === `localhost:${port}`;
}

/**
 * 主流厂商余额接口适配表。
 *
 * 目前只有 DeepSeek 和 Moonshot/Kimi 有公开的账户余额端点；其他厂商（OpenAI、
 * Anthropic、xAI、Google 等）要么没有公开余额接口，要么只提供用量/账单接口，
 * 没有统一的“余额”概念，所以直接返回 unsupported-balance，由前端显示
 * “无法查询余额”。
 */
function balanceAdapterFor(baseURL) {
  let host;
  try {
    host = new URL(baseURL).hostname;
  } catch {
    return null;
  }
  if (host === "api.deepseek.com" || host === "api.deepseek.cn") {
    return {
      kind: "deepseek",
      endpoint: "/user/balance",
      parse: (json) => ({ balance_infos: json.balance_infos ?? [] })
    };
  }
  if (host === "api.moonshot.cn" || host === "api.moonshot.com") {
    return {
      kind: "moonshot",
      endpoint: "/v1/users/me/balance",
      parse: (json) => ({
        balance_infos: [{
          currency: "CNY",
          total_balance: String(json?.data?.available_balance ?? "0")
        }]
      })
    };
  }
  return null;
}

async function query(ctx, baseURL) {
  const adapter = balanceAdapterFor(baseURL);
  if (adapter === null) {
    return { ok: false, error: { code: "unsupported-balance", message: "无法查询余额" } };
  }
  const credentials = ctx.get("credentials");
  if (credentials === void 0) {
    return { ok: false, error: { code: "no-credentials", message: "credentials 服务不可用" } };
  }
  const hit = await credentials.resolve(credentialRef("DEEPSEEK_API_KEY"));
  const apiKey = hit?.value;
  if (apiKey === void 0 || apiKey.length === 0) {
    return { ok: false, error: { code: "no-api-key", message: "未配置 DEEPSEEK_API_KEY" } };
  }

  let res;
  try {
    res = await fetch(`${baseURL.replace(/\/+$/u, "")}${adapter.endpoint}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json"
      }
    });
  } catch (error) {
    return { ok: false, error: { code: "network", message: error?.message ?? "余额请求失败" } };
  }
  if (!res.ok) {
    return { ok: false, error: { code: `http-${res.status}`, message: `余额接口返回 ${res.status}` } };
  }
  const json = await res.json();
  return { ok: true, value: adapter.parse(json) };
}

function pricingOf(config) {
  return { currency: config.currency, peakMultiplier: config.peakMultiplier, modelPricing: config.modelPricing };
}

/** 自动同步来的官方价优先；本地配置里多出来的（第三方/自定义）条目继续保留。 */
function mergeModelPricing(synced, config) {
  const modelPricing = { ...synced.modelPricing };
  for (const [key, value] of Object.entries(config.modelPricing ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(modelPricing, key)) modelPricing[key] = value;
  }
  return { ...synced, modelPricing };
}

function pricingCacheFilePath() {
  return join(resolveDshHome(), "plugins", PRICING_CACHE_FILE);
}

async function readPricingCache() {
  try {
    return JSON.parse(await readFile(pricingCacheFilePath(), "utf8"));
  } catch {
    return null;
  }
}

async function writePricingCache(data) {
  try {
    const file = pricingCacheFilePath();
    await mkdir(join(resolveDshHome(), "plugins"), { recursive: true });
    await writeFile(file, JSON.stringify(data), "utf8");
    return true;
  } catch {
    return false;
  }
}

function stripCell(cell) {
  return cell
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePriceCell(cell) {
  const match = cell.match(/(\d+(?:\.\d+)?)\s*元/);
  return match ? Number(match[1]) : null;
}

/**
 * 从官方定价页 HTML 里解析模型单价。
 * 页面结构：一个 `<table>`，模型行之后有「百万tokens输入（缓存命中/未命中）」
 * 和「百万tokens输出」三组行，每组含空闲/高峰两行。
 * 解析成功会同时校验高峰/空闲倍率是否统一；不统一就放弃自动同步，回退配置。
 */
function parseOfficialPricing(html) {
  const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => m[0]);
  const table = tables.find((t) => t.includes("百万tokens输入"));
  if (!table) return null;

  const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((m) => [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => stripCell(c[1])))
    .filter((cells) => cells.length > 0);

  const modelRow = rows.find((cells) => cells[0] === "模型");
  const models = modelRow
    ? modelRow.slice(1).filter((cell) => /^deepseek-[A-Za-z0-9._-]+$/.test(cell))
    : [];
  if (models.length === 0) return null;

  const idle = {};
  const peak = {};
  let currentKind = null;
  for (const cells of rows) {
    const labelIndex = cells.findIndex((cell) => cell.includes("百万tokens输入") || cell.includes("百万tokens输出"));
    if (labelIndex !== -1) {
      const label = cells[labelIndex];
      if (label.includes("百万tokens输入") && label.includes("缓存命中")) currentKind = "cacheHit";
      else if (label.includes("百万tokens输入") && label.includes("缓存未命中")) currentKind = "cacheMiss";
      else if (label.includes("百万tokens输出")) currentKind = "output";
      const periodIndex = labelIndex + 1;
      if (cells[periodIndex] !== "空闲时段" && cells[periodIndex] !== "高峰时段") continue;
      const values = cells.slice(periodIndex + 1, periodIndex + 1 + models.length).map(parsePriceCell);
      if (currentKind && values.every((v) => v !== null && Number.isFinite(v) && v > 0)) {
        (cells[periodIndex] === "空闲时段" ? idle : peak)[currentKind] = values;
      }
    } else if (cells[0] === "空闲时段" || cells[0] === "高峰时段") {
      const period = cells[0] === "空闲时段" ? "idle" : "peak";
      const values = cells.slice(1, 1 + models.length).map(parsePriceCell);
      if (currentKind && values.every((v) => v !== null && Number.isFinite(v) && v > 0)) {
        (period === "idle" ? idle : peak)[currentKind] = values;
      }
    }
  }

  const modelPricing = {};
  const ratios = [];
  for (let i = 0; i < models.length; i += 1) {
    const cacheHit = idle.cacheHit?.[i];
    const cacheMiss = idle.cacheMiss?.[i];
    const output = idle.output?.[i];
    const peakHit = peak.cacheHit?.[i];
    const peakMiss = peak.cacheMiss?.[i];
    const peakOutput = peak.output?.[i];
    if ([cacheHit, cacheMiss, output, peakHit, peakMiss, peakOutput].some((v) => v === void 0 || v === null || !Number.isFinite(v) || v <= 0)) {
      return null;
    }
    modelPricing[`deepseek-official:${models[i]}`] = {
      cacheHitPerMillion: cacheHit,
      cacheMissPerMillion: cacheMiss,
      outputPerMillion: output
    };
    ratios.push(peakHit / cacheHit, peakMiss / cacheMiss, peakOutput / output);
  }
  if (ratios.length === 0) return null;
  const minRatio = Math.min(...ratios);
  const maxRatio = Math.max(...ratios);
  if (maxRatio - minRatio > 0.01) return null;

  return {
    currency: "CNY",
    peakMultiplier: Number((ratios.reduce((a, b) => a + b, 0) / ratios.length).toFixed(4)),
    modelPricing
  };
}

async function fetchOfficialPricing() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PRICING_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(PRICING_PAGE_URL, {
      signal: controller.signal,
      headers: { accept: "text/html" }
    });
    if (!res.ok) return null;
    return parseOfficialPricing(await res.text());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let pricingRefreshPromise = null;
function refreshOfficialPricing() {
  if (pricingRefreshPromise === null) {
    pricingRefreshPromise = fetchOfficialPricing()
      .then(async (pricing) => {
        if (pricing) await writePricingCache({ fetchedAt: Date.now(), pricing });
        return pricing;
      })
      .catch(() => null)
      .finally(() => {
        pricingRefreshPromise = null;
      });
  }
  return pricingRefreshPromise;
}

async function getEffectivePricing(config) {
  const cached = await readPricingCache();
  const now = Date.now();
  if (cached?.pricing?.modelPricing && cached?.fetchedAt) {
    const age = now - Number(cached.fetchedAt);
    if (age < PRICING_TTL_MS) return mergeModelPricing(cached.pricing, config);
    if (age < PRICING_STALE_MS) {
      // 旧缓存先顶上，同时后台刷新；下次请求就是新价。
      refreshOfficialPricing();
      return mergeModelPricing(cached.pricing, config);
    }
  }
  const synced = await refreshOfficialPricing();
  if (synced) return mergeModelPricing(synced, config);
  return pricingOf(config);
}

function checkRequest(ctx, req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: { code: "method-not-allowed", message: "GET only" } }));
    return false;
  }
  // port 在请求时动态取：webServer 是 [Service.init] 时才绑定端口，
  // apply 执行时读到的还是 null。
  const port = ctx.webServer.port;
  if (port != null && !originAllowed(req, port)) {
    res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: { code: "forbidden-origin", message: "跨源请求被拒绝" } }));
    return false;
  }
  return true;
}

/**
 * POST 必须是 `application/json`。
 *
 * 这条和 originAllowed 是**配套**的，只有一条等于没有：Origin 头在「无 preflight
 * 的简单请求」里可以缺席，而 `text/plain` 发出来的跨源 POST 正是简单请求——恶意
 * 页面拿不到响应体（本服务从不发 CORS 头），但请求照样打进来了，而这个路由会写盘
 * （花费账本）。要求 application/json 就把请求推进「非简单请求」，必须先过
 * preflight，跨源页面到不了这一步。
 *
 * 实现与本作者另外三个插件逐字一致：同一个威胁必须同一种处理，一个插件把判定写松
 * 一点，排查起来比没有防线更费劲。
 */
function requireJson(req) {
  const ct = String(req.headers["content-type"] ?? "").toLowerCase();
  return ct.startsWith("application/json");
}

function pluginFilePath(name) {
  return join(resolveDshHome(), "plugins", name);
}

async function readJsonFile(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function writeJsonFile(file, data) {
  try {
    await mkdir(join(resolveDshHome(), "plugins"), { recursive: true });
    await writeFile(file, JSON.stringify(data), "utf8");
    return true;
  } catch {
    return false;
  }
}

/** 增量扫描的缓存：每个日志文件记「尺寸 / 已读到哪个字节 / 已抽出的记录」。 */
const USAGE_CACHE_FILE = "dsh-ui-balance-usage-cache.json";
/** 「重置」写下的清零下限，按 day/week/month 各一份。 */
const RESET_FILE = "dsh-ui-balance-reset.json";

function sessionsRoot() {
  return join(resolveDshHome(), "sessions");
}

/**
 * 扫描结果的进程内缓存。
 *
 * 扫描是 IO 密集的（首次全量要把每个会话日志的 zstd 帧全解一遍），但增量之后
 * 只剩 readdir + stat。仍然加一层内存缓存 + 单飞（single-flight）：侧边栏和
 * 详情面板会同时要数据，两个请求撞在一起不该扫两遍。
 */
let usageCache = null;
let usageRecords = null;
let usageScanAt = 0;
let usageScanPromise = null;
const USAGE_SCAN_TTL_MS = 5 * 1000;

async function refreshUsage(force) {
  if (usageScanPromise !== null) return usageScanPromise;
  if (!force && usageRecords !== null && Date.now() - usageScanAt < USAGE_SCAN_TTL_MS) return usageRecords;
  usageScanPromise = (async () => {
    if (usageCache === null) usageCache = await readJsonFile(pluginFilePath(USAGE_CACHE_FILE));
    const { records, cache, changed } = await scanUsage(sessionsRoot(), usageCache, Date.now());
    usageCache = cache;
    usageRecords = records;
    usageScanAt = Date.now();
    if (changed) await writeJsonFile(pluginFilePath(USAGE_CACHE_FILE), cache);
    return records;
  })()
    .catch(() => usageRecords ?? [])
    .finally(() => {
      usageScanPromise = null;
    });
  return usageScanPromise;
}

/** 读清零下限；周期键对不上（跨天/跨周/跨月）的那条自动作废。 */
async function readResetFloors(now) {
  const stored = await readJsonFile(pluginFilePath(RESET_FILE));
  const current = { day: dayKeyOf(now), week: weekKeyOf(now), month: monthKeyOf(now) };
  const floors = {};
  for (const period of ["day", "week", "month"]) {
    const entry = stored?.[period];
    if (entry && entry.key === current[period] && Number.isFinite(Number(entry.at))) floors[period] = Number(entry.at);
  }
  return { floors, current };
}

function checkUsageRequest(ctx, req, res, allowPost) {
  const methods = allowPost ? ["GET", "HEAD", "POST"] : ["GET", "HEAD"];
  if (!methods.includes(req.method)) {
    res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: { code: "method-not-allowed", message: methods.join("/") + " only" } }));
    return false;
  }
  const port = ctx.webServer.port;
  if (port != null && !originAllowed(req, port)) {
    res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: { code: "forbidden-origin", message: "跨源请求被拒绝" } }));
    return false;
  }
  if (req.method === "POST" && !requireJson(req)) {
    res.writeHead(415, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: { code: "unsupported-media-type", message: "Content-Type 必须是 application/json" } }));
    return false;
  }
  return true;
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** 一个周期的统计窗口下界：周期自然起点与清零下限里靠后的那个。 */
function periodStart(now, period) {
  const d = new Date(now);
  if (period === "month") return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  if (period === "week") return new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

async function handleUsage(ctx, config, req, res) {
  if (!checkUsageRequest(ctx, req, res, false)) return;
  const url = new URL(req.url, "http://127.0.0.1");
  const sinceParam = Number(url.searchParams.get("since"));
  const now = Date.now();
  const [records, pricing, reset] = await Promise.all([
    refreshUsage(url.searchParams.get("force") === "1"),
    getEffectivePricing(config),
    readResetFloors(now)
  ]);
  const window = (period) => Math.max(periodStart(now, period), reset.floors[period] ?? 0);
  // 「本次打开」也走同一条路：下界是应用打开的时刻（浏览器半传上来的），
  // 上界没有。它和日/周/月唯一的区别就是这个下界，不再是另一套累加逻辑。
  const since = Number.isFinite(sinceParam) && sinceParam > 0 ? sinceParam : now;
  const payload = {
    ok: true,
    scannedAt: usageScanAt,
    pricing,
    session: aggregate(records, pricing, { from: since }),
    daily: { key: reset.current.day, ...aggregate(records, pricing, { from: window("day") }) },
    weekly: { key: reset.current.week, ...aggregate(records, pricing, { from: window("week") }) },
    monthly: { key: reset.current.month, ...aggregate(records, pricing, { from: window("month") }) }
  };
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function handleReset(ctx, req, res) {
  if (!checkUsageRequest(ctx, req, res, true)) return;
  const now = Date.now();
  const file = pluginFilePath(RESET_FILE);
  if (req.method === "POST") {
    const data = await readJsonBody(req).catch(() => null);
    const period = data?.period;
    if (period !== "day" && period !== "week" && period !== "month") {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: { code: "bad-period", message: "period 必须是 day/week/month" } }));
      return;
    }
    const stored = (await readJsonFile(file)) ?? {};
    const key = period === "month" ? monthKeyOf(now) : period === "week" ? weekKeyOf(now) : dayKeyOf(now);
    stored[period] = { key, at: now };
    await writeJsonFile(file, stored);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, period, at: now }));
    return;
  }
  const { floors } = await readResetFloors(now);
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: true, floors }));
}

async function handleBalance(ctx, config, req, res) {
  if (!checkRequest(ctx, req, res)) return;
  const [result, pricing] = await Promise.all([
    query(ctx, config.baseURL),
    getEffectivePricing(config)
  ]);
  // 余额查询失败（比如没配 key）也不该连带把花费预估一起挡掉，两者算的是
  // 完全不同的事，所以 pricing 始终随响应带回。
  const payload = { ...result, pricing };
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function handlePricing(ctx, config, req, res) {
  if (!checkRequest(ctx, req, res)) return;
  const pricing = await getEffectivePricing(config);
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: true, pricing }));
}

export function apply(ctx, config) {
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: ROUTE,
    handler: (req, res) => handleBalance(ctx, config, req, res)
  }), `balance: ${ROUTE}`);
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: PRICING_ROUTE,
    handler: (req, res) => handlePricing(ctx, config, req, res)
  }), `balance: ${PRICING_ROUTE}`);
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: USAGE_ROUTE,
    handler: (req, res) => handleUsage(ctx, config, req, res)
  }), `balance: ${USAGE_ROUTE}`);
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: RESET_ROUTE,
    handler: (req, res) => handleReset(ctx, req, res)
  }), `balance: ${RESET_ROUTE}`);

  // 启动即后台抓一次官方价，不阻塞 boot。它和后续请求触发的刷新共用同一个
  // pricingRefreshPromise，所以不会和首个 pricing 请求撞出并发抓取。
  refreshOfficialPricing();
  // 同理先把会话日志扫一遍。第一次没有缓存时要把所有会话的 zstd 帧解一遍，
  // 在一台攒了两百个会话的机器上要十几秒；放在 boot 后台跑，等用户点开面板
  // 时通常已经就绪，之后靠文件尺寸做增量，正常一次扫描只有 readdir + stat。
  refreshUsage(true);
}
