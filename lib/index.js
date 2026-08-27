import { Service } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";

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
 * DeepSeek 账户余额查询服务（host 半）。
 * 注册一个 /api/balance HTTP 路由，浏览器半 fetch 该端点获取余额。
 * 走 webServer 路由而非 Typert Remote，避免依赖编译生成的 remote descriptor。
 */
class BalanceService extends Service {
  static inject = ["webServer"];

  constructor(ctx) {
    super(ctx, "balance");
    this.ctx.effect(() => this.ctx.webServer.register({
      kind: "exact",
      path: "/api/balance",
      handler: (req, res) => this.handle(req, res)
    }), "balance: web route");
  }

  async handle(req, res) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: { code: "method-not-allowed", message: "GET only" } }));
      return;
    }
    // port 在请求时动态取：webServer 是 [Service.init] 时才绑定端口，
    // constructor 阶段读到的还是 null。
    const port = this.ctx.webServer.port;
    if (port != null && !originAllowed(req, port)) {
      res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: { code: "forbidden-origin", message: "跨源请求被拒绝" } }));
      return;
    }
    const result = await this.query();
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(result));
  }

  async query() {
    const credentials = this.ctx.get("credentials");
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
      res = await fetch("https://api.deepseek.com/user/balance", {
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
}

export default BalanceService;
