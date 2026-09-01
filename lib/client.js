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
			"balance.spend.session": "本次对话已消费",
			"balance.spend.total": "本次打开共消费",
			"balance.sidebar.title": "余额"
		};
		const en = {
			"balance.label": "Balance",
			"balance.loading": "Loading balance…",
			"balance.error": "Failed to load balance",
			"balance.unavailable": "Account unavailable",
			"balance.spend.session": "This conversation",
			"balance.spend.total": "Since app open",
			"balance.sidebar.title": "Balance"
		};

		const css = ".dsbBal{display:inline-flex;align-items:center;gap:6px;margin-top:12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}.dsbBal .dsbBalValue{color:var(--dsw-alias-label-secondary)}.dsbBal .dsbBalErr{color:var(--dsw-alias-state-error-primary)}"
			+ ".dsbSpend{display:inline-flex;align-items:center;gap:4px;margin-top:2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}.dsbSpend .dsbSpendValue{color:var(--dsw-alias-label-secondary)}"
			// 横向 padding 8px 跟 Git/终端/市场那几个 footer 按钮（.dstFooterBtn 同款
			// box model）对齐——它们是 width:100%+padding:0 8px，图标左边缘落在容器
			// 左边缘往里 8px，我们这块要跟它们左对齐就得用同一个数字，不能照抄别处
			// 随手取的 10px/margin，那样看着就是没对齐。
			+ ".dsbSideWrap{display:flex;flex-direction:column;gap:2px;width:100%;box-sizing:border-box;padding:6px 8px;font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary);cursor:default}.dsbSideWrap .dsbSideRow{display:flex;align-items:center;justify-content:space-between;gap:8px;white-space:nowrap}.dsbSideWrap .dsbSideValue{color:var(--dsw-alias-label-secondary);font-weight:500}"
			+ ".dsbSideIcon{display:flex;align-items:center;width:100%;height:32px;padding:0 8px;box-sizing:border-box;color:var(--dsw-alias-label-secondary);cursor:default}";
		const tagId = "dsh-ui-balance/balance.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-ui-balance";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		/**
		 * 花费预估：按 host 半 `/api/dsdesktop/balance` 顺带回来的 `pricing`（每百万
		 * token 单价）乘 `useProjection("tokenUsage")` 给的 provider 真实用量算出来的
		 * ——不是拿浏览器猜的 token 数，是 DeepSeek 每次响应自己报的 usage 折算的，
		 * 唯一不确定的只有单价本身（见 host 半 `Config` 上的注释）。
		 */
		function estimateCost(usage, pricing) {
			if (!usage || !pricing) return null;
			const tokens = (usage.uncachedInputTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
			return (
				tokens * pricing.cacheMissPerMillion
				+ (usage.cacheReadTokens ?? 0) * pricing.cacheHitPerMillion
				+ (usage.outputTokens ?? 0) * pricing.outputPerMillion
			) / 1e6;
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

		// 本次打开应用的时刻——用来判断一个 Turn 是「这次启动之后发生的」还是
		// 「翻旧会话翻出来的历史」。client.js 的 factory 每次页面加载只跑一遍，
		// 跟「这次打开 APP」是同一个时间点。
		const appOpenTime = Date.now();

		/**
		 * 「本次打开应用共消费」的累加器：跨会话共享（模块级单例，只要没触发
		 * client.js 热重载就一直存活）。
		 *
		 * 不能直接把每个会话的 `tokenUsage`（整条日志从第一条消息起的累计用量）
		 * 加总——重新打开一个几天前的旧会话，它的累计用量早就不是零，会把历史
		 * 消费也算到这次启动头上。也不能简单地「第一次看到这个会话就把当前值当
		 * 基线、不计入」——单轮对话（问一句、答一句就关掉）只会触发一次上报，
		 * 那一轮全部落在「第一次看到」上，会把这次对话的全部花费漏算成 0，而这
		 * 恰恰是最常见的使用方式。
		 *
		 * 真正能用的信号是 Turn 自己的起始时间（`turn.start.time`）：跟 `appOpenTime`
		 * 一比，能确凿地区分「这一轮发生在本次启动之后」和「这是本次启动前就有
		 * 的历史」——前者没有理由不算，后者才该被当基线滤掉。翻开一个老会话时，
		 * 它历史上每一轮的 turnTail 会同时挂载一遍，全部读到同一个当前累计值、
		 * 全部带着「早于 appOpenTime」的时间戳，谁先处理都会把同一个值记成基线；
		 * 之后这个会话里再收工的新一轮，`turn.start.time` 才会晚于 appOpenTime，
		 * 这时候用当前累计值减掉基线，得到的就正好是这一轮真正花的钱。
		 *
		 * 同一个会话在同一时刻可能有多个 turnTail 实例同时挂载（原因同上），全部
		 * 读到同一个 `useProjection` 值、各自触发一次上报——`sessionLast` 是模块级
		 * 共享状态，第一个实例处理完就把基线推到最新值，后到的实例算出的增量是
		 * 0，天然去重，不会重复计费。
		 */
		const appSpendStore = (() => {
			let total = 0;
			let currency = null;
			const listeners = new Set();
			const notify = () => listeners.forEach((fn) => fn());
			const sessionLast = new Map();
			return {
				getTotal: () => total,
				getCurrency: () => currency,
				subscribe: (fn) => {
					listeners.add(fn);
					return () => listeners.delete(fn);
				},
				noteSessionCost(sessionId, cost, unit, turnStartTime) {
					if (sessionId === void 0 || cost === null) return;
					if (currency === null) currency = unit;
					if (!sessionLast.has(sessionId)) {
						const isHistorical = turnStartTime !== void 0 && turnStartTime < appOpenTime;
						// 没证据证明是历史（时间戳缺失，或就是发生在本次启动之后）时，
						// 保守按「全新对话」处理：基线记 0，这一轮全额计入。
						sessionLast.set(sessionId, isHistorical ? cost : 0);
					}
					const last = sessionLast.get(sessionId);
					const delta = cost - last;
					if (delta > 1e-9) {
						sessionLast.set(sessionId, cost);
						total += delta;
						notify();
					}
				}
			};
		})();

		function useAppSpend() {
			const total = react.useSyncExternalStore(appSpendStore.subscribe, appSpendStore.getTotal);
			const currency = react.useSyncExternalStore(appSpendStore.subscribe, appSpendStore.getCurrency);
			return { total, currency };
		}

		// 渲染某一条余额（balance_infos 里的一项）。
		function renderInfo(t, info) {
			const value = info.total_balance ?? info.topped_up_balance;
			const currency = info.currency ?? "";
			return react_jsx_runtime.jsx("span", {
				className: "dsbBalValue",
				children: `${currency} ${value}`
			}, info.currency + ":" + String(value));
		}

		function BalanceTail({ t, sessionId, useProjection, turn }) {
			const [view, setView] = react.useState({ status: "loading", value: null, error: null, pricing: null });

			react.useEffect(() => {
				let alive = true;
				fetch("/api/dsdesktop/balance").then((res) => res.json()).then((result) => {
					if (!alive) return;
					const pricing = result?.pricing ?? null;
					if (!result || !result.ok) {
						setView({ status: "error", value: null, error: result?.error?.message ?? "failed", pricing });
						return;
					}
					setView({ status: "ready", value: result.value, error: null, pricing });
				}).catch((err) => {
					if (alive) setView({ status: "error", value: null, error: String(err), pricing: null });
				});
				return () => {
					alive = false;
				};
			}, []);

			// 本会话累计用量：`tokenUsage` 是整条会话日志从头到现在的累计（不是单条
			// 回合的增量），拿来算「本次对话已消费」正合适——就是这条会话目前一共
			// 花了多少，不需要自己再折算「这一回合花了多少」。
			const usage = typeof useProjection === "function" ? useProjection("tokenUsage") : void 0;
			const cost = estimateCost(usage, view.pricing);

			react.useEffect(() => {
				if (cost === null) return;
				appSpendStore.noteSessionCost(sessionId, cost, view.pricing?.currency ?? "", turn?.start?.time);
			}, [sessionId, cost, view.pricing, turn]);

			const spendLine = cost === null ? null : react_jsx_runtime.jsxs("div", { className: "dsbSpend", children: [
				react_jsx_runtime.jsx("span", { children: t("balance.spend.session") }),
				react_jsx_runtime.jsx("span", { className: "dsbSpendValue", children: formatMoney(view.pricing.currency, cost) })
			] });

			if (view.status === "loading") {
				return react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, { children: [
					react_jsx_runtime.jsx("div", { className: "dsbBal", children: t("balance.loading") }),
					spendLine
				] });
			}
			if (view.status === "error") {
				return react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, { children: [
					react_jsx_runtime.jsxs("div", { className: "dsbBal", children: [
						react_jsx_runtime.jsx("span", { children: t("balance.label") }),
						react_jsx_runtime.jsx("span", { className: "dsbBalErr", children: t("balance.error") })
					] }),
					spendLine
				] });
			}
			const data = view.value ?? {};
			const infos = Array.isArray(data.balance_infos) ? data.balance_infos : [];
			if (infos.length === 0) {
				return react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, { children: [
					react_jsx_runtime.jsxs("div", { className: "dsbBal", children: [
						react_jsx_runtime.jsx("span", { children: t("balance.label") }),
						react_jsx_runtime.jsx("span", { className: "dsbBalValue", children: t("balance.unavailable") })
					] }),
					spendLine
				] });
			}
			return react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, { children: [
				react_jsx_runtime.jsxs("div", { className: "dsbBal", children: [
					react_jsx_runtime.jsx("span", { children: t("balance.label") }),
					...infos.map((info) => renderInfo(t, info))
				] }),
				spendLine
			] });
		}

		function WalletIcon({ size }) {
			return react_jsx_runtime.jsxs("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.3", children: [
				react_jsx_runtime.jsx("rect", { x: "1.5", y: "3.5", width: "13", height: "9.5", rx: "1.8" }),
				react_jsx_runtime.jsx("path", { d: "M1.5 6.2 H14.5" }),
				react_jsx_runtime.jsx("circle", { cx: "11.3", cy: "9.4", r: "0.9", fill: "currentColor", stroke: "none" })
			] });
		}

		// 侧边栏「终端上面」的余额 + 本次打开累计花费面板。同一份余额也在每条回复
		// 下面查过一次（BalanceTail），但那是挂在具体某条会话的回合里、会随着滚动
		// 出现很多份；这里是常驻在侧边栏 footer 的独立占位，各查各的，互不影响。
		function BalanceSidebarInfo({ wide, t }) {
			const [view, setView] = react.useState({ status: "loading", value: null });
			const { total, currency } = useAppSpend();

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
			const balanceText = view.status === "loading"
				? t("balance.loading")
				: infos.length > 0
					? infos.map((info) => `${info.currency ?? ""} ${info.total_balance ?? info.topped_up_balance}`).join(" / ")
					: t(view.status === "error" ? "balance.error" : "balance.unavailable");
			const spendText = currency === null ? "—" : formatMoney(currency, total);

			if (!wide) {
				const title = `${t("balance.sidebar.title")} ${balanceText}\n${t("balance.spend.total")} ${spendText}`;
				return react_jsx_runtime.jsx("div", { className: "dsbSideIcon", title, "aria-label": title, children: react_jsx_runtime.jsx(WalletIcon, { size: 15 }) });
			}
			return react_jsx_runtime.jsxs("div", { className: "dsbSideWrap", children: [
				react_jsx_runtime.jsxs("div", { className: "dsbSideRow", children: [
					react_jsx_runtime.jsx("span", { children: t("balance.sidebar.title") }),
					react_jsx_runtime.jsx("span", { className: "dsbSideValue", children: balanceText })
				] }),
				react_jsx_runtime.jsxs("div", { className: "dsbSideRow", children: [
					react_jsx_runtime.jsx("span", { children: t("balance.spend.total") }),
					react_jsx_runtime.jsx("span", { className: "dsbSideValue", children: spendText })
				] })
			] });
		}

		const inject = ["slots", "locale"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-balance: dictionaries");
			ctx.slots.inject("conversation.chat.turnTail", () => {
				const dispose = ctx.slots.register({
					name: "conversation.chat.turnTail",
					id: "balance",
					select: () => ({}),
					locale: NS,
					inject: () => ({})
				}, BalanceTail);
				return () => dispose();
			});
			ctx.slots.inject("sidebar.footer.action", () => {
				const dispose = ctx.slots.register({
					name: "sidebar.footer.action",
					id: "balance",
					// order: 120 —— 排序先 priority 后 order 都升序，数字小的在上面；
					// 市场是 110，要排在市场下面（Git 100、终端 90），留了间隔方便以后插队。
					order: 120,
					locale: NS,
					inject: () => ({})
				}, BalanceSidebarInfo);
				return () => dispose();
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
