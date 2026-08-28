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

export const name = "dsh-ui-balance";

export const inject = ["webServer"];

/**
 * `baseURL` 必须可配：dsh 自己的 DeepSeek provider 就把它放在 Config 里
 * （`dsh-llm-deepseek` 的 `baseURL: z.string()`），设置页有对应输入框。写死
 * 意味着用户把 dsh 指向兼容代理之后，余额面板不但查错了 host，还会把他填在
 * `DEEPSEEK_API_KEY` 里的**别家 key** 发到 api.deepseek.com 去。
 */
export const Config = z.object({
  baseURL: z.string().default("https://api.deepseek.com")
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

async function handle(ctx, config, req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: { code: "method-not-allowed", message: "GET only" } }));
    return;
  }
  // port 在请求时动态取：webServer 是 [Service.init] 时才绑定端口，
  // apply 执行时读到的还是 null。
  const port = ctx.webServer.port;
  if (port != null && !originAllowed(req, port)) {
    res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: { code: "forbidden-origin", message: "跨源请求被拒绝" } }));
    return;
  }
  const result = await query(ctx, config.baseURL);
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(result));
}

export function apply(ctx, config) {
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: ROUTE,
    handler: (req, res) => handle(ctx, config, req, res)
  }), `balance: ${ROUTE}`);
}
