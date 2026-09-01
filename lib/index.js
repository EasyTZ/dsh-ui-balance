import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";

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

async function query(ctx, baseURL) {
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
    res = await fetch(`${baseURL.replace(/\/+$/u, "")}/user/balance`, {
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
  return { ok: true, value: await res.json() };
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
}
