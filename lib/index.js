import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expandHomePath, resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { DEFAULT_PEAK_SCHEDULE, aggregate, dayKeyOf, monthKeyOf, pricingAt, pruneFloor, scanUsage, weekKeyOf } from "./usage-log.js";
import { DEFAULT_HOLIDAY_CALENDAR_URL, fetchHolidayCalendar, yearsInRange } from "./holidays.js";

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
// `parseOfficialPricing`；缓存落在 dsh home 的 plugins 目录，TTL 半天。启动时
// 后台抓一次，之后请求触发 + TTL 刷新。
//
// **同步不上的时候一律继续用手上最后那份真实价，不再退回代码里写死的默认值**，
// 由 `/usage` 带回的 `pricingStatus` 把「多久没同步上、为什么」摊到界面上。旧实现
// 在缓存超过 7 天后会静默切到内置默认价——那是一个只在界面上看不出来的地方悄悄
// 换掉计价口径，比显示一个「已经 8 天没同步」的旧价危险得多。
const PRICING_PAGE_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/";
const PRICING_CACHE_FILE = "dsh-ui-balance-pricing-cache.json";
/**
 * 价格时间线：每次同步到**不一样**的价表就在这里追加一条，记下第一次看到它的时刻。
 * 汇总时按每条消息自己的时刻选价表，所以官方调价不会把调价之前的历史金额改写。
 */
const PRICING_HISTORY_FILE = "dsh-ui-balance-pricing-history.json";
/** 时间线最多留几条。正常一年也就调几次价，留 24 条纯粹是防写坏文件时无限长大。 */
const PRICING_HISTORY_MAX = 24;
/**
 * `pricingEffectiveFrom` 允许跟「第一次看到新价的时刻」差多远。官方提前挂价、或者
 * 我们晚一阵才抓到，都在这个量级之内；差得比这还远的多半是忘了更新的旧值。
 */
const PRICING_EFFECTIVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const PRICING_TTL_MS = 12 * 60 * 60 * 1000;
const PRICING_FETCH_TIMEOUT_MS = 10 * 1000;

/**
 * 内置的计费路由，只在**从来没成功同步过**时顶上（跟 `Config.modelPricing` 那份
 * 默认价配套）。正常情况下这两条是从定价页脚注里读出来的，见 `parseBillingRoutes`。
 *
 * 抄的是 2026-09-10 定价页上的原话：旧模型名按 Flash 价计费；北京时间 2026-09-14
 * 12:00 之后 `deepseek-v4-pro` 也按 Flash 价计费。**这里写死不意味着代码里锁死了
 * 这个口径**——只要同步成功过一次，用的就是页面上当时写的规则。
 */
const DEFAULT_BILLING_ROUTES = [
  { model: "deepseek-v4-flash", billedAs: "deepseek-flash", from: null, note: "旧模型名 deepseek-v4-flash、deepseek-v4-flash-vision-exp 仍可调用，但对应模型已下线，请求将由 DeepSeek-V4.1-Flash 模型提供服务，并按 Flash 价格计费" },
  { model: "deepseek-v4-flash-vision-exp", billedAs: "deepseek-flash", from: null, note: "旧模型名 deepseek-v4-flash、deepseek-v4-flash-vision-exp 仍可调用，但对应模型已下线，请求将由 DeepSeek-V4.1-Flash 模型提供服务，并按 Flash 价格计费" },
  { model: "deepseek-v4-pro", billedAs: "deepseek-flash", from: Date.UTC(2026, 8, 14, 4, 0), note: "北京时间 2026 年 9 月 14 日 12:00 之后，至未来 V4.1 Pro 上线之前，您访问 deepseek-v4-pro 的请求将全部路由到 V4.1 Flash，并按 V4.1 Flash 价格计费" }
];

export const name = "dsh-ui-balance";

export const inject = ["webServer"];

/**
 * `baseURL` 必须可配：dsh 自己的 DeepSeek provider 就把它放在 Config 里
 * （`dsh-llm-deepseek` 的 `baseURL: z.string()`），设置页有对应输入框。写死
 * 意味着用户把 dsh 指向兼容代理之后，余额面板不但查错了 host，还会把他填在
 * `DEEPSEEK_API_KEY` 里的**别家 key** 发到 api.deepseek.com 去。
 */
/**
 * 一个模型的单价，三项都是**空闲时段**的价（官方页上就是这么给的）。
 *
 * 这里刻意不带高峰那一套：自动同步来的价表里每个模型可以额外带一个 `peak`
 * 三项（官方页上峰谷是两张独立的表，不保证是统一倍率——不同模型、不同 token
 * 类别都可能打不同的折，历史上「一律 2 倍」只是当时恰好如此），但那是解析结果
 * 里的字段，不是要用户手填的东西。手工配的条目（第三方模型）仍按
 * 「基准价 × peakMultiplier」折算，见 `usage-log.js` 的 `ratesOf`。
 */
const ModelPrice = z.object({
  cacheHitPerMillion: z.number(),
  cacheMissPerMillion: z.number(),
  outputPerMillion: z.number()
});

/**
 * 花费折算用的单价表，键是 `${provider}:${model}`——查表用的是**每条 assistant
 * 消息自己记在日志里的 `data.message.source`**，逐条精确归因，不是拿会话当前
 * 选中的模型去套（那正是旧版会记出「未知模型」和串价的原因）。
 *
 * 官方价通过 `getPricingBundle` 自动同步：优先用从官方定价页解析出来的空闲时段
 * 基准价与高峰价（DeepSeek 官方 provider），下面这份默认值只在**从来没成功同步过**
 * 时才顶上；非 DeepSeek 官方的第三方模型仍以本地配置为准。
 *
 * 每次同步到不一样的价表都会在时间线上记一条（`PRICING_HISTORY_FILE`），汇总时按
 * 每条消息自己的时刻选价表——官方调价不会把调价之前的历史金额改写。
 *
 * 高峰时段的规则（周几、哪几个时间窗）同样是从定价页脚注解析来的、跟价表一起进
 * 时间线；判定按每条消息自己的时刻做，纯算术、不查网（`usage-log.js` 的
 * `compilePeakSchedule`）。下面的 `peakDays` / `peakWindows` 可以覆盖它。
 */
export const Config = z.object({
  baseURL: z.string().default("https://api.deepseek.com"),
  /**
   * 会话事件日志的根目录，费用统计就是从这里读的。
   *
   * 留空表示跟着 `dsh-session-persistence-jsonl` 的默认走——dsh-base 的 patch 把
   * 它配成 `dshHomePath('sessions')`，而 `resolveDshHome()` 认 `DSH_HOME`，所以
   * 改过 home 的用户不用动这一项。但那个 `root` 是**可配的**（Config 里是
   * `z.string().required()`），谁在自己的 patch 里换了地方，插件就会扫空、四格
   * 全是 0 而且没有任何报错——那种「安静地显示 0」比报错更难查，所以留一个能
   * 对上的口子。支持 `~` 开头。
   */
  sessionsRoot: z.string().default(""),
  /**
   * 最近一次官方调价的**实际生效时刻**，用来校准价格时间线。
   *
   * 插件会把每次同步到的新价表连同「第一次看到它的时刻」记进
   * `dsh-ui-balance-pricing-history.json`，汇总时按每条消息自己的时刻选价表——所以
   * 调价前的历史金额不会被新价改写。但「第一次看到」不等于「开始生效」：官方可能
   * 提前几天就把新价挂上页面，也可能我们隔了十几个小时才抓到。差多少钱取决于这段
   * 窗口里的用量，想对齐账单就把这里填成官方公告的生效时刻。
   *
   * 支持任何 `Date` 认得的写法，例如 `2026-09-10T00:00:00+08:00`。它只作用于时间线
   * 上**最新**那条，而且必须晚于上一条的生效时刻、跟「第一次看到新价」相差不超过
   * 一个月——超出范围就当没填（面板上的「生效时刻」会显示成「第一次看到」的那个）。
   * **下一次调价之后记得改成新的或者清空**：它认的永远是最新那一条。
   */
  pricingEffectiveFrom: z.string().default(""),
  currency: z.string().default("CNY"),
  /**
   * 手工配置的条目在高峰时段的倍率。自动同步来的官方模型不走这条——它们各自带着
   * 官方页上那套独立的峰价（见 `ModelPrice` 的注释）。
   */
  peakMultiplier: z.number().default(2),
  /**
   * 高峰时段是**周几**。留空表示跟着定价页脚注自动同步来的走（官方现在写的是
   * 「周一至周五」）；填了就以填的为准。
   *
   * 写法：`1-5`、`1,2,3,4,5`、`周一至周五` 都认（1=周一 … 7=周日）。
   */
  peakDays: z.string().default(""),
  /**
   * 高峰时段的**时间窗**（北京时间）。留空表示跟着定价页脚注自动同步来的走（官方
   * 现在写的是 `9:00-12:00`、`14:00-18:00`）；填了就以填的为准。
   *
   * 写法：`9:00-12:00,14:00-18:00`。填 `none` 表示「没有高峰时段，一律按空闲价」。
   *
   * 注意这两项的覆盖是**全时间线生效**的，不像价格那样按时刻分段——它表达的是
   * 「我认为规则本该是这样」，所以改它会重算全部历史金额。
   */
  peakWindows: z.string().default(""),
  /**
   * 法定节假日算高峰还是空闲。
   *
   * - `auto`（默认）：**照官方定价页说的算**。现在那句话只说「周一至周五
   *   9:00-12:00、14:00-18:00」、一个字都没提节假日，所以国庆、春节落在周一至周五
   *   就是高峰。官方哪天补一句「法定节假日按空闲时段计价」，插件会从脚注里认出来
   *   （`parsePeakSchedule`）并自动切过去——不用等新版本，也不用谁去填日期。
   * - `offpeak` / `peak`：不管页面怎么写，一律按这个算。核对过账单、发现口径跟
   *   页面字面不一样时用它。
   *
   * 判成 `offpeak` 时会自动去取当年的放假安排（含调休上班日，见 `holidays.js`）；
   * 那份日历只有在真的需要时才联网，取不到就退回按字面算并在界面上说明。
   */
  peakHolidays: z.union(["auto", "offpeak", "peak"]).default("auto"),
  /**
   * 放假安排的数据源，`{year}` 会被替换成四位年份。默认是 holiday-cn 那份公开数据集
   * （按年一个 JSON，每条带 `date` / `isOffDay`，并在 `papers` 里附上所依据的 gov.cn
   * 政策文件链接）。公司内网可以换成自己的镜像。
   */
  holidayCalendarUrl: z.string().default(DEFAULT_HOLIDAY_CALENDAR_URL),
  /**
   * 额外整天按**空闲时段**计价的日期。日历已经能自动覆盖法定节假日，这一项是留给
   * 它盖不到的情况（公司自己的休息日、日历源拉不到时手工兜一下）。
   *
   * 写法：`2026-10-01`，或者 `2026-10-01..2026-10-07` 表示一段（单次最多展开一年）。
   */
  offPeakDates: z.array(z.string()).default([]),
  /**
   * 额外整天按**工作日**看待的日期（那天仍要落在时间窗里才算高峰）。与
   * `offPeakDates` 冲突时以 `offPeakDates` 为准——整天放假优先。
   */
  peakDates: z.array(z.string()).default([]),
  modelPricing: z.dict(ModelPrice).default({
    "deepseek-official:deepseek-flash": { cacheHitPerMillion: 0.02, cacheMissPerMillion: 1, outputPerMillion: 4 },
    "deepseek-official:deepseek-v4-pro": { cacheHitPerMillion: 0.15, cacheMissPerMillion: 4.5, outputPerMillion: 13.5 }
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
  return {
    currency: config.currency,
    peakMultiplier: config.peakMultiplier,
    modelPricing: config.modelPricing,
    billing: { routes: DEFAULT_BILLING_ROUTES, unparsed: [] }
  };
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
    // 脚注角标先整块扔掉，别只脱标签：官方 2026-09 那版页面把模型名写成
    // `deepseek-flash<sup>(1)</sup>`，只脱标签会留下「deepseek-flash(1)」，
    // 模型名正则当场匹配不上、整份表判成解析失败——**而失败是安静的**，插件会
    // 继续用上一次同步到的旧价，界面上除了「同步于 x」之外看不出任何异样。
    .replace(/<sup[^>]*>[\s\S]*?<\/sup>/gi, "")
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
 * 放假安排的本地缓存。一年一份，`{ years: { "2026": {...} }, attempt }`。
 *
 * TTL 给到七天：国务院一年公布一次，改动罕见。真正的时效性靠「需要用到某一年、
 * 缓存里没有」时的即时抓取兜住。
 */
const HOLIDAY_CACHE_FILE = "dsh-ui-balance-holidays.json";
const HOLIDAY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let holidayRefreshPromise = null;
/** 最近一次取日历的尝试，跟单价那份一样：失败原因要能摊到界面上。 */
let lastHolidayAttempt = null;

async function readHolidayCache() {
  const data = await readJsonFile(pluginFilePath(HOLIDAY_CACHE_FILE));
  const years = data?.years && typeof data.years === "object" ? data.years : {};
  return { years, attempt: data?.attempt ?? null };
}

/**
 * 补齐缺的年份。单飞：面板和侧边栏同时挂着，两个订阅者不该各抓一遍。
 * @returns 抓完之后的缓存
 */
function refreshHolidays(config, years) {
  if (holidayRefreshPromise !== null) return holidayRefreshPromise;
  holidayRefreshPromise = (async () => {
    const cache = await readHolidayCache();
    const url = String(config?.holidayCalendarUrl ?? "").trim() || DEFAULT_HOLIDAY_CALENDAR_URL;
    let changed = false;
    for (const year of years) {
      const result = await fetchHolidayCalendar(year, url);
      const at = Date.now();
      lastHolidayAttempt = { at, error: result.error ?? null, year };
      if (result.error !== void 0) continue;
      cache.years[String(year)] = {
        fetchedAt: at,
        offDays: result.offDays,
        workDays: result.workDays,
        papers: result.papers
      };
      changed = true;
    }
    cache.attempt = lastHolidayAttempt;
    if (changed || cache.attempt !== null) {
      await writeJsonFile(pluginFilePath(HOLIDAY_CACHE_FILE), { version: 1, ...cache });
    }
    return cache;
  })()
    .catch(() => ({ years: {}, attempt: lastHolidayAttempt }))
    .finally(() => {
      holidayRefreshPromise = null;
    });
  return holidayRefreshPromise;
}

/**
 * 取统计窗口覆盖到的那几年的放假安排。
 *
 * **`wanted` 为假时一次请求都不发**：官方没说节假日免峰价、用户也没手工开启时，
 * 这份日历根本不参与计价，没有任何理由去联网。
 *
 * 抓不到就退回空日历（= 按字面算），并把失败原因带进 status——那意味着节假日又
 * 变回按高峰计，是个必须看得见的差别。
 */
async function getHolidayCalendar(config, wanted, now) {
  if (!wanted) return { needed: false, offDays: [], workDays: [], years: [], papers: [], attempt: null };
  const years = yearsInRange(pruneFloor(now), now);
  let cache = await readHolidayCache();
  const missing = years.filter((year) => {
    const entry = cache.years[String(year)];
    return entry === void 0 || !Array.isArray(entry.offDays);
  });
  const stale = years.filter((year) => {
    const entry = cache.years[String(year)];
    return entry !== void 0 && now - Number(entry.fetchedAt ?? 0) >= HOLIDAY_TTL_MS;
  });
  if (missing.length > 0) {
    // 缺整年就必须等：拿不到就等于「节假日按高峰算」，那是另一套金额，
    // 不能让面板先摊一份、几秒后再跳一次。
    cache = await refreshHolidays(config, missing);
  } else if (stale.length > 0) {
    refreshHolidays(config, stale);
  }
  const offDays = [];
  const workDays = [];
  const papers = [];
  const loaded = [];
  for (const year of years) {
    const entry = cache.years[String(year)];
    if (entry === void 0 || !Array.isArray(entry.offDays)) continue;
    loaded.push(year);
    for (const date of entry.offDays) offDays.push(date);
    for (const date of entry.workDays ?? []) workDays.push(date);
    for (const paper of entry.papers ?? []) papers.push(paper);
  }
  return {
    needed: true,
    offDays,
    workDays,
    years: loaded,
    missing: years.filter((year) => !loaded.includes(year)),
    papers: [...new Set(papers)],
    attempt: lastHolidayAttempt ?? cache.attempt ?? null
  };
}

/** 中文里的「周几」→ 1=周一 … 7=周日。 */
const WEEKDAY_NAMES = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 七: 7, 天: 7 };

/**
 * 从定价页的脚注里解析高峰时段规则。官方现在那句话是：
 *
 *   「(1) 空闲时段价格为高峰时段价格的一半。高峰时段为北京时间周一至周五
 *     9:00 - 12:00、14:00 - 18:00（其余为空闲时段）。」
 *
 * 规则如下：
 *
 * - 先按句号切句，只看**以「高峰时段」开头**的那句。前一句里也有「高峰时段」四个字
 *   （「空闲时段价格为高峰时段价格的一半」），从那句里读时段会读成反的。
 * - 必须写着**北京时间**才认。这一条是硬要求：整套判定是按 UTC+8 的固定偏移算的，
 *   哪天官方换成 UTC 或者别的时区表述，宁可退回上一份规则，也不能把时段整体搬错
 *   八小时——那种错算出来的钱看不出问题。
 * - 星期支持「周一至周五」「周一到周五」「周一、周三」「每天/全天」几种写法。
 * - 时段支持一到多个 `H:MM - H:MM`，全角/半角冒号与各种连字符都认。
 *
 * 解析不出来返回 null：调用方会继续用上一次同步到的那份规则，并在界面上说明。
 */
/**
 * 官方要是给节假日单开一条规则，会长什么样。
 *
 * 现在页面上一个字都没提节假日，所以这几条模式都还用不上——它们存在的意义是
 * **官方哪天加了这么一句，插件自己就跟上了，不用等我发新版、更不用让用户手填日期**。
 * 认得出来就把节假日整天判成空闲，并去拉当年的放假安排（含调休上班日）。
 */
const HOLIDAY_OFF_PEAK_PATTERNS = [
  /法定节假日[^，,。]{0,8}(全天)?[^，,。]{0,8}(为|按|计入|视为)[^，,。]{0,6}空闲/,
  /(不含|不包括|除外|剔除)[^，,。]{0,6}法定节假日/,
  /法定节假日[^，,。]{0,6}(除外|不计入高峰|不算高峰)/,
  /节假日[^，,。]{0,8}(为|按|视为)[^，,。]{0,6}空闲/
];

/**
 * 值得警惕、但我**没有**建模的计费词汇。
 *
 * 命中就在界面上把那句原文摆出来、提示「这条规则插件没读懂」。这是整套解析的兜底：
 * 我只认识「周几 + 时间窗 + 节假日」，官方以后加别的（阶梯价、封顶、换时区、
 * 新用户优惠……）我一定读不懂，那时**宁可让人看见一句读不懂的话，也不能装作规则没变**。
 */
const UNMODELLED_RULE_WORDS = /节假日|假期|调休|时区|UTC|阶梯|封顶|上限|折扣|首月|新用户/;

/**
 * 从定价页的脚注里解析高峰时段规则。
 *
 * 返回值里的 `note` 是被解析的那句**原文**：界面上原样摆出来，用户永远能看到插件
 * 到底是照哪句话在算钱；`unmodelled` 则标记「这句话里有我没建模的计费词」。
 */
/**
 * 定价页正文的纯文本：脱标签、去掉脚本样式、空白归一。脚注规则都从这上面读。
 *
 * **块级边界要当句号使**。这套解析是按句子读规则的，而脱完标签之后 `</p>` 两边的
 * 两段话会直接挤成一句——表格里那一堆模型名跟脚注里那句「按 Flash 价格计费」挤到
 * 一起，`parseBillingRoutes` 就会把整张表的模型名都当成这条规则点名的对象，把
 * `deepseek-v4-pro` 也一并路由走。那是一个算出来的钱看不出错的错。
 */
function plainTextOf(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(?:p|div|li|td|th|tr|table|h[1-6])>|<br\s*\/?>/gi, "。")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ");
}

/** 把正文切成句子（脚注编号 `(1)` 这类前缀去掉）。 */
function sentencesOf(text) {
  return text.split(/[。;；]/).map((raw) => raw.trim().replace(/^[（(]\d+[)）]\s*/, ""));
}

export function parsePeakSchedule(html) {
  const text = plainTextOf(html);
  // 脚注常常是「空闲时段价格为高峰时段价格的一半。高峰时段为……。法定节假日……。」
  // 这样连着几句，规则可能分散在其中任意一句里，所以先切句、再整段一起看。
  const sentences = sentencesOf(text);
  for (const [index, sentence] of sentences.entries()) {
    if (!sentence.startsWith("高峰时段")) continue;
    if (!sentence.includes("北京时间")) continue;
    // 括号里通常是「其余为空闲时段」这类补充，别把它当规则的一部分读。
    const body = sentence.split(/[（(]/)[0];
    const windows = [...body.matchAll(/(\d{1,2})\s*[:：]\s*(\d{2})\s*[-－—~～至到]\s*(\d{1,2})\s*[:：]\s*(\d{2})/g)]
      .map((m) => [Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])])
      .filter(([start, end]) => start >= 0 && end <= 24 * 60 && start < end);
    if (windows.length === 0) continue;
    const days = parseWeekdaySpec(body);
    if (days === null) continue;
    // 节假日那句可能单独成句，也可能就跟在这句后面的括号里。取这一句连同后面一句
    // 一起找——再往后就是别的脚注了（图片换算、价格变动声明之类）。
    const scope = [sentence, sentences[index + 1] ?? ""].join("。");
    const holidays = HOLIDAY_OFF_PEAK_PATTERNS.some((pattern) => pattern.test(scope)) ? "offpeak" : "peak";
    // 认出节假日规则之后，那句话里的「节假日」就不再是「没读懂的词」了。
    const rest = holidays === "offpeak" ? scope.replace(/法定节假日|节假日/g, "") : scope;
    return {
      days,
      windows,
      holidays,
      note: sentence,
      unmodelled: UNMODELLED_RULE_WORDS.test(rest)
    };
  }
  return null;
}

/** 从「周一至周五」「周一、周三」「每天」里读出星期集合。读不出来返回 null。 */
function parseWeekdaySpec(text) {
  if (/每天|全天|每日|不分工作日/.test(text)) return [1, 2, 3, 4, 5, 6, 7];
  const range = text.match(/(?:周|星期)([一二三四五六日七天])\s*[至到\-－—~～]\s*(?:周|星期)?([一二三四五六日七天])/);
  if (range !== null) {
    const from = WEEKDAY_NAMES[range[1]];
    const to = WEEKDAY_NAMES[range[2]];
    if (from !== void 0 && to !== void 0 && from <= to) {
      const days = [];
      for (let day = from; day <= to; day += 1) days.push(day);
      return days;
    }
    return null;
  }
  const listed = [...text.matchAll(/(?:周|星期)([一二三四五六日七天])/g)]
    .map((m) => WEEKDAY_NAMES[m[1]])
    .filter((day) => day !== void 0);
  return listed.length > 0 ? [...new Set(listed)].sort((a, b) => a - b) : null;
}

/** `"1-5"` / `"1,2,3"` / `"周一至周五"` → 星期集合；读不出来返回 null（表示「没配」）。 */
function parseConfiguredDays(raw) {
  const value = String(raw ?? "").trim();
  if (value.length === 0) return null;
  if (/[周星]/.test(value)) return parseWeekdaySpec(value);
  const days = new Set();
  for (const part of value.split(/[,，、\s]+/)) {
    const range = part.match(/^(\d)\s*[-~～]\s*(\d)$/);
    if (range !== null) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from >= 1 && to <= 7 && from <= to) {
        for (let day = from; day <= to; day += 1) days.add(day);
        continue;
      }
      return null;
    }
    const day = Number(part);
    if (Number.isInteger(day) && day >= 1 && day <= 7) days.add(day);
    else if (part.length > 0) return null;
  }
  return days.size > 0 ? [...days].sort((a, b) => a - b) : null;
}

/** `"9:00-12:00,14:00-18:00"` → 分钟区间；读不出来返回 null。`"none"` 表示「没有高峰时段」。 */
function parseConfiguredWindows(raw) {
  const value = String(raw ?? "").trim();
  if (value.length === 0) return null;
  // 明确表达「取消峰谷」的写法。留一个口子是因为空字符串已经被「跟着自动同步走」占了。
  if (/^(none|无|不分)$/i.test(value)) return [];
  const windows = [];
  for (const part of value.split(/[,，、;；]+/)) {
    const match = part.trim().match(/^(\d{1,2})\s*[:：]?\s*(\d{2})?\s*[-－—~～至到]\s*(\d{1,2})\s*[:：]?\s*(\d{2})?$/);
    if (match === null) {
      if (part.trim().length > 0) return null;
      continue;
    }
    const start = Number(match[1]) * 60 + Number(match[2] ?? 0);
    const end = Number(match[3]) * 60 + Number(match[4] ?? 0);
    if (start < 0 || end > 24 * 60 || start >= end) return null;
    windows.push([start, end]);
  }
  return windows.length > 0 ? windows : null;
}

/** `"2026-10-01"`、`"2026-10-01..2026-10-07"` → 展开成一串 `YYYY-MM-DD`。 */
function expandDateList(list) {
  const out = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const value = String(raw ?? "").trim();
    if (value.length === 0) continue;
    const range = value.split(/\.\.|~|至/).map((part) => part.trim());
    const from = Date.parse(`${range[0]}T00:00:00Z`);
    if (!Number.isFinite(from)) continue;
    if (range.length === 1) {
      out.add(range[0]);
      continue;
    }
    const to = Date.parse(`${range[1]}T00:00:00Z`);
    if (!Number.isFinite(to) || to < from) continue;
    // 一次最多展开一年，防手滑写出 `2026-01-01..2099-01-01` 这种把内存吃光。
    for (let at = from; at <= to && at - from <= 366 * 24 * 3600 * 1000; at += 24 * 3600 * 1000) {
      out.add(new Date(at).toISOString().slice(0, 10));
    }
  }
  return [...out].sort();
}

/**
 * 合成最终生效的高峰时段规则：自动同步来的那份为底，Config 里填了的项覆盖它。
 *
 * 覆盖是**全时间线生效**的，不像价格那样按时刻分段——它表达的是「我认为规则本该是
 * 这样」，而不是「某天起改成了这样」。所以改这几项会重算全部历史金额。
 */
/** 这张价表的节假日口径：`auto` 跟着定价页说的走，否则以配置为准。 */
export function resolveHolidayMode(parsed, config) {
  const mode = config?.peakHolidays ?? "auto";
  if (mode === "offpeak" || mode === "peak") return mode;
  return parsed?.holidays === "offpeak" ? "offpeak" : "peak";
}

export function effectivePeakSchedule(parsed, config, calendar) {
  const days = parseConfiguredDays(config?.peakDays);
  const windows = parseConfiguredWindows(config?.peakWindows);
  const holidays = resolveHolidayMode(parsed, config);
  // 放假安排只在「节假日算空闲」这个口径下才参与判定。口径是「按字面算」时，
  // 调休上班的周六本来就该是空闲——那时把日历里的上班日拿来判高峰反而算多了。
  const dated = holidays === "offpeak" && calendar
    ? { offDays: calendar.offDays ?? [], workDays: calendar.workDays ?? [] }
    : { offDays: [], workDays: [] };
  return {
    days: days ?? parsed?.days ?? DEFAULT_PEAK_SCHEDULE.days,
    windows: windows ?? parsed?.windows ?? DEFAULT_PEAK_SCHEDULE.windows,
    holidays,
    // 被解析的那句原文，以及「这句话里有我没建模的计费词」。界面上原样摆出来——
    // 官方以后加了别的规则，至少让人看得见插件在照哪句话算钱、哪句没读懂。
    note: parsed?.note ?? null,
    unmodelled: parsed?.unmodelled === true,
    offPeakDates: [...dated.offDays, ...expandDateList(config?.offPeakDates)],
    peakDates: [...dated.workDays, ...expandDateList(config?.peakDates)],
    // 界面上要说清「现在这套时段是从哪来的」：官方页解析到的、手工配的、还是内置默认。
    source: days !== null || windows !== null ? "config" : (parsed ? "official" : "default"),
    holidaySource: (config?.peakHolidays ?? "auto") === "auto" ? "official" : "config"
  };
}

/**
 * 计费路由：定价页脚注里那种「访问 A 的请求实际按 B 的价格计费」的规则。
 *
 * 2026-09 官方一次性给了两条：
 *
 *   (1) 旧模型名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 仍可调用，但对应
 *       模型已下线，请求由 DeepSeek-V4.1-Flash 提供服务，**并按 Flash 价格计费**。
 *   (2) 北京时间 2026 年 9 月 14 日 12:00 之后、至 V4.1 Pro 上线之前，`deepseek-v4-pro`
 *       的请求全部路由到 V4.1 Flash，**并按 V4.1 Flash 价格计费**。
 *
 * 这两条都不是「价表里少了一行」那么简单，不建模就一定算错钱，而且是**两个方向**的错：
 *
 * - 旧模型名在新版价表里根本不出现了。不路由的话它们变成「未配置单价」，那批用量的
 *   金额直接算 0——用量表里有 token、费用表里没有钱。
 * - `deepseek-v4-pro` 在价表里**仍然挂着 Pro 的价**，而 9/14 12:00 之后实际按 Flash 收。
 *   不路由的话按 Pro 价算，一笔输出要多算 2.4 倍。
 *
 * 所以规则从页面上读、不写死在代码里，跟着价表一起进价格时间线（`billing` 字段进
 * 指纹）。这一点很要紧：官方哪天上线 V4.1 Pro、把脚注 (2) 撤掉，下一次同步就会在
 * 时间线上留一条新记录，那之后的消息自动回到按 Pro 价算，而**那之前的历史仍按当时
 * 页面上写的规则算**——不需要有人记得回来改代码。
 *
 * 代价是我们最多比页面晚 `PRICING_TTL_MS`（半天）发现规则变化，这跟价格本身的同步
 * 延迟是同一个量级，认了。
 *
 * `models` 是同一张表里解析出来的模型名，用来把脚注里的「Flash」这种口语称呼落到
 * 具体的模型键上——落不到就不认这条规则（宁可不路由，也不能猜错路由到谁）。
 *
 * **导出只是为了测试**：跟 `parseOfficialPricing` 一样，它是被上游改一次版就会安静
 * 失效的地方，必须能单独喂 HTML 断言。
 */
export function parseBillingRoutes(html, models) {
  const known = (Array.isArray(models) ? models : []).map(String);
  const routes = [];
  const unparsed = [];
  // 价格表整块扔掉再读。规则是写在脚注散文里的，而表格里排着一列模型名——万一哪天
  // 表格和脚注之间没有句号把它们隔开，那一列名字就会被当成这条规则点名的对象。
  const prose = String(html).replace(/<table[\s\S]*?<\/table>/gi, "。");
  for (const sentence of sentencesOf(plainTextOf(prose))) {
    // 只看「按谁计费」这件事，而且得同时是一句在讲模型路由/下线的话。光有「计费」
    // 两个字的句子（「扣减费用 = token 消耗量 × 模型单价」之类）不该进来。
    if (!/计费/.test(sentence)) continue;
    if (!/(路由|下线|提供服务|旧模型名|仍可调用)/.test(sentence)) continue;
    const billedAs = resolveBilledAs(sentence, known);
    // 模型名只认小写的那种 API 名（`deepseek-v4-pro`），句子里的
    // 「DeepSeek-V4.1-Flash」是模型版本号、不是能拿去调用的名字。
    const sources = [...new Set([...sentence.matchAll(/deepseek-[a-z0-9][a-z0-9.-]*/g)].map((m) => m[0]))]
      .filter((name) => name !== billedAs);
    const moment = parseEffectiveFrom(sentence);
    const from = moment?.at ?? null;
    // 句子里出现了时间界限却读不出来：**宁可不套用这条规则**。整句忽略会按价表原价
    // 算（多算），从头套用会按目标价算（少算）——两个方向都是错，但少算的那种更像
    // 「一切正常」，而多算至少还留着页面上的原价这个能对得上的口径。两种情况都把
    // 原文摆到界面上，由人来判。
    const boundedButUnread = (moment !== null && moment.at === null)
      || (moment === null && /(北京时间|之后|起)/.test(sentence) && /\d/.test(sentence));
    if (billedAs === null || sources.length === 0 || boundedButUnread) {
      unparsed.push(sentence);
      continue;
    }
    for (const model of sources) routes.push({ model, billedAs, from, note: sentence });
  }
  return { routes, unparsed };
}

/**
 * 「并按 V4.1 Flash 价格计费」→ 表里那个 `deepseek-flash`。落不到具体模型就返回 null。
 *
 * 只认**逐字对得上**的名字（`flash` → `deepseek-flash`），不按后缀猜。曾经试过「唯一
 * 后缀匹配」那种退一步的写法，它会把 2026-09-09 那张表上的「按 Flash 价格计费」认到
 * `deepseek-v4-flash` 头上——猜对猜错都看不出来，而算错的钱是真的。落不到就当读不懂，
 * 把原句摆到界面上让人判，这是这套解析一贯的失败方式。
 */
function resolveBilledAs(sentence, models) {
  const match = sentence.match(/按\s*([A-Za-z0-9.\- ]{1,32}?)\s*(?:模型\s*)?(?:价格\s*)?计费/);
  if (match === null) return null;
  // 「V4.1 Flash」这种写法里，真正对得上模型名的是最后那个词。
  const token = match[1].trim().split(/\s+/).pop()?.toLowerCase() ?? "";
  if (token.length === 0) return null;
  return models.find((name) => name === token || name === `deepseek-${token}`) ?? null;
}

/**
 * 「北京时间 2026 年 9 月 14 日 12:00 之后」→ `{ at }`。句子里没有时刻返回 null，
 * 有时刻但读不懂返回 `{ at: null }`（调用方据此判成「没读懂」，整条规则不套用）。
 *
 * 一句话里出现**两个**时刻是要特别当心的一种：「A 之后至 B 之前」是带起止的规则，
 * 而这里只建模了「起」。照单认下第一个会把这条路由一直套到天荒地老——B 那天之后
 * 官方早就换回原价了，面板还在按目标模型的价算，而且一个字都不会说。
 */
function parseEffectiveFrom(sentence) {
  const all = [...sentence.matchAll(/北京时间\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2})\s*[:：]\s*(\d{2})/g)];
  if (all.length === 0) return null;
  if (all.length > 1) return { at: null };
  const match = all[0];
  // 必须是「……之后 / ……起 / ……开始」那种表达生效时刻的写法。页面上出现的日期也
  // 可能是别的意思（公告日期、截止日期），当成生效时刻会把一整段历史按错的价重算。
  if (!/(之后|以后|起|开始)/.test(sentence.slice(match.index + match[0].length, match.index + match[0].length + 8))) return { at: null };
  const [, y, mo, d, h, mi] = match.map(Number);
  // 固定 UTC+8，跟 `compilePeakSchedule` 判高峰用的是同一套时区口径。
  const at = Date.UTC(y, mo - 1, d, h - 8, mi);
  return { at: Number.isFinite(at) ? at : null };
}

/**
 * 把计费路由套到一张价表上：被路由的模型键**改挂目标模型的价**。
 *
 * `at` 是「按哪个时刻判」——带生效时刻的规则（pro → flash 那条）在此之前不算数。
 * 汇总时这个时刻是**每条消息自己发生的时刻**，由价格时间线在路由分界点切一刀来
 * 保证（见 `splitAtRouteBoundaries`）。
 *
 * 目标模型不在这张表里就跳过这条规则：翻旧账时老价表上根本没有 `deepseek-flash`
 * 这一行，那时候的 `deepseek-v4-flash` 就该按它自己那份价算，正是当时的实情。
 *
 * 结果里多带一个 `routedModels`（键 → 实际计费的模型名），界面上要标出来——单价
 * 表里凭空多出两行一模一样的价，不说清就成了「这表是不是坏了」。
 */
export function applyBillingRoutes(pricing, at) {
  const routes = pricing?.billing?.routes ?? [];
  if (routes.length === 0) return pricing;
  const source = pricing.modelPricing ?? {};
  const modelPricing = { ...source };
  const routedModels = {};
  for (const route of routes) {
    if (route.from !== null && route.from !== void 0 && Number(at) < Number(route.from)) continue;
    // 目标价一律从**原表**里取，不取已经改写过的那份：两条规则首尾相接时（A→B、
    // B→C）串起来算出来的东西页面上并没有这么说。
    const target = source[`deepseek-official:${route.billedAs}`];
    if (target === void 0) continue;
    modelPricing[`deepseek-official:${route.model}`] = target;
    routedModels[`deepseek-official:${route.model}`] = route.billedAs;
  }
  if (Object.keys(routedModels).length === 0) return pricing;
  return { ...pricing, modelPricing, routedModels };
}

/** 这张表里所有计费路由的生效时刻（去重升序）。价格时间线要在这些点上切一刀。 */
function routeBoundariesOf(pricing) {
  const seen = new Set();
  for (const route of pricing?.billing?.routes ?? []) {
    const from = Number(route?.from);
    if (Number.isFinite(from)) seen.add(from);
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * 在计费路由的生效时刻上把时间线切开。
 *
 * 价表本身没变（官方没调价），但**同一张表在 9/14 12:00 前后算出来的钱不一样**。
 * 时间线是按「每条消息自己的时刻选表」用的，所以这里补出来的那一段用的还是同一张
 * 原始价表，只是 `from` 不同——套路由时按各自的 `from` 判，前一段 pro 按 Pro 价、
 * 后一段按 Flash 价。
 *
 * 补出来的段**只活在内存里**，不写进 `PRICING_HISTORY_FILE`：它不是「我们看到官方
 * 换了一张表」，而是同一张表自己写明的分段，落盘反而会让下一次指纹比对认不出来。
 */
function splitAtRouteBoundaries(timeline) {
  const out = [];
  for (const [index, entry] of timeline.entries()) {
    out.push(entry);
    const next = timeline[index + 1];
    for (const from of routeBoundariesOf(entry.pricing)) {
      if (from <= entry.from) continue;
      if (next !== void 0 && from >= next.from) continue;
      out.push({ ...entry, from, fromSource: "route" });
    }
  }
  return out;
}

/**
 * 从官方定价页 HTML 里解析模型单价。
 *
 * 页面结构：一个 `<table>`，模型行之后有「百万tokens输入（缓存命中/未命中）」和
 * 「百万tokens输出」三组行；每组**可能**再分空闲/高峰两行。
 *
 * 这里对峰谷的态度是「有就存下来，没有就算没有」：
 *
 * - 峰价按**每个模型每一类**单独存进 `peak`，不再要求「峰价 ÷ 空闲价」在所有模型、
 *   所有 token 类别上是同一个倍率。原先那条校验不过就整份放弃自动同步、静默退回
 *   写死的默认价——而官方只要给某一类单独打个不一样的折，就会触发它。
 * - 表里根本没有空闲/高峰两行（官方取消峰谷）时，那一组的数就是这个模型的唯一价，
 *   `peak` 留空、`peakMultiplier` 记 1，界面上的峰谷角标也会跟着不再出现。
 *
 * `peakMultiplier` 只剩一个用途：给**没有**自己那套峰价的条目（手工配置的第三方
 * 模型）兜底。所以它取所有比值的平均数，倍率统一时就是那个统一值。
 *
 * **导出只是为了测试**：这个函数是整个插件里最容易被上游一次改版打断的地方，
 * 而它失败的方式是安静的（继续用旧价）。所以它必须能被单独喂 HTML 断言，
 * 而不是只能靠一次真实网络请求去碰。
 */
export function parseOfficialPricing(html) {
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
  const kindOf = (label) => {
    if (label.includes("百万tokens输入") && label.includes("缓存命中")) return "cacheHit";
    if (label.includes("百万tokens输入") && label.includes("缓存未命中")) return "cacheMiss";
    if (label.includes("百万tokens输出")) return "output";
    return null;
  };
  /** 一行里从 `start` 开始的 N 个价格单元；有一个读不出来就整行不要。 */
  const valuesFrom = (cells, start) => {
    const values = cells.slice(start, start + models.length).map(parsePriceCell);
    if (values.length !== models.length) return null;
    return values.every((v) => v !== null && Number.isFinite(v) && v > 0) ? values : null;
  };
  const periodOf = (cell) => (cell === "空闲时段" ? idle : cell === "高峰时段" ? peak : null);

  let currentKind = null;
  for (const cells of rows) {
    const labelIndex = cells.findIndex((cell) => cell.includes("百万tokens输入") || cell.includes("百万tokens输出"));
    if (labelIndex !== -1) {
      currentKind = kindOf(cells[labelIndex]) ?? currentKind;
      if (currentKind === null) continue;
      const bucket = periodOf(cells[labelIndex + 1]);
      if (bucket !== null) {
        // 「<类别> | 空闲时段 | 价 | 价 …」：类别和时段挤在同一行里。
        const values = valuesFrom(cells, labelIndex + 2);
        if (values !== null) bucket[currentKind] = values;
        continue;
      }
      // 没有时段那一格：这一行的数就是这一类的唯一价（官方取消峰谷时的形状）。
      const values = valuesFrom(cells, labelIndex + 1);
      if (values !== null) idle[currentKind] = values;
      continue;
    }
    const bucket = periodOf(cells[0]);
    if (bucket !== null && currentKind !== null) {
      const values = valuesFrom(cells, 1);
      if (values !== null) bucket[currentKind] = values;
    }
  }

  const modelPricing = {};
  const ratios = [];
  for (let i = 0; i < models.length; i += 1) {
    const base = {
      cacheHitPerMillion: idle.cacheHit?.[i],
      cacheMissPerMillion: idle.cacheMiss?.[i],
      outputPerMillion: idle.output?.[i]
    };
    // 基准（空闲）那三项缺一个就整份放弃：宁可继续用上一次同步到的价，也不要摊出
    // 一张半截的表——半截的表算出来的钱是错的，而且错得看不出来。
    if (Object.values(base).some((v) => v === void 0 || v === null || !Number.isFinite(v) || v <= 0)) return null;
    const peakTriple = {
      cacheHitPerMillion: peak.cacheHit?.[i],
      cacheMissPerMillion: peak.cacheMiss?.[i],
      outputPerMillion: peak.output?.[i]
    };
    const hasPeak = Object.values(peakTriple).every((v) => Number.isFinite(v) && v > 0);
    modelPricing[`deepseek-official:${models[i]}`] = hasPeak ? { ...base, peak: peakTriple } : base;
    if (hasPeak) {
      ratios.push(
        peakTriple.cacheHitPerMillion / base.cacheHitPerMillion,
        peakTriple.cacheMissPerMillion / base.cacheMissPerMillion,
        peakTriple.outputPerMillion / base.outputPerMillion
      );
    }
  }

  const peakSchedule = parsePeakSchedule(html);
  // 计费路由（「访问 A 按 B 的价计费」）跟价表一起进时间线，理由见 `parseBillingRoutes`。
  // 一条都没有、也没有读不懂的句子时不带这个字段：老价表的指纹里本来就没有它，
  // 凭空多一个空字段会被判成一次调价，在时间线上留一条假的。
  const billing = parseBillingRoutes(html, models);
  return {
    currency: "CNY",
    peakMultiplier: ratios.length === 0
      ? 1
      : Number((ratios.reduce((a, b) => a + b, 0) / ratios.length).toFixed(4)),
    // 高峰时段规则跟价表一起进价格时间线：官方连时段一起调的时候，历史消息仍按
    // 当时的时段判定。脚注读不出来就不带这个字段，由 `effectivePeakSchedule`
    // 退回上一份/内置默认，并在界面上标明来源。
    ...(peakSchedule === null ? {} : { peakSchedule }),
    ...(billing.routes.length === 0 && billing.unparsed.length === 0 ? {} : { billing }),
    modelPricing
  };
}

/**
 * 抓一次官方定价页。返回 `{ pricing, error }`——**失败原因要留下来**，界面上要能
 * 区分「网页打不开」和「网页结构变了解析不出来」：前者等网络恢复就好，后者是得
 * 有人来改解析规则的信号，而调价那几天正是它最可能发生的时候。
 */
async function fetchOfficialPricing() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PRICING_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(PRICING_PAGE_URL, {
      signal: controller.signal,
      headers: { accept: "text/html" }
    });
    if (!res.ok) return { pricing: null, error: `http-${res.status}` };
    const pricing = parseOfficialPricing(await res.text());
    return pricing === null ? { pricing: null, error: "parse" } : { pricing, error: null };
  } catch {
    return { pricing: null, error: "network" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 一张价表的指纹，用来判断「这次同步到的价跟上次是不是同一份」。
 *
 * 比的是**实际算钱用的那几个数**，不是对象的形状：
 *
 * - 键先排序。对象字面量的键序取决于解析顺序，官方页上模型列换个位置就会让指纹
 *   变化，凭空在时间线上多出一条「调价」。
 * - 没有自己那套峰价的条目，按 `基准价 × peakMultiplier` 折出来再比，跟
 *   `usage-log.js` 的 `ratesOf` 同一套规则。0.7.0 解析出来的表只有一个统一倍率、
 *   没有 `peak` 块，升级后第一次同步会带上 `peak`——**那不是调价**，两张表算出来
 *   的钱一模一样，不该在时间线上留一条、也不该让面板报「本周期跨越了 2 张价表」。
 * - 因此 `peakMultiplier` 本身不进指纹：它的作用已经折进上面那几个数里了。
 */
function pricingFingerprint(pricing) {
  const modelPricing = pricing?.modelPricing ?? {};
  const multiplier = Number(pricing?.peakMultiplier ?? 1);
  const round = (value) => Number(Number(value).toFixed(6));
  // 时段规则也进指纹：官方把 9:00-12:00 改成 8:30-12:00 同样是一次「调价」，得在
  // 时间线上留一条，历史消息才会继续按旧时段判定。
  //
  // **没记时段的老条目按内置默认规则算**，不是按「未知」：0.7.x 只认那一套写死的
  // 规则，它当时确实就是按周一至周五 9-12/14-18 计的价。不做这个归一，升级后第一次
  // 同步会因为「多了 peakSchedule 字段」被判成一次调价，在时间线上留一条假的。
  const schedule = pricing?.peakSchedule ?? DEFAULT_PEAK_SCHEDULE;
  // 计费路由也算这张表的一部分：官方撤掉「pro 按 flash 计费」那条脚注（V4.1 Pro
  // 上线）跟直接调价一样会改变一大批消息的金额，得在时间线上留一条，之前的历史
  // 才会继续按当时页面写的规则算。老条目没有这个字段，按「没有路由」归一。
  const routes = (pricing?.billing?.routes ?? [])
    .map((route) => [route.model, route.billedAs, Number.isFinite(Number(route.from)) ? Number(route.from) : null])
    .sort((a, b) => String(a).localeCompare(String(b)));
  return JSON.stringify([
    pricing?.currency ?? null,
    routes,
    // 节假日口径也算规则的一部分：官方补一句「法定节假日除外」同样会改变一大批
    // 消息的金额，得在时间线上留一条，公告之前的历史才会继续按当时的口径算。
    // 老条目没这个字段，按「按字面算」归一——0.7.x 当时确实就是那么算的。
    [schedule.days, schedule.windows, schedule.holidays ?? "peak"],
    Object.keys(modelPricing).sort().map((key) => {
      const price = modelPricing[key];
      const peak = price.peak ?? {
        cacheHitPerMillion: price.cacheHitPerMillion * multiplier,
        cacheMissPerMillion: price.cacheMissPerMillion * multiplier,
        outputPerMillion: price.outputPerMillion * multiplier
      };
      return [
        key,
        round(price.cacheHitPerMillion), round(price.cacheMissPerMillion), round(price.outputPerMillion),
        round(peak.cacheHitPerMillion), round(peak.cacheMissPerMillion), round(peak.outputPerMillion)
      ];
    })
  ]);
}

/** 时间线上存下来的原始条目（`{ seenAt, pricing }`，升序）。 */
async function readPricingHistory() {
  const data = await readJsonFile(pluginFilePath(PRICING_HISTORY_FILE));
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  return entries
    .filter((entry) => Number.isFinite(Number(entry?.seenAt)) && entry?.pricing?.modelPricing)
    .map((entry) => ({ seenAt: Number(entry.seenAt), pricing: entry.pricing }))
    .sort((a, b) => a.seenAt - b.seenAt);
}

/**
 * 裁剪时间线。用量记录本身只留到上月 1 日（`pruneFloor`），比那更早的价表再也用不上；
 * 但**必须留下那个下限当时生效的那一条**，否则最早那批记录会被算到一张更新的价表上。
 */
function prunePricingHistory(entries, now) {
  const floor = pruneFloor(now);
  let keepFrom = 0;
  for (let i = 0; i < entries.length; i += 1) {
    if (entries[i].seenAt <= floor) keepFrom = i;
  }
  const kept = entries.slice(keepFrom);
  return kept.length > PRICING_HISTORY_MAX ? kept.slice(kept.length - PRICING_HISTORY_MAX) : kept;
}

/** 同步到的价表跟上一条不一样就往时间线上追加一条。返回是否真的变了。 */
async function notePricingChange(pricing, now) {
  const entries = await readPricingHistory();
  const last = entries[entries.length - 1];
  if (last !== void 0 && pricingFingerprint(last.pricing) === pricingFingerprint(pricing)) return false;
  entries.push({ seenAt: now, pricing });
  await writeJsonFile(pluginFilePath(PRICING_HISTORY_FILE), {
    version: 1,
    entries: prunePricingHistory(entries, now)
  });
  return true;
}

/** 最近一次同步尝试（内存里那份，进程内立刻可见；同时也落进缓存文件跨重启保留）。 */
let lastPricingAttempt = null;

let pricingRefreshPromise = null;
function refreshOfficialPricing() {
  if (pricingRefreshPromise === null) {
    pricingRefreshPromise = fetchOfficialPricing()
      .then(async (result) => {
        const at = Date.now();
        lastPricingAttempt = { at, error: result.error };
        if (result.pricing !== null) {
          await writePricingCache({ fetchedAt: at, pricing: result.pricing, attempt: lastPricingAttempt });
          // 时间线写不进去不该让这次同步整体算失败：价已经拿到了，缓存也落了，
          // 少一条时间线记录的后果是「这次调价的分界点不准」，比把成功报成失败轻。
          await notePricingChange(result.pricing, at).catch(() => {});
        } else {
          // 失败也要落盘：不然重启之后「上次尝试是什么时候、为什么失败」就没了，
          // 界面只能说「同步于三天前」，说不出「这三天一直在失败」。
          const cached = await readPricingCache();
          if (cached !== null) await writePricingCache({ ...cached, attempt: lastPricingAttempt });
        }
        return result;
      })
      .catch(() => ({ pricing: null, error: "internal" }))
      .finally(() => {
        pricingRefreshPromise = null;
      });
  }
  return pricingRefreshPromise;
}

/** Config 里手填的生效时刻，解析不出来就当没填。 */
function configuredEffectiveFrom(config) {
  const raw = String(config?.pricingEffectiveFrom ?? "").trim();
  if (raw.length === 0) return null;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? at : null;
}

/**
 * 把存下来的条目变成价格时间线：`[{ from, seenAt, pricing }]`，升序。
 *
 * `from` 默认就是「第一次看到这张价的时刻」。Config 里的 `pricingEffectiveFrom`
 * 只用来校准**最新**那一条，而且要过两道关：
 *
 * - 必须晚于上一条的 `from`，否则时间线就乱序了；
 * - 跟「第一次看到」相差不能超过 `PRICING_EFFECTIVE_WINDOW_MS`。官方可能提前挂价、
 *   我们也可能晚十几个小时才抓到，一个月的余量足够；超出这个范围的十有八九是上一次
 *   调价时填下、后来忘了改的旧值，认它反而会把一大段历史按错的价重算。
 *
 * 两道关都是「不认就退回第一次看到的时刻」，不报错——这个字段是校准用的，填错不该
 * 让整份统计不可用。
 */
function pricingTimelineOf(entries, config) {
  const timeline = entries.map((entry) => ({ from: entry.seenAt, seenAt: entry.seenAt, pricing: entry.pricing }));
  const override = configuredEffectiveFrom(config);
  if (override !== null && timeline.length > 0) {
    const last = timeline[timeline.length - 1];
    const prev = timeline[timeline.length - 2];
    const ordered = prev === void 0 || override > prev.from;
    const nearby = Math.abs(override - last.seenAt) <= PRICING_EFFECTIVE_WINDOW_MS;
    if (ordered && nearby) {
      last.from = override;
      last.fromSource = "config";
    }
  }
  return timeline;
}

/** 这张表里到底有没有峰谷价——没有就别在界面上摆峰/谷角标。 */
function hasPeakPricing(pricing) {
  const entries = Object.values(pricing?.modelPricing ?? {});
  if (entries.some((price) => price?.peak !== void 0 && price?.peak !== null)) return true;
  return entries.length > 0 && Number(pricing?.peakMultiplier ?? 1) !== 1;
}

/**
 * 当前该用的价表 + 价格时间线 + 同步状态。
 *
 * 三件事一起给，因为它们必须自洽：界面上摊的单价、算钱用的时间线、以及「这份价是
 * 什么时候同步到的」得是同一次读出来的结果。
 *
 * 同步不上时**继续用手上最后那份真实价**，多旧都用，只把状态标出来；只有从来没
 * 成功同步过（新装、一直没网）才用代码里写死的默认价。
 */
async function getPricingBundle(config) {
  const now = Date.now();
  const cached = await readPricingCache();
  const syncedAt = Number.isFinite(Number(cached?.fetchedAt)) ? Number(cached.fetchedAt) : null;
  let synced = cached?.pricing?.modelPricing ? cached.pricing : null;
  let attempt = lastPricingAttempt ?? (cached?.attempt ?? null);

  if (synced === null) {
    // 一份都没有：必须等这一次抓完，不然第一次打开面板显示的是写死的默认价。
    const result = await refreshOfficialPricing();
    if (result?.pricing) synced = result.pricing;
    attempt = lastPricingAttempt ?? attempt;
  } else if (syncedAt === null || now - syncedAt >= PRICING_TTL_MS) {
    // 过期了：后台刷新，本次仍用手上这份，下一次请求就是新价。
    refreshOfficialPricing();
  }

  let entries = await readPricingHistory();
  // 缓存里那份价必须在时间线上有对应的一条。两种情况会缺：
  //
  //   1. 时间线文件还不存在（从 0.7.x 升上来，或者写盘失败过）。
  //   2. 缓存比时间线新——比如还在跑 0.7.x 的那个进程刷新了缓存（它不认识时间线），
  //      之后才换成新版本启动。这时如果只信时间线，界面上摊的会是**旧价**。
  //
  // 补的那一条按缓存的 `fetchedAt` 记「第一次看到」，跟正常同步走的是同一套语义。
  // 而且**顺手落盘**，别等下一次同步成功：时间线上那条旧价只有在调价之前落下来才
  // 有用，万一接下来几天同步一直失败、等调价之后才成功一次，时间线上就只剩新价
  // 一条，所有历史都会按新价重算——正是这套机制要防的那件事。写盘按指纹去重。
  if (synced !== null) {
    const last = entries[entries.length - 1];
    if (last === void 0 || pricingFingerprint(last.pricing) !== pricingFingerprint(synced)) {
      const seenAt = last === void 0 ? (syncedAt ?? now) : Math.max(syncedAt ?? now, last.seenAt + 1);
      entries = entries.concat([{ seenAt, pricing: synced }]);
      notePricingChange(synced, seenAt).catch(() => {});
    }
  }
  // 每一张历史价表都要补两样：手工配置的第三方模型（不然翻旧账时它们全变成「未配置
  // 单价」），以及最终生效的高峰时段规则（那张表自己解析到的为底、Config 覆盖）。
  // 节假日日历要不要拉，取决于**有没有哪张价表的口径是「节假日算空闲」**：官方
  // 页面上写了（`auto` 下解析出来）、或者用户手工设成 offpeak。都不是的话一次请求
  // 都不发——那份日历根本不参与计价。
  const rawSchedules = [
    ...entries.map((entry) => entry.pricing?.peakSchedule ?? null),
    synced?.peakSchedule ?? null
  ];
  const holidaysWanted = rawSchedules.some((schedule) => resolveHolidayMode(schedule, config) === "offpeak");
  const calendar = await getHolidayCalendar(config, holidaysWanted, now);

  // 计费路由在**合并本地配置之前**套：路由补出来的那几行（比如价表里已经没有的
  // `deepseek-v4-flash`）必须占住位置，否则 `mergeModelPricing` 会拿 Config 里那份
  // 早就过期的默认价把它填上——那是一个在界面上完全看不出来的错价。
  const withOverrides = (pricing, fallbackSchedule, at) => ({
    ...mergeModelPricing(applyBillingRoutes(pricing, at), config),
    peakSchedule: effectivePeakSchedule(pricing?.peakSchedule ?? fallbackSchedule ?? null, config, calendar)
  });
  const base = pricingTimelineOf(entries, config);
  // 「最新那条」要在切分之前认出来：切出来的段用的是同一张原始价表，按下标找会
  // 找到切片上去。这里只影响那条兜底的时段规则来源，不影响任何金额。
  const newest = base.length > 0 ? base[base.length - 1].pricing : null;
  const timeline = splitAtRouteBoundaries(base).map((entry) => ({
    ...entry,
    // 只有**最新**那条允许拿缓存里刚同步到的时段规则兜底。老条目（0.7.x 写下的）
    // 没记时段，按内置默认算——那正是它们当时用的规则。而最新那条如果也没记，说明
    // 页面上的规则跟内置默认一模一样（否则指纹会变、早就另起一条了），拿同步到的
    // 那份填进去只是把「这套规则是从官方页读到的」这个来源说准，不改变任何金额。
    pricing: withOverrides(entry.pricing, entry.pricing === newest ? (synced?.peakSchedule ?? null) : null, entry.from)
  }));

  const current = timeline.length > 0
    ? (pricingAt(timeline, now) ?? timeline[timeline.length - 1].pricing)
    : withOverrides(synced !== null ? synced : pricingOf(config), null, now);
  const currentEntry = timeline.length > 0
    ? timeline.filter((entry) => entry.from <= now).slice(-1)[0] ?? timeline[0]
    : null;

  return {
    current,
    timeline,
    status: {
      source: synced === null ? "default" : "official",
      syncedAt,
      attemptedAt: attempt?.at ?? null,
      error: attempt?.error ?? null,
      stale: synced === null || syncedAt === null || now - syncedAt >= PRICING_TTL_MS,
      peak: hasPeakPricing(current) && current.peakSchedule.windows.length > 0,
      // 现在这套高峰时段是从哪来的：定价页解析到的 / 手工配的 / 内置默认。界面上要
      // 把时段本身写出来——用户没法从数字上看出插件按的是哪套规则。
      schedule: {
        days: current.peakSchedule.days,
        windows: current.peakSchedule.windows,
        source: current.peakSchedule.source,
        offPeakDates: current.peakSchedule.offPeakDates.length,
        peakDates: current.peakSchedule.peakDates.length,
        // 节假日口径 + 那句原文。原文一定要带上：官方以后改了措辞、加了新规则，
        // 界面上能直接读到它照的是哪句话，而 `unmodelled` 说的是「这句里有我没
        // 建模的计费词」——读不懂也要喊一声，不能装作规则没变。
        holidays: current.peakSchedule.holidays,
        holidaySource: current.peakSchedule.holidaySource,
        note: current.peakSchedule.note,
        unmodelled: current.peakSchedule.unmodelled,
        // 放假安排取到了没有：取不到就意味着节假日又变回按高峰算，是个必须看得见的差别。
        calendar: calendar.needed
          ? {
            years: calendar.years,
            missing: calendar.missing ?? [],
            error: calendar.attempt?.error ?? null,
            papers: calendar.papers ?? []
          }
          : null
      },
      // 计费路由的现状：哪些模型名此刻实际按别的模型计价、哪条规则还等着生效、
      // 以及页面上哪句像是这类规则却没读懂。三样都要摊到界面上——单价表里凭空
      // 多出几行一样的价，不说清就成了「这表是不是坏了」。
      billing: {
        routed: Object.entries(current.routedModels ?? {}).map(([key, billedAs]) => ({
          model: key.slice(key.indexOf(":") + 1),
          billedAs,
          note: (current.billing?.routes ?? []).find((route) => `deepseek-official:${route.model}` === key)?.note ?? null
        })),
        pending: (current.billing?.routes ?? [])
          .filter((route) => Number.isFinite(Number(route.from)) && Number(route.from) > now)
          .map((route) => ({ model: route.model, billedAs: route.billedAs, from: Number(route.from), note: route.note ?? null })),
        unparsed: current.billing?.unparsed ?? []
      },
      effectiveFrom: currentEntry?.from ?? null,
      effectiveFromSource: currentEntry?.fromSource ?? "seen",
      // 路由分界点切出来的那一段不算「还没开始套用的新价」：价表本身没变，界面上
      // 说「已抓到一份新价」会让人以为官方又调价了。它由上面的 `billing.pending` 说。
      pendingFrom: timeline
        .filter((entry) => entry.from > now && entry.fromSource !== "route")
        .map((entry) => entry.from)
    }
  };
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

/** 增量扫描的缓存：每个日志文件记「尺寸 / 已读到哪个字节 / 续读锚点 / 已抽出的记录」。 */
const USAGE_CACHE_FILE = "dsh-ui-balance-usage-cache.json";
/** 「重置」写下的清零下限，按 day/week/month 各一份。 */
const RESET_FILE = "dsh-ui-balance-reset.json";

function sessionsRoot(config) {
  const configured = String(config?.sessionsRoot ?? "").trim();
  if (configured.length > 0) return resolve(expandHomePath(configured));
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

async function refreshUsage(config, force) {
  if (usageScanPromise !== null) return usageScanPromise;
  if (!force && usageRecords !== null && Date.now() - usageScanAt < USAGE_SCAN_TTL_MS) return usageRecords;
  usageScanPromise = (async () => {
    if (usageCache === null) usageCache = await readJsonFile(pluginFilePath(USAGE_CACHE_FILE));
    const { records, cache, changed } = await scanUsage(sessionsRoot(config), usageCache, Date.now());
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
  const now = Date.now();
  const [records, bundle, reset] = await Promise.all([
    refreshUsage(config, url.searchParams.get("force") === "1"),
    getPricingBundle(config),
    readResetFloors(now)
  ]);
  const window = (period) => Math.max(periodStart(now, period), reset.floors[period] ?? 0);
  // 算钱用整条时间线（每条消息按自己发生的时刻选价表），摊到界面上的单价用当前
  // 生效的那张。两者必须是同一次读出来的，否则「表里的单价」和「算出来的钱」会
  // 对不上号。
  const priced = { ...bundle.current, timeline: bundle.timeline };
  const payload = {
    ok: true,
    scannedAt: usageScanAt,
    pricing: bundle.current,
    pricingStatus: bundle.status,
    daily: { key: reset.current.day, ...aggregate(records, priced, { from: window("day") }) },
    weekly: { key: reset.current.week, ...aggregate(records, priced, { from: window("week") }) },
    monthly: { key: reset.current.month, ...aggregate(records, priced, { from: window("month") }) }
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
  const [result, bundle] = await Promise.all([
    query(ctx, config.baseURL),
    getPricingBundle(config)
  ]);
  // 余额查询失败（比如没配 key）也不该连带把花费预估一起挡掉，两者算的是
  // 完全不同的事，所以 pricing 始终随响应带回。
  const payload = { ...result, pricing: bundle.current };
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function handlePricing(ctx, config, req, res) {
  if (!checkRequest(ctx, req, res)) return;
  const bundle = await getPricingBundle(config);
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: true, pricing: bundle.current, status: bundle.status }));
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
  refreshUsage(config, true);
}
