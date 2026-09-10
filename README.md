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

**侧边栏那一行.** 装完就在侧边栏里，一行两段：`余额：xx 元` 和 `花费：xx 元/日`——后者是**今天到现在**为止的花费，会随着消息生成实时跳动。最右侧一个绿色「谷」或蓝色「峰」，一眼看清当前是哪个计费时段。

**点开它.** 点侧边栏那一行，弹出费用详情面板，从上到下是：

| 区块 | 看什么 |
|---|---|
| API 供应商 | 当前接入的是谁（DeepSeek / 智谱 GLM / Kimi …） |
| 余额 | DeepSeek、Moonshot(Kimi) 直接查；其他厂商显示「无法查询余额」 |
| 用量汇总 | 按模型列出输入未命中 / 缓存命中 / 输出 token 与缓存命中率，右上角切「日 / 周 / 月」 |
| 费用汇总 | 同样按模型分行，列跟用量表逐列对齐但格子里是钱（第五列换成这一行的合计），最后一行总计；跟着上面那个周期选择器走 |
| 目前单价 | 所有已配置模型的价格，统一按每百万 token；峰谷折算后的实际单价，以及这份价是什么时候同步到的 |

**数字是从哪来的.** 日 / 周 / 月三份数字都由插件的 host 半直接读 dsh 自己的会话事件日志（`$DSH_HOME/sessions/**/session.jsonl.zstd`）现算：每条 assistant 消息都带着 provider 报回来的精确 token 用量，以及**这条消息真正用的那个模型**。所以它统计的是「这台机器上真的发生过的每一次调用」——不管那个会话属于哪个工作区、有没有被你滚动到、是不是在这次启动之前跑的。

**什么时候更新.** 侧边栏那一行是实时的：正在生成的那条消息按字符数估一个输出 token 数叠进今天的数字，所以长回复生成期间它也在动。面板里的两张表是**结算口径**——回合一结束（约一秒后，日志落盘之后）刷新成 provider 报回来的精确值，不掺估算（估算只有输出、没有输入与缓存，混进去会让按类别分的那几列失真）。另外每 20 秒兜底刷一次，别的窗口 / 后台会话产生的花费也算得进来。

**官方调价怎么处理.** 单价从官方定价页自动同步（启动抓一次，之后每半天）。每次同步到**不一样**的价表，插件就在一条「价格时间线」上记一条，连同第一次看到它的时刻；汇总时**每条消息按它发生时生效的那张价表**计价——所以调价不会把调价之前的历史金额改写一遍。跨越调价的那个周期会在费用汇总下面标一句。

「第一次看到」不等于「开始生效」：官方可能提前挂价，也可能我们隔十几个小时才抓到。想跟账单严丝合缝就把插件的 `pricingEffectiveFrom` 填成公告里的生效时刻（如 `2026-09-10T00:00:00+08:00`）；它只校准最新那一次调价，下次调价记得改或清空。

峰谷两套价是**分别**读的，不再假设「峰价 = 空闲价 × 2」：不同模型、不同 token 类别都可能打不同的折。官方哪天取消峰谷，峰/谷角标和那句「已按高峰时段折算」会自己消失。

**模型改名与「按别的模型计费」.** 官方偶尔会让一个模型名的请求实际按**另一个模型**的价收钱。2026-09 就一次给了两条：旧模型名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 已下线、请求按 Flash 价计费；`deepseek-v4-pro` 在北京时间 2026-09-14 12:00 之后路由到 V4.1 Flash、也按 Flash 价计费。这两种都不建模就一定算错钱，而且是两个方向的错——旧模型名在新版价表里根本没有对应的行（那批用量会变成「未配置单价」、金额算 0），而 `deepseek-v4-pro` 在表里仍挂着 Pro 的价（照它算要多算两倍多）。

这类规则同样**从定价页脚注读、不写死在代码里**，跟价表一起进时间线，并按每条消息自己的时刻套：9/14 12:00 之前的 pro 调用仍按 Pro 价算，之后才换成 Flash 价。所以官方哪天上线 V4.1 Pro、把那条脚注撤掉，下一次同步之后 pro 自动回到按价表算，而**那之前的历史仍按当时页面上写的规则算**——不用等插件发新版。单价表里被路由的那一行会标一个 `↦ deepseek-flash`，下面把定价页的原话摆出来；还没到生效时刻的那条会提前预告一句。读不出来的（比如生效时刻写得含糊）**一律不套用**，把原句标红交给你核对。

**高峰时段怎么判.** 时段规则本身也是从定价页脚注抓的（现在那句话是「高峰时段为北京时间周一至周五 9:00 - 12:00、14:00 - 18:00」），跟价表一起进时间线 —— 官方连时段一起调，历史消息仍按当时的时段判。判定按北京时间（UTC+8 固定偏移），跟你机器的时区无关，精确到分钟。面板的单价那一节会把当前生效的时段原样写出来。

想自己定就配 `peakDays`（如 `1-5`）和 `peakWindows`（如 `9:00-12:00,14:00-18:00`，填 `none` 表示没有高峰时段）；配了就以配的为准，界面上会标成「手工配置」。注意这两项是**全时间线生效**的，改了会重算全部历史金额。

**法定节假日.** 默认**照官方那句话的字面算**：它只说周一至周五、一个字没提节假日，所以国庆、春节落在周一至周五 9-12 / 14-18 就按高峰翻倍，反过来调休上班的周六按空闲算。插件不替官方发明规则。

官方哪天在脚注里补一句「法定节假日除外 / 按空闲时段计价」，插件**自己就跟上了** —— 解析器认得这几种写法，认出来就切口径，并自动去取当年的放假安排（含调休上班日，数据源是国务院文件的机器可读镜像，`papers` 里附着原文链接）。不用等插件发新版，也不用谁去手填日期。那份日历**只在真的需要时才联网**：默认口径下一次请求都不会发。

如果你核对过账单、发现口径跟页面字面不一样，`peakHolidays` 一个词就能定：`auto`（默认，跟着页面走）/ `offpeak` / `peak`。`offPeakDates`、`peakDates` 留给日历盖不到的情况（公司自己的休息日、日历源拉不到时手工兜一下），不是常规用法。

**读不懂就喊.** 插件只认识「周几 + 时间窗 + 节假日」这三样。官方以后要是加了别的计费规则（阶梯价、封顶、换时区……），面板会把那句原文摆出来并标明「插件没读懂，请核对」——**不会装作规则没变**。同理，放假安排取不到时也会明说「节假日暂按高峰计」，因为那等于又换回了另一套金额。

同步失败不会静默：单价那一节会写着这份价是什么时候同步到的；连不上或者页面结构变了解析不出来时，会明确告诉你已经多久没同步、原因是什么、现在用的是哪一天的价——**而且继续用手上最后那份真实价**，不会偷偷换成插件内置的默认价。

**周期怎么算.** 本日 = 当天 00:00–23:59:59，本周 = 周一到周日，本月 = 1 日到月末，都自动跨期。多个会话并行时，所有进行中的会话都计入。用量汇总和费用汇总同源——同一个周期、同一批消息、同一个排序，两张表第 n 行说的是同一个模型。

**重置.** 标题栏右上角的「重置」清零**当前选中的那个周期**（清哪个周期会写在二次确认里）。因为数字是每次从日志现算的，清零记的是一个「从这一刻起算」的下限而不是删掉数字：跨天 / 跨周 / 跨月后自动失效，日 / 周 / 月互不影响。清完立刻落盘，重开应用不会长回来。

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
- DeepSeek 官方模型价格会自动从官方定价页同步（启动抓一次，之后每半天）。同步不上时会继续用最后那份真实价并在界面上标明，只有**从来没成功同步过**才用插件内置的默认价；其他供应商价格仍来自本地配置，建议偶尔核对。
- 价格时间线只从**装上这个插件之后**才开始记。比第一条记录更早的调用只能按手上最老的那张价表折算——插件装上之前的历史，谁也没记下当时的价。
- 费用是**按当前单价折算出来的估算**，不是账单。它统计的是这台机器上会话日志里的调用；换机器、或者用别的客户端（网页版、CLI）产生的花费不在其中。
- 会话攒得多时，第一次启动要把全部日志扫一遍（两百个会话大约十几秒，在后台跑，不挡界面）；之后按文件尺寸增量，正常一次刷新只有目录枚举。
- 日志默认在 `$DSH_HOME/sessions`（`DSH_HOME` 环境变量会被自动跟随）。如果你在自己的 patch 里给 `dsh-session-persistence-jsonl` 换了 `root`，四格费用会全是 0 —— 把插件的 `sessionsRoot` 配成同一个路径即可。

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

- **Sidebar row.** Two segments: `Balance: xx` and `Spend: xx/day` — the latter is what today has cost so far, and it ticks up live while a reply is streaming. Plus a green "off-peak" / blue "peak" marker for the current pricing window.
- **Click the row** to open the detail panel: provider, balance, a per-model usage summary you can switch between day / week / month, a per-model cost summary (same columns as the usage table but filled with money, the fifth column being that row's total, plus a grand-total row) driven by the same period selector, and the current price table for every configured model, normalised to per-million tokens.
- **Where the numbers come from.** All three figures are computed by the plugin's host half straight from dsh's own session event log (`$DSH_HOME/sessions/**/session.jsonl.zstd`). Every assistant message there carries the provider-reported token usage and the model that actually produced it, so the totals cover every call this machine really made — regardless of which workspace the session belongs to, whether you scrolled to it, or whether it happened before this app launch.
- **When they update.** The sidebar row is live: the in-flight message is estimated from its character count and folded into today's figure, so it moves while a long reply streams. The panel's tables are the settled view — they refresh about a second after a turn ends, once the event has hit the log, with the provider's exact numbers and no estimate mixed in, so the per-column amounts always add up to the row total. A 20-second poll backs that up, so spend from other windows and background sessions lands too.
- **Official price changes.** Prices sync from the official pricing page (once at startup, then every 12 hours). Every time a *different* table comes back, the plugin appends it to a price timeline along with the moment it first saw it; each message is then priced with the table in effect **when that message happened**, so a price change never rewrites the spend that came before it. A period that straddles a change says so under the cost table. Since "first seen" is not "took effect", set the plugin's `pricingEffectiveFrom` (e.g. `2026-09-10T00:00:00+08:00`) to align with the official announcement; it calibrates only the most recent change. Peak and off-peak prices are read as two independent tables rather than assuming peak = 2× off-peak, and if DeepSeek ever drops peak pricing the peak/off-peak badge disappears on its own.
- **Model renames and "billed as another model".** DeepSeek occasionally makes requests for one model name bill at *another* model's price — in September 2026 it did so twice: the retired names `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` bill at the Flash rate, and from 2026-09-14 12:00 Beijing time `deepseek-v4-pro` routes to V4.1 Flash and bills at the Flash rate too. Both go wrong in opposite directions if left unmodelled: the retired names have no row at all in the new table (their usage would show tokens but zero cost), while `deepseek-v4-pro` still lists the Pro price (billing it that way overcharges by more than 2×). These rules are parsed from the page footnote rather than hard-coded, travel on the timeline with the prices, and are applied per message: a pro call before the cutoff still costs the Pro rate. If DeepSeek later ships V4.1 Pro and drops that footnote, pro goes back to its table price on the next sync while older history keeps the rule that was published at the time. Routed rows are marked `↦ deepseek-flash` in the price table with the page's own sentence printed underneath, a rule that has not taken effect yet is announced in advance, and a rule the plugin cannot read is never applied — the sentence is flagged for you to check.
- **Peak hours** are parsed from the same page footnote (currently "北京时间周一至周五 9:00 - 12:00、14:00 - 18:00") and travel on the timeline with the prices, so a change to the hours does not re-judge older messages. Judged in Beijing time (a fixed UTC+8 offset, independent of your machine's zone) to the minute, and the panel prints the window in effect. Override with `peakDays` (e.g. `1-5`) and `peakWindows` (e.g. `9:00-12:00,14:00-18:00`, or `none` for no peak hours) — an override applies to the whole timeline, so it re-prices all history.
- **Statutory holidays** follow the official sentence literally, which names only Mon–Fri: National Day or Spring Festival falling on a weekday inside 9–12 / 14–18 is billed at the peak rate, and a make-up workday on a Saturday is off-peak. The plugin does not invent a rule DeepSeek has not published. If DeepSeek ever adds "法定节假日除外" to that footnote, the plugin picks it up on its own — it recognises the phrasing, switches the rule, and fetches that year's holiday calendar (including make-up workdays; the data is a machine-readable mirror of the State Council notice, with the source document linked in `papers`). No plugin release, no dates to type. That calendar is only fetched when it is actually needed: under the default rule no request is made at all. Override with `peakHolidays`: `auto` (default, follow the page) / `offpeak` / `peak`; `offPeakDates` and `peakDates` remain for what the calendar cannot cover.
- **When it cannot read the rule, it says so.** The plugin models weekdays, time windows and holidays — nothing else. If the footnote ever states another billing rule (tiered pricing, a cap, a different time zone), the panel prints that sentence verbatim and flags that it was not understood, rather than pretending the rule is unchanged. Likewise, if the holiday calendar cannot be fetched it says holidays are being counted as peak for now.
- **Sync failures are visible.** The price section says when the table was last synced; if the page is unreachable or its structure changed, it says how long it has been failing and why — and keeps using the last real table it has rather than silently swapping in the plugin's built-in defaults.
- **Periods** roll over automatically (day at midnight, week on Monday, month on the 1st). Parallel sessions all count toward the same totals, and the usage and cost tables are computed from the same data with the same ordering, so row *n* is the same model in both.
- **Reset** (top right) clears *the currently selected period* — costs and usage together, with a confirmation step naming the period. Since the figures are recomputed from the log each time, a reset records a "count from here" floor rather than deleting rows; it expires on the next day/week/month boundary. Day/week/month are independent, and the reset is persisted immediately.

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
- DeepSeek official model prices are auto-synced from the official pricing page (once at startup, then every 12 hours). On failure the last real table keeps being used and the panel says so; the bundled defaults only apply if a sync has *never* succeeded. Other vendors' prices still come from local configuration — worth checking now and then.
- The price timeline only starts when this plugin is installed. Calls older than its first entry are priced with the oldest table on hand — nobody recorded what the price was before that.
- Costs are an estimate derived from those prices, not a bill. They cover calls recorded in this machine's session logs; spend from another machine or another client (web, CLI) is not included.
- With many stored sessions the first launch scans every log once (roughly a dozen seconds for two hundred sessions, in the background). After that it is incremental by file size, so a normal refresh is just a directory walk.
- Logs live in `$DSH_HOME/sessions` by default (the `DSH_HOME` env var is followed automatically). If your own patch points `dsh-session-persistence-jsonl` at a different `root`, all four cost figures will read 0 — set the plugin's `sessionsRoot` to the same path.
- Pure web UI plus HTTP routes, so it should work everywhere; mainly verified on the Windows desktop build.

</details>

## 许可证 / License

[MIT](LICENSE)
