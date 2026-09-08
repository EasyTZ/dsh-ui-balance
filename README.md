<h1 align="center">dsh-ui-balance</h1>
<p align="center"><b>把账户余额、token 用量和真实花费放回会话旁边。</b></p>
<p align="center">余额查询 · 实时估算 · 模型拆分 · 日/周/月汇总 · 峰谷单价</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@easytz/dsh-ui-balance"><img alt="npm" src="https://img.shields.io/npm/v/@easytz/dsh-ui-balance?style=flat-square&color=4d6bfe"></a>
  <img alt="dsh plugin" src="https://img.shields.io/badge/dsh-plugin-17223b?style=flat-square">
  <img alt="providers" src="https://img.shields.io/badge/providers-DeepSeek%20%7C%20Kimi-2f855a?style=flat-square">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-8b5cf6?style=flat-square">
</p>
<p align="center"><img src="docs/panel.png" alt="余额与花费：用量、费用汇总与实时单价" width="560"></p>

> Balance and cost panel for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): live spend, per-model usage and current pricing beside the conversation.

<details open>
<summary><b>中文</b></summary>

## 前置要求

- dsh `>= 0.1.1-rc.2`
- 已配置 `DEEPSEEK_API_KEY` 凭据
- `pnpm` 可用（`dsh plugin` 底层转发给 pnpm）

## 安装

最省事的办法是用[插件市场](https://github.com/EasyTZ/dsh-market)：打开「发现」，搜 `balance`，点「安装」。

命令行：

```sh
dsh plugin --profile <name> add @easytz/dsh-ui-balance
```

`<name>` 是**必填**的 profile 名，不能省略——桌面版通常是 `web`，TUI 是 `tui`；不确定就看 `$DSH_HOME/profiles/` 下的目录名。想钉死版本就写 `@easytz/dsh-ui-balance@0.6.7`。

装完重启 dsh 即可使用。

## 用法

**侧边栏那一行.** 装完就在侧边栏里，显示账户余额和「本次打开」的花费；最右侧一个绿色「谷」或蓝色「峰」，一眼看清当前是哪个计费时段。

**点开它.** 点侧边栏那一行，弹出费用详情面板，从上到下是：

| 区块 | 看什么 |
|---|---|
| API 供应商 | 当前接入的是谁（DeepSeek / 智谱 GLM / Kimi …） |
| 余额 | DeepSeek、Moonshot(Kimi) 直接查；其他厂商显示「无法查询余额」 |
| 本次打开用量 | 按模型列出输入未命中 / 缓存命中 / 输出 token 与缓存命中率 |
| 用量汇总 | 同样的列，右上角切「日 / 周 / 月」 |
| 费用汇总 | 本次打开（含进行中消息的实时估算）、本日、本周、本月 |
| 目前单价 | 所有已配置模型的价格，统一按每百万 token；峰谷折算后的实际单价 |

**数字是从哪来的.** 日 / 周 / 月 / 本次打开四个数字都由插件的 host 半直接读 dsh 自己的会话事件日志（`$DSH_HOME/sessions/**/session.jsonl.zstd`）现算：每条 assistant 消息都带着 provider 报回来的精确 token 用量，以及**这条消息真正用的那个模型**。所以它统计的是「这台机器上真的发生过的每一次调用」——不管那个会话属于哪个工作区、有没有被你滚动到、是不是在这次启动之前跑的。

**周期怎么算.** 本日 = 当天 00:00–23:59:59，本周 = 周一到周日，本月 = 1 日到月末，都自动跨期。多个会话并行时，所有进行中的会话都计入。用量汇总和费用汇总同源——同一个周期、同一批消息，两张表对得上。

**重置.** 标题栏右上角的「重置」清零「本次打开」**加上当前选中的那个周期**（清哪个周期会写在二次确认里）。因为数字是每次从日志现算的，清零记的是一个「从这一刻起算」的下限而不是删掉数字：跨天 / 跨周 / 跨月后自动失效，日 / 周 / 月互不影响。清完立刻落盘，重开应用不会长回来。

## 供应商兼容性

| 供应商 | 余额查询 | 费用统计 | 价格表 |
|---|---|---|---|
| DeepSeek | 支持 | 支持 | 支持 |
| Moonshot / Kimi | 支持 | 支持 | 支持 |
| OpenAI / Claude / Grok / Gemini | 显示「无法查询余额」 | 支持 | 支持（需配置模型单价） |

## 卸载

```sh
dsh plugin --profile <name> remove @easytz/dsh-ui-balance
```

`<name>` 与安装时一致。重启 dsh 后侧边栏那一行消失。

## 已知限制

- 余额查询仅 DeepSeek 和 Moonshot/Kimi 有公开接口；其他厂商需要官方提供余额接口后再适配。
- DeepSeek 官方模型价格会自动从官方定价页同步（启动时抓一次，之后每半天更新，失败时回退本地默认价）；其他供应商价格仍来自本地配置，建议偶尔核对。
- 费用是**按当前单价折算出来的估算**，不是账单。它统计的是这台机器上会话日志里的调用；换机器、或者用别的客户端（网页版、CLI）产生的花费不在其中。
- 会话攒得多时，第一次启动要把全部日志扫一遍（两百个会话大约十几秒，在后台跑，不挡界面）；之后按文件尺寸增量，正常一次刷新只有目录枚举。

## 平台支持

纯 web UI + HTTP 路由，理论上全平台可用；目前主要在 Windows 桌面发行版上验证。

</details>

<details>
<summary><b>English</b></summary>

A third-party plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) that puts your **API balance and spending** in the sidebar, so you never have to open a billing page mid-conversation.

### Requirements

- dsh `>= 0.1.1-rc.2`
- A configured `DEEPSEEK_API_KEY` credential
- `pnpm` available (`dsh plugin` shells out to pnpm)

### Install

Easiest path is the [plugin market](https://github.com/EasyTZ/dsh-market): open **Discover**, search `balance`, hit **Install**.

From the command line:

```sh
dsh plugin --profile <name> add @easytz/dsh-ui-balance
```

`<name>` is **required** — your dsh profile (usually `web` for the desktop/web UI, `tui` for the TUI). Restart dsh afterwards.

### Usage

- **Sidebar row.** Shows your account balance and what this session has cost so far, plus a green "off-peak" / blue "peak" marker for the current pricing window.
- **Click the row** to open the detail panel: provider, balance, per-model token usage for this session, a usage summary you can switch between day / week / month, a cost summary (this session — including a live estimate for in-flight messages — plus today, this week, this month), and the current price table for every configured model, normalised to per-million tokens.
- **Where the numbers come from.** All four figures are computed by the plugin's host half straight from dsh's own session event log (`$DSH_HOME/sessions/**/session.jsonl.zstd`). Every assistant message there carries the provider-reported token usage and the model that actually produced it, so the totals cover every call this machine really made — regardless of which workspace the session belongs to, whether you scrolled to it, or whether it happened before this app launch.
- **Periods** roll over automatically (day at midnight, week on Monday, month on the 1st). Parallel sessions all count toward the same totals, and the usage and cost tables are computed from the same data, so they always agree.
- **Reset** (top right) clears "this session" *plus the currently selected period* — costs and usage together, with a confirmation step naming the period. Since the figures are recomputed from the log each time, a reset records a "count from here" floor rather than deleting rows; it expires on the next day/week/month boundary. Day/week/month are independent, and the reset is persisted immediately.

### Provider support

| Provider | Balance lookup | Cost tracking | Price table |
|---|---|---|---|
| DeepSeek | yes | yes | yes |
| Moonshot / Kimi | yes | yes | yes |
| OpenAI / Claude / Grok / Gemini | "unavailable" | yes | yes (configure prices) |

### Uninstall

```sh
dsh plugin --profile <name> remove @easytz/dsh-ui-balance
```

### Limitations

- Only DeepSeek and Moonshot/Kimi expose a public balance endpoint; other vendors need one before support can be added.
- DeepSeek official model prices are auto-synced from the official pricing page (once at startup, then every half-day, falling back to bundled defaults on failure). Other vendors' prices still come from local configuration — worth checking now and then.
- Costs are an estimate derived from those prices, not a bill. They cover calls recorded in this machine's session logs; spend from another machine or another client (web, CLI) is not included.
- With many stored sessions the first launch scans every log once (roughly a dozen seconds for two hundred sessions, in the background). After that it is incremental by file size, so a normal refresh is just a directory walk.
- Pure web UI plus HTTP routes, so it should work everywhere; mainly verified on the Windows desktop build.

</details>

## 许可证 / License

[MIT](LICENSE)
