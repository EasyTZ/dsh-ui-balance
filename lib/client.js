window.__ModuleLoader__.load({
	id: "@easytz/dsh-ui-balance",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");

		const NS = "balance";

		// dsh 0.1.2 的外部 store 方法会通过 `this` 访问内部快照。React 会把传入
		// useSyncExternalStore 的函数脱离对象调用，所以统一包一层保留接收者。
		function useStore(source) {
			const subscribe = react.useCallback((listener) => source.subscribe(listener), [source]);
			const getSnapshot = react.useCallback(() => source.getSnapshot(), [source]);
			return react.useSyncExternalStore(subscribe, getSnapshot);
		}

		// dsh 0.1.2 把会话聊天数据从 `useSession()` 挪到了 `useChat()` 的
		// ChatSnapshot 里，同时为了过渡保留了 `legacy.partial`、`legacy.turnTimings`。
		// 读这两样的路径都先归一化，兼容 0.1.1 与 0.1.2 两种结构。
		function chatPartialOf(snapshot) {
			if (!snapshot) return null;
			return snapshot.partial ?? snapshot.legacy?.partial ?? null;
		}

		function chatTurnTimingsOf(snapshot) {
			if (!snapshot) return null;
			return snapshot.turnTimings ?? snapshot.legacy?.turnTimings ?? null;
		}

		function ensureModelDirectoryLoaded(directory, directoryState) {
			if (!directory || typeof directory.load !== "function") return;
			const state = directoryState ?? {};
			if (state.current) return;
			if (state.status === "loading" || state.status === "error") return;
			try {
				directory.load().catch(() => {});
			} catch {
				// 模型目录加载失败不影响消息显示；后续 composer 加载成功后仍会补记。
			}
		}



		const zh = {
			"balance.label": "余额",
			"balance.loading": "余额加载中…",
			"balance.error": "余额查询失败",
			"balance.unavailable": "账户不可用",
			"balance.panel.title": "费用详情",
			"balance.panel.close": "关闭",
			"balance.provider.title": "API 供应商",
			"balance.unsupported": "无法查询余额",
			"balance.usage.table.input": "输入未命中",
			"balance.usage.table.hit": "缓存命中",
			"balance.usage.table.output": "输出",
			"balance.usage.table.hit_rate": "缓存命中率",
			"balance.usage.summary.title": "用量汇总",
			"balance.usage.summary.empty": "该统计周期还没有产生用量",
			"balance.usage.period.day": "日",
			"balance.usage.period.week": "周",
			"balance.usage.period.month": "月",
			"balance.reset.button": "重置",
			"balance.reset.confirm": "清零「{period}」的费用与用量？不可撤销。",
			"balance.reset.yes": "确认重置",
			"balance.reset.no": "取消",
			"balance.cost.unpriced": "另有 {model} 的用量未配置单价，未计入",
			"balance.cost.live_unpriced": "进行中消息的模型未配置单价，侧边栏那一行暂按 0 计，回合结束后按日志校正",
			"balance.cost.summary.title": "费用汇总（{period}）",
			"balance.cost.summary.empty": "该统计周期还没有产生费用",
			"balance.cost.table.total": "合计",
			"balance.cost.table.all": "总计",
			"balance.cost.price_change": "本周期跨越了 {count} 张价表，每条消息都按它发生时的单价计算",
			"balance.daily.title": "本日费用",
			// 侧边栏那一行的两段文字。「/日」是量纲，不是分隔符——这一行显示的是
			// 今天到现在为止的花费，不写单位的话很容易被当成账户累计消费。
			"balance.side.balance": "余额：{value}",
			"balance.side.cost": "花费：{value}/日",
			"balance.price.title": "目前单价",
			"balance.price.table.model": "模型",
			"balance.price.table.hit": "输入命中",
			"balance.price.table.miss": "输入未命中",
			"balance.price.table.output": "输出（每百万 token）",
			"balance.price.period_note": "DeepSeek 已按{period}折算",
			// 单价的同步状态。同步失败是安静的（继续用旧价），所以这几句必须真的摊在
			// 界面上——用户看着一个不知道多旧的价算钱，比看到一行警告危险得多。
			"balance.price.synced": "单价同步于 {when}",
			"balance.price.stale": "单价已 {age}没能同步（{reason}），现在用的是 {when} 那份",
			"balance.price.never": "没能同步到官方单价，正在使用插件内置的默认价",
			"balance.price.error.network": "定价页打不开",
			"balance.price.error.parse": "定价页结构变了，解析不出来",
			"balance.price.error.http": "定价页返回 {code}",
			"balance.price.effective": "自 {when} 起生效",
			// 高峰时段的具体规则。必须写出来：同一笔用量按峰还是按谷，差一倍钱，
			// 而用户从数字上看不出插件按的是哪套规则（尤其是自己改过配置之后）。
			"balance.price.window": "高峰时段：{days} {windows}（北京时间）",
			"balance.price.window_none": "当前规则里没有高峰时段，一律按空闲价",
			"balance.price.window_config": "手工配置",
			"balance.price.window_default": "内置默认",
			"balance.price.window_dates": "另有 {offPeak} 天整天按空闲、{peak} 天按工作日",
			// 节假日口径。这是用户一定会问、而数字上完全看不出来的一件事，必须写在脸上。
			"balance.price.holiday_peak": "法定节假日按高峰",
			"balance.price.holiday_offpeak": "法定节假日按空闲",
			"balance.price.holiday_calendar": "依据 {years} 年放假安排",
			"balance.price.holiday_calendar_failed": "放假安排取不到（{reason}），节假日暂按高峰计",
			// 读不懂就喊一声：官方以后加了新规则（阶梯价、封顶、换时区……），
			// 插件一定读不懂，那时宁可让人看见一句读不懂的话，也不能装作规则没变。
			"balance.price.unmodelled": "定价页这句话里有插件没读懂的计费规则，请核对：{note}",
			"balance.price.days_range": "{from}至{to}",
			"balance.price.days_all": "每天",
			"balance.price.weekday.1": "周一",
			"balance.price.weekday.2": "周二",
			"balance.price.weekday.3": "周三",
			"balance.price.weekday.4": "周四",
			"balance.price.weekday.5": "周五",
			"balance.price.weekday.6": "周六",
			"balance.price.weekday.7": "周日",
			"balance.price.pending": "已抓到一份 {when} 起生效的新价，还没开始套用",
			"balance.price.routed": "按 {target} 计费",
			"balance.price.route_note": "{models} 的请求按 {target} 的单价计算（定价页原文：{note}）",
			"balance.price.route_pending": "自 {when} 起，{model} 的请求改按 {target} 计费（定价页原文：{note}）",
			"balance.price.route_unparsed": "定价页这句像是「按别的模型计费」的规则，插件没读懂、暂未套用，请核对：{note}",
			"balance.age.hours": "{n} 小时",
			"balance.age.days": "{n} 天",
			"balance.price.other_note": "价格",
			"balance.price.peak": "高峰时段",
			"balance.price.offpeak": "空闲时段",
			"balance.price.peak_badge": "峰",
			"balance.price.offpeak_badge": "谷",
			"balance.model.unknown": "未知模型"
		};
		const en = {
			"balance.label": "Balance",
			"balance.loading": "Loading balance…",
			"balance.error": "Failed to load balance",
			"balance.unavailable": "Account unavailable",
			"balance.panel.title": "Cost details",
			"balance.panel.close": "Close",
			"balance.provider.title": "API provider",
			"balance.unsupported": "Cannot query balance",
			"balance.usage.table.input": "Input miss",
			"balance.usage.table.hit": "Cache hit",
			"balance.usage.table.output": "Output",
			"balance.usage.table.hit_rate": "Hit rate",
			"balance.usage.summary.title": "Usage summary",
			"balance.usage.summary.empty": "No usage in this period yet",
			"balance.usage.period.day": "Day",
			"balance.usage.period.week": "Week",
			"balance.usage.period.month": "Month",
			"balance.reset.button": "Reset",
			"balance.reset.confirm": "Clear cost and usage for {period}? This cannot be undone.",
			"balance.reset.yes": "Confirm reset",
			"balance.reset.no": "Cancel",
			"balance.cost.unpriced": "{model} usage has no configured price, excluded",
			"balance.cost.live_unpriced": "The in-flight model has no configured price; the sidebar counts it as 0 until the turn ends",
			"balance.cost.summary.title": "Cost summary ({period})",
			"balance.cost.summary.empty": "No cost in this period yet",
			"balance.cost.table.total": "Total",
			"balance.cost.table.all": "All models",
			"balance.cost.price_change": "This period spans {count} price tables; each message is priced at the rate in effect when it happened",
			"balance.daily.title": "Today's cost",
			"balance.side.balance": "Balance: {value}",
			"balance.side.cost": "Spend: {value}/day",
			"balance.price.title": "Current price",
			"balance.price.table.model": "Model",
			"balance.price.table.hit": "Input hit",
			"balance.price.table.miss": "Input miss",
			"balance.price.table.output": "Output (per million tokens)",
			"balance.price.period_note": "DeepSeek price ({period} rate)",
			"balance.price.synced": "Prices synced {when}",
			"balance.price.stale": "Prices have not synced for {age} ({reason}); using the table from {when}",
			"balance.price.never": "Official prices never synced; using the plugin's built-in defaults",
			"balance.price.error.network": "pricing page unreachable",
			"balance.price.error.parse": "pricing page structure changed, cannot parse",
			"balance.price.error.http": "pricing page returned {code}",
			"balance.price.effective": "in effect since {when}",
			"balance.price.window": "Peak hours: {days} {windows} (Beijing time)",
			"balance.price.window_none": "No peak hours in the current rule; everything is billed off-peak",
			"balance.price.window_config": "configured",
			"balance.price.window_default": "built-in default",
			"balance.price.window_dates": "plus {offPeak} day(s) forced off-peak and {peak} day(s) forced peak",
			"balance.price.holiday_peak": "statutory holidays count as peak",
			"balance.price.holiday_offpeak": "statutory holidays count as off-peak",
			"balance.price.holiday_calendar": "per the {years} holiday calendar",
			"balance.price.holiday_calendar_failed": "holiday calendar unavailable ({reason}); holidays counted as peak for now",
			"balance.price.unmodelled": "The pricing page states a rule this plugin did not understand — please check: {note}",
			"balance.price.days_range": "{from}-{to}",
			"balance.price.days_all": "every day",
			"balance.price.weekday.1": "Mon",
			"balance.price.weekday.2": "Tue",
			"balance.price.weekday.3": "Wed",
			"balance.price.weekday.4": "Thu",
			"balance.price.weekday.5": "Fri",
			"balance.price.weekday.6": "Sat",
			"balance.price.weekday.7": "Sun",
			"balance.price.pending": "a new table takes effect {when}, not applied yet",
			"balance.price.routed": "billed as {target}",
			"balance.price.route_note": "{models} requests are priced at the {target} rate (pricing page: {note})",
			"balance.price.route_pending": "from {when}, {model} requests switch to the {target} rate (pricing page: {note})",
			"balance.price.route_unparsed": "The pricing page states what looks like a bill-as-another-model rule this plugin did not understand and has not applied — please check: {note}",
			"balance.age.hours": "{n}h",
			"balance.age.days": "{n}d",
			"balance.price.other_note": "Price",
			"balance.price.peak": "peak-hour",
			"balance.price.offpeak": "off-peak",
			"balance.price.peak_badge": "Peak",
			"balance.price.offpeak_badge": "Off",
			"balance.model.unknown": "Unknown model"
		};

		function fmt(template, vars) {
			return template.replace(/\{(\w+)\}/gu, (_, key) => String(vars[key] ?? ""));
		}

		const css = ""
			// 就是一行字，不要按钮的粗框，但静止/悬浮的反馈要跟 Git/终端/市场那几个
			// footer 按钮（.dstFooterBtn）同一套：静止用 label-secondary（不是更暗的
			// tertiary——之前用 tertiary 反而在这个深色主题下显得比旁边几个图标更
			// 显眼，误导成「一直是高亮/打开状态」），悬浮加背景色块，不是只变文字
			// 颜色——光变文字颜色的反馈太弱，容易让人觉得「没反应、不像能点」。
			// 横向 padding 8px 也是照抄 .dstFooterBtn 的 box model，跟图标左边缘对齐。
			+ ".dsbSideBtn{display:flex;align-items:baseline;gap:12px;position:relative;width:100%;box-sizing:border-box;padding:4px 36px 4px 8px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#cfd3d6);cursor:pointer;font-size:12px;font-family:inherit;text-align:left;overflow:hidden;white-space:nowrap}.dsbSideBtn:hover{background:var(--dsw-alias-interactive-bg-hover)}"
			// 间距用 gap 固定在 12px，**不用 justify-content:space-between**：标签缩成
			// 「花费」之后整行很短，两端对齐会在中间豁开一大片空白，而且那片空白的宽度
			// 随余额位数变化，数字一跳整行就跟着晃。左对齐还能跟上下那几个 footer 项
			// （Git/终端/市场都是图标+文字左对齐）排在同一条竖线上。
			//
			// 两段都要 min-width:0 才会真的省略号截断——flex 子项默认 min-width:auto，
			// 不放开的话它们宁可一起溢出也不肯缩，窄栏里就是两段都被切掉右半边。
			+ ".dsbSideBal,.dsbSideCost{min-width:0;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}"
			// 峰谷角标：侧边栏最后一行里用一个小圆角标签明确当前计价时段。绿色“谷”表示
			// 空闲时段、峰用 DeepSeek 的品牌蓝。用绝对定位钉在右侧，左边余额/花费长度
			// 再怎么变化，这个角标都固定在行最右，不会跳。
			+ ".dsbSidePeak,.dsbSideOffpeak{position:absolute;right:8px;top:50%;transform:translateY(-50%);font-size:10px;line-height:1;padding:2px 5px;border-radius:999px;font-weight:600;white-space:nowrap}"
			+ ".dsbSidePeak{color:var(--dsw-alias-state-business-primary,#4d6bfe);background:rgba(77,107,254,.14)}"
			+ ".dsbSideOffpeak{color:var(--dsw-alias-state-success-primary,#3fb950);background:rgba(63,185,80,.14)}"
			+ ".dsbPriceBadge{display:inline-block;font-size:10px;line-height:1;padding:2px 5px;border-radius:999px;font-weight:600;white-space:nowrap;margin-left:6px}"

			// 折叠态用的图标按钮：box model 照抄 .dstFooterBtn（width:100%+height:32px+
			// padding:0 8px），跟 Git/终端/市场折叠时的图标尺寸对齐，不然这一项
			// 单独大一圈/小一圈，排在同一列里会很显眼。
			+ ".dsbSideIcon{display:flex;align-items:center;justify-content:center;width:100%;height:32px;padding:0 8px;box-sizing:border-box;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#cfd3d6);cursor:pointer}.dsbSideIcon:hover{background:var(--dsw-alias-interactive-bg-hover)}"
			// 侧边栏 footer 的容器在上游是 `display:flex`（默认 row，且不换行），每个
			// footer action 都是 width:100% 的元素 —— 两个以上插件同时注册就被挤成同行，
			// 余额这一项尤其吃亏：它是一整行文字，被压到三分之一宽就只剩省略号。改成
			// 纵向，一个 action 独占一行。
			//
			// **这条规则在四个 footer 插件里各写一份，是有意的重复**：原先只有终端面板
			// 写了它，于是装了终端面板的机器一切正常，只装市场 + 余额的机器上三个图标
			// 挤成一行 —— 一个插件的样式在替别的插件兜底，这是隐性依赖。任何一个插件
			// 都可能被单独安装，所以每个往这个槽里放东西的插件都得自带这条。声明完全
			// 相同，重复注入无副作用。
			//
			// [class*="footerActions"] 与上游 CSS module 的 hash class 弱耦合；本插件
			// 样式运行时注入、晚于 bundle，同特异性下后写的规则生效。折叠态上游另有一条
			// 只设 width:auto/justify-content:center 的规则，不冲突。
			+ '[class*="footerActions"]{flex-direction:column;align-items:stretch}'
			// 关闭态必须 pointer-events:none —— opacity 0 的元素照样拦点击（shell.overlay
			// 的通用规矩，Git/终端两个面板同款写法）。
			//
			// 定位用 right，不能用 left：侧边栏本身就贴在屏幕左边、宽度能到 280px，
			// `left:20px` 会正好落在侧边栏自己的不透明背景底下，面板等于被侧边栏
			// 挡住——看不见也点不到，Git/终端两个面板入口虽然也在左侧栏，但弹出的
			// 面板同样是 right 定位，就是为了绕开这个重叠。
			//
			// max-height 给到 calc(100vh - 40px)：面板贴 bottom:20px，这个上限正好让它
			// 往上顶到离窗口顶部 20px 的位置。内容全展开（用量表 + 三档汇总 + 单价表）
			// 大概要 1000px，卡在 70vh 时正常窗口高度下必出滚动条——面板本身是只读的
			// 一屏信息，能一眼看完就别让人再滚一遍。
			+ ".dsbPanel{position:fixed;right:20px;bottom:20px;z-index:20;width:min(600px,calc(100vw - 40px));max-height:calc(100vh - 40px);display:flex;flex-direction:column;background:var(--dsw-specific-sidebar-fill,#1b1b1c);border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.32);color:var(--dsw-alias-label-primary,#f9fafb);font-size:13px;overflow:hidden;pointer-events:none;opacity:0;transform:translateY(8px);transition:opacity .16s ease,transform .16s ease}"
			+ ".dsbPanel.dsbOpen{opacity:1;pointer-events:auto;transform:translateY(0)}"
			+ ".dsbPanelHeader{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));font-size:14px;font-weight:600}"
			// 关闭按钮：padding:0 + box-sizing:border-box 缺一不可。浏览器给 button 自带
			// `padding:1px 6px`，只写 width/height 的话（默认 content-box）实际盒子是
			// 36×26 而不是 24×24——旁边的重置按钮是钉死的 24px，两个悬浮色块就差出
			// 2px，并排看一眼就能看出来。
			+ ".dsbPanelClose{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;box-sizing:border-box;border:none;border-radius:6px;background:transparent;color:inherit;cursor:pointer}.dsbPanelClose:hover{background:var(--dsw-alias-interactive-bg-hover)}"
			+ ".dsbPanelBody{overflow-y:auto;scrollbar-gutter:stable;scrollbar-width:thin;padding:8px 16px 16px}"
			// 标题保持不动，正文内容统一缩进 16px，视觉上对齐。
			+ ".dsbPanelBody .dsbSection > .dsbRow,.dsbPanelBody .dsbSection > .dsbNote,.dsbPanelBody .dsbSection > .dsbPriceTable,.dsbPanelBody .dsbSection > .dsbPeriodTabs{margin-left:16px}"
			+ ".dsbPanelBody .dsbSection > .dsbPriceTable{width:calc(100% - 16px)}"
			+ ".dsbSection{padding:12px 0;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06))}.dsbSection:first-child{border-top:none}"
			+ ".dsbSectionTitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-tertiary);margin-bottom:8px}"
			+ ".dsbRow{display:flex;align-items:baseline;justify-content:space-between;gap:10px;line-height:22px}"
			+ ".dsbRowLabel{color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"
			+ ".dsbRowValue{color:var(--dsw-alias-label-secondary);font-weight:500;white-space:nowrap;font-size:13px}"
			// 顶部账户行：API 供应商和余额各占 50%，标题在上、值在下，不做两端对齐。
			+ ".dsbPanelBody .dsbSection > .dsbAccountRow{margin-left:0}"
			+ ".dsbAccountRow{display:flex;align-items:flex-start;gap:12px;justify-content:flex-start}"
			+ ".dsbAccountItem{display:flex;flex-direction:column;align-items:flex-start;gap:4px;width:50%;min-width:0}"
			+ ".dsbAccountItem .dsbRowValue{min-width:0;margin-left:16px;overflow:hidden;text-overflow:ellipsis}"
			// 单价表：用真正的 <table> 展示，模型/命中/未命中/输出各一列，表头只出现一次。
			+ ".dsbPriceTable{width:100%;border-collapse:collapse;font-size:11px;line-height:20px}"
			+ ".dsbPriceTable th{color:var(--dsw-alias-label-tertiary);font-weight:600;text-align:center;padding:3px 6px;white-space:nowrap;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}"
			+ ".dsbPriceTable td{padding:3px 6px;vertical-align:top;text-align:center;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.04))}"
			+ ".dsbPriceTable .dsbPriceModel{color:var(--dsw-alias-label-tertiary);white-space:nowrap;text-align:left}"
			+ ".dsbPriceTable .dsbPriceRouted{margin-left:4px;opacity:.65;font-size:10px}"
			+ ".dsbPriceTable .dsbPriceValue{color:var(--dsw-alias-label-secondary);white-space:nowrap}"
			+ ".dsbPriceTable th:first-child{text-align:left}"
			+ ".dsbUsageTable tbody tr:last-child td{border-bottom:none}"
			// 费用表最后那行「总计」：上面加一条分隔线、字提亮，跟按模型分的那几行拉开
			// 层次。不用 tfoot——这张表和上面的用量表是同一套 CSS，多一个 tfoot 就得
			// 再给它写一份 padding/对齐，两张表容易慢慢长歪。
			+ ".dsbUsageTable tbody tr.dsbTotalRow td{border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#f9fafb);font-weight:600}"
			// 用量汇总的日/周/月切换：一个分段控件（segmented control），不是三个独立按钮——
			// 三个周期互斥，同一时刻只有一个成立，分段控件的外框正好把「这是一组单选」画出来。
			// 选中态用面板自己的底色反白（跟未选中的凹槽形成层次），而不是只加粗文字：
			// 深色主题下光靠字重区分，扫一眼看不出当前停在哪个周期。
			+ ".dsbPeriodTabs{display:inline-flex;gap:2px;margin-bottom:8px;padding:2px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}"
			+ ".dsbPeriodTab{border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-family:inherit;font-size:11px;line-height:18px;padding:2px 14px}"
			+ ".dsbPeriodTab:hover{color:var(--dsw-alias-label-secondary)}"
			+ ".dsbPeriodTab.dsbActive{background:var(--dsw-specific-sidebar-fill,#1b1b1c);color:var(--dsw-alias-label-primary,#f9fafb);font-weight:600}"
			// 重置按钮：钉在面板标题栏右侧、关闭按钮左边。它清的是当前选中周期的用量
			// **和**费用，横跨了下面两节内容，所以放在标题栏这个面板级的位置，而不是
			// 塞进某一节里——塞进用量那一节会让人以为只清用量、不清费用。
			//
			// 平时压成一个安静的次要文字按钮，只有悬浮时才转警示红：清零不可撤销，
			// 但它在这个面板里不是主操作，做成一直醒目的实心按钮反而勾着人去点。
			// 没有可清的数字时 disabled，省得点了一下什么都没发生。
			//
			// 高度直接钉成 24px（跟 .dsbPanelClose 一样的 border-box 方盒），不靠
			// line-height + padding 去凑：这两个按钮并排在标题栏里，字号还不一样
			// （11px vs 继承的 14px），谁的行高被字体度量顶高一两像素，两个悬浮色块
			// 就会一高一矮，挨着看特别明显。
			+ ".dsbHeaderActions{display:inline-flex;align-items:center;gap:8px}"
			+ ".dsbResetBtn{display:inline-flex;align-items:center;height:24px;box-sizing:border-box;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-family:inherit;font-size:11px;line-height:1;padding:0 10px;white-space:nowrap}"
			+ ".dsbResetBtn:hover:not(:disabled){color:var(--dsw-alias-state-error-primary,#f85149);border-color:rgba(248,81,73,.32);background:rgba(248,81,73,.10)}"
			+ ".dsbResetBtn:disabled{opacity:.4;cursor:default}"
			// 二次确认条：贴在标题栏下方、面板正文最上面，不弹 confirm()——原生弹窗会
			// 阻塞整个渲染进程（面板里其它实时数字全卡住），而且点空白处关面板那条
			// mousedown 监听也会跟它抢焦点。就地确认还能把「要清掉什么」写在按钮旁边，
			// 误点时一眼看得出来。
			+ ".dsbConfirmBar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:4px 0;padding:6px 10px;border:1px solid rgba(248,81,73,.32);border-radius:8px;background:rgba(248,81,73,.08)}"
			// 确认条一出现，原本的第一个 section 就不再是 :first-child 了，它的分隔线会
			// 突然冒出来——整块内容跟着往下跳 1px。这条把它按回去。
			+ ".dsbConfirmBar+.dsbSection{border-top:none}"
			+ ".dsbConfirmText{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}"
			+ ".dsbConfirmActions{display:inline-flex;gap:6px;flex:0 0 auto}"
			+ ".dsbConfirmYes{border:none;border-radius:6px;background:var(--dsw-alias-state-error-primary,#f85149);color:#fff;cursor:pointer;font-family:inherit;font-size:11px;font-weight:600;line-height:18px;padding:2px 10px;white-space:nowrap}"
			+ ".dsbConfirmYes:hover{filter:brightness(1.08)}"
			+ ".dsbConfirmNo{border:none;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;font-size:11px;line-height:18px;padding:2px 10px;white-space:nowrap}"
			// 警告版的注释行：单价同步不上、跨了调价这类「数字还能看但得知道为什么」的
			// 提示。颜色用主题的 warning，不用 error 红——它不是故障，是一个前提说明。
			+ ".dsbNote.dsbWarn{color:var(--dsw-alias-state-warning-primary,#d29922)}"
			+ ".dsbNote{margin-top:4px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}";
		const tagId = "dsh-ui-balance/balance.css";
		if (typeof document !== "undefined") {
			const selector = "style[data-plugin-css=" + JSON.stringify(tagId) + "]";
			const existing = document.querySelector(selector);
			if (existing !== null) {
				// HMR/热重载会重新执行 client.js；旧 style 标签可能还在，
				// 必须更新 textContent，否则改 CSS 后看起来“样式没生效”。
				existing.textContent = css;
			} else {
				const tag = document.createElement("style");
				tag.dataset.plugin = "dsh-ui-balance";
				tag.dataset.pluginCss = tagId;
				tag.textContent = css;
				document.head.appendChild(tag);
			}
		}

		function formatMoney(currency, amount) {
			const n = Number(amount) || 0;
			const unit = currencyUnit(currency);
			if (n === 0) return `0.00 ${unit}`;
			// 花费金额通常很小（几千 token 也就几分钱），固定两位小数经常显示成
			// 0.00；保留到 4 位小数，再去掉多余的尾随 0，但至少留 2 位。
			let s = n.toFixed(4);
			while (s.endsWith("0") && s.split(".")[1].length > 2) s = s.slice(0, -1);
			return `${s} ${unit}`;
		}

		/**
		 * 单价（每百万 token）的显示格式。**不能直接把乘出来的数摊上界面**：
		 * 基准价乘高峰倍率是浮点乘法，0.7 * 1.3 会算出 0.9099999999999999。
		 * 最多留 4 位小数，再把多余的尾随 0 去掉（2 → "2" 而不是 "2.0000"）。
		 */
		function formatUnitPrice(n) {
			const v = Number(n);
			if (!Number.isFinite(v)) return "—";
			return String(Number(v.toFixed(4)));
		}

		/**
		 * 中文友好的币种单位：CNY → 元，USD → 美元，其他直接显示代码。
		 * 统一放在数字后面，符合中文阅读习惯。
		 */
		function currencyUnit(currency) {
			if (currency === "CNY") return "元";
			if (currency === "USD") return "美元";
			return currency ?? "";
		}


		function formatTokens(n) {
			return Number(n ?? 0).toLocaleString();
		}

		/** 缓存命中率 = 缓存命中 token / (输入未命中 token + 缓存命中 token)。 */
		function formatHitRate(tokens) {
			const miss = Number(tokens?.input ?? 0);
			const hit = Number(tokens?.cacheRead ?? 0);
			const total = miss + hit;
			if (total <= 0) return "—";
			return `${Number((hit / total * 100).toFixed(1))}%`;
		}

		/**
		 * 流式估算用：把文本长度折算成 token 数的启发式。CJK 字符按 1 token，
		 * 其余按 4 字符 1 token。这个数字只用于「进行中」的实时展示，回合结束
		 * 后会被 provider 报上来的精确 usage 替换，所以不需要 tokenizer 级精度。
		 */
		function estimateTextTokens(text) {
			const value = String(text ?? "");
			let cjk = 0;
			let other = 0;
			for (const ch of value) {
				const cp = ch.codePointAt(0);
				if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0xf900 && cp <= 0xfaff)) {
					cjk += 1;
				} else {
					other += 1;
				}
			}
			return cjk + Math.ceil(other / 4);
		}

		function estimatePartialOutputTokens(partial) {
			let tokens = 0;
			for (const block of partial?.blocks ?? []) {
				if (block.kind === "text" || block.kind === "reasoning") tokens += estimateTextTokens(block.text);
				else if (block.kind === "tool-call") tokens += estimateTextTokens((block.name ?? "") + " " + (block.argsRaw ?? ""));
			}
			return tokens;
		}

		/** ModelSelection -> 单价表的键，跟 host 半 `Config.modelPricing` 的键必须逐字一致。 */
		function priceKey(selection) {
			return selection ? `${selection.provider}:${selection.model}` : "unknown";
		}

		/** 是否为 DeepSeek 官方 provider；只有它适用峰谷时段倍率。 */
		function isDeepSeekProvider(provider) {
			return provider === "deepseek-official" || provider === "deepseek";
		}

		/**
		 * 本次是否为 DeepSeek 官方 API。侧边栏是 root 槽，拿不到当前会话的
		 * modelDirectories，只能从单价表里判断：默认/官方模型都会以
		 * `deepseek-official:` 开头。用户接第三方 API 时通常不会保留 DEEPSEEK
		 * 的定价键，因此这个判断足以让“峰/谷”只在 DS 调用场景下出现。
		 */
		function hasDeepSeekPricing(pricing) {
			const pricingMap = pricing?.modelPricing;
			if (!pricingMap) return false;
			return Object.keys(pricingMap).some((key) => isDeepSeekProvider(key.split(":")[0]));
		}

		/**
		 * 这张价表里到底有没有峰谷价。与 host 半 `hasPeakPricing` 同一套判定。
		 *
		 * 官方哪天取消峰谷，解析出来的表里就不会再有 `peak`、倍率也会记成 1——那时
		 * 侧边栏那个「峰/谷」角标和单价表上那句「已按高峰时段折算」都该自己消失，
		 * 而不是继续显示一个已经不存在的计费规则。
		 */
		function hasPeakPricing(pricing) {
			const entries = Object.values(pricing?.modelPricing ?? {});
			if (entries.some((price) => price?.peak !== void 0 && price?.peak !== null)) return true;
			return entries.length > 0 && Number(pricing?.peakMultiplier ?? 1) !== 1;
		}

		/**
		 * 某个模型此刻的三个单价。与 host 半 `ratesOf` 同一套规则：优先用页面上那套
		 * 独立的峰价，只有手工配置这种只给了基准价的条目才退回「基准价 × 倍率」。
		 *
		 * **不能在这里拿基准价乘一个统一倍率就算完**：官方页上峰谷是两张独立的表，
		 * 不同模型、不同 token 类别都可能打不同的折。
		 */
		function effectiveRates(price, peak, multiplier) {
			if (!peak) return price;
			const own = price?.peak;
			if (own && [own.cacheHitPerMillion, own.cacheMissPerMillion, own.outputPerMillion].every((v) => Number.isFinite(v))) return own;
			return {
				cacheHitPerMillion: price.cacheHitPerMillion * multiplier,
				cacheMissPerMillion: price.cacheMissPerMillion * multiplier,
				outputPerMillion: price.outputPerMillion * multiplier
			};
		}

		/** `M/D HH:mm`。不用 toLocaleString：那串在不同语言/时区设置下长短差很多，会把一行注释撑破。 */
		function formatWhen(ms) {
			const d = new Date(Number(ms));
			if (!Number.isFinite(d.getTime())) return "—";
			return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
		}

		/** 「已经多久」：不到一天说小时，否则说天。 */
		function formatAge(t, ms) {
			const hours = Math.max(0, Math.floor(Number(ms) / 3600000));
			if (hours < 24) return fmt(t("balance.age.hours"), { n: hours });
			return fmt(t("balance.age.days"), { n: Math.floor(hours / 24) });
		}

		/** 分钟数 → `9:00`。 */
		function formatClock(minutes) {
			const value = Math.max(0, Math.min(24 * 60, Number(minutes) || 0));
			return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
		}

		/**
		 * 把高峰时段规则写成一句人话：「高峰时段：周一至周五 9:00–12:00、14:00–18:00（北京时间）」。
		 *
		 * 为什么要摊出来：同一笔用量按峰还是按谷，差一倍钱，而用户从数字上完全看不出
		 * 插件按的是哪套规则——尤其是自己改过 `peakDays` / `peakWindows` 之后。
		 */
		function formatPeakWindows(t, schedule) {
			const days = Array.isArray(schedule?.days) ? schedule.days.slice().sort((a, b) => a - b) : [];
			const windows = Array.isArray(schedule?.windows) ? schedule.windows : [];
			if (windows.length === 0 || days.length === 0) return null;
			const name = (day) => t("balance.price.weekday." + day);
			const contiguous = days.length > 1 && days[days.length - 1] - days[0] === days.length - 1;
			const dayText = days.length === 7
				? t("balance.price.days_all")
				: contiguous
					? fmt(t("balance.price.days_range"), { from: name(days[0]), to: name(days[days.length - 1]) })
					: days.map(name).join("、");
			const windowText = windows.map((window) => `${formatClock(window[0])}–${formatClock(window[1])}`).join("、");
			return fmt(t("balance.price.window"), { days: dayText, windows: windowText });
		}

		/** 同步失败的原因，翻成一句人话。 */
		function formatSyncError(t, error) {
			if (error === "network" || error === "internal") return t("balance.price.error.network");
			if (error === "parse") return t("balance.price.error.parse");
			if (typeof error === "string" && error.startsWith("http-")) return fmt(t("balance.price.error.http"), { code: error.slice(5) });
			return t("balance.price.error.network");
		}

		/** 返回所有已配置的模型价格条目，用于详情面板的价格表；不只限于 DeepSeek。 */
		function configuredModelPricing(pricing) {
			return Object.entries(pricing?.modelPricing ?? {});
		}

		/** 从 `provider:model` 里只取模型名，界面不再展示 provider 前缀。 */
		function modelShortName(value) {
			if (value === void 0 || value === null) return "";
			const key = String(value);
			const index = key.indexOf(":");
			return index < 0 ? key : key.slice(index + 1);
		}

		/** 把 provider 键转成中文友好的厂家名。 */
		function providerDisplayName(provider) {
			if (provider === "deepseek-official" || provider === "deepseek") return "DeepSeek";
			if (provider === "glm" || provider === "zhipu" || provider === "z.ai") return "智谱 GLM";
			if (provider === "kimi" || provider === "moonshot") return "Kimi";
			return provider ?? "";
		}

		/**
		 * 高峰时段的内置默认规则：北京时间周一至周五 9:00-12:00、14:00-18:00。
		 * 与 host 半 `DEFAULT_PEAK_SCHEDULE` 逐字一致，只在还没拿到单价表时顶一下。
		 */
		const DEFAULT_PEAK_SCHEDULE = { days: [1, 2, 3, 4, 5], windows: [[540, 720], [840, 1080]] };

		/**
		 * 北京时间与 UTC 的固定时差。可以直接加 8 小时再用 UTC 取值：中国自 1991 年起
		 * 全境统一 UTC+8、不实行夏令时。原先这里用 `Intl.DateTimeFormat` 按
		 * Asia/Shanghai 取，为了绕开 `hour12:false` 把午夜格式成 "24" 的坑还得设
		 * `hourCycle`；算术做法既没有那个坑，也能精确到分钟（官方哪天把时段改成
		 * 8:30 开始，按整点判就会错半小时）。
		 */
		const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

		/**
		 * 某个时刻是不是高峰时段。规则跟着单价表走（host 半从定价页脚注解析、可被
		 * 配置覆盖），与 host 半 `compilePeakSchedule` 同一套判定——同一条消息在
		 * 侧边栏和在费用表里必须得出同一个答案。
		 *
		 * @param {Date|number} date 时刻。参数化是为了能在测试里钉死时间。
		 * @param {object} [schedule] `pricing.peakSchedule`，缺了就用内置默认规则。
		 */
		function isPeakHours(date, schedule) {
			const windows = Array.isArray(schedule?.windows) ? schedule.windows : DEFAULT_PEAK_SCHEDULE.windows;
			if (windows.length === 0) return false;
			const days = Array.isArray(schedule?.days) ? schedule.days : DEFAULT_PEAK_SCHEDULE.days;
			const time = date instanceof Date ? date.getTime() : Number(date);
			const d = new Date(time + BEIJING_OFFSET_MS);
			const dateKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
			// getUTCDay 是 0=周日；换成 1=周一 … 7=周日。
			const day = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
			const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
			// 日期级覆盖优先于星期：整天放假 > 「周三本来是工作日」。
			if ((schedule?.offPeakDates ?? []).includes(dateKey)) return false;
			if (!(schedule?.peakDates ?? []).includes(dateKey) && !days.includes(day)) return false;
			return windows.some((window) => minutes >= window[0] && minutes < window[1]);
		}

		// 单价是纯本地配置（host 半 Config 来的，不查 DeepSeek），缓存成一个模块级
		// 的 Promise：不管多少个 turnTail 探针同时要用，实际只发一次请求。
		let pricingPromise = null;
		function getPricing() {
			if (pricingPromise === null) {
				pricingPromise = fetch("/api/dsdesktop/balance/pricing")
					.then((res) => res.json())
					.then((result) => (result && result.ok ? result.pricing : null))
					.catch(() => {
						// 单次失败不要永久缓存成 null：探针/面板下一次再要单价时还有机会重试。
						pricingPromise = null;
						return null;
					});
			}
			return pricingPromise;
		}

		/**
		 * 本次打开应用的时刻。client.js 的 factory 每次页面加载只跑一遍，跟「这次
		 * 打开 APP」是同一个时间点；对话报错恢复时页面可能整页重载，所以落一份在
		 * sessionStorage 里，重载后仍是「这次打开」而不是从头再来。
		 *
		 * 现在它只有一个用途：判断一条「进行中」的消息是不是这次启动之后才开始的。
		 * 界面上再没有「本次打开」这个统计口径了——日/周/月三格都由 host 半从会话
		 * 日志现算，而一条早于本次启动的 partial 十有八九是从磁盘恢复出来的残留
		 * （真在生成的回合活不过一次重启），给它记一笔估算就再没人来撤销。
		 */
		const OPEN_KEY = "dsh-ui-balance/appOpen/v1";
		function readSessionValue(key) {
			try {
				if (typeof sessionStorage === "undefined") return null;
				const raw = sessionStorage.getItem(key);
				return raw === null ? null : JSON.parse(raw);
			} catch {
				return null;
			}
		}
		function writeSessionValue(key, value) {
			try {
				if (typeof sessionStorage === "undefined") return;
				sessionStorage.setItem(key, JSON.stringify(value));
			} catch {
				// 存储不可用（隐私模式 / 配额满）只影响重载后的连续性，不影响本次显示。
			}
		}
		const appOpenTime = Number(readSessionValue(OPEN_KEY)) || Date.now();
		writeSessionValue(OPEN_KEY, appOpenTime);

		function dayKeyOf(date) {
			const d = date instanceof Date ? date : new Date(date);
			return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
		}
		function weekKeyOf(date) {
			const d = date instanceof Date ? date : new Date(date);
			const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
			return dayKeyOf(monday);
		}
		function monthKeyOf(date) {
			const d = date instanceof Date ? date : new Date(date);
			return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
		}

		const EMPTY_PERIOD = Object.freeze({ key: null, currency: null, totalCost: 0, perModel: Object.freeze([]), priceChanges: Object.freeze([]) });

		/**
		 * 用量与花费：**只做展示，不做记账**。
		 *
		 * 以前这里是一本浏览器侧的账本——每条 assistant 消息由挂在 turnTail 的探针
		 * 上报，按 `sessionId:seq` 去重，按日/周/月三份累加器分别累计，落 localStorage
		 * 再跨 origin 同步到 host 文件。那套东西有三个各自独立、又互相掩盖的毛病：
		 *
		 * 1. 探针只看得见「当前工作区里正好被渲染出来的那些消息」。后台会话、没滚到
		 *    的历史、应用重启之前发生的一切全都不会上报。实测一个月真实产生 6147 条
		 *    assistant 消息，账本里只记下 21 条。
		 * 2. 模型归属取的是「这条消息收工那一刻会话选中的模型」，模型目录还没加载
		 *    出来时就只能记成 `unknown`、按 0 元计——而那条 unknown 记录会被持久化，
		 *    重启之后再没人去把它迁移回真正的模型。
		 * 3. 流式阶段按字符数估的 token（只算输出、不算输入与缓存）会被折进账本，
		 *    撤销它依赖只存在于 sessionStorage 的一张表，而桌面端每次启动端口都变、
		 *    sessionStorage 必丢——于是估算永久留在账本里，精确值再叠一遍。
		 *
		 * 现在这些全都不存在了：日/周/月三个数字都由 host 半从 dsh 的会话事件日志
		 * 现算（`usage-log.js`），那里每条消息都带 provider 报的精确 usage 和逐条
		 * 精确的 `{provider, model}`。浏览器半只剩两件事——把结果拉下来，以及为
		 * **正在生成中**的那条消息补一个字符数估算，让侧边栏那一行在回合结束前也会动。
		 */
		const costStore = (() => {
			// host 半算好的三格数字。live 之外的一切都以它为准。
			let served = { status: "loading", currency: null, pricing: null, daily: EMPTY_PERIOD, weekly: EMPTY_PERIOD, monthly: EMPTY_PERIOD };
			// 进行中消息的流式估算：**可以同时有多条**（多个会话/多个 turn 并行生成），
			// 按 `sessionId:turn:step` 分别保存。只活在内存里，不落盘也不进任何累计：
			// 回合一结束它就被丢掉，换成日志里那条精确的。
			const live = new Map();
			const listeners = new Set();
			let snapshot = freeze();
			let timer = null;
			let inFlight = null;
			let forceQueued = false;

			function freeze() {
				return Object.freeze({
					status: served.status,
					currency: served.currency,
					// 单价的同步状态：什么时候同步到的、上次为什么失败、当前这张表从
					// 什么时候起生效。同步失败是**安静的**（继续用旧价），所以这份状态
					// 必须一路摊到界面上，否则用户看到的是一个不知道多旧的价。
					pricing: served.pricing,
					live: Object.freeze(
						Array.from(live.values()).map((item) => Object.freeze({ ...item, tokens: Object.freeze({ ...item.tokens }) }))
					),
					daily: served.daily,
					weekly: served.weekly,
					monthly: served.monthly
				});
			}

			function notify() {
				snapshot = freeze();
				listeners.forEach((fn) => fn());
			}

			function normalizePricingStatus(raw) {
				if (!raw) return null;
				const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
				return Object.freeze({
					source: raw.source === "default" ? "default" : "official",
					// 高峰时段规则：周几 / 哪几个时间窗 / 这套规则从哪来 / 有多少天被
					// 日期级覆盖。界面上要写出来——数字上看不出插件按的是哪套规则。
					schedule: raw.schedule === void 0 || raw.schedule === null ? null : Object.freeze({
						days: Object.freeze((Array.isArray(raw.schedule.days) ? raw.schedule.days : []).map(Number)),
						windows: Object.freeze((Array.isArray(raw.schedule.windows) ? raw.schedule.windows : [])
							.filter((w) => Array.isArray(w) && w.length === 2)
							.map((w) => Object.freeze([Number(w[0]), Number(w[1])]))),
						source: raw.schedule.source === "config" ? "config" : raw.schedule.source === "default" ? "default" : "official",
						offPeakDates: Number(raw.schedule.offPeakDates ?? 0),
						peakDates: Number(raw.schedule.peakDates ?? 0),
						// 节假日口径：这是用户一定会问、而数字上完全看不出来的一件事。
						holidays: raw.schedule.holidays === "offpeak" ? "offpeak" : "peak",
						holidaySource: raw.schedule.holidaySource === "config" ? "config" : "official",
						// 被解析的那句原文 + 「这句里有我没建模的计费词」。官方以后加了
						// 别的规则，界面上要能直接读到原文，而不是装作规则没变。
						note: typeof raw.schedule.note === "string" ? raw.schedule.note : null,
						unmodelled: raw.schedule.unmodelled === true,
						calendar: raw.schedule.calendar === void 0 || raw.schedule.calendar === null ? null : Object.freeze({
							years: Object.freeze((Array.isArray(raw.schedule.calendar.years) ? raw.schedule.calendar.years : []).map(Number)),
							missing: Object.freeze((Array.isArray(raw.schedule.calendar.missing) ? raw.schedule.calendar.missing : []).map(Number)),
							error: typeof raw.schedule.calendar.error === "string" ? raw.schedule.calendar.error : null
						})
					}),
					syncedAt: number(raw.syncedAt),
					attemptedAt: number(raw.attemptedAt),
					error: typeof raw.error === "string" ? raw.error : null,
					stale: raw.stale === true,
					peak: raw.peak === true,
					effectiveFrom: number(raw.effectiveFrom),
					effectiveFromSource: raw.effectiveFromSource === "config" ? "config" : "seen",
					pendingFrom: Object.freeze((Array.isArray(raw.pendingFrom) ? raw.pendingFrom : []).map(Number))
				});
			}

			function normalizePeriod(raw) {
				if (!raw) return EMPTY_PERIOD;
				const perModel = Array.isArray(raw.perModel) ? raw.perModel : [];
				return Object.freeze({
					key: raw.key ?? null,
					currency: raw.currency ?? null,
					totalCost: Number(raw.totalCost ?? 0),
					// 这个周期实际用到过几张价表。多于一张说明它跨越了一次调价，界面上
					// 要说明一句——不然「本月费用」跟着调价整体变一档，看着像算错了。
					priceChanges: Object.freeze((Array.isArray(raw.priceChanges) ? raw.priceChanges : []).map(Number)),
					perModel: Object.freeze(perModel.map((m) => Object.freeze({
						provider: m.provider ?? null,
						model: m.model ?? null,
						priced: m.priced === true,
						cost: Number(m.cost ?? 0),
						tokens: Object.freeze({
							input: Number(m.tokens?.input ?? 0),
							cacheRead: Number(m.tokens?.cacheRead ?? 0),
							output: Number(m.tokens?.output ?? 0)
						}),
						// 按 token 类别拆开的金额，由 host 半算好（峰谷倍率是逐条消息判的，
						// 这边拿 token 数乘单价反推不出来）。老 host 半没有这个字段，
						// 补 0 而不是留 undefined，费用表里就不会渲染出空格子。
						costs: Object.freeze({
							input: Number(m.costs?.input ?? 0),
							cacheRead: Number(m.costs?.cacheRead ?? 0),
							output: Number(m.costs?.output ?? 0)
						})
					})))
				});
			}

			/**
			 * 拉一次统计。单飞：侧边栏和详情面板同时挂着，两个订阅者不该各扫一遍日志
			 * （host 半自己也有 5 秒的扫描节流，这里再挡一层是为了连 HTTP 都不必发）。
			 *
			 * `force` 会一路穿到 host 半，跳过那 5 秒节流。回合刚结束时必须带上它：
			 * 那条消息是在几百毫秒前才落进日志的，节流窗口里的一次请求返回的正是
			 * 「这条消息还没算进去」的旧数字。
			 */
			function refresh(force) {
				if (inFlight !== null) {
					// 单飞，但强制刷新不能被一个正在飞的普通请求吃掉——那个请求很可能
					// 正卡在 host 半的节流窗口里。排到它后面再补一发。
					if (force === true && !forceQueued) {
						forceQueued = true;
						inFlight.then(() => {
							forceQueued = false;
							refresh(true);
						});
					}
					return inFlight;
				}
				if (typeof fetch === "undefined") return Promise.resolve();
				inFlight = fetch(`/api/dsdesktop/balance/usage${force === true ? "?force=1" : ""}`)
					.then((res) => res.json())
					.then((result) => {
						if (!result || result.ok !== true) return;
						served = {
							status: "ready",
							currency: result.pricing?.currency ?? null,
							pricing: normalizePricingStatus(result.pricingStatus),
							daily: normalizePeriod(result.daily),
							weekly: normalizePeriod(result.weekly),
							monthly: normalizePeriod(result.monthly)
						};
						notify();
					})
					.catch(() => {
						// 单次失败不改变已有数字：面板继续显示上一次拉到的值，下一轮再试。
					})
					.finally(() => {
						inFlight = null;
					});
				return inFlight;
			}

			/**
			 * 回合结束后的补拉时刻表（毫秒）。
			 *
			 * 两发而不是一发：那条消息要先由 host 半序列化、zstd 压帧、追加落盘，我们
			 * 才读得到。第一发赶在「通常已经落盘」的时点，第二发兜底——慢盘 / 大回合上
			 * 第一发可能还是空手而归，而下一次兜底轮询要等 20 秒，那 20 秒里面板显示的
			 * 是「刚才这条不要钱」。
			 */
			const SETTLE_DELAYS = [1200, 6000];
			let settleTimers = [];
			function scheduleSettleRefresh() {
				for (const timer of settleTimers) clearTimeout(timer);
				settleTimers = SETTLE_DELAYS.map((delay) => setTimeout(() => refresh(true), delay));
			}

			// 面板开着时每 20 秒兜一次底：别的窗口/后台会话产生的花费不会触发这边任何
			// 事件，只能靠轮询。日志扫描是增量的（按文件尺寸判断有没有新内容），一次
			// 空转只有 readdir + stat。
			const POLL_MS = 20 * 1000;

			function dropLive(sessionId, turn, step) {
				let removed = false;
				for (const [key, item] of live) {
					if (sessionId !== void 0 && item.sessionId !== sessionId) continue;
					if (turn !== void 0 && item.turn !== turn) continue;
					if (step !== void 0 && item.step !== step) continue;
					live.delete(key);
					removed = true;
				}
				return removed;
			}

			function sameLive(a, b) {
				return a.sessionId === b.sessionId && a.turn === b.turn && a.step === b.step
					&& a.priced === b.priced
					&& a.tokens.input === b.tokens.input && a.tokens.cacheRead === b.tokens.cacheRead
					&& a.tokens.output === b.tokens.output && a.cost === b.cost
					&& a.provider === b.provider && a.model === b.model;
			}

			// 模块一加载就拉一次，不等第一个订阅者。侧边栏那一行是常驻的，等它挂载
			// 再发请求等于白白多一个来回；页面重载后也能立刻显示上数字而不是先闪一下 0。
			refresh();

			return {
				getSnapshot: () => snapshot,
				subscribe(fn) {
					listeners.add(fn);
					if (timer === null) {
						refresh();
						timer = setInterval(refresh, POLL_MS);
					}
					return () => {
						listeners.delete(fn);
						if (listeners.size === 0 && timer !== null) {
							clearInterval(timer);
							timer = null;
						}
					};
				},
				refresh,
				/** 记下/更新一条进行中消息的流式估算。 */
				noteLiveEstimate({ sessionId, turn, step, tokens, cost, selection, priced, startTime }) {
					if (turn === void 0) {
						// partial 消失但拿不到 turn：这个会话没有进行中的消息了。
						if (dropLive(sessionId)) notify();
						scheduleSettleRefresh();
						return;
					}
					const liveKey = `${sessionId ?? "unknown"}:${turn}:${step ?? ""}`;
					const next = {
						sessionId: sessionId ?? null,
						turn,
						step: step ?? null,
						startTime: startTime ?? void 0,
						provider: selection?.provider ?? null,
						model: selection?.model ?? null,
						priced: priced === true,
						tokens: { input: 0, cacheRead: 0, output: tokens?.output ?? 0 },
						cost: cost ?? 0
					};
					const prev = live.get(liveKey);
					if (prev && sameLive(prev, next)) return;
					live.set(liveKey, next);
					notify();
				},
				/**
				 * 一条消息不再进行中：丢掉估算，稍后拉一次精确值。
				 *
				 * 旧实现在这里把估算「折进累计」，理由是对话报错时精确 usage 永远不会
				 * 到账、至少保住估算。现在不需要了：会话日志才是唯一口径——真发生过的
				 * 调用日志里就有，没落进日志的调用本来也不该算钱。
				 */
				dropLive(sessionId, turn, step) {
					if (dropLive(sessionId, turn, step)) notify();
					scheduleSettleRefresh();
				},
				/**
				 * 清零一个统计周期。
				 *
				 * 统计既然每次都从会话日志现算，清零就不能靠删数字——删了下一次照样算
				 * 回来。改成往 host 半写一个时间下限，汇总时早于它的记录一律跳过。
				 */
				resetPeriod(period) {
					const scope = period === "week" ? "week" : period === "month" ? "month" : "day";
					if (typeof fetch === "undefined") return;
					fetch("/api/dsdesktop/balance/reset", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ period: scope })
					})
						.catch(() => {
							// 写不进去就什么都没变；下一次刷新会把原样的数字拉回来。
						})
						// 强制刷新：清零下限是每次请求都重新读的，节流的只是日志扫描结果，
						// 所以普通刷新也能反映清零。带上 force 是为了顺手把节流窗口里可能
						// 攒下的新消息一起算进来——清零之后这一格该显示的是「从刚才起算」，
						// 而不是一个 5 秒前的快照。
						.finally(() => refresh(true));
				}
			};
		})();

		function useCostSnapshot() {
			return useStore(costStore);
		}

		/**
		 * 一个统计周期的金额显示文本。
		 *
		 * `live` 是**进行中**那条消息的字符数估算，只有侧边栏那一行会带上它（`withLive`）：
		 * 侧边栏要求实时跳动，而面板里的费用表是「回合结束后更新」的一份结算口径：
		 * 估算只有输出、没有输入与缓存，混进去会让按类别分的那几列失真。
		 *
		 * 估算按 `startTime` 落在哪个周期归类。拿不到 turnTimings 时 `startTime` 是
		 * undefined——那条消息**正在生成**，按定义就发生在今天/本周/本月，所以算进来。
		 * 反过来（要求 startTime 存在才算）会让没有 turnTimings 的会话里数字一动不动。
		 *
		 * **还没产生任何花费时显示 0，不是「—」**：破折号在这个面板里的含义是
		 * 「读不出来」（余额查询失败、单价没配），而「今天还没花钱」是一个确定的事实，
		 * 把它显示成「读不出来」等于把好消息报成故障。
		 *
		 * 币种在记下第一笔之前是 null，退回单价表声明的那个；连单价表都没有时才
		 * 只显示裸数字。
		 */
		function formatPeriodCost(cost, period, fallbackCurrency, withLive) {
			const source = period === "week" ? cost.weekly : period === "month" ? cost.monthly : cost.daily;
			const liveCost = withLive === true
				? livePeriodItems(cost, period).reduce((sum, item) => sum + (item.cost ?? 0), 0)
				: 0;
			const amount = (source?.totalCost ?? 0) + liveCost;
			const currency = source?.currency ?? cost.currency ?? fallbackCurrency ?? null;
			return currency === null ? formatMoney("", amount).trim() : formatMoney(currency, amount);
		}

		/** 落在指定周期里的那些进行中估算。 */
		function livePeriodItems(cost, period) {
			const keyOf = period === "week" ? weekKeyOf : period === "month" ? monthKeyOf : dayKeyOf;
			const nowKey = keyOf(new Date());
			return (Array.isArray(cost.live) ? cost.live : [])
				.filter((item) => item.startTime === void 0 || keyOf(item.startTime) === nowKey);
		}

		/** 单价表完整对象，侧边栏峰/谷角标和面板共用。getPricing 是模块级缓存，不会多发请求。 */
		function usePricing() {
			const [pricing, setPricing] = react.useState(null);
			react.useEffect(() => {
				let alive = true;
				getPricing().then((p) => {
					if (alive) setPricing(p);
				});
				return () => {
					alive = false;
				};
			}, []);
			return pricing;
		}

		// modelDirectories 服务不可用（比如上游哪天摘掉了这个包）或者会话还没
		// 选过模型时，useSyncExternalStore 也要有稳定的 subscribe/getSnapshot
		// 可调——不能因为拿不到 store 就跳过这个 hook，React 的 hooks 顺序不允许
		// 条件调用。
		const NULL_DIRECTORY_STORE = { getSnapshot: () => null, subscribe: () => () => {} };

	/**
	 * 常驻 session 头部的静默探针：只做一件事——把当前正在流式生成的 partial
	 * 文本按字符数估算成输出 token，写进 costStore.live。精确用量由 host 半从
	 * 会话事件日志读，但那条消息要等回合结束、事件落盘之后才读得到；没有这个
	 * 估算的话，长回复生成期间面板上的数字会一动不动。回合一结束，估算就被丢掉，
	 * 换成日志里那条精确的。
	 */
	function LiveCostProbe({ sessionId, useSession, useChat, modelDirectories }) {
		const partial = typeof useChat === "function"
			? useChat((s) => chatPartialOf(s))
			: typeof useSession === "function"
				? useSession((s) => chatPartialOf(s))
				: null;
		const turnTimings = typeof useChat === "function"
			? useChat((s) => chatTurnTimingsOf(s))
			: typeof useSession === "function"
				? useSession((s) => chatTurnTimingsOf(s))
				: null;
		const directory = modelDirectories && sessionId !== void 0 ? modelDirectories.directoryFor(sessionId) : void 0;
		const directoryState = useStore(directory ? directory.store : NULL_DIRECTORY_STORE);
		react.useEffect(() => {
			if (!partial || !Array.isArray(partial.blocks)) {
				// 这个会话没有进行中的消息了：丢掉估算，稍后拉一次日志算出来的精确值。
				// 对话报错时 partial 同样会消失，那种情况下这条调用要么已经落进了会话
				// 日志（照样算钱），要么根本没发生过（本来就不该算），都不需要在这里
				// 替它保住一个估算。
				costStore.dropLive(sessionId);
				return undefined;
			}
			const turnId = partial.turn;
			const startTime = turnTimings?.get?.(turnId)?.startTime ?? void 0;
			if (startTime !== void 0 && startTime < appOpenTime) {
				costStore.dropLive(sessionId, turnId);
				return undefined;
			}
			ensureModelDirectoryLoaded(directory, directoryState);
			const selection = directoryState?.current ?? void 0;
			const billedAt = startTime !== void 0 ? new Date(startTime) : new Date();
			let alive = true;
			getPricing().then((pricing) => {
				if (!alive) return;
				const key = priceKey(selection);
				const priceEntry = pricing && selection ? pricing.modelPricing?.[key] : void 0;
				const peak = selection && isDeepSeekProvider(selection.provider) ? isPeakHours(billedAt, pricing?.peakSchedule) : false;
				const outputTokens = estimatePartialOutputTokens(partial);
				const cost = priceEntry !== void 0
					? outputTokens * priceEntry.outputPerMillion / 1e6 * (peak ? (pricing?.peakMultiplier ?? 1) : 1)
					: 0;
				costStore.noteLiveEstimate({
					sessionId,
					turn: turnId,
					step: partial.step,
					selection,
					priced: priceEntry !== void 0,
						tokens: { input: 0, cacheRead: 0, output: outputTokens },
						currency: pricing?.currency,
						startTime,
						cost
				});
			});
			return () => {
				alive = false;
			};
		}, [partial, directoryState, sessionId]);
		return null;
	}

		/**
		 * 观察任意一个 session 的实时 partial，并把流式估算写入 costStore。
		 * 与 LiveCostProbe 的区别：这里不依赖「当前打开的会话」，可以从根组件直接
		 * 订阅 sessions.binding(id).session，因此即使当前工作区没有在跑对话，
		 * 其他工作区/会话正在生成的消息也会被计入。
		 */
		function observeSessionLive(sessionId, session, modelDirectories, feedVersion, isCurrent) {
			let snapshot;
			try {
				snapshot = typeof session.getSnapshot === "function" ? session.getSnapshot() : null;
			} catch {
				snapshot = null;
			}
			const partial = chatPartialOf(snapshot);
			if (!partial || !Array.isArray(partial.blocks)) {
				// 跟 LiveCostProbe 同规则：没有进行中的消息就丢掉估算，等日志里的精确值。
				costStore.dropLive(sessionId);
				return;
			}
			const turnId = partial.turn;
			const startTime = snapshot?.turnTimings?.get?.(turnId)?.startTime ?? void 0;
			if (startTime !== void 0 && startTime < appOpenTime) {
				costStore.dropLive(sessionId, turnId);
				return;
			}
			let selection;
			try {
				const directory = modelDirectories && sessionId !== void 0 ? modelDirectories.directoryFor(sessionId) : void 0;
				selection = directory?.store?.getSnapshot?.()?.current ?? void 0;
			} catch {
				selection = void 0;
			}
			const billedAt = startTime !== void 0 ? new Date(startTime) : new Date();
			getPricing().then((pricing) => {
				if (feedVersion !== void 0 && !isCurrent()) return;
				const key = priceKey(selection);
				const priceEntry = pricing && selection ? pricing.modelPricing?.[key] : void 0;
				const peak = selection && isDeepSeekProvider(selection.provider) ? isPeakHours(billedAt, pricing?.peakSchedule) : false;
				const outputTokens = estimatePartialOutputTokens(partial);
				const cost = priceEntry !== void 0
					? outputTokens * priceEntry.outputPerMillion / 1e6 * (peak ? (pricing?.peakMultiplier ?? 1) : 1)
					: 0;
				costStore.noteLiveEstimate({
					sessionId,
					turn: turnId,
					step: partial.step,
					selection,
					priced: priceEntry !== void 0,
					tokens: { input: 0, cacheRead: 0, output: outputTokens },
					currency: pricing?.currency,
					startTime,
					cost
				});
			});
		}

		/**
		 * 根级静默探针：通过 sessions.list 拿到所有会话，再逐个订阅 session 快照。
		 * 这样无论当前打开哪个工作区，都会统计所有正在进行的对话。
		 */
		function AllSessionsLiveProbe({ sessions, modelDirectories }) {
			const list = useStore(sessions?.list ?? NULL_DIRECTORY_STORE);
			react.useEffect(() => {
				if (!sessions?.list) return undefined;
				const ids = Array.isArray(list?.ids) ? list.ids : Object.keys(list?.byId ?? {});
				const cleanups = [];
				for (const sessionId of ids) {
					let session;
					try {
						session = sessions.binding?.(sessionId)?.session;
					} catch {
						session = void 0;
					}
					if (!session) continue;
					let alive = true;
					let version = 0;
					const feed = () => {
						if (!alive) return;
						const current = ++version;
						observeSessionLive(sessionId, session, modelDirectories, current, () => version === current);
					};
					feed();
					const unsubscribe = typeof session.subscribe === "function" ? session.subscribe(feed) : null;
					cleanups.push(() => {
						alive = false;
						unsubscribe?.();
					});
				}
				return () => {
					for (const cleanup of cleanups) cleanup();
				};
			}, [sessions, list, modelDirectories]);
			return null;
		}


		function createOpenStore() {
			let open = false;
			const listeners = new Set();
			const notify = () => listeners.forEach((fn) => fn());
			return {
				getSnapshot: () => open,
				subscribe: (fn) => {
					listeners.add(fn);
					return () => listeners.delete(fn);
				},
				toggle: () => { open = !open; notify(); },
				close: () => { if (open) { open = false; notify(); } }
			};
		}

		/** 余额自动刷新的间隔。余额不常变，太频繁只会白打 DeepSeek API；60s 一刷足够“开着不用管”。 */
		const BALANCE_REFRESH_MS = 60 * 1000;

		/**
		 * 余额共享 store：侧边栏和详情面板共用一份数据，不各自轮询。
		 * 首个订阅者触发一次立即查询并启动定时刷新；最后一个订阅者离开后停止，
		 * 避免面板关了还在后台空转。
		 */
		const balanceStore = (() => {
			let snapshot = { status: "loading", value: null };
			const listeners = new Set();
			let timer = null;
			let inFlight = null;

			function notify() {
				listeners.forEach((fn) => fn(snapshot));
			}
			function refresh() {
				if (inFlight !== null) return inFlight;
				inFlight = fetch("/api/dsdesktop/balance")
					.then((res) => res.json())
					.then((result) => {
						snapshot = result && result.ok
							? { status: "ready", value: result.value, code: null }
							: { status: "error", value: null, code: result?.error?.code ?? "error" };
						inFlight = null;
						notify();
					})
					.catch(() => {
						snapshot = { status: "error", value: null, code: "network" };
						inFlight = null;
						notify();
					});
				return inFlight;
			}
			function ensureActive() {
				if (timer !== null) return;
				refresh();
				timer = setInterval(refresh, BALANCE_REFRESH_MS);
			}
			return {
				getSnapshot: () => snapshot,
				subscribe(fn) {
					listeners.add(fn);
					ensureActive();
					return () => {
						listeners.delete(fn);
						if (listeners.size === 0 && timer !== null) {
							clearInterval(timer);
							timer = null;
						}
					};
				},
				refresh
			};
		})();

		/** 订阅余额 store 并格式化为显示文本。任一组件挂载都会触发一次实时查询。 */
		function useBalanceText(t) {
			const [view, setView] = react.useState(() => balanceStore.getSnapshot());
			react.useEffect(() => balanceStore.subscribe(setView), []);
			const infos = Array.isArray(view.value?.balance_infos) ? view.value.balance_infos : [];
			if (view.status === "loading") return t("balance.loading");
			if (view.status === "error") return t(view.code === "unsupported-balance" ? "balance.unsupported" : "balance.error");
			if (infos.length === 0) return t("balance.unavailable");
			return infos.map((info) => `${info.total_balance ?? info.topped_up_balance} ${currencyUnit(info.currency)}`).join(" / ");
		}

		// 侧边栏「插件市场下面」的入口：就是一行字，不要按钮的框/背景/图标——
		// 点开详情面板看用量/花费/单价。
		function WalletIcon({ size }) {
			return react_jsx_runtime.jsxs("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.3", children: [
				react_jsx_runtime.jsx("rect", { x: "1.5", y: "3.5", width: "13", height: "9.5", rx: "1.8" }),
				react_jsx_runtime.jsx("path", { d: "M1.5 6.2 H14.5" }),
				react_jsx_runtime.jsx("circle", { cx: "11.3", cy: "9.4", r: "0.9", fill: "currentColor", stroke: "none" })
			] });
		}

		/**
		 * 关闭按钮里的 ×。**不用 "×" 这个字符**：字形在 em 盒里的位置由字体度量决定，
		 * 行盒是按 ascent/descent 居中的，而乘号是按数学轴（约 x-height 的一半）摆的，
		 * 两者差着零点几个 em——表现出来就是「悬浮色块出来了，× 却偏在框里靠下」，
		 * 而且换个字体偏多少还不一样。画成 SVG 就是几何居中，跟字体无关。
		 */
		function CloseIcon() {
			return react_jsx_runtime.jsxs("svg", { width: "12", height: "12", viewBox: "0 0 12 12", fill: "none", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round", children: [
				react_jsx_runtime.jsx("path", { d: "M2.5 2.5 L9.5 9.5" }),
				react_jsx_runtime.jsx("path", { d: "M9.5 2.5 L2.5 9.5" })
			] });
		}

		// 侧边栏折起来（56px 窄栏）时容不下一整行文字：Git/终端/市场那几个
		// footer 按钮在这个状态下都是只显示一个图标，我们跟着同一个规矩来，
		// 不然这一项比其他几项高/宽出一截，会把同一列里别的图标挤到看不见
		// （实测过——之前一直渲染整行文字，折叠态直接把另外三个挤没了）。
		function BalanceSidebarButton({ wide, t, store }) {
			const balanceText = useBalanceText(t);
			const cost = useCostSnapshot();
			const pricing = usePricing();
			// 这一行显示的是**今天**的花费，而且带上进行中那条消息的估算——它是唯一
			// 一处要求实时跳动的地方（面板里那张表是回合结束后才更新的结算口径）。
			const costText = formatPeriodCost(cost, "day", pricing?.currency ?? null, true);
			const balanceLabel = fmt(t("balance.side.balance"), { value: balanceText });
			const costLabel = fmt(t("balance.side.cost"), { value: costText });
			// 只有 DeepSeek 官方 API 才适用“峰谷”计价规则；第三方中转/兼容 API 不贴角标。
			// 而且得是**这张价表里真的有峰价**：官方哪天取消峰谷，这个角标就该自己消失，
			// 不能继续贴一个已经不存在的计费规则。
			const peakNow = isPeakHours(new Date(), pricing?.peakSchedule);
			const isDeepSeek = hasDeepSeekPricing(pricing) && hasPeakPricing(pricing)
				&& (pricing?.peakSchedule?.windows?.length ?? 1) > 0;
			const priceBadge = isDeepSeek ? t(peakNow ? "balance.price.peak_badge" : "balance.price.offpeak_badge") : null;
			const priceBadgeClass = peakNow ? "dsbSidePeak" : "dsbSideOffpeak";
			const priceBadgeTitle = isDeepSeek ? t(peakNow ? "balance.price.peak" : "balance.price.offpeak") : null;
			// title/aria 用**完整**那句（不是可视标签的「花费…/日」）：可视标签靠紧挨着
			// 「余额」的上下文加一个量纲就够读懂，悬浮提示没有那个上下文，得把「哪段
			// 时间的花费」说全。折叠成图标时它更是唯一能读到这两个数的地方。
			const label = `${balanceLabel} · ${t("balance.daily.title")} ${costText}${priceBadgeTitle ? ` · ${priceBadgeTitle}` : ""}`;
			if (!wide) {
				return react_jsx_runtime.jsx("button", {
					type: "button",
					className: "dsbSideIcon",
					title: label,
					"aria-label": label,
					onClick: () => {
						store.toggle();
						balanceStore.refresh();
						costStore.refresh(true);
					},
					children: react_jsx_runtime.jsx(WalletIcon, { size: 15 })
				});
			}
			// 拆成两个 span 而不是拼一个字符串：中间那道 12px 的空隙得由 CSS 的 gap
			// 撑（见上面 .dsbSideBal/.dsbSideCost），拼字符串就只能靠 `·` 挤在一起，
			// 眼睛还得先找分隔符才能分清哪个是余额哪个是花费；窄栏里也只能整句一起
			// 截断，而分成两段是各自省略号，谁也不会把谁挤没。
			return react_jsx_runtime.jsxs("button", {
				type: "button",
				className: "dsbSideBtn",
				title: label,
				"aria-label": label,
				onClick: () => {
					store.toggle();
					balanceStore.refresh();
					costStore.refresh(true);
				},
				children: [
					react_jsx_runtime.jsx("span", { className: "dsbSideBal", children: balanceLabel }, "bal"),
					react_jsx_runtime.jsx("span", { className: "dsbSideCost", children: costLabel }, "cost"),
					priceBadge === null ? null : react_jsx_runtime.jsx("span", {
						className: priceBadgeClass,
						style: {
							color: peakNow ? "var(--dsw-alias-state-business-primary,#4d6bfe)" : "var(--dsw-alias-state-success-primary,#3fb950)",
							backgroundColor: peakNow ? "rgba(77,107,254,.14)" : "rgba(63,185,80,.14)"
						},
						title: priceBadgeTitle ?? void 0,
						"aria-label": priceBadgeTitle ?? void 0,
						children: priceBadge
					}, "price")
				]
			});
		}

		/** 用量汇总可选的统计周期，顺序即界面上分段控件的顺序。 */
		const USAGE_PERIODS = ["day", "week", "month"];

		/**
		 * 按下方价格表的行序排列模型行（configuredOrder 是「价格表里第几行」的索引），
		 * 价格表里没有配置单价的模型排到最后。
		 *
		 * 用量表和费用表共用这一个排序：两张表是同一个周期、同一批消息，上下对读时
		 * 第 n 行必须说的是同一个模型，各自排一次序早晚会排出两个顺序来。
		 */
		function sortByPriceOrder(models, configuredOrder) {
			return models.slice().sort((a, b) => {
				const keyA = a.provider && a.model ? priceKey({ provider: a.provider, model: a.model }) : "";
				const keyB = b.provider && b.model ? priceKey({ provider: b.provider, model: b.model }) : "";
				const orderA = configuredOrder.has(keyA) ? configuredOrder.get(keyA) : Number.MAX_SAFE_INTEGER;
				const orderB = configuredOrder.has(keyB) ? configuredOrder.get(keyB) : Number.MAX_SAFE_INTEGER;
				return orderA - orderB;
			});
		}

		/**
		 * 用量表：模型 / 输入未命中 / 缓存命中 / 输出 / 缓存命中率。
		 */
		function UsageTable({ t, models, configuredOrder, empty }) {
			if (models.length === 0) return react_jsx_runtime.jsx("div", { className: "dsbNote", children: empty });
			const rows = sortByPriceOrder(models, configuredOrder);
			return react_jsx_runtime.jsxs("table", { className: "dsbPriceTable dsbUsageTable", children: [
				react_jsx_runtime.jsxs("thead", { children: react_jsx_runtime.jsxs("tr", { children: [
					react_jsx_runtime.jsx("th", { children: t("balance.price.table.model") }),
					react_jsx_runtime.jsx("th", { children: t("balance.usage.table.input") }),
					react_jsx_runtime.jsx("th", { children: t("balance.usage.table.hit") }),
					react_jsx_runtime.jsx("th", { children: t("balance.usage.table.output") }),
					react_jsx_runtime.jsx("th", { children: t("balance.usage.table.hit_rate") })
				] }) }),
				react_jsx_runtime.jsxs("tbody", { children: rows.map((m) => {
					const label = m.model ? modelShortName(m.model) : t("balance.model.unknown");
					return react_jsx_runtime.jsxs("tr", { children: [
						react_jsx_runtime.jsx("td", { className: "dsbPriceModel", children: label }),
						react_jsx_runtime.jsx("td", { className: "dsbPriceValue", children: formatTokens(m.tokens?.input) }),
						react_jsx_runtime.jsx("td", { className: "dsbPriceValue", children: formatTokens(m.tokens?.cacheRead) }),
						react_jsx_runtime.jsx("td", { className: "dsbPriceValue", children: formatTokens(m.tokens?.output) }),
						react_jsx_runtime.jsx("td", { className: "dsbPriceValue", children: formatHitRate(m.tokens) })
					] }, label);
				}) })
			] });
		}

		/**
		 * 费用表：模型 / 输入未命中 / 缓存命中 / 输出 / 合计，最后一行是总计。
		 *
		 * 表头跟上面那张用量表逐列对齐，格子里换成钱——同一行、同一列说的是同一批
		 * token，一眼就能看出「缓存命中省下多少」这类问题。第五列用量表是缓存命中率，
		 * 费用这边没有对应的比率概念，换成这一行的合计。
		 *
		 * 分项金额一律取 host 半算好的 `costs`，**不在这里拿 token 数乘单价**：峰谷
		 * 倍率是逐条消息判的，一个周期里既有高峰也有空闲，用汇总后的 token 数反推
		 * 必然算错（那正是旧版算错钱的原因之一）。
		 *
		 * 总计那一格取周期自己的 `totalCost`（跟侧边栏、跟 host 半同一个数），前四格才
		 * 是各行相加。两者数值上本来就是同一个数（`totalCost` 就是各行合计之和），但
		 * 这一格的口径跟着 host 半走，别在这里另立一个。
		 *
		 * 显示上有个免不了的零头：每格都是各自四舍五入到 4 位小数的，所以把「合计」
		 * 那一列的几个显示值加起来，末位可能跟总计差 1（0.0001 元）。底下的数字是准的，
		 * 只是别指望摊在屏幕上的四位小数彼此严丝合缝。
		 */
		function CostTable({ t, models, configuredOrder, currency, total, empty }) {
			if (models.length === 0) return react_jsx_runtime.jsx("div", { className: "dsbNote", children: empty });
			const rows = sortByPriceOrder(models, configuredOrder);
			const money = (amount) => (currency === null || currency === void 0
				? formatMoney("", amount).trim()
				: formatMoney(currency, amount));
			return react_jsx_runtime.jsxs("table", { className: "dsbPriceTable dsbUsageTable", children: [
				react_jsx_runtime.jsxs("thead", { children: react_jsx_runtime.jsxs("tr", { children: [
					react_jsx_runtime.jsx("th", { children: t("balance.price.table.model") }),
					react_jsx_runtime.jsx("th", { children: t("balance.usage.table.input") }),
					react_jsx_runtime.jsx("th", { children: t("balance.usage.table.hit") }),
					react_jsx_runtime.jsx("th", { children: t("balance.usage.table.output") }),
					react_jsx_runtime.jsx("th", { children: t("balance.cost.table.total") })
				] }) }),
				react_jsx_runtime.jsxs("tbody", { children: [
					...rows.map((m) => {
						const label = m.model ? modelShortName(m.model) : t("balance.model.unknown");
						return react_jsx_runtime.jsxs("tr", { children: [
							react_jsx_runtime.jsx("td", { className: "dsbPriceModel", children: label }),
							react_jsx_runtime.jsx("td", { className: "dsbPriceValue", children: money(m.costs?.input ?? 0) }),
							react_jsx_runtime.jsx("td", { className: "dsbPriceValue", children: money(m.costs?.cacheRead ?? 0) }),
							react_jsx_runtime.jsx("td", { className: "dsbPriceValue", children: money(m.costs?.output ?? 0) }),
							react_jsx_runtime.jsx("td", { className: "dsbPriceValue", children: money(m.cost ?? 0) })
						] }, label);
					}),
					// 只有一个模型时不出这一行：总计就等于上面那一行，两行一模一样摆在
					// 一起像是渲染坏了，而「这个周期一共花了多少」那个数并没有因此消失。
					rows.length < 2 ? null : react_jsx_runtime.jsxs("tr", { className: "dsbTotalRow", children: [
						react_jsx_runtime.jsx("td", { className: "dsbPriceModel", children: t("balance.cost.table.all") }),
						react_jsx_runtime.jsx("td", { className: "dsbPriceValue", children: money(rows.reduce((sum, m) => sum + (m.costs?.input ?? 0), 0)) }),
						react_jsx_runtime.jsx("td", { className: "dsbPriceValue", children: money(rows.reduce((sum, m) => sum + (m.costs?.cacheRead ?? 0), 0)) }),
						react_jsx_runtime.jsx("td", { className: "dsbPriceValue", children: money(rows.reduce((sum, m) => sum + (m.costs?.output ?? 0), 0)) }),
						react_jsx_runtime.jsx("td", { className: "dsbPriceValue", children: money(total ?? 0) })
					] }, "total")
				] })
			] });
		}

		/**
		 * 单价那一节末尾的状态说明。
		 *
		 * 为什么非要有：同步失败是**安静的**——抓不到或者解析不出来时，插件会继续用手上
		 * 最后那份真实价，界面上原本什么都不说。于是「官方昨天调价了、而我这儿的解析器
		 * 被页面改版打断了」这件事，从数字上完全看不出来，只能靠人自己起疑。
		 *
		 * 正常时只有一行安静的「同步于 x」；同步不上、或者从来没成功过，才转成警示色。
		 */
		function syncNotes(t, sync) {
			if (sync === null) return [];
			const notes = [];
			// 先写清「按的是哪套高峰时段」，再写价是什么时候同步到的。规则在前：它决定
			// 一笔用量是按峰还是按谷，差的是一倍钱。
			const schedule = sync.schedule ?? null;
			if (schedule !== null) {
				const windows = formatPeakWindows(t, schedule);
				const extras = [];
				const overridden = schedule.source === "config"
					|| schedule.holidaySource === "config"
					|| (schedule.offPeakDates ?? 0) > 0 || (schedule.peakDates ?? 0) > 0;
				if (schedule.source === "config") extras.push(t("balance.price.window_config"));
				else if (schedule.source === "default") extras.push(t("balance.price.window_default"));
				// 节假日口径写在时段后面：官方那句话只说周一至周五，节假日算不算高峰
				// 是用户一定会问、而数字上完全看不出来的一件事。
				const holiday = t(schedule.holidays === "offpeak" ? "balance.price.holiday_offpeak" : "balance.price.holiday_peak");
				const calendarYears = schedule.calendar?.years ?? [];
				const holidayNote = schedule.holidays === "offpeak" && calendarYears.length > 0
					? `${holiday}（${fmt(t("balance.price.holiday_calendar"), { years: calendarYears.join("、") })}）`
					: holiday;
				if ((schedule.offPeakDates ?? 0) > 0 || (schedule.peakDates ?? 0) > 0) {
					extras.push(fmt(t("balance.price.window_dates"), {
						offPeak: schedule.offPeakDates ?? 0,
						peak: schedule.peakDates ?? 0
					}));
				}
				notes.push(react_jsx_runtime.jsx("div", {
					// 只要覆盖过官方规则（改了星期/时间窗/节假日口径，或者拿日期整天掩过）
					// 就转警示色：那是一份「我不按官方那句话算」的声明，对账对不上的时候
					// 得能一眼想起来这里改过。
					className: "dsbNote" + (overridden ? " dsbWarn" : ""),
					children: (windows ?? t("balance.price.window_none"))
						+ ` · ${holidayNote}`
						+ (extras.length > 0 ? `（${extras.join("，")}）` : "")
				}, "window"));
				// 说好按空闲算、日历却没取到：那等于又变回按高峰计，是个必须看得见的差别。
				if (schedule.holidays === "offpeak" && schedule.calendar !== null && (schedule.calendar.missing ?? []).length > 0) {
					notes.push(react_jsx_runtime.jsx("div", {
						className: "dsbNote dsbWarn",
						children: fmt(t("balance.price.holiday_calendar_failed"), {
							reason: formatSyncError(t, schedule.calendar.error)
						})
					}, "calendar"));
				}
				// 页面上出现了插件没建模的计费规则：把原文摆出来，别装作规则没变。
				if (schedule.unmodelled && schedule.note !== null) {
					notes.push(react_jsx_runtime.jsx("div", {
						className: "dsbNote dsbWarn",
						children: fmt(t("balance.price.unmodelled"), { note: schedule.note })
					}, "unmodelled"));
				}
			}
			// 计费路由：「访问 A 的请求按 B 的价格计费」。这类规则跟峰谷一样直接决定
			// 金额，而且是从价表本身完全看不出来的——单价表里 pro 那一行摆着 Pro 的价，
			// 实际却按 Flash 收——所以必须在这儿把定价页的原话摆出来。
			const billing = sync.billing ?? null;
			if (billing !== null) {
				// 同一条规则往往一次点名好几个旧模型名，按「计费成谁 + 原文」并成一行说。
				const grouped = new Map();
				for (const item of billing.routed ?? []) {
					const groupKey = `${item.billedAs} ${item.note ?? ""}`;
					if (!grouped.has(groupKey)) grouped.set(groupKey, { target: item.billedAs, note: item.note, models: [] });
					grouped.get(groupKey).models.push(item.model);
				}
				for (const [groupKey, group] of grouped) {
					notes.push(react_jsx_runtime.jsx("div", {
						className: "dsbNote",
						children: fmt(t("balance.price.route_note"), {
							models: group.models.join("、"),
							target: group.target,
							note: group.note ?? "—"
						})
					}, "routed:" + groupKey));
				}
				for (const item of billing.pending ?? []) {
					notes.push(react_jsx_runtime.jsx("div", {
						className: "dsbNote",
						children: fmt(t("balance.price.route_pending"), {
							when: formatWhen(item.from),
							model: item.model,
							target: item.billedAs,
							note: item.note ?? "—"
						})
					}, "route-pending:" + item.model + ":" + item.from));
				}
				// 读不懂的那种：**没有套用**，所以金额按价表原价算。转警示色，原文照抄。
				for (const note of billing.unparsed ?? []) {
					notes.push(react_jsx_runtime.jsx("div", {
						className: "dsbNote dsbWarn",
						children: fmt(t("balance.price.route_unparsed"), { note })
					}, "route-unparsed:" + note));
				}
			}
			if (sync.source === "default") {
				notes.push(react_jsx_runtime.jsx("div", { className: "dsbNote dsbWarn", children: t("balance.price.never") }, "never"));
			} else if (sync.stale && sync.syncedAt !== null) {
				notes.push(react_jsx_runtime.jsx("div", {
					className: "dsbNote dsbWarn",
					children: fmt(t("balance.price.stale"), {
						age: formatAge(t, Date.now() - sync.syncedAt),
						reason: formatSyncError(t, sync.error),
						when: formatWhen(sync.syncedAt)
					})
				}, "stale"));
			} else if (sync.syncedAt !== null) {
				const synced = fmt(t("balance.price.synced"), { when: formatWhen(sync.syncedAt) });
				// 生效时刻只在被手工校准过、或者跟同步时刻明显不是一回事时才提——否则
				// 「同步于 x · 自 x 起生效」两句说的是同一件事，白占一行。
				const effective = sync.effectiveFromSource === "config" && sync.effectiveFrom !== null
					? ` · ${fmt(t("balance.price.effective"), { when: formatWhen(sync.effectiveFrom) })}`
					: "";
				notes.push(react_jsx_runtime.jsx("div", { className: "dsbNote", children: synced + effective }, "synced"));
			}
			for (const at of sync.pendingFrom) {
				notes.push(react_jsx_runtime.jsx("div", { className: "dsbNote", children: fmt(t("balance.price.pending"), { when: formatWhen(at) }) }, "pending:" + at));
			}
			return notes;
		}

		function BalanceDetailsPanel({ t, store }) {
			const open = useStore(store);
			const balanceText = useBalanceText(t);
			const cost = useCostSnapshot();
			const [pricing, setPricing] = react.useState(null);
			// 用量汇总看哪个统计周期。只是一个展示开关，不影响累计逻辑——日/周/月三份
			// 用量本来就一直在各自累加，这里只决定把哪一份摊到表里。
			const [usagePeriod, setUsagePeriod] = react.useState("day");
			// 正在等二次确认的周期（null = 没在确认）。存的是周期而不是布尔值：确认条
			// 上写着「清零『日』…」，中途切到「周」必须连问题一起作废，不能让人对着
			// 「日」的问题点确认、清掉「周」。
			const [confirmReset, setConfirmReset] = react.useState(null);
			const rootRef = react.useRef(null);

			react.useEffect(() => {
				let alive = true;
				getPricing().then((p) => {
					if (alive) setPricing(p);
				});
				return () => {
					alive = false;
				};
			}, []);

			// 面板一关就把没答完的确认收掉：下次打开应该是干净的「重置」按钮，而不是
			// 一条还举着的红色确认条——隔了几分钟再回来，人早忘了自己点过什么。
			react.useEffect(() => {
				if (!open) setConfirmReset(null);
			}, [open]);

			// Esc 关闭：跟点 × 是同一件事的第二种触发方式（Git/市场两个面板同款）。
			react.useEffect(() => {
				if (!open) return undefined;
				const onKeyDown = (e) => {
					if (e.key === "Escape") store.close();
				};
				document.addEventListener("keydown", onKeyDown);
				return () => document.removeEventListener("keydown", onKeyDown);
			}, [open, store]);

			// 点空白处关闭：这个面板不像市场那个是带全屏遮罩的弹窗，只是贴在
			// 右下角的小面板，没有遮罩可点，只能自己在 document 上听 mousedown、
			// 判断点击有没有落在面板节点之外。用 mousedown 而不是 click 是为了
			// 跟原生下拉菜单的习惯保持一致——按下就关，不等松开，体感更跟手。
			//
			// 侧边栏那个切换按钮（.dsbSideBtn）要单独排除：它自己的 onClick 已经
			// 会调 store.toggle()，如果这里的 mousedown 也把它当「面板外」处理，
			// 面板开着时点按钮会先被这里 close()、click 事件再 toggle() 回 open——
			// 两边打架，按钮变成永远关不掉面板。
			react.useEffect(() => {
				if (!open) return undefined;
				const onMouseDown = (e) => {
					if (rootRef.current && rootRef.current.contains(e.target)) return;
					if (e.target?.closest?.(".dsbSideBtn")) return;
					store.close();
				};
				document.addEventListener("mousedown", onMouseDown);
				return () => document.removeEventListener("mousedown", onMouseDown);
			}, [open, store]);

			const live = Array.isArray(cost.live) ? cost.live : (cost.live ? [cost.live] : []);
			const unpricedLive = live.find((item) => !item.priced);
			const configuredModels = configuredModelPricing(pricing);
			// 用量表里的模型顺序跟随下方价格表：按价格表顺序排列，其余排到后面。
			const configuredOrder = new Map(configuredModels.map(([key], index) => [key, index]));
			// 用量表和费用表读的是同一个周期、同一批消息（host 半一次汇总同时给出 token
			// 和金额），所以两张表天然对得上——第 n 行说的是同一个模型的同一批调用。
			const periodSource = usagePeriod === "week" ? cost.weekly : usagePeriod === "month" ? cost.monthly : cost.daily;
			const periodUsage = Array.isArray(periodSource?.perModel) ? periodSource.perModel : [];
			// 有单价没配的模型就在费用表下面点一句：它的 token 数照样列在用量表里，
			// 但金额只能算 0，不说清就成了「用量有、钱不见」。
			const unpriced = periodUsage.filter((m) => !m.priced && (m.tokens.input || m.tokens.cacheRead || m.tokens.output));
			// 当前周期已经是 0 就没什么可清的，按钮置灰——不然点一遍二次确认，结果
			// 什么都没变。
			const hasResettable = periodUsage.length > 0 || Number(periodSource?.totalCost ?? 0) > 0;
			// 顶部展示的 API 厂家：优先单价表里出现的 provider，再并上实际用量里出现的。
			// 用量那边取**三个周期的并集**而不是当前选中的那个：这一行说的是「这台机器
			// 接的是谁」，不该跟着上面切日/周/月一起变。
			const providerNames = [...new Set([
				...Object.keys(pricing?.modelPricing ?? {}).map((key) => key.split(":")[0]),
				...[cost.daily, cost.weekly, cost.monthly]
					.flatMap((source) => (Array.isArray(source?.perModel) ? source.perModel : []))
					.map((m) => m.provider)
					.filter((provider) => Boolean(provider))
			])].map(providerDisplayName).filter((name) => Boolean(name));
			const peakNow = isPeakHours(new Date(), pricing?.peakSchedule);
			// 峰谷这套规则得**这张表里真的有峰价、而且真的有高峰时段**才提。官方哪天
			// 取消峰谷，解析出来的表里既没有 `peak`、倍率是 1，时段窗口也是空的，那时
			// 这一节不该还写着「已按高峰时段折算」。
			const peakPricing = hasPeakPricing(pricing) && (pricing?.peakSchedule?.windows?.length ?? 1) > 0;
			const hasDeepSeek = hasDeepSeekPricing(pricing) && peakPricing;
			const periodLabel = t(peakNow ? "balance.price.peak" : "balance.price.offpeak");
			const multiplier = pricing?.peakMultiplier ?? 1;
			// 单价的同步状态。host 半随 /usage 一起带回来（面板和侧边栏共用那一份），
			// 还没拉到就什么都不说，别在加载期间闪一行「从没同步过」。
			const sync = cost.pricing ?? null;
			// 「命中 0.5 · 未命中 2 · 输出 8」单看是几个裸数字，0.5 是人民币还是美元
			// 全靠猜。币种在标题里说一次就够，不用在每行三个数上各贴一遍。单价表自己
			// 声明的优先；它没说（老配置）就退回花费那边记下的那个；两边都没有时换用
			// 不带币种的标题，而不是渲染出一个「（ / 每百万 token）」的空槽。
			const priceCurrency = pricing?.currency ?? cost.currency ?? null;

			return react_jsx_runtime.jsxs("div", { ref: rootRef, className: "dsbPanel" + (open ? " dsbOpen" : ""), children: [
				react_jsx_runtime.jsxs("div", { className: "dsbPanelHeader", children: [
					react_jsx_runtime.jsx("span", { children: t("balance.panel.title") }),
					react_jsx_runtime.jsxs("span", { className: "dsbHeaderActions", children: [
						react_jsx_runtime.jsx("button", {
							type: "button",
							className: "dsbResetBtn",
							disabled: !hasResettable,
							onClick: () => setConfirmReset(usagePeriod),
							children: t("balance.reset.button")
						}, "reset"),
						react_jsx_runtime.jsx("button", { type: "button", className: "dsbPanelClose", "aria-label": t("balance.panel.close"), onClick: () => store.close(), children: react_jsx_runtime.jsx(CloseIcon, {}) }, "close")
					] })
				] }),
				react_jsx_runtime.jsxs("div", { className: "dsbPanelBody", children: [
					confirmReset === null ? null : react_jsx_runtime.jsxs("div", { className: "dsbConfirmBar", role: "alertdialog", children: [
						react_jsx_runtime.jsx("span", { className: "dsbConfirmText", children: fmt(t("balance.reset.confirm"), { period: t("balance.usage.period." + confirmReset) }) }),
						react_jsx_runtime.jsxs("span", { className: "dsbConfirmActions", children: [
							react_jsx_runtime.jsx("button", {
								type: "button",
								className: "dsbConfirmYes",
								onClick: () => {
									costStore.resetPeriod(confirmReset);
									setConfirmReset(null);
								},
								children: t("balance.reset.yes")
							}, "yes"),
							react_jsx_runtime.jsx("button", {
								type: "button",
								className: "dsbConfirmNo",
								onClick: () => setConfirmReset(null),
								children: t("balance.reset.no")
							}, "no")
						] })
					] }),
					react_jsx_runtime.jsxs("div", { className: "dsbSection", children: [
						react_jsx_runtime.jsxs("div", { className: "dsbRow dsbAccountRow", children: [
							react_jsx_runtime.jsxs("span", { className: "dsbAccountItem", children: [
								react_jsx_runtime.jsx("span", { className: "dsbRowLabel", children: t("balance.provider.title") }),
								react_jsx_runtime.jsx("span", { className: "dsbRowValue", children: providerNames.length > 0 ? providerNames.join(" / ") : "—" })
							] }, "provider"),
							react_jsx_runtime.jsxs("span", { className: "dsbAccountItem", children: [
								react_jsx_runtime.jsx("span", { className: "dsbRowLabel", children: t("balance.label") }),
								react_jsx_runtime.jsx("span", { className: "dsbRowValue", children: balanceText })
							] }, "balance")
						] })
					] }),
					react_jsx_runtime.jsxs("div", { className: "dsbSection", children: [
						react_jsx_runtime.jsx("div", { className: "dsbSectionTitle", children: t("balance.usage.summary.title") }),
						react_jsx_runtime.jsx("div", { className: "dsbPeriodTabs", role: "tablist", children: USAGE_PERIODS.map((period) => react_jsx_runtime.jsx("button", {
							type: "button",
							role: "tab",
							"aria-selected": usagePeriod === period,
							className: "dsbPeriodTab" + (usagePeriod === period ? " dsbActive" : ""),
							onClick: () => {
								// 切周期要把没答完的确认收掉：确认条上写着「清零『日』…」，
								// 中途切到「周」还留着那句话，点确认就成了答非所问。
								setConfirmReset(null);
								setUsagePeriod(period);
							},
							children: t("balance.usage.period." + period)
						}, period)) }),
						react_jsx_runtime.jsx(UsageTable, {
							t,
							models: periodUsage,
							configuredOrder,
							empty: t("balance.usage.summary.empty")
						})
					] }),
					react_jsx_runtime.jsxs("div", { className: "dsbSection", children: [
						// 标题里带上周期：选择器在上一节里（两节共用同一个），隔着一张表看
						// 过来，不写清楚就分不出这张表算的是哪一段时间。
						react_jsx_runtime.jsx("div", { className: "dsbSectionTitle", children: fmt(t("balance.cost.summary.title"), { period: t("balance.usage.period." + usagePeriod) }) }),
						react_jsx_runtime.jsx(CostTable, {
							t,
							models: periodUsage,
							configuredOrder,
							currency: periodSource?.currency ?? cost.currency ?? pricing?.currency ?? null,
							total: periodSource?.totalCost ?? 0,
							empty: t("balance.cost.summary.empty")
						}),
						...unpriced.map((m) => {
							const label = m.model ? modelShortName(m.model) : t("balance.model.unknown");
							return react_jsx_runtime.jsx("div", { className: "dsbNote", children: fmt(t("balance.cost.unpriced"), { model: label }) }, "unpriced:" + label);
						}),
						(periodSource?.priceChanges?.length ?? 0) > 1
							? react_jsx_runtime.jsx("div", { className: "dsbNote dsbWarn", children: fmt(t("balance.cost.price_change"), { count: periodSource.priceChanges.length }) }, "price_change")
							: null,
						live.some((item) => !item.priced) ? react_jsx_runtime.jsx("div", { className: "dsbNote", children: fmt(t("balance.cost.live_unpriced"), { model: unpricedLive?.model ? modelShortName(unpricedLive.model) : t("balance.model.unknown") }) }, "live_unpriced:" + (unpricedLive?.model ? modelShortName(unpricedLive.model) : t("balance.model.unknown"))) : null,
					] }),
					react_jsx_runtime.jsxs("div", { className: "dsbSection", children: [
						react_jsx_runtime.jsx("div", { className: "dsbSectionTitle", children: fmt(t("balance.price.title"), { period: periodLabel }) }),
						hasDeepSeek
							? react_jsx_runtime.jsxs("div", { className: "dsbNote", children: [
								react_jsx_runtime.jsx("span", { children: fmt(t("balance.price.period_note"), { period: periodLabel }) }),
								react_jsx_runtime.jsx("span", {
									className: "dsbPriceBadge",
									style: {
										color: peakNow ? "var(--dsw-alias-state-business-primary,#4d6bfe)" : "var(--dsw-alias-state-success-primary,#3fb950)",
										backgroundColor: peakNow ? "rgba(77,107,254,.14)" : "rgba(63,185,80,.14)"
									},
									children: t(peakNow ? "balance.price.peak_badge" : "balance.price.offpeak_badge")
								})
							] })
							: react_jsx_runtime.jsx("div", { className: "dsbNote", children: t("balance.price.other_note") }),
						configuredModels.length === 0
							? react_jsx_runtime.jsx("div", { className: "dsbNote", children: "—" })
							: react_jsx_runtime.jsxs("table", { className: "dsbPriceTable", children: [
								react_jsx_runtime.jsxs("thead", { children: react_jsx_runtime.jsxs("tr", { children: [
									react_jsx_runtime.jsx("th", { children: t("balance.price.table.model") }),
									react_jsx_runtime.jsx("th", { children: t("balance.price.table.hit") }),
									react_jsx_runtime.jsx("th", { children: t("balance.price.table.miss") }),
									react_jsx_runtime.jsx("th", { children: t("balance.price.table.output") })
								] }) }),
								react_jsx_runtime.jsxs("tbody", { children: configuredModels.map(([key, base]) => {
									const unit = currencyUnit(priceCurrency);
									// 每个模型按自己那套峰价折算，不是全表乘一个倍率：官方页上峰谷是
									// 两张独立的表，不同模型、不同 token 类别都可能打不同的折。
									const rowPeak = peakNow && isDeepSeekProvider(key.split(":")[0]);
									const rates = effectiveRates(base, rowPeak, multiplier);
									// 这一行的价是从别的模型那儿路由过来的（官方「按 Flash 价格计费」那类
									// 规则）就标一句。不标的话表里会凭空多出几行一模一样的价，看着像坏了。
									const routedTo = pricing?.routedModels?.[key];
									return react_jsx_runtime.jsxs("tr", { children: [
										react_jsx_runtime.jsxs("td", { className: "dsbPriceModel", children: [
											modelShortName(key),
											routedTo === void 0 ? null : react_jsx_runtime.jsx("span", {
												className: "dsbPriceRouted",
												children: `↦ ${routedTo}`
											}, "routed")
										] }),
										react_jsx_runtime.jsx("td", { className: "dsbPriceValue", children: `${formatUnitPrice(rates.cacheHitPerMillion)} ${unit}` }),
										react_jsx_runtime.jsx("td", { className: "dsbPriceValue", children: `${formatUnitPrice(rates.cacheMissPerMillion)} ${unit}` }),
										react_jsx_runtime.jsx("td", { className: "dsbPriceValue", children: `${formatUnitPrice(rates.outputPerMillion)} ${unit}` })
									] }, key);
								}) })
							] }),
						...syncNotes(t, sync)
					] })
				] })
			] });
		}

		const inject = ["slots", "locale"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-balance: dictionaries");
			// modelDirectories 可能是 undefined（比如上游哪天摘掉了这个包）——
			// ctx.get 而不是硬 inject，读不到就退化成「不知道用的哪个 model」，
			// 不阻塞整个插件加载（同 host 半 ctx.get("credentials") 的理由）。
			const modelDirectories = ctx.get("modelDirectories");
			const sessions = ctx.get("sessions");
			// `conversation.chat.turnTail` 上曾经挂过一个逐条上报精确 usage 的探针。
			// 它已经删掉了：那个槽只在「当前工作区里正好被渲染出来的回合」上挂载，
			// 拿它当计费数据源必然漏掉后台会话与没滚到的历史（实测一个月漏掉 99%）。
			// 精确用量改由 host 半从会话事件日志读，那里没有「有没有被渲染到」这回事。

			ctx.slots.inject("conversation.session.header.actions", () => {
				const dispose = ctx.slots.register({
					name: "conversation.session.header.actions",
					id: "balance-live",
					order: 999,
					locale: NS,
					inject: () => ({ modelDirectories })
				}, LiveCostProbe);
				return () => dispose();
			});
			const store = createOpenStore();
			ctx.slots.inject("sidebar.footer.action", () => {
				const dispose = ctx.slots.register({
					name: "sidebar.footer.action",
					id: "balance",
					// order: 120 —— 排序先 priority 后 order 都升序，数字小的在上面；
					// 市场是 110，要排在市场下面（Git 100、终端 90），留了间隔方便以后插队。
					order: 120,
					locale: NS,
					inject: () => ({ store })
				}, BalanceSidebarButton);
				return () => dispose();
			});
			ctx.slots.inject("shell.overlay", () => {
				// 根级静默探针：统计所有工作区/会话的进行中费用，不依赖当前打开的会话。
				const disposeLive = ctx.slots.register({
					name: "shell.overlay",
					id: "balance-all-sessions-live",
					locale: NS,
					inject: () => ({ sessions, modelDirectories })
				}, AllSessionsLiveProbe);
				const disposePanel = ctx.slots.register({
					name: "shell.overlay",
					id: "balance-panel",
					locale: NS,
					inject: () => ({ store })
				}, BalanceDetailsPanel);
				return () => {
					disposeLive();
					disposePanel();
				};
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
