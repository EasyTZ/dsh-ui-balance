window.__ModuleLoader__.load({
	id: "@easytz/dsh-ui-balance",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");

		const NS = "balance";

		const zh = {
			"balance.label": "余额",
			"balance.loading": "余额加载中…",
			"balance.error": "余额查询失败",
			"balance.unavailable": "账户不可用",
			"balance.panel.title": "余额详情",
			"balance.panel.close": "关闭",
			"balance.usage.title": "本次打开用量",
			"balance.usage.empty": "本次打开还没有产生用量",
			"balance.usage.row": "输入(未命中缓存) {input} · 缓存命中 {hit} · 输出 {output}",
			"balance.cost.title": "本次打开花费（预估）",
			"balance.cost.unpriced": "另有 {model} 的用量未配置单价，未计入",
			"balance.cost.live": "含进行中消息的估算值，完成后按实际用量校正",
			"balance.cost.live_unpriced": "进行中消息的模型未配置单价，暂按 0 计，完成后校正",
			"balance.cost.short": "花费",
			"balance.cost.summary.title": "费用汇总",
			"balance.cost.summary.type": "费用类型",
			"balance.cost.summary.amount": "金额",
			"balance.daily.title": "本日费用",
			"balance.monthly.title": "月度费用",
			"balance.price.title": "目前单价（已按{period}折算）",
			"balance.price.title_nocurrency": "目前单价（已按{period}折算）",
			"balance.price.row": "命中 {hit}{unit} · 未命中 {miss}{unit} · 输出 {output}{unit}（每百万 token）",
			"balance.price.table.model": "模型",
			"balance.price.table.hit": "输入命中",
			"balance.price.table.miss": "输入未命中",
			"balance.price.table.output": "输出（每百万 token）",
			"balance.price.unit_note": "以上单价均为每百万 token 的价格",
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
			"balance.panel.title": "Balance details",
			"balance.panel.close": "Close",
			"balance.usage.title": "Usage since app open",
			"balance.usage.empty": "No usage yet since app open",
			"balance.usage.row": "Input (uncached) {input} · Cache hit {hit} · Output {output}",
			"balance.cost.title": "Spend since app open (estimated)",
			"balance.cost.unpriced": "{model} usage has no configured price, excluded",
			"balance.cost.live": "Includes live estimate for the in-progress message; adjusted when final usage arrives",
			"balance.cost.live_unpriced": "In-progress model has no configured price; counted as 0 until final usage arrives",
			"balance.cost.short": "Spend",
			"balance.cost.summary.title": "Cost summary",
			"balance.cost.summary.type": "Cost type",
			"balance.cost.summary.amount": "Amount",
			"balance.daily.title": "Today's cost",
			"balance.monthly.title": "Monthly cost",
			"balance.price.title": "Current price ({period} rate)",
			"balance.price.title_nocurrency": "Current price ({period} rate)",
			"balance.price.row": "Hit {hit}{unit} · Miss {miss}{unit} · Output {output}{unit} (per million tokens)",
			"balance.price.table.model": "Model",
			"balance.price.table.hit": "Input hit",
			"balance.price.table.miss": "Input miss",
			"balance.price.table.output": "Output (per million tokens)",
			"balance.price.unit_note": "All prices are per million tokens",
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
			+ ".dsbPanel{position:fixed;right:20px;bottom:20px;z-index:20;width:min(600px,calc(100vw - 40px));max-height:70vh;display:flex;flex-direction:column;background:var(--dsw-specific-sidebar-fill,#1b1b1c);border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.32);color:var(--dsw-alias-label-primary,#f9fafb);font-size:13px;overflow:hidden;pointer-events:none;opacity:0;transform:translateY(8px);transition:opacity .16s ease,transform .16s ease}"
			+ ".dsbPanel.dsbOpen{opacity:1;pointer-events:auto;transform:translateY(0)}"
			+ ".dsbPanelHeader{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));font-size:14px;font-weight:600}"
			+ ".dsbPanelClose{width:24px;height:24px;border:none;border-radius:6px;background:transparent;color:inherit;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}.dsbPanelClose:hover{background:var(--dsw-alias-interactive-bg-hover)}"
			+ ".dsbPanelBody{overflow-y:auto;padding:8px 16px 16px}"
			// 标题保持不动，正文内容统一缩进 16px，视觉上对齐。
			+ ".dsbPanelBody .dsbSection > .dsbRow,.dsbPanelBody .dsbSection > .dsbNote,.dsbPanelBody .dsbSection > .dsbModelBlock,.dsbPanelBody .dsbSection > .dsbCostTable,.dsbPanelBody .dsbSection > .dsbPriceTable{margin-left:16px}"
			+ ".dsbPanelBody .dsbSection > .dsbCostTable,.dsbPanelBody .dsbSection > .dsbPriceTable{width:calc(100% - 16px)}"
			+ ".dsbSection{padding:12px 0;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06))}.dsbSection:first-child{border-top:none}"
			+ ".dsbSectionTitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-tertiary);margin-bottom:8px}"
			+ ".dsbRow{display:flex;align-items:baseline;justify-content:space-between;gap:10px;line-height:22px}"
			+ ".dsbRowLabel{color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"
			+ ".dsbRowValue{color:var(--dsw-alias-label-secondary);font-weight:500;white-space:nowrap;font-size:13px}"
			// 单价表：用真正的 <table> 展示，模型/命中/未命中/输出各一列，表头只出现一次。
			+ ".dsbPriceTable{width:100%;border-collapse:collapse;font-size:11px;line-height:20px}"
			+ ".dsbPriceTable th{color:var(--dsw-alias-label-tertiary);font-weight:600;text-align:center;padding:3px 6px;white-space:nowrap;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}"
			+ ".dsbPriceTable td{padding:3px 6px;vertical-align:top;text-align:center;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.04))}"
			+ ".dsbPriceTable .dsbPriceModel{color:var(--dsw-alias-label-tertiary);white-space:nowrap;text-align:left}"
			+ ".dsbPriceTable .dsbPriceValue{color:var(--dsw-alias-label-secondary);white-space:nowrap}"
			+ ".dsbPriceTable th:first-child{text-align:left}"
			// 费用汇总表：本次打开/本日/月度三行费用，表头一次展示。
			+ ".dsbCostTable{width:100%;border-collapse:collapse;font-size:12px;line-height:20px}"
			+ ".dsbCostTable th{color:var(--dsw-alias-label-tertiary);font-weight:600;text-align:left;padding:3px 6px;white-space:nowrap;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}"
			+ ".dsbCostTable td{padding:3px 6px;vertical-align:top;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.04))}"
			+ ".dsbCostTable tbody tr:last-child td{border-bottom:none}"
			+ ".dsbModelBlock+.dsbModelBlock{margin-top:6px}"
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

		/**
		 * 本次是否为 DeepSeek 官方 API。侧边栏是 root 槽，拿不到当前会话的
		 * modelDirectories，只能从单价表里判断：默认/官方模型都会以
		 * `deepseek-official:` 开头。用户接第三方 API 时通常不会保留 DEEPSEEK
		 * 的定价键，因此这个判断足以让“峰/谷”只在 DS 调用场景下出现。
		 */
		function hasDeepSeekPricing(pricing) {
			const pricingMap = pricing?.modelPricing;
			if (!pricingMap) return false;
			return Object.keys(pricingMap).some((key) => ["deepseek-official", "deepseek"].includes(key.split(":")[0]));
		}

		/** 只取 DeepSeek 官方模型的价格条目，用于详情面板的“官网全部模型价格表”。 */
		function officialModelPricing(pricing) {
			const pricingMap = pricing?.modelPricing ?? {};
			return Object.entries(pricingMap).filter(([key]) => ["deepseek-official", "deepseek"].includes(key.split(":")[0]));
		}

		/**
		 * 现在是不是 DeepSeek 定价页说的「高峰时段」（北京时间周一至周五
		 * 9:00-12:00、14:00-18:00，其余时段价格减半）。参数化时间是为了能在测试
		 * 里注入固定时刻，不依赖真实系统时钟。用 Intl 按 Asia/Shanghai 取，不管
		 * 用户系统时区是什么，判的都是北京时间——`hourCycle: "h23"` 是为了绕开
		 * Intl 在 hour12:false 下把午夜格式成 "24" 而不是 "0" 的常见坑。
		 * @param {Date} date
		 */
		function isPeakHours(date) {
			const parts = new Intl.DateTimeFormat("en-US", {
				timeZone: "Asia/Shanghai",
				hourCycle: "h23",
				weekday: "short",
				hour: "numeric"
			}).formatToParts(date);
			const weekday = parts.find((p) => p.type === "weekday")?.value;
			const hour = Number(parts.find((p) => p.type === "hour")?.value);
			const isWeekday = weekday !== "Sat" && weekday !== "Sun";
			return isWeekday && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
		}

		/**
		 * 一条 assistant 消息自己的真实用量（不是整条会话的累计）折算成花费；没有
		 * 配置这个 model 的单价就返回 null——不瞎猜价格，只在面板里提示「未计入」。
		 * `priceEntry` 是空闲时段基准价，高峰时段（`peak`）按 `peakMultiplier` 加价，
		 * 跟官方定价页同一套规则。
		 */
		function costOfUsage(usage, priceEntry, peakMultiplier, peak) {
			if (!usage || !priceEntry) return null;
			const multiplier = peak ? (peakMultiplier ?? 1) : 1;
			const missTokens = (usage.inputTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
			return (
				missTokens * priceEntry.cacheMissPerMillion
				+ (usage.cacheReadTokens ?? 0) * priceEntry.cacheHitPerMillion
				+ (usage.outputTokens ?? 0) * priceEntry.outputPerMillion
			) / 1e6 * multiplier;
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

		// 本次打开应用的时刻——用来判断一条消息是「这次启动之后发生的」还是
		// 「翻旧会话翻出来的历史」。client.js 的 factory 每次页面加载只跑一遍，
		// 跟「这次打开 APP」是同一个时间点。
		//
		// 页面可能在对话报错恢复时被整页重载，factory 会再跑一遍；把 appOpenTime
		// 和花费累计一起落在 sessionStorage 里，重载后仍是「这次打开」而不是从
		// 0 重新开始。
		const STORE_KEY = "dsh-ui-balance/costStore/v1";
		function readStoredCost() {
			try {
				if (typeof sessionStorage === "undefined") return null;
				const raw = sessionStorage.getItem(STORE_KEY);
				return raw === null ? null : JSON.parse(raw);
			} catch {
				return null;
			}
		}
		function writeStoredCost(value) {
			try {
				if (typeof sessionStorage === "undefined") return;
				sessionStorage.setItem(STORE_KEY, JSON.stringify(value));
			} catch {
				// 存储不可用（隐私模式 / 配额满）只影响重载后的连续性，不影响本次显示。
			}
		}
		const storedCost = readStoredCost();
		const appOpenTime = storedCost?.appOpenTime ?? Date.now();

		// 月度费用用 localStorage 持久化：它不是「本次打开」的临时口径，而是当月累计，
		// 关掉应用再打开也要能续上。跨月后会按当前月份重新从 0 开始。
		const MONTHLY_STORE_KEY = "dsh-ui-balance/monthlyCostStore/v1";
		function readStoredMonthly() {
			try {
				if (typeof localStorage === "undefined") return null;
				const raw = localStorage.getItem(MONTHLY_STORE_KEY);
				return raw === null ? null : JSON.parse(raw);
			} catch {
				return null;
			}
		}
		function writeStoredMonthly(value) {
			try {
				if (typeof localStorage === "undefined") return;
				localStorage.setItem(MONTHLY_STORE_KEY, JSON.stringify(value));
			} catch {
				// 存储不可用时月度费用仍然可以在本次会话内累计，只是不跨启动保留。
			}
		}
		function monthKeyOf(date) {
			const d = date instanceof Date ? date : new Date(date);
			return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
		}
		function isSameMonth(date, timestamp) {
			return monthKeyOf(date) === monthKeyOf(timestamp);
		}
		function resetMonthly() {
			return {
				month: monthKeyOf(new Date()),
				currency: null,
				totalCost: 0,
				perModel: new Map(),
				accounted: new Map()
			};
		}
		function readMonthly() {
			const stored = readStoredMonthly();
			const current = monthKeyOf(new Date());
			if (stored?.month !== current) return resetMonthly();
			return {
				month: current,
				currency: stored.currency ?? null,
				totalCost: Number(stored.totalCost ?? 0),
				perModel: new Map(Array.isArray(stored.perModel) ? stored.perModel : []),
				accounted: new Map(Array.isArray(stored.accounted) ? stored.accounted : [])
			};
		}

		// 本日费用也用 localStorage 持久化：当天 00:00 - 23:59:59 的累计，跨启动保留。
		const DAILY_STORE_KEY = "dsh-ui-balance/dailyCostStore/v1";
		function readStoredDaily() {
			try {
				if (typeof localStorage === "undefined") return null;
				const raw = localStorage.getItem(DAILY_STORE_KEY);
				return raw === null ? null : JSON.parse(raw);
			} catch {
				return null;
			}
		}
		function writeStoredDaily(value) {
			try {
				if (typeof localStorage === "undefined") return;
				localStorage.setItem(DAILY_STORE_KEY, JSON.stringify(value));
			} catch {
				// 存储不可用时，本次会话内仍可累计。
			}
		}
		function dayKeyOf(date) {
			const d = date instanceof Date ? date : new Date(date);
			return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
		}
		function resetDaily() {
			return {
				day: dayKeyOf(new Date()),
				currency: null,
				totalCost: 0,
				perModel: new Map(),
				accounted: new Map()
			};
		}
		function readDaily() {
			const stored = readStoredDaily();
			const current = dayKeyOf(new Date());
			if (stored?.day !== current) return resetDaily();
			return {
				day: current,
				currency: stored.currency ?? null,
				totalCost: Number(stored.totalCost ?? 0),
				perModel: new Map(Array.isArray(stored.perModel) ? stored.perModel : []),
				accounted: new Map(Array.isArray(stored.accounted) ? stored.accounted : [])
			};
		}



		/**
		 * 「本次打开用量/花费」的累加器：跨会话共享的模块级单例。
		 *
		 * 按**每条 assistant 消息自己的用量**（`AssistantMessageNode.usage`，provider
		 * 对那一次请求自己报的数字，不是整条会话的累计）计——而不是拿会话级的
		 * `tokenUsage` 投影（那是从会话第一条消息起的全量累计，重新打开一个几天
		 * 前的旧会话会把历史用量也带出来）。单条消息的用量本身就是一个真实、有
		 * 界的「这一次请求花了多少」，只需要用 `turn.start.time` 跟 `appOpenTime`
		 * 一比，就能确凿分清「这条消息发生在本次启动之后」还是「翻旧会话翻出来
		 * 的」——前者计入，后者忽略。
		 *
		 * 每条消息归到哪个 model，用的是**这条消息收工那一刻，这个会话composer
		 * 里当前选中的模型**（`ctx.modelDirectories`）——不是精确的逐条归因（消息
		 * 真正用的 model 理论上可能在请求发出后、收工前被切换掉），但这是浏览器
		 * 端目前唯一拿得到的信号：`AssistantMessageNode.provenance` 字段在这版
		 * dsh 里还没实现（翻过 dsh-client-runtime 源码确认，类型声明有、赋值代码
		 * 没有），没法真的按每条消息精确查出用的哪个 model。
		 *
		 * `accounted` 按 `sessionId:seq` 记录每条消息的归集信息：同一条消息的 turnTail
		 * 只可能触发一次上报（探针挂载时机就是那条消息刚收工那一刻），但热重载、
		 * Strict Mode 或面板重新打开都可能让同一个探针重新跑一遍 effect。Map 既保证
		 * 已计价的记录不会重复计费，也允许「模型目录晚于首报加载完成」时把同一条
		 * 消息从 unknown/未计价迁移到真正的 model 并补记费用。
		 */
		const costStore = (() => {
			let totalCost = Number(storedCost?.totalCost ?? 0);
			let currency = storedCost?.currency ?? null;
			const perModel = new Map(Array.isArray(storedCost?.perModel) ? storedCost.perModel : []);
			// accountKey -> 首次报账时的归集信息。Set 只能去重，无法在「模型目录
			// 晚于首报加载完成」时把同一条消息从 unknown 迁移到真正的 model，所以
			// 记 Map，允许同一条消息在未被计价前修正归属并补记费用。
			const accounted = new Map(Array.isArray(storedCost?.accounted) ? storedCost.accounted : []);
			// 流式估算被折进总额后留下的记录：key = `${sessionId}:${turn}:${step}`，
			// 同一条消息的精确 usage 迟到时，先撤掉估算再按精确值计，避免重复计费。
			const estimatedLive = new Map(Array.isArray(storedCost?.estimatedLive) ? storedCost.estimatedLive : []);
			// 进行中消息的流式估算：**可以同时有多条**（多个会话/多个 turn 并行生成），
			// 用 Map 按 `sessionId:turn:step` 分别保存；最终 usage 到账时由 noteMessage 清掉。
			const live = new Map(
				Array.isArray(storedCost?.liveEntries)
					? storedCost.liveEntries
					: storedCost?.live
						? [[`${storedCost.live.sessionId ?? "unknown"}:${storedCost.live.turn}:${storedCost.live.step ?? ""}`, storedCost.live]]
						: []
			);
			// 本日费用累计器：当天 00:00 - 23:59:59，跨启动保留（localStorage）。
			let daily = readDaily();
			// 月度费用累计器：跨会话、跨启动保留（localStorage），只统计当月 1 日 00:00
			// 到最后一天 23:59:59 的消息。月份切换时自动从 0 开始。
			let monthly = readMonthly();
			const listeners = new Set();
			let rolloverTimer = null;
			let snapshot = freeze();

			function freeze() {
				if (daily.day !== dayKeyOf(new Date())) daily = resetDaily();
				if (monthly.month !== monthKeyOf(new Date())) monthly = resetMonthly();
				return Object.freeze({
					currency,
					totalCost,
					perModel: Object.freeze(
						Array.from(perModel.values()).map((m) => Object.freeze({ ...m, tokens: Object.freeze({ ...m.tokens }) }))
					),
					live: Object.freeze(
						Array.from(live.values()).map((item) => Object.freeze({ ...item, tokens: Object.freeze({ ...item.tokens }) }))
					),
					daily: Object.freeze({
						day: daily.day,
						currency: daily.currency,
						totalCost: daily.totalCost,
						perModel: Object.freeze(
							Array.from(daily.perModel.values()).map((m) => Object.freeze({ ...m, tokens: Object.freeze({ ...m.tokens }) }))
						)
					}),
					monthly: Object.freeze({
						month: monthly.month,
						currency: monthly.currency,
						totalCost: monthly.totalCost,
						perModel: Object.freeze(
							Array.from(monthly.perModel.values()).map((m) => Object.freeze({ ...m, tokens: Object.freeze({ ...m.tokens }) }))
						)
					})
				});
			}
			function persist() {
				writeStoredCost({
					appOpenTime,
					currency,
					totalCost,
					perModel: Array.from(perModel.entries()),
					accounted: Array.from(accounted.entries()),
					estimatedLive: Array.from(estimatedLive.entries()),
					liveEntries: Array.from(live.entries())
				});
				writeStoredDaily({
					day: daily.day,
					currency: daily.currency,
					totalCost: daily.totalCost,
					perModel: Array.from(daily.perModel.entries()),
					accounted: Array.from(daily.accounted.entries())
				});
				writeStoredMonthly({
					month: monthly.month,
					currency: monthly.currency,
					totalCost: monthly.totalCost,
					perModel: Array.from(monthly.perModel.entries()),
					accounted: Array.from(monthly.accounted.entries())
				});
			}
			function notify() {
				snapshot = freeze();
				persist();
				listeners.forEach((fn) => fn());
			}

			function tokenDeltaOf(usage) {
				return {
					input: usage.inputTokens ?? 0,
					cacheRead: usage.cacheReadTokens ?? 0,
					output: usage.outputTokens ?? 0
				};
			}

			function applyDelta(key, tokens, cost, selection, priced) {
				const entry = perModel.get(key) ?? {
					provider: selection?.provider ?? null,
					model: selection?.model ?? null,
					priced,
					tokens: { input: 0, cacheRead: 0, output: 0 },
					cost: 0
				};
				entry.tokens.input += tokens.input;
				entry.tokens.cacheRead += tokens.cacheRead;
				entry.tokens.output += tokens.output;
				entry.priced = entry.priced || priced;
				if (cost !== null) {
					entry.cost += cost;
					totalCost += cost;
				}
				perModel.set(key, entry);
			}

			function removeDelta(key, tokens, cost) {
				const entry = perModel.get(key);
				if (!entry) return;
				entry.tokens.input -= tokens.input;
				entry.tokens.cacheRead -= tokens.cacheRead;
				entry.tokens.output -= tokens.output;
				entry.cost -= cost;
				if (entry.tokens.input <= 0 && entry.tokens.cacheRead <= 0 && entry.tokens.output <= 0 && entry.cost <= 0) {
					perModel.delete(key);
				}
			}

			function monthlyApplyDelta(key, tokens, cost, selection, priced) {
				const entry = monthly.perModel.get(key) ?? {
					provider: selection?.provider ?? null,
					model: selection?.model ?? null,
					priced,
					tokens: { input: 0, cacheRead: 0, output: 0 },
					cost: 0
				};
				entry.tokens.input += tokens.input;
				entry.tokens.cacheRead += tokens.cacheRead;
				entry.tokens.output += tokens.output;
				entry.priced = entry.priced || priced;
				if (cost !== null) {
					entry.cost += cost;
					monthly.totalCost += cost;
				}
				monthly.perModel.set(key, entry);
			}

			function monthlyRemoveDelta(key, tokens, cost) {
				const entry = monthly.perModel.get(key);
				if (!entry) return;
				entry.tokens.input -= tokens.input;
				entry.tokens.cacheRead -= tokens.cacheRead;
				entry.tokens.output -= tokens.output;
				entry.cost -= cost;
				if (entry.tokens.input <= 0 && entry.tokens.cacheRead <= 0 && entry.tokens.output <= 0 && entry.cost <= 0) {
					monthly.perModel.delete(key);
				}
			}

			/**
			 * 把一条最终 assistant 消息计入「本月费用」。不受 appOpenTime 限制：
			 * 只要消息发生时间落在当月 1 日 00:00 - 最后一天 23:59:59，翻旧会话也要算。
			 * 用 monthly.accounted 去重，避免同一条历史消息重复渲染时重复计费。
			 */
			function monthlyAccountMessage(accountKey, turnStartTime, usage, selection, pricing) {
				if (turnStartTime === void 0 || usage === void 0 || usage === null) return false;
				const now = new Date();
				const current = monthKeyOf(now);
				if (monthly.month !== current) monthly = resetMonthly();
				if (monthKeyOf(turnStartTime) !== current) return false;
				if (monthly.currency === null && pricing) monthly.currency = pricing.currency;
				const key = priceKey(selection);
				const priceEntry = pricing && selection ? pricing.modelPricing?.[key] : void 0;
				// 月度费用按「消息实际发生时间」判断峰谷，比统一用当前时刻更准确。
				const peak = isPeakHours(new Date(turnStartTime));
				const cost = costOfUsage(usage, priceEntry, pricing?.peakMultiplier, peak);
				const tokens = tokenDeltaOf(usage);
				const priced = priceEntry !== void 0;
				const next = { key, priced, cost: cost ?? 0, tokens };

				const prior = monthly.accounted.get(accountKey);
				if (prior) {
					if (prior.priced) return false;
					if (prior.key === key && !priced) return false;
					monthlyRemoveDelta(prior.key, prior.tokens, prior.cost);
					monthly.totalCost -= prior.cost;
				}
				monthly.accounted.set(accountKey, next);
				monthlyApplyDelta(key, tokens, cost, selection, priced);
				return true;
			}

			function dailyApplyDelta(key, tokens, cost, selection, priced) {
				const entry = daily.perModel.get(key) ?? {
					provider: selection?.provider ?? null,
					model: selection?.model ?? null,
					priced,
					tokens: { input: 0, cacheRead: 0, output: 0 },
					cost: 0
				};
				entry.tokens.input += tokens.input;
				entry.tokens.cacheRead += tokens.cacheRead;
				entry.tokens.output += tokens.output;
				entry.priced = entry.priced || priced;
				if (cost !== null) {
					entry.cost += cost;
					daily.totalCost += cost;
				}
				daily.perModel.set(key, entry);
			}

			function dailyRemoveDelta(key, tokens, cost) {
				const entry = daily.perModel.get(key);
				if (!entry) return;
				entry.tokens.input -= tokens.input;
				entry.tokens.cacheRead -= tokens.cacheRead;
				entry.tokens.output -= tokens.output;
				entry.cost -= cost;
				if (entry.tokens.input <= 0 && entry.tokens.cacheRead <= 0 && entry.tokens.output <= 0 && entry.cost <= 0) {
					daily.perModel.delete(key);
				}
			}

			/** 把一条最终 assistant 消息计入「本日费用」，当天 00:00 - 23:59:59。 */
			function dailyAccountMessage(accountKey, turnStartTime, usage, selection, pricing) {
				if (turnStartTime === void 0 || usage === void 0 || usage === null) return false;
				const now = new Date();
				const current = dayKeyOf(now);
				if (daily.day !== current) daily = resetDaily();
				if (dayKeyOf(turnStartTime) !== current) return false;
				if (daily.currency === null && pricing) daily.currency = pricing.currency;
				const key = priceKey(selection);
				const priceEntry = pricing && selection ? pricing.modelPricing?.[key] : void 0;
				const peak = isPeakHours(new Date(turnStartTime));
				const cost = costOfUsage(usage, priceEntry, pricing?.peakMultiplier, peak);
				const tokens = tokenDeltaOf(usage);
				const priced = priceEntry !== void 0;
				const next = { key, priced, cost: cost ?? 0, tokens };

				const prior = daily.accounted.get(accountKey);
				if (prior) {
					if (prior.priced) return false;
					if (prior.key === key && !priced) return false;
					dailyRemoveDelta(prior.key, prior.tokens, prior.cost);
					daily.totalCost -= prior.cost;
				}
				daily.accounted.set(accountKey, next);
				dailyApplyDelta(key, tokens, cost, selection, priced);
				return true;
			}


			function sameLive(a, b) {
				return a.sessionId === b.sessionId && a.turn === b.turn && a.step === b.step
					&& a.priced === b.priced
					&& a.tokens.input === b.tokens.input && a.tokens.cacheRead === b.tokens.cacheRead
					&& a.tokens.output === b.tokens.output && a.cost === b.cost
					&& a.provider === b.provider && a.model === b.model;
			}

			function commitLiveNow(sessionId) {
				const keys = Array.from(live.keys()).filter((key) => {
					if (sessionId === void 0) return true;
					return live.get(key)?.sessionId === sessionId;
				});
				for (const key of keys) {
					const item = live.get(key);
					if (!item) continue;
					const modelKey = item.provider && item.model ? priceKey({ provider: item.provider, model: item.model }) : "unknown";
					const tokens = { input: item.tokens?.input ?? 0, cacheRead: item.tokens?.cacheRead ?? 0, output: item.tokens?.output ?? 0 };
					const cost = item.cost ?? 0;
					applyDelta(modelKey, tokens, cost, { provider: item.provider, model: item.model }, item.priced === true);
					estimatedLive.set(key, { key: modelKey, tokens, cost, priced: item.priced === true });
					live.delete(key);
				}
			}
			function clearLiveNow(sessionId, turn, step) {
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

			function noteLiveEstimate({ sessionId, turn, step, tokens, cost, selection, priced, currency: currencyCode }) {
				if (currency === null && currencyCode) currency = currencyCode;
				if (turn === void 0) {
					// partial 消失但还拿不到精确 usage 时，把这个会话的流式估算折进累计。
					commitLiveNow(sessionId);
					notify();
					return;
				}
				const liveKey = `${sessionId ?? "unknown"}:${turn}:${step ?? ""}`;
				const next = {
					sessionId: sessionId ?? null,
					turn,
					step: step ?? null,
					provider: selection?.provider ?? null,
					model: selection?.model ?? null,
					priced: priced === true,
					tokens: { input: tokens?.input ?? 0, cacheRead: tokens?.cacheRead ?? 0, output: tokens?.output ?? 0 },
					cost: cost ?? 0
				};
				const prev = live.get(liveKey);
				if (prev && sameLive(prev, next)) return;
				live.set(liveKey, next);
				notify();
			}

			function rolloverIfNeeded() {
				const current = monthKeyOf(new Date());
				if (monthly.month === current) return;
				monthly = resetMonthly();
				notify();
			}
			function ensureRolloverTimer() {
				rolloverIfNeeded();
				if (rolloverTimer !== null) return;
				// 每分钟检查一次，最多延迟 1 分钟就会把 localStorage 滚到新月份。
				rolloverTimer = setInterval(rolloverIfNeeded, 60 * 1000);
			}


			return {
				getSnapshot: () => snapshot,
				subscribe(fn) {
					listeners.add(fn);
					ensureRolloverTimer();
					return () => {
						listeners.delete(fn);
						if (listeners.size === 0 && rolloverTimer !== null) {
							clearInterval(rolloverTimer);
							rolloverTimer = null;
						}
					};
				},
				noteLiveEstimate,
				commitLive(sessionId) {
					if (live.size === 0) return;
					commitLiveNow(sessionId);
					notify();
				},
				clearLive(sessionId, turn, step) {
					if (clearLiveNow(sessionId, turn, step)) notify();
				},
				noteMessage(sessionId, accountKey, turnStartTime, usage, selection, pricing, turnId, step) {
					if (accountKey === void 0 || usage === void 0 || usage === null) return;
					let touched = false;
					// 同一条消息的精确 usage 到账前，先把可能已经折进总额的流式估算
					// 撤掉，避免估算和精确值重复计费。
					const liveKey = turnId !== void 0 ? `${sessionId}:${turnId}:${step ?? ""}` : void 0;
					if (liveKey !== void 0) {
						const estimated = estimatedLive.get(liveKey);
						if (estimated) {
							removeDelta(estimated.key, estimated.tokens, estimated.cost);
							totalCost -= estimated.cost;
							estimatedLive.delete(liveKey);
							touched = true;
						}
					}
					// 本日/月度费用不受「本次打开」限制：当天/当月内消息哪怕是翻旧会话翻出来的也要计。
					if (dailyAccountMessage(accountKey, turnStartTime, usage, selection, pricing)) touched = true;
					if (monthlyAccountMessage(accountKey, turnStartTime, usage, selection, pricing)) touched = true;
					if (turnStartTime === void 0 || turnStartTime < appOpenTime) { // 历史消息，不计入本次启动
						if (touched) notify();
						return;
					}

					if (currency === null && pricing) currency = pricing.currency;
					const key = priceKey(selection);
					const priceEntry = pricing && selection ? pricing.modelPricing?.[key] : void 0;
					const peak = isPeakHours(new Date());
					const cost = costOfUsage(usage, priceEntry, pricing?.peakMultiplier, peak);
					const tokens = tokenDeltaOf(usage);
					const priced = priceEntry !== void 0;
					const next = { key, priced, cost: cost ?? 0, tokens };

					const prior = accounted.get(accountKey);
					if (prior) {
						// 已经按某个模型报过账。已计价的记录是终态：后续重渲染/热重载
						// 不得重复计费，也不能因为用户之后切换了选择器而迁移。
						if (prior.priced) {
							if (touched) notify();
							return;
						}
						// 首次报账时模型目录可能还没加载出来（selection 为 null），当时
						// 只能记成 unknown/未计价。目录加载后 effect 会重跑，这里把同一条
						// 消息迁移到真正的模型，并补记费用。
						if (prior.key === key && !priced) {
							if (touched) notify();
							return;
						}
						removeDelta(prior.key, prior.tokens, prior.cost);
						totalCost -= prior.cost;
						touched = true;
					}
					accounted.set(accountKey, next);
					if (clearLiveNow(sessionId, turnId, step)) touched = true;
					applyDelta(key, tokens, cost, selection, priced);
					touched = true;
					if (touched) notify();
				}
			};
		})();

		function useCostSnapshot() {
			return react.useSyncExternalStore(costStore.subscribe, costStore.getSnapshot);
		}

		/**
		 * 「本次打开花费」的显示文本。侧边栏和详情面板共用同一个函数——同一个数字
		 * 在两处显示成不一样的东西，用户第一反应是「哪个才是真的」。
		 *
		 * **还没产生任何花费时显示 0，不是「—」**：破折号在这个面板里的含义是
		 * 「读不出来」（余额查询失败、单价没配），而「这次打开还没花钱」是一个确定
		 * 的事实，把它显示成「读不出来」等于把好消息报成故障。
		 *
		 * 币种在记下第一笔之前是 null，退回单价表声明的那个；连单价表都没有时才
		 * 只显示裸数字。
		 */
		function formatSpend(cost, fallbackCurrency) {
			const liveCost = Array.isArray(cost.live)
				? cost.live.reduce((sum, item) => sum + (item.cost ?? 0), 0)
				: (cost.live?.cost ?? 0);
			const amount = cost.totalCost + liveCost;
			const currency = cost.currency ?? fallbackCurrency ?? null;
			return currency === null ? formatMoney("", amount).trim() : formatMoney(currency, amount);
		}

		/** 本日费用显示：金额来自 daily.totalCost，币种优先本日记录，退回单价表。 */
		function formatDailyCost(cost, fallbackCurrency) {
			const amount = cost.daily?.totalCost ?? 0;
			const currency = cost.daily?.currency ?? cost.currency ?? fallbackCurrency ?? null;
			return currency === null ? formatMoney("", amount).trim() : formatMoney(currency, amount);
		}

		/** 月度费用独立显示：金额来自 monthly.totalCost，币种优先月度自身记录，退回单价表。 */
		function formatMonthlyCost(cost, fallbackCurrency) {
			const amount = cost.monthly?.totalCost ?? 0;
			const currency = cost.monthly?.currency ?? cost.currency ?? fallbackCurrency ?? null;
			return currency === null ? formatMoney("", amount).trim() : formatMoney(currency, amount);
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

		/** 单价表里的币种，只用来给「还没花过钱」时的 0 配个单位。 */
		function usePricingCurrency() {
			return usePricing()?.currency ?? null;
		}

		// modelDirectories 服务不可用（比如上游哪天摘掉了这个包）或者会话还没
		// 选过模型时，useSyncExternalStore 也要有稳定的 subscribe/getSnapshot
		// 可调——不能因为拿不到 store 就跳过这个 hook，React 的 hooks 顺序不允许
		// 条件调用。
		const NULL_DIRECTORY_STORE = { getSnapshot: () => null, subscribe: () => () => {} };

		/**
		 * 静默探针：挂在 `conversation.chat.turnTail`（历史上每一轮回合都会挂一份），
		 * 不渲染任何东西——花费信息现在只在侧边栏的详情面板里看，这里只负责把
		 * 「这条消息自己的用量 + 当前选中的模型」读出来喂给 costStore。之所以留在
		 * 这个槽而不是挪进侧边栏，是因为只有 `scope: 'session'` 的槽才会被框架自动
		 * 注入 `useSession` / `sessionId`（侧边栏是 `scope: 'root'`，拿不到当前会话
		 * 的消息数据，也拿不到这条会话自己的模型选择）。
		 */
		function MessageCostProbe({ sessionId, useSession, turn, seq, modelDirectories }) {
			const node = typeof useSession === "function"
				? useSession((snapshot) => snapshot.nodes.find((n) => n.kind === "assistant" && n.seq === seq))
				: void 0;

			const directory = modelDirectories && sessionId !== void 0 ? modelDirectories.directoryFor(sessionId) : void 0;
			const directoryState = react.useSyncExternalStore(
				directory ? directory.store.subscribe : NULL_DIRECTORY_STORE.subscribe,
				directory ? directory.store.getSnapshot : NULL_DIRECTORY_STORE.getSnapshot
			);

			// 单价要等 getPricing() 的 Promise 真的落定（成功或失败）才能报账，不能
			// 先拿 pricing=null 报一次、等状态更新了再报一次——`noteMessage` 里
			// `accounted` 是按 seq 去重的一次性标记，第一次报账时不管单价到没到都
			// 会把这条 seq 标记成「已处理」，等真正的单价随后才到，第二次调用会被
			// dedup 直接吃掉，这条消息就永远卡在「未配置单价」，哪怕单价其实是有
			// 的。把整个「等单价、再报账」收进同一个 effect、单价用局部变量接，
			// 不经 useState 状态往返，就不存在这个先报后到的时间差了。
			react.useEffect(() => {
				if (!node || node.usage === void 0) return;
				let alive = true;
				getPricing().then((pricing) => {
					if (!alive) return;
					costStore.noteMessage(sessionId, `${sessionId}:${seq}`, turn?.start?.time, node.usage, directoryState?.current ?? void 0, pricing, turn?.turn, node?.step);
				});
				return () => {
					alive = false;
				};
			}, [node, sessionId, seq, turn, directoryState]);

			return null;
		}

	/**
	 * 常驻 session 头部的静默探针：只做一件事——把当前正在流式生成的 partial
	 * 文本按字符数估算成输出 token，写进 costStore.live。turnTail 探针只在回合
	 * 结束那一刻才挂载，单靠它的话，长回复生成期间面板上的花费不会动；这里补上
	 * 流式过程中的估算，最终 usage 到账后再由 noteMessage 清掉并替换成精确值。
	 */
	function LiveCostProbe({ sessionId, useSession, modelDirectories }) {
		const partial = useSession((s) => s.partial);
		const turnTimings = useSession((s) => s.turnTimings);
		const directory = modelDirectories && sessionId !== void 0 ? modelDirectories.directoryFor(sessionId) : void 0;
		const directoryState = react.useSyncExternalStore(
			directory ? directory.store.subscribe : NULL_DIRECTORY_STORE.subscribe,
			directory ? directory.store.getSnapshot : NULL_DIRECTORY_STORE.getSnapshot
		);
		react.useEffect(() => {
			if (!partial || !Array.isArray(partial.blocks)) {
				// partial 消失不代表该把 live 清掉：对话报错时 partial 同样会消失，
				// 而那条消息的精确 usage 永远不会到账。把 live 折进累计，至少保住
				// 流式阶段已经算出来的估算花费，而不是清零。
				costStore.commitLive(sessionId);
				return undefined;
			}
			const turnId = partial.turn;
			const startTime = turnTimings?.get?.(turnId)?.startTime ?? void 0;
			if (startTime !== void 0 && startTime < appOpenTime) {
				costStore.clearLive(sessionId, turnId);
				return undefined;
			}
			const selection = directoryState?.current ?? void 0;
			let alive = true;
			getPricing().then((pricing) => {
				if (!alive) return;
				const key = priceKey(selection);
				const priceEntry = pricing && selection ? pricing.modelPricing?.[key] : void 0;
				const peak = isPeakHours(new Date());
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
			const partial = snapshot?.partial ?? null;
			if (!partial || !Array.isArray(partial.blocks)) {
				// 跟 LiveCostProbe 同规则：partial 消失（比如报错）时把该会话的流式
				// 估算折进累计，而不是悄悄清零。
				costStore.commitLive(sessionId);
				return;
			}
			const turnId = partial.turn;
			const startTime = snapshot?.turnTimings?.get?.(turnId)?.startTime ?? void 0;
			if (startTime !== void 0 && startTime < appOpenTime) {
				costStore.clearLive(sessionId, turnId);
				return;
			}
			let selection;
			try {
				const directory = modelDirectories && sessionId !== void 0 ? modelDirectories.directoryFor(sessionId) : void 0;
				selection = directory?.store?.getSnapshot?.()?.current ?? void 0;
			} catch {
				selection = void 0;
			}
			getPricing().then((pricing) => {
				if (feedVersion !== void 0 && !isCurrent()) return;
				const key = priceKey(selection);
				const priceEntry = pricing && selection ? pricing.modelPricing?.[key] : void 0;
				const peak = isPeakHours(new Date());
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
					cost
				});
			});
		}

		/**
		 * 根级静默探针：通过 sessions.list 拿到所有会话，再逐个订阅 session 快照。
		 * 这样无论当前打开哪个工作区，都会统计所有正在进行的对话。
		 */
		function AllSessionsLiveProbe({ sessions, modelDirectories }) {
			const list = react.useSyncExternalStore(
				sessions?.list?.subscribe ?? NULL_DIRECTORY_STORE.subscribe,
				sessions?.list?.getSnapshot ?? NULL_DIRECTORY_STORE.getSnapshot
			);
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
							? { status: "ready", value: result.value }
							: { status: "error", value: null };
						inFlight = null;
						notify();
					})
					.catch(() => {
						snapshot = { status: "error", value: null };
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
			if (infos.length === 0) return t(view.status === "error" ? "balance.error" : "balance.unavailable");
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

		// 侧边栏折起来（56px 窄栏）时容不下一整行文字：Git/终端/市场那几个
		// footer 按钮在这个状态下都是只显示一个图标，我们跟着同一个规矩来，
		// 不然这一项比其他几项高/宽出一截，会把同一列里别的图标挤到看不见
		// （实测过——之前一直渲染整行文字，折叠态直接把另外三个挤没了）。
		function BalanceSidebarButton({ wide, t, store }) {
			const balanceText = useBalanceText(t);
			const cost = useCostSnapshot();
			const pricing = usePricing();
			const costText = formatSpend(cost, pricing?.currency ?? null);
			const balanceLabel = `${t("balance.label")} ${balanceText}`;
			const costLabel = `${t("balance.cost.short")} ${costText}`;
			// 只有 DeepSeek 官方 API 才适用“峰谷”计价规则；第三方中转/兼容 API 不贴角标。
			const peakNow = isPeakHours(new Date());
			const isDeepSeek = hasDeepSeekPricing(pricing);
			const priceBadge = isDeepSeek ? t(peakNow ? "balance.price.peak_badge" : "balance.price.offpeak_badge") : null;
			const priceBadgeClass = peakNow ? "dsbSidePeak" : "dsbSideOffpeak";
			const priceBadgeTitle = isDeepSeek ? t(peakNow ? "balance.price.peak" : "balance.price.offpeak") : null;
			// title/aria 用**完整**那句（不是可视标签的「花费」）：可视标签靠紧挨着
			// 「余额」的上下文就能读懂，悬浮提示没有那个上下文，得自己说清是哪段时间的
			// 花费。折叠成图标时它更是唯一能读到这两个数的地方。
			const label = `${balanceLabel} · ${t("balance.cost.title")} ${costText}${priceBadgeTitle ? ` · ${priceBadgeTitle}` : ""}`;
			if (!wide) {
				return react_jsx_runtime.jsx("button", {
					type: "button",
					className: "dsbSideIcon",
					title: label,
					"aria-label": label,
					onClick: () => {
						store.toggle();
						balanceStore.refresh();
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

		/**
		 * 显示完整的 `provider:model`（不是光秃秃的 model 名），而不是 host 半
		 * `Config.modelPricing` 要用的键一模一样——用户接的不是 DeepSeek 而是
		 * 别家 API 时，这一行就是「该往 Config 里加哪个键」的现成答案，不用另外
		 * 去猜 provider 怎么拼。
		 */
		function ModelUsageRow({ t, entry }) {
			const label = entry.provider && entry.model ? priceKey({ provider: entry.provider, model: entry.model }) : t("balance.model.unknown");
			return react_jsx_runtime.jsxs("div", { className: "dsbModelBlock", children: [
				react_jsx_runtime.jsx("div", { className: "dsbRowLabel", children: label }),
				react_jsx_runtime.jsx("div", { className: "dsbNote", children: fmt(t("balance.usage.row"), {
					input: formatTokens(entry.tokens.input),
					hit: formatTokens(entry.tokens.cacheRead),
					output: formatTokens(entry.tokens.output)
				}) })
			] });
		}

		function BalanceDetailsPanel({ t, store }) {
			const open = react.useSyncExternalStore(store.subscribe, store.getSnapshot);
			const balanceText = useBalanceText(t);
			const cost = useCostSnapshot();
			const [pricing, setPricing] = react.useState(null);
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

			const unpriced = cost.perModel.filter((m) => !m.priced && (m.tokens.input || m.tokens.cacheRead || m.tokens.output));
			const live = Array.isArray(cost.live) ? cost.live : (cost.live ? [cost.live] : []);
			const unpricedLive = live.find((item) => !item.priced);
			const officialModels = officialModelPricing(pricing);
			const peakNow = isPeakHours(new Date());
			const periodLabel = t(peakNow ? "balance.price.peak" : "balance.price.offpeak");
			const multiplier = peakNow ? (pricing?.peakMultiplier ?? 1) : 1;
			// 「命中 0.5 · 未命中 2 · 输出 8」单看是几个裸数字，0.5 是人民币还是美元
			// 全靠猜。币种在标题里说一次就够，不用在每行三个数上各贴一遍。单价表自己
			// 声明的优先；它没说（老配置）就退回花费那边记下的那个；两边都没有时换用
			// 不带币种的标题，而不是渲染出一个「（ / 每百万 token）」的空槽。
			const priceCurrency = pricing?.currency ?? cost.currency ?? null;

			return react_jsx_runtime.jsxs("div", { ref: rootRef, className: "dsbPanel" + (open ? " dsbOpen" : ""), children: [
				react_jsx_runtime.jsxs("div", { className: "dsbPanelHeader", children: [
					react_jsx_runtime.jsx("span", { children: t("balance.panel.title") }),
					react_jsx_runtime.jsx("button", { type: "button", className: "dsbPanelClose", "aria-label": t("balance.panel.close"), onClick: () => store.close(), children: "×" })
				] }),
				react_jsx_runtime.jsxs("div", { className: "dsbPanelBody", children: [
					react_jsx_runtime.jsxs("div", { className: "dsbSection", children: [
						react_jsx_runtime.jsx("div", { className: "dsbSectionTitle", children: t("balance.label") }),
						react_jsx_runtime.jsx("div", { className: "dsbRow", children: react_jsx_runtime.jsx("span", { className: "dsbRowValue", children: balanceText }) })
					] }),
					react_jsx_runtime.jsxs("div", { className: "dsbSection", children: [
						react_jsx_runtime.jsx("div", { className: "dsbSectionTitle", children: t("balance.usage.title") }),
						cost.perModel.length === 0
							? react_jsx_runtime.jsx("div", { className: "dsbNote", children: t("balance.usage.empty") })
							: cost.perModel.map((m) => react_jsx_runtime.jsx(ModelUsageRow, { t, entry: m }, priceKey({ provider: m.provider, model: m.model })))
					] }),
					react_jsx_runtime.jsxs("div", { className: "dsbSection", children: [
						react_jsx_runtime.jsx("div", { className: "dsbSectionTitle", children: t("balance.cost.summary.title") }),
						react_jsx_runtime.jsxs("table", { className: "dsbCostTable", children: [
							react_jsx_runtime.jsxs("thead", { children: react_jsx_runtime.jsxs("tr", { children: [
								react_jsx_runtime.jsx("th", { children: t("balance.cost.summary.type") }),
								react_jsx_runtime.jsx("th", { children: t("balance.cost.summary.amount") })
							] }) }),
							react_jsx_runtime.jsxs("tbody", { children: [
								react_jsx_runtime.jsxs("tr", { children: [
									react_jsx_runtime.jsx("td", { children: t("balance.cost.title") }),
									react_jsx_runtime.jsx("td", { children: formatSpend(cost, pricing?.currency ?? null) })
								] }, "app"),
								react_jsx_runtime.jsxs("tr", { children: [
									react_jsx_runtime.jsx("td", { children: t("balance.daily.title") }),
									react_jsx_runtime.jsx("td", { children: formatDailyCost(cost, pricing?.currency ?? null) })
								] }, "daily"),
								react_jsx_runtime.jsxs("tr", { children: [
									react_jsx_runtime.jsx("td", { children: t("balance.monthly.title") }),
									react_jsx_runtime.jsx("td", { children: formatMonthlyCost(cost, pricing?.currency ?? null) })
								] }, "monthly")
							] })
						] }),
						...unpriced.map((m) => {
							const label = m.provider && m.model ? priceKey({ provider: m.provider, model: m.model }) : t("balance.model.unknown");
							return react_jsx_runtime.jsx("div", { className: "dsbNote", children: fmt(t("balance.cost.unpriced"), { model: label }) }, "unpriced:" + label);
						}),
						live.length > 0 ? react_jsx_runtime.jsx("div", { className: "dsbNote", children: t("balance.cost.live") }, "live") : null,
						live.some((item) => !item.priced) ? react_jsx_runtime.jsx("div", { className: "dsbNote", children: fmt(t("balance.cost.live_unpriced"), { model: unpricedLive?.provider && unpricedLive?.model ? priceKey({ provider: unpricedLive.provider, model: unpricedLive.model }) : t("balance.model.unknown") }) }, "live_unpriced:" + (unpricedLive?.provider && unpricedLive?.model ? priceKey({ provider: unpricedLive.provider, model: unpricedLive.model }) : t("balance.model.unknown"))) : null,
					] }),
					react_jsx_runtime.jsxs("div", { className: "dsbSection", children: [
						react_jsx_runtime.jsx("div", { className: "dsbSectionTitle", children: fmt(t("balance.price.title"), { period: periodLabel }) }),
						react_jsx_runtime.jsx("div", { className: "dsbNote", children: t("balance.price.unit_note") }),
						officialModels.length === 0
							? react_jsx_runtime.jsx("div", { className: "dsbNote", children: "—" })
							: react_jsx_runtime.jsxs("table", { className: "dsbPriceTable", children: [
								react_jsx_runtime.jsxs("thead", { children: react_jsx_runtime.jsxs("tr", { children: [
									react_jsx_runtime.jsx("th", { children: t("balance.price.table.model") }),
									react_jsx_runtime.jsx("th", { children: t("balance.price.table.hit") }),
									react_jsx_runtime.jsx("th", { children: t("balance.price.table.miss") }),
									react_jsx_runtime.jsx("th", { children: t("balance.price.table.output") })
								] }) }),
								react_jsx_runtime.jsxs("tbody", { children: officialModels.map(([key, base]) => {
									const unit = currencyUnit(priceCurrency);
									return react_jsx_runtime.jsxs("tr", { children: [
										react_jsx_runtime.jsx("td", { className: "dsbPriceModel", children: key }),
										react_jsx_runtime.jsx("td", { className: "dsbPriceValue", children: `${formatUnitPrice(base.cacheHitPerMillion * multiplier)} ${unit}` }),
										react_jsx_runtime.jsx("td", { className: "dsbPriceValue", children: `${formatUnitPrice(base.cacheMissPerMillion * multiplier)} ${unit}` }),
										react_jsx_runtime.jsx("td", { className: "dsbPriceValue", children: `${formatUnitPrice(base.outputPerMillion * multiplier)} ${unit}` })
									] }, key);
								}) })
							] })
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
			ctx.slots.inject("conversation.chat.turnTail", () => {
				const dispose = ctx.slots.register({
					name: "conversation.chat.turnTail",
					id: "balance",
					select: () => ({}),
					locale: NS,
					inject: () => ({ modelDirectories })
				}, MessageCostProbe);
				return () => dispose();
			});

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
