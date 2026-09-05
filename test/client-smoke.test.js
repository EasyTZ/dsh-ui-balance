// 客户端半的冒烟测试：在 node 里伪造 window / React，真跑一遍 factory、apply()
// 与三个槽组件的渲染路径。手法照抄 dsh-terminal-panel 的 test/client-smoke.test.js
// （见其文件顶部注释的两条硬规矩：迷你 React 必须真的会渲染，effect 的 teardown
// 不能在本轮就调）。
//
// 这个文件额外要守的几条是本插件特有的：
//   1. `costStore` 是模块级单例，`MessageCostProbe`（写）跟 `BalanceSidebarButton`
//      / `BalanceDetailsPanel`（读）之间隔着没有 props 传递的共享状态——只有把
//      它们都真的渲染一遍、检查渲染结果，才能证明这条线路是通的。
//   2. 按当前选中模型分开计价、未配置单价的 model 不瞎猜——得真的喂两种
//      selection 进去，看面板渲染出来的东西对不对。
//   3. 高峰/空闲时段价格差一倍，而 `isPeakHours` 读的是真实系统时钟——测试要
//      用 `withFixedNow` 把时间钉死，不然这个文件今天绿、高峰时段跑起来就可能
//      变红（或者反过来，平时绿、一到高峰就红）。

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js");

function flatten(node, out = []) {
	if (node === null || node === undefined || node === false) return out;
	if (Array.isArray(node)) {
		for (const child of node) flatten(child, out);
		return out;
	}
	if (typeof node !== "object") return out;
	out.push(node);
	const children = node.props && node.props.children;
	if (children !== undefined) flatten(children, out);
	return out;
}

/**
 * 把树里的函数组件真的调起来展开（loadModule 内部的 deepRender 在测试外部用不到，
 * 这里是同一套逻辑的对外版）。渲染循环里要在「点击的那一轮」当场检查表格内容，
 * 而 jsx() 只造描述对象——不展开的话，UsageTable 这类子组件的表格根本还没生成，
 * 断言会对着一棵空壳树做判断，看起来「数字不见了」，其实只是没渲染到。
 */
function expandComponents(node, depth = 0) {
	if (node === null || node === undefined || typeof node !== "object" || depth > 60) return node;
	if (Array.isArray(node)) return node.map((child) => expandComponents(child, depth + 1));
	if (typeof node.type === "function") return expandComponents(node.type(node.props), depth + 1);
	const children = node.props && node.props.children;
	if (children === undefined) return node;
	return { ...node, props: { ...node.props, children: expandComponents(children, depth + 1) } };
}

function textOf(nodes) {
	return nodes.map((n) => JSON.stringify((n.props && n.props.children) ?? null) ?? "").join("\n");
}

/** 2026-09-05 是周六，北京时间全天都是空闲时段——用它当「确定不是高峰」的钉死时刻。 */
const OFF_PEAK_ISO = "2026-09-05T02:00:00.000Z";
/** 2026-09-01 周二北京时间 10:00，落在 9-12 高峰窗口内。 */
const PEAK_ISO = "2026-09-01T02:00:00.000Z";

/** 在固定的系统时间下运行 fn（连 `appOpenTime`、`turn.start.time` 的相对偏移都一致）。 */
async function withFixedNow(iso, fn) {
	const RealDate = Date;
	const fixed = new RealDate(iso).getTime();
	class FixedDate extends RealDate {
		constructor(...args) {
			if (args.length === 0) { super(fixed); return; }
			super(...args);
		}
		static now() { return fixed; }
	}
	globalThis.Date = FixedDate;
	try {
		return await fn();
	} finally {
		globalThis.Date = RealDate;
	}
}

const PRICING = {
	currency: "CNY",
	peakMultiplier: 2,
	modelPricing: {
		"deepseek-official:deepseek-v4-flash": { cacheHitPerMillion: 0.05, cacheMissPerMillion: 1.5, outputPerMillion: 4.5 }
	}
};

// /balance/cost-store 那次回填默认走兜底分支（ok:false，不回填）；
// 需要模拟「回填晚到」的测试用 deferCostStore() 把它挂起，自己决定何时放行。
let costStorePending = null;

function fakeFetch(url) {
	const u = String(url);
	if (u.endsWith("/balance/cost-store") && costStorePending !== null) {
		return costStorePending.then((payload) => ({ ok: true, json: async () => payload }));
	}
	if (u.endsWith("/balance/pricing")) {
		return Promise.resolve({ ok: true, json: async () => ({ ok: true, pricing: PRICING }) });
	}
	if (u.endsWith("/dsdesktop/balance")) {
		return Promise.resolve({
			ok: true,
			json: async () => ({ ok: true, value: { balance_infos: [{ currency: "CNY", total_balance: "12.34" }] }, pricing: PRICING })
		});
	}
	return Promise.resolve({ ok: true, json: async () => ({ ok: false, error: { message: "unexpected " + u } }) });
}

/** 造一个够用的 modelDirectories：固定返回某个 selection（或 null 表示还没选过）。 */
function fakeModelDirectories(selection) {
	return {
		directoryFor: () => ({
			store: {
				value: { current: selection },
				subscribe() { assert.ok(this.value); return () => {}; },
				getSnapshot() { return this.value; }
			}
		})
	};
}

/** 造一个可变的 modelDirectories：模拟模型目录晚于探针首报才加载完成。 */
function fakeMutableModelDirectories(initialSelection) {
	let snapshot = { current: initialSelection };
	const listeners = new Set();
	const store = {
		subscribe: (fn) => {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		getSnapshot: () => snapshot
	};
	return {
		directoryFor: () => ({ store }),
		setSelection(selection) {
			snapshot = { current: selection };
			listeners.forEach((fn) => fn());
		}
	};
}

function createStorage() {
	let data = new Map();
	return {
		getItem: (key) => data.has(key) ? data.get(key) : null,
		setItem: (key, value) => { data.set(key, String(value)); },
		removeItem: (key) => { data.delete(key); },
		clear: () => { data.clear(); }
	};
}

function loadModule(sessionStorage = createStorage()) {
	const src = fs.readFileSync(CLIENT, "utf8");
	const registrations = [];
	Object.assign(globalThis, {
		window: { __ModuleLoader__: { load: (reg) => registrations.push(reg) } },
		document: {
			querySelector: () => null,
			createElement: () => ({ dataset: {}, style: {} }),
			head: { appendChild() {} },
			addEventListener() {},
			removeEventListener() {}
		},
		fetch: fakeFetch,
		sessionStorage
	});

	const reactJsx = {
		jsx: (type, props, key) => ({ type, props: props || {}, key }),
		jsxs: (type, props, key) => ({ type, props: props || {}, key }),
		Fragment: Symbol("Fragment")
	};

	// —— 一个够用的迷你 React ——
	// 每次 __render() 都重置 cells：不同组件树共用同一份 cells 数组会把后一棵树
	// 的 hook 状态错读成前一棵的。只在同一次 __render 内部的多轮收敛循环里，
	// hook 状态才需要跨轮持久。
	let cells = [];
	let cursor = 0;
	let dirty = false;
	const effects = [];
	const cell = (init) => {
		const i = cursor++;
		if (cells.length <= i) cells[i] = { v: typeof init === "function" ? init() : init };
		return cells[i];
	};
	const reactHooks = {
		useState(init) {
			const c = cell(init);
			return [c.v, (next) => {
				const value = typeof next === "function" ? next(c.v) : next;
				if (!Object.is(value, c.v)) { c.v = value; dirty = true; }
			}];
		},
		useRef(init) {
			const c = cell(() => ({ current: init }));
			return c.v;
		},
		useCallback: (fn) => fn,
		useMemo: (fn) => fn(),
		useEffect(fn, deps) { effects.push({ fn, deps }); },
		useSyncExternalStore: (_sub, get) => get()
	};
	// 真 React 会继续往下渲染子组件；jsx() 只造一个 {type, props} 描述对象，
	// 函数组件不会自己执行。之前这个文件漏了这一步，导致 ModelUsageRow /
	// WalletIcon 这类嵌套组件从没真的跑过——断言能过纯粹是因为 JSON.stringify
	// 顺带把 props（比如 entry.model 这个原始字符串）序列化了进去，不是因为
	// 组件真的把它渲染成了看得见的节点。这里子组件都不含 hook，深度渲染在
	// render() 之外单独调用是安全的（照抄 dsh-terminal-panel 同款写法）。
	const deepRender = (node, depth = 0) => {
		if (node === null || node === undefined || typeof node !== "object" || depth > 60) return node;
		if (Array.isArray(node)) return node.map((child) => deepRender(child, depth + 1));
		if (typeof node.type === "function") return deepRender(node.type(node.props), depth + 1);
		const children = node.props && node.props.children;
		if (children === undefined) return node;
		return { ...node, props: { ...node.props, children: deepRender(children, depth + 1) } };
	};
	reactHooks.__render = async (render) => {
		cells = [];
		const teardowns = [];
		let last;
		for (let round = 0; round < 12; round += 1) {
			cursor = 0;
			dirty = false;
			effects.length = 0;
			last = deepRender(render());
			const seen = new Set();
			for (const { fn } of effects) {
				if (seen.has(fn)) continue;
				seen.add(fn);
				const teardown = fn();
				if (typeof teardown === "function") teardowns.push(teardown);
			}
			await new Promise((r) => setTimeout(r, 0));
			if (!dirty) break;
		}
		for (const fn of teardowns) fn();
		return last;
	};

	const fakeRequire = (id) => {
		if (id === "react/jsx-runtime") return reactJsx;
		if (id === "react") return reactHooks;
		throw new Error("unexpected require: " + id);
	};
	// eslint-disable-next-line no-eval
	eval(src);
	assert.strictEqual(registrations.length, 1, "应恰好注册一次");
	const mod = registrations[0].factory(fakeRequire);
	mod.__render = reactHooks.__render;
	return mod;
}

const cleanup = () => Object.assign(globalThis, { window: undefined, document: undefined, fetch: undefined, sessionStorage: undefined });

function mount() {
	const mod = loadModule();
	const captured = {};
	const ctx = {
		effect: (fn) => { fn(); return () => {}; },
		locale: { register() {} },
		get: () => void 0, // 默认没有 modelDirectories；需要的测试自己在 apply 之外注入
		slots: {
			inject: (key, cb) => { cb(); return () => {}; },
			register: (o, comp) => { captured[o.name + ":" + o.id] = { opts: o, component: comp }; return () => {}; }
		}
	};
	mod.apply(ctx);
	return { mod, captured, t: (k) => k };
}

function mountWithStorage(sessionStorage) {
	const mod = loadModule(sessionStorage);
	const captured = {};
	const ctx = {
		effect: (fn) => { fn(); return () => {}; },
		locale: { register() {} },
		get: () => void 0,
		slots: {
			inject: (key, cb) => { cb(); return () => {}; },
			register: (o, comp) => { captured[o.name + ":" + o.id] = { opts: o, component: comp }; return () => {}; }
		}
	};
	mod.apply(ctx);
	return { mod, captured, t: (k) => k };
}

/** 造一个够用的 useSession：只支持 selector 形式，读固定的 nodes 数组。 */
function fakeUseSession(nodes) {
	return (selector) => selector({ nodes });
}
/** 造一个更完整的 useSession：可以同时读 nodes / partial / turnTimings。 */
function fakeUseSessionSnapshot(snapshot) {
	return (selector) => selector(snapshot);
}

test("冒烟：四个槽都注册到位", async () => {
	try {
		const { mod, captured } = mount();
		assert.strictEqual(typeof mod.apply, "function");

		const probe = captured["conversation.chat.turnTail:balance"];
		const liveProbe = captured["conversation.session.header.actions:balance-live"];
		const button = captured["sidebar.footer.action:balance"];
		const panel = captured["shell.overlay:balance-panel"];
		assert.ok(probe, "探针应注册进 conversation.chat.turnTail");
		assert.ok(liveProbe, "实时估算探针应注册进 conversation.session.header.actions");
		assert.ok(button, "入口按钮应注册进 sidebar.footer.action");
		assert.ok(panel, "详情面板应注册进 shell.overlay");
		assert.strictEqual(button.opts.order, 120);
		assert.strictEqual(typeof probe.component, "function");
		assert.strictEqual(typeof liveProbe.component, "function");
		assert.strictEqual(typeof button.component, "function");
		assert.strictEqual(typeof panel.component, "function");
	} finally {
		cleanup();
	}
});

test("dsh 0.1.2：会话快照尚无 nodes、外部 store 方法依赖 this 时探针不崩", async () => {
	try {
		const { mod, captured } = mount();
		const Probe = captured["conversation.chat.turnTail:balance"].component;
		const tree = await mod.__render(() => Probe({
			sessionId: "s1",
			seq: 1,
			turn: {},
			useSession: (selector) => selector({}),
			modelDirectories: fakeModelDirectories(null)
		}));
		assert.strictEqual(tree, null);
	} finally {
		cleanup();
	}
});

test("探针不渲染任何东西，按当前选中模型算出花费", async () => {
	await withFixedNow(OFF_PEAK_ISO, async () => {
		try {
			const { mod, captured, t } = mount();
			const Probe = captured["conversation.chat.turnTail:balance"].component;
			const Panel = captured["shell.overlay:balance-panel"].component;

			const node = { kind: "assistant", seq: 1, usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0 } };
			const modelDirectories = fakeModelDirectories({ provider: "deepseek-official", model: "deepseek-v4-flash" });
			const tree = await mod.__render(() => Probe({
				sessionId: "s1", seq: 1, turn: { start: { time: Date.now() + 10 } },
				useSession: fakeUseSession([node]), modelDirectories
			}));
			assert.strictEqual(tree, null, "探针不该渲染任何东西");

			const panelTree = flatten(await mod.__render(() => Panel({ t, store: { subscribe: () => () => {}, getSnapshot: () => true, close() {} } })));
			const text = textOf(panelTree);
			// 空闲时段：(1000*1.5 + 500*4.5) / 1e6 = 0.00375，toFixed(4) 四舍五入成 0.0037
			assert.ok(text.includes("0.0037"), `面板应显示折算出来的花费，实际:\n${text}`);

			// 「用量」小节里，ModelUsageRow 真的把 model 名渲染进了一个可见节点——
			// 不能只在整块 text 里搜子串：「目前单价」小节自己也会独立渲染同一个
			// key，两边都不渲染时子串搜索一样会命中「误报」这条子串本身不来自
			// ModelUsageRow，抓不出 ModelUsageRow 自己渲染错的 bug。
			const usageTitleIdx = panelTree.findIndex((n) => n.props && n.props.children === "balance.usage.title");
			assert.ok(usageTitleIdx >= 0, "应该能找到「用量」这个小节标题");
			const usageLabelNode = panelTree.slice(usageTitleIdx + 1).find((n) => n.props && n.props.className === "dsbPriceModel");
			assert.ok(usageLabelNode, "用量小节下面应该有一个 model 标签节点");
			assert.strictEqual(usageLabelNode.props.children, "deepseek-v4-flash", `用量小节应该只显示模型名，实际: ${usageLabelNode.props.children}`);
		} finally {
			cleanup();
		}
	});
});

test("高峰时段按 2 倍单价折算", async () => {
	await withFixedNow(PEAK_ISO, async () => {
		try {
			const { mod, captured, t } = mount();
			const Probe = captured["conversation.chat.turnTail:balance"].component;
			const Panel = captured["shell.overlay:balance-panel"].component;

			const node = { kind: "assistant", seq: 1, usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0 } };
			const modelDirectories = fakeModelDirectories({ provider: "deepseek-official", model: "deepseek-v4-flash" });
			await mod.__render(() => Probe({
				sessionId: "s1", seq: 1, turn: { start: { time: Date.now() + 10 } },
				useSession: fakeUseSession([node]), modelDirectories
			}));

			const panelTree = flatten(await mod.__render(() => Panel({ t, store: { subscribe: () => () => {}, getSnapshot: () => true, close() {} } })));
			const text = textOf(panelTree);
			// 高峰：空闲价 0.00375 的 2 倍 = 0.0075（这个刚好不落在四舍五入的边界上）
			assert.ok(text.includes("0.0075"), `高峰时段应该是空闲时段的 2 倍，实际:\n${text}`);
		} finally {
			cleanup();
		}
	});
});

test("跨峰谷边界的消息按 turn 开始时刻计价，不按完成时刻", async () => {
	await withFixedNow(PEAK_ISO, async () => {
		try {
			const { mod, captured, t } = mount();
			const Probe = captured["conversation.chat.turnTail:balance"].component;
			const Panel = captured["shell.overlay:balance-panel"].component;

			const node = { kind: "assistant", seq: 1, usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0 } };
			const modelDirectories = fakeModelDirectories({ provider: "deepseek-official", model: "deepseek-v4-flash" });
			// 当前是高峰（周二 10:00），但消息开始于空闲时段（周六 10:00）。
			const offPeakStart = new Date(OFF_PEAK_ISO).getTime();
			await mod.__render(() => Probe({
				sessionId: "s1", seq: 1, turn: { start: { time: offPeakStart } },
				useSession: fakeUseSession([node]), modelDirectories
			}));

			const panelTree = flatten(await mod.__render(() => Panel({ t, store: { subscribe: () => () => {}, getSnapshot: () => true, close() {} } })));
			const costTitleIdx = panelTree.findIndex((n) => n.props && n.props.children === "balance.cost.title");
			const costValueNode = panelTree.slice(costTitleIdx + 1).find((n) => n.type === "td");
			assert.strictEqual(costValueNode.props.children, "0.0037 元", `应按 turn 开始时刻的空闲价计费，实际: ${costValueNode.props.children}`);
		} finally {
			cleanup();
		}
	});
});

test("没配置单价的 model（或还没选过模型）只显示用量、不计费，且不会跟别的 model 混在一起", async () => {
	await withFixedNow(OFF_PEAK_ISO, async () => {
		try {
			const { mod, captured, t } = mount();
			const Probe = captured["conversation.chat.turnTail:balance"].component;
			const Panel = captured["shell.overlay:balance-panel"].component;

			const priced = { kind: "assistant", seq: 1, usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0 } };
			const unpriced = { kind: "assistant", seq: 2, usage: { inputTokens: 999, outputTokens: 999, cacheReadTokens: 0 } };

			await mod.__render(() => Probe({
				sessionId: "s1", seq: 1, turn: { start: { time: Date.now() + 10 } },
				useSession: fakeUseSession([priced, unpriced]),
				modelDirectories: fakeModelDirectories({ provider: "deepseek-official", model: "deepseek-v4-flash" })
			}));
			await mod.__render(() => Probe({
				sessionId: "s1", seq: 2, turn: { start: { time: Date.now() + 10 } },
				useSession: fakeUseSession([priced, unpriced]),
				modelDirectories: fakeModelDirectories({ provider: "some-other", model: "some-model" })
			}));

			const panelTree = flatten(await mod.__render(() => Panel({ t, store: { subscribe: () => () => {}, getSnapshot: () => true, close() {} } })));
			const text = textOf(panelTree);
			assert.ok(text.includes("0.0037"), `已配置单价的部分应正常计费，实际:\n${text}`);
			assert.ok(text.includes("some-model"), `未配置单价的 model 也该显示用量，实际:\n${text}`);
			assert.ok(text.includes("balance.cost.unpriced"), `应提示这部分用量没计入花费，实际:\n${text}`);

			// `flatten`+`textOf` 是把每个节点自己的 children 各自 JSON.stringify 一遍，
			// 父节点的那一行天然包含子树的完整内容——直接在拼起来的大文本里找子串
			// 位置不可靠。要验证「花费金额具体是多少」就该直接找到那个 .dsbRowValue
			// 节点，看它自己的文本。
			const costTitleIdx = panelTree.findIndex((n) => n.props && n.props.children === "balance.cost.title");
			assert.ok(costTitleIdx >= 0, "应该能找到「花费」这个小节标题");
			const costValueNode = panelTree.slice(costTitleIdx + 1).find((n) => n.type === "td");
			assert.ok(costValueNode, "花费小节下面应该有一个金额节点");
			assert.strictEqual(costValueNode.props.children, "0.0037 元", `花费金额只该是 priced 那条算出来的数，不该把 unpriced 的用量也折算进来，实际: ${costValueNode.props.children}`);
		} finally {
			cleanup();
		}
	});
});

test("模型目录晚于探针首报加载完成时，同一条消息应从 unknown 迁移到真实模型并补记费用", async () => {
	await withFixedNow(OFF_PEAK_ISO, async () => {
		try {
			const { mod, captured, t } = mount();
			const Probe = captured["conversation.chat.turnTail:balance"].component;
			const Panel = captured["shell.overlay:balance-panel"].component;

			const node = { kind: "assistant", seq: 1, usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0 } };
			const modelDirectories = fakeMutableModelDirectories(null);

			// 首报时模型目录还没加载出来，selection 为 null：先记成 unknown/未计价。
			await mod.__render(() => Probe({
				sessionId: "s1", seq: 1, turn: { start: { time: Date.now() + 10 } },
				useSession: fakeUseSession([node]), modelDirectories
			}));
			let panelTree = flatten(await mod.__render(() => Panel({ t, store: { subscribe: () => () => {}, getSnapshot: () => true, close() {} } })));
			let costTitleIdx = panelTree.findIndex((n) => n.props && n.props.children === "balance.cost.title");
			let costValueNode = panelTree.slice(costTitleIdx + 1).find((n) => n.type === "td");
			assert.strictEqual(costValueNode.props.children, "0.00 元", `模型目录未加载时不应计费，实际: ${costValueNode.props.children}`);

			// 模型目录随后加载完成，同一条消息必须迁移到真实 model 并补记费用，不能因为
			// accounted 去重而永远卡在 unknown/未计价。
			modelDirectories.setSelection({ provider: "deepseek-official", model: "deepseek-v4-flash" });
			await mod.__render(() => Probe({
				sessionId: "s1", seq: 1, turn: { start: { time: Date.now() + 10 } },
				useSession: fakeUseSession([node]), modelDirectories
			}));

			panelTree = flatten(await mod.__render(() => Panel({ t, store: { subscribe: () => () => {}, getSnapshot: () => true, close() {} } })));
			const text = textOf(panelTree);
			assert.ok(text.includes("0.0037"), `目录加载后应补记费用，实际:\n${text}`);
			costTitleIdx = panelTree.findIndex((n) => n.props && n.props.children === "balance.cost.title");

			costValueNode = panelTree.slice(costTitleIdx + 1).find((n) => n.type === "td");
			assert.strictEqual(costValueNode.props.children, "0.0037 元", `补记后花费金额应为 0.0037，实际: ${costValueNode.props.children}`);
		} finally {
			cleanup();
		}
	});
});


test("流式生成期间用 partial 估算花费并实时显示，消息完成后按精确 usage 校正", async () => {
	await withFixedNow(OFF_PEAK_ISO, async () => {
		try {
			const { mod, captured, t } = mount();
			const LiveProbe = captured["conversation.session.header.actions:balance-live"].component;
			const Probe = captured["conversation.chat.turnTail:balance"].component;
			const Panel = captured["shell.overlay:balance-panel"].component;
			const modelDirectories = fakeModelDirectories({ provider: "deepseek-official", model: "deepseek-v4-flash" });

			// 1000 个 CJK 字符，按我们的启发式 = 1000 个输出 token。
			// 空闲时段 1000 * 4.5 / 1e6 = 0.0045。
			const partial = { turn: 7, step: 1, blocks: [{ kind: "text", text: "你".repeat(1000) }] };
			const snapshot = { nodes: [], partial, turnTimings: undefined };
			const tree = await mod.__render(() => LiveProbe({
				sessionId: "s1",
				useSession: fakeUseSessionSnapshot(snapshot),
				modelDirectories
			}));
			assert.strictEqual(tree, null, "实时探针不该渲染任何东西");

			let panelTree = flatten(await mod.__render(() => Panel({ t, store: { subscribe: () => () => {}, getSnapshot: () => true, close() {} } })));
			let costTitleIdx = panelTree.findIndex((n) => n.props && n.props.children === "balance.cost.title");
			let costValueNode = panelTree.slice(costTitleIdx + 1).find((n) => n.type === "td");
			assert.ok(costValueNode, "花费小节下面应该有一个金额节点");
			assert.strictEqual(costValueNode.props.children, "0.0045 元", `流式期间应显示已完成精确值 + 进行中估算值，实际: ${costValueNode.props.children}`);
			assert.ok(!panelTree.some((n) => n.props && n.props.children === "balance.cost.live"), "流式期间不应再渲染「含进行中估算值」提示行");

			// 消息结束，turnTail 探针用精确 usage 结算：应清掉 live 估算，只剩精确值。
			// 精确用量：(1000*1.5 + 500*4.5) / 1e6 = 0.00375 -> 显示 0.0037。
			const finalNode = { kind: "assistant", seq: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0 } };
			await mod.__render(() => Probe({
				sessionId: "s1", seq: 1, turn: { start: { time: Date.now() + 10 }, turn: 7 },
				useSession: fakeUseSession([finalNode]), modelDirectories
			}));

			panelTree = flatten(await mod.__render(() => Panel({ t, store: { subscribe: () => () => {}, getSnapshot: () => true, close() {} } })));
			costTitleIdx = panelTree.findIndex((n) => n.props && n.props.children === "balance.cost.title");
			costValueNode = panelTree.slice(costTitleIdx + 1).find((n) => n.type === "td");
			assert.strictEqual(costValueNode.props.children, "0.0037 元", `完成后应回到精确值，实际: ${costValueNode.props.children}`);
			assert.ok(!panelTree.some((n) => n.props && n.props.children === "balance.cost.live"), "完成后不应再显示「含进行中估算值」");
		} finally {
			cleanup();
		}
	});
});

test("对话报错时 partial 消失，流式估算会折进累计而不是清零", async () => {
	await withFixedNow(OFF_PEAK_ISO, async () => {
		try {
			const { mod, captured, t } = mount();
			const LiveProbe = captured["conversation.session.header.actions:balance-live"].component;
			const Panel = captured["shell.overlay:balance-panel"].component;
			const modelDirectories = fakeModelDirectories({ provider: "deepseek-official", model: "deepseek-v4-flash" });

			// 流式生成中：1000 个 CJK 字符 ≈ 1000 输出 token，空闲时段 = 0.0045。
			const partial = { turn: 7, step: 1, blocks: [{ kind: "text", text: "你".repeat(1000) }] };
			await mod.__render(() => LiveProbe({
				sessionId: "s1",
				useSession: fakeUseSessionSnapshot({ nodes: [], partial, turnTimings: undefined }),
				modelDirectories
			}));

			// 对话报错：partial 消失，且没有任何带 usage 的最终 assistant 节点。
			await mod.__render(() => LiveProbe({
				sessionId: "s1",
				useSession: fakeUseSessionSnapshot({ nodes: [], partial: null, turnTimings: undefined }),
				modelDirectories
			}));

			const panelTree = flatten(await mod.__render(() => Panel({ t, store: { subscribe: () => () => {}, getSnapshot: () => true, close() {} } })));
			const costTitleIdx = panelTree.findIndex((n) => n.props && n.props.children === "balance.cost.title");
			const costValueNode = panelTree.slice(costTitleIdx + 1).find((n) => n.type === "td");
			assert.ok(costValueNode, "花费小节下面应该有一个金额节点");
			assert.strictEqual(costValueNode.props.children, "0.0045 元", `报错后应保留流式估算而不是清零，实际: ${costValueNode.props.children}`);
		} finally {
			cleanup();
		}
	});
});

test("流式估算折进累计后，精确 usage 到账会替换估算而不是重复计费", async () => {
	await withFixedNow(OFF_PEAK_ISO, async () => {
		try {
			const { mod, captured, t } = mount();
			const LiveProbe = captured["conversation.session.header.actions:balance-live"].component;
			const Probe = captured["conversation.chat.turnTail:balance"].component;
			const Panel = captured["shell.overlay:balance-panel"].component;
			const modelDirectories = fakeModelDirectories({ provider: "deepseek-official", model: "deepseek-v4-flash" });

			const partial = { turn: 7, step: 1, blocks: [{ kind: "text", text: "你".repeat(1000) }] };
			await mod.__render(() => LiveProbe({
				sessionId: "s1",
				useSession: fakeUseSessionSnapshot({ nodes: [], partial, turnTimings: undefined }),
				modelDirectories
			}));
			// partial 消失 → 估算被折进累计（0.0045）。
			await mod.__render(() => LiveProbe({
				sessionId: "s1",
				useSession: fakeUseSessionSnapshot({ nodes: [], partial: null, turnTimings: undefined }),
				modelDirectories
			}));

			// 精确 usage 到账（同一 turn/step）：应撤掉 0.0045 的估算，只保留 0.0037。
			const finalNode = { kind: "assistant", seq: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0 } };
			await mod.__render(() => Probe({
				sessionId: "s1", seq: 1, turn: { start: { time: Date.now() + 10 }, turn: 7 },
				useSession: fakeUseSession([finalNode]), modelDirectories
			}));

			const panelTree = flatten(await mod.__render(() => Panel({ t, store: { subscribe: () => () => {}, getSnapshot: () => true, close() {} } })));
			const costTitleIdx = panelTree.findIndex((n) => n.props && n.props.children === "balance.cost.title");
			const costValueNode = panelTree.slice(costTitleIdx + 1).find((n) => n.type === "td");
			assert.ok(costValueNode, "花费小节下面应该有一个金额节点");
			assert.strictEqual(costValueNode.props.children, "0.0037 元", `精确 usage 应替换估算，实际: ${costValueNode.props.children}`);
		} finally {
			cleanup();
		}
	});
});

test("重载页面后花费从 sessionStorage 恢复，不会清零", async () => {
	await withFixedNow(OFF_PEAK_ISO, async () => {
		const storage = createStorage();
		try {
			const first = mountWithStorage(storage);
			const Probe = first.captured["conversation.chat.turnTail:balance"].component;
			await first.mod.__render(() => Probe({
				sessionId: "s1", seq: 1, turn: { start: { time: Date.now() + 10 } },
				useSession: fakeUseSession([{ kind: "assistant", seq: 1, usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0 } }]),
				modelDirectories: fakeModelDirectories({ provider: "deepseek-official", model: "deepseek-v4-flash" })
			}));

			// 第二个模块实例：模拟页面重载（factory 重跑），共享同一个 sessionStorage。
			const second = mountWithStorage(storage);
			const Panel = second.captured["shell.overlay:balance-panel"].component;
			const panelTree = flatten(await second.mod.__render(() => Panel({ t: (k) => k, store: { subscribe: () => () => {}, getSnapshot: () => true, close() {} } })));
			const costTitleIdx = panelTree.findIndex((n) => n.props && n.props.children === "balance.cost.title");
			const costValueNode = panelTree.slice(costTitleIdx + 1).find((n) => n.type === "td");
			assert.ok(costValueNode, "花费小节下面应该有一个金额节点");
			assert.strictEqual(costValueNode.props.children, "0.0037 元", `重载后应从 sessionStorage 恢复已累计花费，实际: ${costValueNode.props.children}`);
		} finally {
			cleanup();
		}
	});
});

test("历史消息（turn.start.time 早于本次启动）不计入，同一条消息不会重复计费", async () => {
	await withFixedNow(OFF_PEAK_ISO, async () => {
		try {
			const { mod, captured, t } = mount();
			const Probe = captured["conversation.chat.turnTail:balance"].component;
			const Panel = captured["shell.overlay:balance-panel"].component;
			const modelDirectories = fakeModelDirectories({ provider: "deepseek-official", model: "deepseek-v4-flash" });

			const historicalNode = { kind: "assistant", seq: 1, usage: { inputTokens: 100000, outputTokens: 50000, cacheReadTokens: 0 } };
			await mod.__render(() => Probe({
				sessionId: "sOld", seq: 1, turn: { start: { time: Date.now() - 100000 } },
				useSession: fakeUseSession([historicalNode]), modelDirectories
			}));
			let panelTree = flatten(await mod.__render(() => Panel({ t, store: { subscribe: () => () => {}, getSnapshot: () => true, close() {} } })));
			assert.ok(textOf(panelTree).includes("balance.usage.empty"), `历史消息不该计入，实际:\n${textOf(panelTree)}`);

			const freshNode = { kind: "assistant", seq: 2, usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0 } };
			// 同一条消息的探针「挂载」两次（模拟组件因为别的原因重渲染），不该重复计费。
			await mod.__render(() => Probe({ sessionId: "sNew", seq: 2, turn: { start: { time: Date.now() + 10 } }, useSession: fakeUseSession([freshNode]), modelDirectories }));
			await mod.__render(() => Probe({ sessionId: "sNew", seq: 2, turn: { start: { time: Date.now() + 10 } }, useSession: fakeUseSession([freshNode]), modelDirectories }));

			panelTree = flatten(await mod.__render(() => Panel({ t, store: { subscribe: () => () => {}, getSnapshot: () => true, close() {} } })));
			const text = textOf(panelTree);
			assert.ok(text.includes("0.0037"), `应只计入这一条新消息一次，实际:\n${text}`);
		} finally {
			cleanup();
		}
	});
});

test("点击侧边栏按钮会切换面板的开关 store（展开态）", async () => {
	try {
		const { mod, captured, t } = mount();
		const Button = captured["sidebar.footer.action:balance"].component;

		let toggled = false;
		const store = { toggle: () => { toggled = true; } };
		const tree = flatten(await mod.__render(() => Button({ wide: true, t, store })));
		const btn = tree.find((n) => n.type === "button");
		assert.ok(btn, "应渲染出一个可点击的按钮");
		assert.strictEqual(btn.props.className, "dsbSideBtn", "展开态应该是那种没有框的纯文字按钮");
		btn.props.onClick();
		assert.strictEqual(toggled, true, "点击应调用 store.toggle()");
	} finally {
		cleanup();
	}
});

test("折叠态（wide:false）只显示一个图标按钮，不显示整行文字", async () => {
	try {
		const { mod, captured, t } = mount();
		const Button = captured["sidebar.footer.action:balance"].component;

		let toggled = false;
		const store = { toggle: () => { toggled = true; } };
		const tree = flatten(await mod.__render(() => Button({ wide: false, t, store })));
		const btn = tree.find((n) => n.type === "button");
		assert.ok(btn, "折叠态也应该渲染出一个可点击的按钮");
		assert.strictEqual(btn.props.className, "dsbSideIcon", "折叠态应该是图标按钮，跟 Git/终端/市场折叠时一致");
		// 图标按钮的 children 应该是一个 svg 节点，不是整行「余额 CNY xx」的文字——
		// 之前就是因为折叠态还在渲染整行文字，把同一列里另外三个图标挤没了。
		assert.strictEqual(btn.props.children.type, "svg", `折叠态不该渲染文字，应该是图标，实际 children: ${JSON.stringify(btn.props.children)}`);
		btn.props.onClick();
		assert.strictEqual(toggled, true, "折叠态点击也应该调用 store.toggle()");
	} finally {
		cleanup();
	}
});

/** t 的默认实现是「原样返回 key」，要验模板里的占位符有没有被填上就得给一份真模板。 */
function tWith(templates) {
	return (k) => templates[k] ?? k;
}

test("展开态：余额与花费是分开的两段，中间由 CSS 撑出空隙", async () => {
	await withFixedNow(OFF_PEAK_ISO, async () => {
		try {
			const { mod, captured, t } = mount();
			const Probe = captured["conversation.chat.turnTail:balance"].component;
			const Button = captured["sidebar.footer.action:balance"].component;

			// 先产生一笔花费，否则 costText 是「—」，测不到真实数字。
			await mod.__render(() => Probe({
				sessionId: "s1", seq: 1, turn: { start: { time: Date.now() + 10 } },
				useSession: fakeUseSession([{ kind: "assistant", seq: 1, usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0 } }]),
				modelDirectories: fakeModelDirectories({ provider: "deepseek-official", model: "deepseek-v4-flash" })
			}));

			const tree = flatten(await mod.__render(() => Button({ wide: true, t, store: { toggle() {} } })));
			const btn = tree.find((n) => n.type === "button");
			assert.strictEqual(btn.props.className, "dsbSideBtn");

			// **重点是「两个节点」而不是「一个拼起来的字符串」**：靠 `·` 分隔时，
			// CSS 没法在中间撑开空隙，窄栏截断也只能整句一起切。
			const bal = tree.find((n) => n.props && n.props.className === "dsbSideBal");
			const costNode = tree.find((n) => n.props && n.props.className === "dsbSideCost");
			assert.ok(bal, "余额应该是独立的一段");
			assert.ok(costNode, "花费应该是独立的一段");
			assert.match(String(bal.props.children), /balance\.label/, "第一段是余额");
			assert.ok(String(bal.props.children).includes("12.34"), `第一段要带上余额数字，实际: ${bal.props.children}`);

			// 花费的算法必须跟面板里那一行同源：同样是 0.0037，不是另算一份。
			assert.ok(String(costNode.props.children).includes("0.0037 元"),
				`侧边栏花费应与面板同源（0.0037 元），实际: ${costNode.props.children}`);

			// 可视标签用短的（「花费」），紧挨着「余额」就能读懂；title/aria 用完整
			// 那句（「本次打开花费（预估）」）——悬浮提示没有那个上下文，而折叠成图标
			// 时它更是唯一能读到这两个数的地方。两者刻意不同，别顺手改成同一个 key。
			assert.match(String(costNode.props.children), /^balance\.cost\.short /,
				`可视标签应该是短的那个词条，实际: ${costNode.props.children}`);
			assert.ok(btn.props.title.includes("balance.label") && btn.props.title.includes("balance.cost.title"),
				`title 应换用完整那句词条，实际: ${btn.props.title}`);
		} finally {
			cleanup();
		}
	});
});

test("目前单价每行带单位，数字不能把浮点误差原样摊出来", async () => {
	await withFixedNow(PEAK_ISO, async () => {
		try {
			const { mod, captured } = mount();
			const pricing = { currency: "USD", peakMultiplier: 1.3, modelPricing: { "deepseek-official:deepseek-v4-flash": { cacheHitPerMillion: 0.7, cacheMissPerMillion: 1.5, outputPerMillion: 4.5 } } };
			globalThis.fetch = (url) => (String(url).endsWith("/balance/pricing") ? Promise.resolve({ ok: true, json: async () => ({ ok: true, pricing }) }) : Promise.resolve({ ok: true, json: async () => ({ ok: true, value: { balance_infos: [] }, pricing }) }));
			const Probe = captured["conversation.chat.turnTail:balance"].component;
			const Panel = captured["shell.overlay:balance-panel"].component;
			await mod.__render(() => Probe({ sessionId: "s1", seq: 1, turn: { start: { time: Date.now() + 10 } }, useSession: fakeUseSession([{ kind: "assistant", seq: 1, usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0 } }]), modelDirectories: fakeModelDirectories({ provider: "deepseek-official", model: "deepseek-v4-flash" }) }));
			const t = tWith({ "balance.price.title": "单价（{period}）", "balance.price.peak": "高峰时段", "balance.price.offpeak": "空闲时段", "balance.price.table.model": "模型", "balance.price.table.hit": "命中", "balance.price.table.miss": "未命中", "balance.price.table.output": "输出（每百万 token）" });
			const tree = flatten(await mod.__render(() => Panel({ t, store: { subscribe: () => () => {}, getSnapshot: () => true, close() {} } })));
			const text = textOf(tree);
			assert.ok(text.includes("单价（高峰时段"));
			assert.ok(text.includes("deepseek-v4-flash"));
			assert.ok(text.includes("0.91 美元"));
			assert.ok(!text.includes("0.9099999999999999"));
			assert.ok(text.includes("1.95 美元") && text.includes("5.85 美元"));
		} finally { cleanup(); }
	});
});
test("单价表没声明币种时，标题不渲染空币种槽，单价行单位留空", async () => {
	await withFixedNow(OFF_PEAK_ISO, async () => {
		try {
			const { mod, captured } = mount();
			const pricing = { peakMultiplier: 1, modelPricing: { "deepseek-official:deepseek-v4-flash": { cacheHitPerMillion: 0.5, cacheMissPerMillion: 2, outputPerMillion: 8 } } };
			globalThis.fetch = (url) => (String(url).endsWith("/balance/pricing") ? Promise.resolve({ ok: true, json: async () => ({ ok: true, pricing }) }) : Promise.resolve({ ok: true, json: async () => ({ ok: true, value: { balance_infos: [] }, pricing }) }));
			const Probe = captured["conversation.chat.turnTail:balance"].component;
			const Panel = captured["shell.overlay:balance-panel"].component;
			await mod.__render(() => Probe({ sessionId: "s1", seq: 1, turn: { start: { time: Date.now() + 10 } }, useSession: fakeUseSession([{ kind: "assistant", seq: 1, usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0 } }]), modelDirectories: fakeModelDirectories({ provider: "deepseek-official", model: "deepseek-v4-flash" }) }));
			const t = tWith({ "balance.price.title": "单价（{period}）", "balance.price.peak": "高峰时段", "balance.price.offpeak": "空闲时段", "balance.price.table.model": "模型", "balance.price.table.hit": "命中", "balance.price.table.miss": "未命中", "balance.price.table.output": "输出（每百万 token）" });
			const text = textOf(flatten(await mod.__render(() => Panel({ t, store: { subscribe: () => () => {}, getSnapshot: () => true, close() {} } }))));
			assert.ok(text.includes("单价（空闲时段"));
			assert.ok(!text.includes("（ / 每百万"));
		} finally { cleanup(); }
	});
});
test("还没产生花费时显示 0 而不是「—」，且带上单价表的币种", async () => {
	await withFixedNow(OFF_PEAK_ISO, async () => {
		try {
			const { mod, captured, t } = mount();
			const Button = captured["sidebar.footer.action:balance"].component;
			const Panel = captured["shell.overlay:balance-panel"].component;

			// 刻意**不**跑探针：costStore 里一笔都没有，currency 还是 null。
			// 「—」在这个面板里的含义是「读不出来」，而这里是个确定的事实——没花钱。
			const btnTree = flatten(await mod.__render(() => Button({ wide: true, t, store: { toggle() {} } })));
			const costNode = btnTree.find((n) => n.props && n.props.className === "dsbSideCost");
			assert.ok(costNode, "花费那一段应该在");
			assert.strictEqual(costNode.props.children, "balance.cost.short 0.00 元",
				`没花过钱时应显示 0（币种取自单价表），实际: ${costNode.props.children}`);

			// 面板里那一行必须跟侧边栏同源，不能一个显示 0、另一个显示「—」。
			const panelTree = flatten(await mod.__render(() => Panel({ t, store: { subscribe: () => () => {}, getSnapshot: () => true, close() {} } })));
			const costTitleIdx = panelTree.findIndex((n) => n.props && n.props.children === "balance.cost.title");
			const panelValue = panelTree.slice(costTitleIdx + 1).find((n) => n.type === "td");
			assert.strictEqual(panelValue.props.children, "0.00 元",
				`面板里那一行应与侧边栏同源，实际: ${panelValue.props.children}`);
		} finally {
			cleanup();
		}
	});
});


/**
 * 让 /balance/cost-store 那次跨 origin 回填「挂起」，由测试决定什么时候放行。
 * 默认（不调这个函数时）该路由走 fakeFetch 的兜底分支，返回 ok:false，不回填。
 */
function deferCostStore() {
	let resolve;
	costStorePending = new Promise((r) => { resolve = r; });
	return {
		resolve: (payload) => resolve(payload),
		release: () => { costStorePending = null; }
	};
}

/**
 * 给日/周/月三个周期各喂一份**不同**的存量数字。三份不一样是有意的：真出现串味
 * （比如三张表读了同一份数据、或者清零清错了周期），数字对不上就会当场露馅。
 */
function seedPeriodStorage() {
	const now = new Date();
	const pad = (n) => String(n).padStart(2, "0");
	const dayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
	const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
	const weekKey = `${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}`;
	const monthKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
	const entry = (input) => [["deepseek-official:deepseek-v4-flash", {
		provider: "deepseek-official",
		model: "deepseek-official:deepseek-v4-flash",
		priced: true,
		tokens: { input, cacheRead: 10, output: 20 },
		cost: 1
	}]];
	const storage = createStorage();
	storage.setItem("dsh-ui-balance/dailyCostStore/v1", JSON.stringify({ day: dayKey, currency: "CNY", totalCost: 1, perModel: entry(1111), accounted: [] }));
	storage.setItem("dsh-ui-balance/weeklyCostStore/v1", JSON.stringify({ week: weekKey, currency: "CNY", totalCost: 2, perModel: entry(2222), accounted: [] }));
	storage.setItem("dsh-ui-balance/monthlyCostStore/v1", JSON.stringify({ month: monthKey, currency: "CNY", totalCost: 3, perModel: entry(3333), accounted: [] }));
	return { storage, dayKey, weekKey, monthKey, entry };
}

test("用量汇总按日/周/月三个周期各出一张表，默认看「日」，数字取自对应周期的累计器", async () => {
	await withFixedNow(OFF_PEAK_ISO, async () => {
		// 日/周/月用量跟费用一样落在 localStorage 里跨启动累计，直接喂三份存量进去。
		globalThis.localStorage = seedPeriodStorage().storage;

		try {
			const { mod, captured, t } = mount();
			const Panel = captured["shell.overlay:balance-panel"].component;
			const tree = flatten(await mod.__render(() => Panel({ t, store: { subscribe: () => () => {}, getSnapshot: () => true, close() {} } })));

			const titleIdx = tree.findIndex((n) => n.props && n.props.children === "balance.usage.summary.title");
			assert.ok(titleIdx >= 0, "用量汇总这一节应该在");

			// 三个周期是一组互斥的单选，默认停在「日」。
			const tabs = tree.filter((n) => n.type === "button" && typeof n.props?.className === "string" && n.props.className.includes("dsbPeriodTab"));
			assert.deepStrictEqual(
				tabs.map((n) => n.props.children),
				["balance.usage.period.day", "balance.usage.period.week", "balance.usage.period.month"]
			);
			assert.deepStrictEqual(
				tabs.map((n) => n.props.className.includes("dsbActive")),
				[true, false, false],
				"默认应该停在「日」"
			);

			// 表格结构跟「本次打开用量」完全一致：模型 + 四列数字，表头一次展示。
			const headers = tree.slice(titleIdx).filter((n) => n.type === "th").map((n) => n.props.children);
			assert.deepStrictEqual(headers.slice(0, 5), [
				"balance.price.table.model",
				"balance.usage.table.input",
				"balance.usage.table.hit",
				"balance.usage.table.output",
				"balance.usage.table.hit_rate"
			]);

			// 默认周期是「日」，摊出来的就该是日累计器里那 1111，不是周/月那两份。
			const cells = tree.slice(titleIdx).filter((n) => n.type === "td").map((n) => n.props.children);
			assert.ok(cells.includes((1111).toLocaleString()), `「日」这一档应显示日累计的 1111，实际: ${cells.slice(0, 5).join(" | ")}`);
			assert.ok(!cells.includes((2222).toLocaleString()) && !cells.includes((3333).toLocaleString()),
				"同一时刻只该摊一个周期的数字，不能把周/月的也一起列出来");
		} finally {
			delete globalThis.localStorage;
			cleanup();
		}
	});
});


test("标题栏的重置要二次确认：先点不清零，取消可反悔，确认后清掉「本次打开」+ 当前周期", async () => {
	await withFixedNow(OFF_PEAK_ISO, async () => {
		globalThis.localStorage = createStorage();
		try {
			const { mod, captured, t: rawT } = mount();
			// 别的 key 照旧回显 key 本身，只有确认文案换成带 {period} 占位符的真模板：
			// 「确认条问的是哪个周期」是这个功能的关键（问日、清成周就是事故），而 key
			// 回显把占位符也吃掉了，看不出插值到底有没有发生。
			const t = (k) => k === "balance.reset.confirm" ? "清零「本次打开」和「{period}」？" : rawT(k);

			// 先真跑一条消息，让「本次打开」和日/周/月四份累计器同时有数。
			const Probe = captured["conversation.chat.turnTail:balance"].component;
			await mod.__render(() => Probe({
				sessionId: "s1", seq: 1, turn: { start: { time: Date.now() + 10 } },
				useSession: fakeUseSession([{ kind: "assistant", seq: 1, usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0 } }]),
				modelDirectories: fakeModelDirectories({ provider: "deepseek-official", model: "deepseek-v4-flash" })
			}));

			const Panel = captured["shell.overlay:balance-panel"].component;
			const store = { subscribe: () => () => {}, getSnapshot: () => true, close() {} };

			// 这个迷你 React 的 hook 状态只在一次 __render 内部跨轮存活，所以点击必须
			// 发生在渲染循环里面：把 Panel 直接调起来拿到当轮的树，点一下，setState 把
			// dirty 立起来，循环自然会再渲染一轮——这才是真实的「点了按钮再重画」。
			const seen = [];
			let step = 0;
			const click = (nodes, className) => {
				const btn = nodes.find((n) => n.type === "button" && n.props?.className === className);
				assert.ok(btn, `应该能找到按钮 .${className}`);
				btn.props.onClick();
			};
			const finalTree = await mod.__render(() => {
				const tree = Panel({ t, store });
				const nodes = flatten(expandComponents(tree));
				seen[step] = nodes;
				if (step === 0) { click(nodes, "dsbResetBtn"); step = 1; }
				else if (step === 1) { click(nodes, "dsbConfirmNo"); step = 2; }
				else if (step === 2) { click(nodes, "dsbResetBtn"); step = 3; }
				else if (step === 3) { click(nodes, "dsbConfirmYes"); step = 4; }
				return tree;
			});

			// 四格费用的读法：费用汇总表表头之后的头四个单元格，依次是本次打开/日/周/月。
			const costCells = (nodes) => {
				const idx = nodes.findIndex((n) => n.type === "th" && n.props?.children === "balance.cost.title");
				return nodes.slice(idx).filter((n) => n.type === "td").slice(0, 4).map((n) => n.props.children);
			};

			// 第一轮：重置按钮在标题栏上（跟关闭按钮同一行），按钮上写着当前周期。
			const headerIdx = seen[0].findIndex((n) => n.props?.className === "dsbPanelHeader");
			const resetBtn = seen[0].slice(headerIdx).find((n) => n.props?.className === "dsbResetBtn");
			assert.ok(resetBtn, "重置按钮应该在面板标题栏里");
			// 按钮上只写「重置」，周期留给二次确认那句话去说清楚。
			assert.strictEqual(resetBtn.props.children, "balance.reset.button");
			assert.ok(!seen[0].some((n) => n.props?.className === "dsbConfirmBar"), "还没点之前不该有确认条");
			const before = costCells(seen[0]);
			assert.ok(before.every((cell) => cell !== "0.00 元"), `四格费用一开始都该有数，实际: ${before.join(" | ")}`);

			// 第二轮：确认条出现，写明清的是「本次打开 + 日」，且**数字一个没动**。
			const confirmText = seen[1].find((n) => n.props?.className === "dsbConfirmText");
			assert.ok(confirmText, "点重置后应该弹出就地确认条");
			assert.strictEqual(confirmText.props.children, "清零「本次打开」和「balance.usage.period.day」？");
			assert.deepStrictEqual(costCells(seen[1]), before, "只点一下重置不能清零");

			// 第三轮：点了取消，确认条收掉，数字还在。
			assert.ok(!seen[2].some((n) => n.props?.className === "dsbConfirmBar"), "取消后确认条应该收掉");
			assert.deepStrictEqual(costCells(seen[2]), before, "取消不能把数字带走");

			// 确认之后：本次打开 + 本日归零，本周/本月原样不动（选的是「日」）。
			const finalNodes = flatten(expandComponents(finalTree));
			const after = costCells(finalNodes);
			assert.deepStrictEqual(after.slice(0, 2), ["0.00 元", "0.00 元"], `本次打开和本日费用都该清零，实际: ${after.join(" | ")}`);
			assert.deepStrictEqual(after.slice(2), before.slice(2), "选的是「日」，本周/本月不该跟着被清");

			// 两张用量表（本次打开 / 当前周期）也要跟着空掉——费用清了、用量还挂着旧
			// 数字的话，两处对不上，用户会以为重置只清了一半。
			const usageIdx = finalNodes.findIndex((n) => n.props?.children === "balance.usage.title");
			const summaryIdx = finalNodes.findIndex((n) => n.props?.children === "balance.usage.summary.title");
			assert.ok(textOf(finalNodes.slice(usageIdx, summaryIdx)).includes("balance.usage.empty"), "本次打开用量表应该空了");
			assert.ok(textOf(finalNodes.slice(summaryIdx)).includes("balance.usage.summary.empty"), "当前周期的用量表应该空了");

			// 清零要落盘：日那份被清空，周/月两份原样留着。
			const daily = JSON.parse(globalThis.localStorage.getItem("dsh-ui-balance/dailyCostStore/v1"));
			assert.strictEqual(daily.totalCost, 0);
			assert.deepStrictEqual(daily.perModel, [], "日用量应该从 localStorage 里也清掉");
			const weekly = JSON.parse(globalThis.localStorage.getItem("dsh-ui-balance/weeklyCostStore/v1"));
			assert.ok(weekly.totalCost > 0 && weekly.perModel.length === 1, "清「日」不该动到「周」");
			const monthly = JSON.parse(globalThis.localStorage.getItem("dsh-ui-balance/monthlyCostStore/v1"));
			assert.ok(monthly.totalCost > 0 && monthly.perModel.length === 1, "清「日」不该动到「月」");
		} finally {
			delete globalThis.localStorage;
			cleanup();
		}
	});
});

test("清零后，启动时那次跨 origin 回填不能把旧数字灌回来", async () => {
	await withFixedNow(OFF_PEAK_ISO, async () => {
		const seeded = seedPeriodStorage();
		globalThis.localStorage = seeded.storage;
		const gate = deferCostStore();
		try {
			const { mod, captured, t } = mount();
			const Panel = captured["shell.overlay:balance-panel"].component;
			const store = { subscribe: () => () => {}, getSnapshot: () => true, close() {} };
			let step = 0;
			await mod.__render(() => {
				const tree = Panel({ t, store });
				const nodes = flatten(expandComponents(tree));
				const click = (className) => nodes.find((n) => n.type === "button" && n.props?.className === className).props.onClick();
				if (step === 0) { click("dsbResetBtn"); step = 1; }
				else if (step === 1) { click("dsbConfirmYes"); step = 2; }
				return tree;
			});

			// host 侧那份文件是异步读回来的，可能晚于用户点确认才到——它看到本地是 0，
			// 「本地还没数据、拿文件补上」这条回填规则就会把刚清掉的数字原样灌回来。
			// 这里让那次回填**真的**晚到：清零点完之后才放行 /balance/cost-store 的响应。
			gate.resolve({ ok: true, daily: { day: seeded.dayKey, currency: "CNY", totalCost: 9, perModel: seeded.entry(9999), accounted: [] } });
			await new Promise((r) => setTimeout(r, 0));
			const tree = flatten(await mod.__render(() => Panel({ t, store })));
			const summaryIdx = tree.findIndex((n) => n.props?.children === "balance.usage.summary.title");
			assert.ok(!textOf(tree.slice(summaryIdx)).includes((9999).toLocaleString()),
				"手动清过的周期不该被启动回填灌回旧数字");
		} finally {
			gate.release();
			delete globalThis.localStorage;
			cleanup();
		}
	});
});


/**
 * 把源码里的注释行剔掉、反斜杠转义还原，再拿去匹配 CSS 规则。
 *
 * 这两步都不能省：这几个文件的注释里都写着 `[class*="footerActions"]` 这串选择器
 * （在解释它为什么长这样），只 grep 源码的话，把规则整条删掉、只留注释，测试照样
 * 绿。转义还原是因为规则可能写在双引号字符串里，文件里存的是 \" 而不是 "。
 */
function cssSource(file) {
	return fs.readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
		.join("\n")
		.replace(/\\"/g, '"');
}

test("侧边栏 footer 的纵向排列由本插件自带，不靠别的插件的样式兜底", () => {
	// 实机反馈：只装了市场 + 余额 + 另一个插件的机器上，三个入口挤在同一行，余额
	// 这一整行文字被压到三分之一宽，只剩省略号。上游那个容器是 display:flex（默认
	// row、不换行），原先只有 dsh-terminal-panel 注入了 flex-direction:column ——
	// 装了终端面板的机器看着一切正常，没装的就露馅。任何一个插件都可能被单独安装，
	// 所以这条规则每个 footer 插件都得自带。
	assert.ok(
		/\[class\*="footerActions"\]\{[^}]*flex-direction:column/.test(cssSource(CLIENT)),
		"余额插件必须自己注入 footerActions 的纵向排列规则"
	);
});
