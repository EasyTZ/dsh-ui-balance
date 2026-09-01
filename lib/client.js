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
			"balance.price.title": "目前单价（每百万 token，已按{period}折算）",
			"balance.price.row": "命中 {hit} · 未命中 {miss} · 输出 {output}",
			"balance.price.peak": "高峰时段",
			"balance.price.offpeak": "空闲时段",
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
			"balance.price.title": "Current price (per million tokens, {period} rate)",
			"balance.price.row": "Hit {hit} · Miss {miss} · Output {output}",
			"balance.price.peak": "peak-hour",
			"balance.price.offpeak": "off-peak",
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
			+ ".dsbSideBtn{display:block;width:100%;box-sizing:border-box;padding:4px 8px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#cfd3d6);cursor:pointer;font-size:12px;font-family:inherit;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsbSideBtn:hover{background:var(--dsw-alias-interactive-bg-hover)}"
			// 折叠态用的图标按钮：box model 照抄 .dstFooterBtn（width:100%+height:32px+
			// padding:0 8px），跟 Git/终端/市场折叠时的图标尺寸对齐，不然这一项
			// 单独大一圈/小一圈，排在同一列里会很显眼。
			+ ".dsbSideIcon{display:flex;align-items:center;justify-content:center;width:100%;height:32px;padding:0 8px;box-sizing:border-box;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#cfd3d6);cursor:pointer}.dsbSideIcon:hover{background:var(--dsw-alias-interactive-bg-hover)}"
			// 关闭态必须 pointer-events:none —— opacity 0 的元素照样拦点击（shell.overlay
			// 的通用规矩，Git/终端两个面板同款写法）。
			//
			// 定位用 right，不能用 left：侧边栏本身就贴在屏幕左边、宽度能到 280px，
			// `left:20px` 会正好落在侧边栏自己的不透明背景底下，面板等于被侧边栏
			// 挡住——看不见也点不到，Git/终端两个面板入口虽然也在左侧栏，但弹出的
			// 面板同样是 right 定位，就是为了绕开这个重叠。
			+ ".dsbPanel{position:fixed;right:20px;bottom:20px;z-index:20;width:min(360px,calc(100vw - 40px));max-height:70vh;display:flex;flex-direction:column;background:var(--dsw-specific-sidebar-fill,#1b1b1c);border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.32);color:var(--dsw-alias-label-primary,#f9fafb);font-size:12px;overflow:hidden;pointer-events:none;opacity:0;transform:translateY(8px);transition:opacity .16s ease,transform .16s ease}"
			+ ".dsbPanel.dsbOpen{opacity:1;pointer-events:auto;transform:translateY(0)}"
			+ ".dsbPanelHeader{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));font-size:13px;font-weight:600}"
			+ ".dsbPanelClose{width:22px;height:22px;border:none;border-radius:6px;background:transparent;color:inherit;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}.dsbPanelClose:hover{background:var(--dsw-alias-interactive-bg-hover)}"
			+ ".dsbPanelBody{overflow-y:auto;padding:4px 12px 12px}"
			+ ".dsbSection{padding:8px 0;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06))}.dsbSection:first-child{border-top:none}"
			+ ".dsbSectionTitle{font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary);margin-bottom:6px}"
			+ ".dsbRow{display:flex;align-items:baseline;justify-content:space-between;gap:10px;line-height:18px}"
			+ ".dsbRowLabel{color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"
			+ ".dsbRowValue{color:var(--dsw-alias-label-secondary);font-weight:500;white-space:nowrap}"
			+ ".dsbModelBlock+.dsbModelBlock{margin-top:6px}"
			+ ".dsbNote{margin-top:4px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px}";
		const tagId = "dsh-ui-balance/balance.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-ui-balance";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		function formatMoney(currency, amount) {
			const n = Number(amount) || 0;
			if (n === 0) return `${currency} 0.00`;
			// 花费金额通常很小（几千 token 也就几分钱），固定两位小数经常显示成
			// 0.00；保留到 4 位小数，再去掉多余的尾随 0，但至少留 2 位。
			let s = n.toFixed(4);
			while (s.endsWith("0") && s.split(".")[1].length > 2) s = s.slice(0, -1);
			return `${currency} ${s}`;
		}

		function formatTokens(n) {
			return Number(n ?? 0).toLocaleString();
		}

		/** ModelSelection -> 单价表的键，跟 host 半 `Config.modelPricing` 的键必须逐字一致。 */
		function priceKey(selection) {
			return selection ? `${selection.provider}:${selection.model}` : "unknown";
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
		const appOpenTime = Date.now();

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
			let totalCost = 0;
			let currency = null;
			const perModel = new Map(); // key -> { provider, model, priced, tokens:{...}, cost }
			// accountKey -> 首次报账时的归集信息。Set 只能去重，无法在「模型目录
			// 晚于首报加载完成」时把同一条消息从 unknown 迁移到真正的 model，所以
			// 记 Map，允许同一条消息在未被计价前修正归属并补记费用。
			const accounted = new Map();
			const listeners = new Set();
			let snapshot = freeze();

			function freeze() {
				return Object.freeze({
					currency,
					totalCost,
					perModel: Object.freeze(
						Array.from(perModel.values()).map((m) => Object.freeze({ ...m, tokens: Object.freeze({ ...m.tokens }) }))
					)
				});
			}
			function notify() {
				snapshot = freeze();
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

			return {
				getSnapshot: () => snapshot,
				subscribe(fn) {
					listeners.add(fn);
					return () => listeners.delete(fn);
				},
				noteMessage(accountKey, turnStartTime, usage, selection, pricing) {
					if (accountKey === void 0 || usage === void 0 || usage === null) return;
					if (turnStartTime === void 0 || turnStartTime < appOpenTime) return; // 历史消息，不计入本次启动

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
						if (prior.priced) return;
						// 首次报账时模型目录可能还没加载出来（selection 为 null），当时
						// 只能记成 unknown/未计价。目录加载后 effect 会重跑，这里把同一条
						// 消息迁移到真正的模型，并补记费用。
						if (prior.key === key && !priced) return;
						removeDelta(prior.key, prior.tokens, prior.cost);
						totalCost -= prior.cost;
					}
					accounted.set(accountKey, next);
					applyDelta(key, tokens, cost, selection, priced);
					notify();
				}
			};
		})();

		function useCostSnapshot() {
			return react.useSyncExternalStore(costStore.subscribe, costStore.getSnapshot);
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
					costStore.noteMessage(`${sessionId}:${seq}`, turn?.start?.time, node.usage, directoryState?.current ?? void 0, pricing);
				});
				return () => {
					alive = false;
				};
			}, [node, sessionId, seq, turn, directoryState]);

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

		/** 拿一次真实余额（会打一次真实 DeepSeek API），按钮和面板各自独立地只查一次。 */
		function useBalanceText(t) {
			const [view, setView] = react.useState({ status: "loading", value: null });
			react.useEffect(() => {
				let alive = true;
				fetch("/api/dsdesktop/balance").then((res) => res.json()).then((result) => {
					if (!alive) return;
					if (!result || !result.ok) {
						setView({ status: "error", value: null });
						return;
					}
					setView({ status: "ready", value: result.value });
				}).catch(() => {
					if (alive) setView({ status: "error", value: null });
				});
				return () => {
					alive = false;
				};
			}, []);
			const infos = Array.isArray(view.value?.balance_infos) ? view.value.balance_infos : [];
			if (view.status === "loading") return t("balance.loading");
			if (infos.length === 0) return t(view.status === "error" ? "balance.error" : "balance.unavailable");
			return infos.map((info) => `${info.currency ?? ""} ${info.total_balance ?? info.topped_up_balance}`).join(" / ");
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
			const label = `${t("balance.label")} ${balanceText}`;
			if (!wide) {
				return react_jsx_runtime.jsx("button", {
					type: "button",
					className: "dsbSideIcon",
					title: label,
					"aria-label": label,
					onClick: () => store.toggle(),
					children: react_jsx_runtime.jsx(WalletIcon, { size: 15 })
				});
			}
			return react_jsx_runtime.jsx("button", {
				type: "button",
				className: "dsbSideBtn",
				title: label,
				"aria-label": label,
				onClick: () => store.toggle(),
				children: label
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
			const priced = cost.perModel.filter((m) => m.priced);
			const peakNow = isPeakHours(new Date());
			const periodLabel = t(peakNow ? "balance.price.peak" : "balance.price.offpeak");
			const multiplier = peakNow ? (pricing?.peakMultiplier ?? 1) : 1;

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
						react_jsx_runtime.jsx("div", { className: "dsbSectionTitle", children: t("balance.cost.title") }),
						react_jsx_runtime.jsx("div", { className: "dsbRow", children: react_jsx_runtime.jsx("span", { className: "dsbRowValue", children: cost.currency === null ? "—" : formatMoney(cost.currency, cost.totalCost) }) }),
						...unpriced.map((m) => {
							const label = m.provider && m.model ? priceKey({ provider: m.provider, model: m.model }) : t("balance.model.unknown");
							return react_jsx_runtime.jsx("div", { className: "dsbNote", children: fmt(t("balance.cost.unpriced"), { model: label }) }, "unpriced:" + label);
						})
					] }),
					react_jsx_runtime.jsxs("div", { className: "dsbSection", children: [
						react_jsx_runtime.jsx("div", { className: "dsbSectionTitle", children: fmt(t("balance.price.title"), { period: periodLabel }) }),
						priced.length === 0
							? react_jsx_runtime.jsx("div", { className: "dsbNote", children: "—" })
							: priced.map((m) => {
								const key = priceKey({ provider: m.provider, model: m.model });
								const base = pricing?.modelPricing?.[key];
								return react_jsx_runtime.jsxs("div", { className: "dsbModelBlock", children: [
									react_jsx_runtime.jsx("div", { className: "dsbRowLabel", children: key }),
									react_jsx_runtime.jsx("div", { className: "dsbNote", children: base ? fmt(t("balance.price.row"), {
										hit: base.cacheHitPerMillion * multiplier,
										miss: base.cacheMissPerMillion * multiplier,
										output: base.outputPerMillion * multiplier
									}) : "—" })
								] }, key);
							})
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
				const dispose = ctx.slots.register({
					name: "shell.overlay",
					id: "balance-panel",
					locale: NS,
					inject: () => ({ store })
				}, BalanceDetailsPanel);
				return () => dispose();
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
