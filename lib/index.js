import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";

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
 * 单价是纯本地配置，不用查 DeepSeek——单独开一条路由，跟真查余额（会打一次
 * 真实 DeepSeek API）分开。浏览器半每条历史回合都要算一次花费（读单价），
 * 全部挤到 `/api/dsdesktop/balance` 上会让翻一次旧会话打出去一整串真实
 * DeepSeek 请求，这正是 `originAllowed` 那条注释想防的放大效应。
 */
const PRICING_ROUTE = "/api/dsdesktop/balance/pricing";
/**
 * 本日/月度费用跨启动持久化路由。localStorage 按 origin（含端口）隔离，
 * 桌面端每次启动端口可能不同，必须落到文件里才能跨 origin 保持。
 */
const COST_STORE_ROUTE = "/api/dsdesktop/balance/cost-store";

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
 * 没有一个 provider 会把「当前定价」做成 API 让人查——DeepSeek 也没有，只有
 * 一个人读的静态定价页，数据不会自动跟着官方变，需要人工核对更新：
 * https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 * （下面默认值查询于 2026-09-01，页面是纯 HTML 表格、没有结构化数据源，做
 * 不了可靠的自动抓取——抓错了不报错，会把错误单价当成"官方最新价"用，比
 * 一份标了查询日期的静态值更危险，所以没做成自动同步。）
 *
 * 单价是**空闲时段**基准价；`peakMultiplier` 是高峰时段相对空闲的倍数——
 * 官方页面上三个模型、三种 token 类型全部统一是 2 倍，所以只留一个全局倍数，
 * 不用给每个 model 都重复填一遍。高峰时段（北京时间周一至周五 9-12、14-18）
 * 的判定在 client.js 里，纯本地时间计算，不查网。
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

function costStoreFilePath() {
  return join(resolveDshHome(), "plugins", "dsh-ui-balance-cost-store.json");
}

async function readCostStoreFile() {
  try {
    return JSON.parse(await readFile(costStoreFilePath(), "utf8"));
  } catch {
    return null;
  }
}

async function writeCostStoreFile(data) {
  try {
    const file = costStoreFilePath();
    await mkdir(join(resolveDshHome(), "plugins"), { recursive: true });
    await writeFile(file, JSON.stringify(data), "utf8");
    return true;
  } catch {
    return false;
  }
}

function checkCostStoreRequest(ctx, req, res) {
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: { code: "method-not-allowed", message: "GET/POST only" } }));
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

async function handleCostStore(ctx, req, res) {
  if (!checkCostStoreRequest(ctx, req, res)) return;
  if (req.method === "POST") {
    const data = await readJsonBody(req).catch(() => null);
    if (!data || typeof data !== "object") {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: { code: "bad-json", message: "请求体不是 JSON" } }));
      return;
    }
    await writeCostStoreFile({ daily: data.daily ?? null, weekly: data.weekly ?? null, monthly: data.monthly ?? null });
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  const store = await readCostStoreFile();
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: true, daily: store?.daily ?? null, weekly: store?.weekly ?? null, monthly: store?.monthly ?? null }));
}

async function handleBalance(ctx, config, req, res) {
  if (!checkRequest(ctx, req, res)) return;
  const result = await query(ctx, config.baseURL);
  // pricing 是本地配置，不依赖 DeepSeek 请求成功与否——余额查询失败（比如没配
  // key）也不该连带把花费预估一起挡掉，两者算的是完全不同的事。
  const payload = { ...result, pricing: pricingOf(config) };
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function handlePricing(ctx, config, req, res) {
  if (!checkRequest(ctx, req, res)) return;
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: true, pricing: pricingOf(config) }));
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
    path: COST_STORE_ROUTE,
    handler: (req, res) => handleCostStore(ctx, req, res)
  }), `balance: ${COST_STORE_ROUTE}`);
}
