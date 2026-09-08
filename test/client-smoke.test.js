// 客户端半的冒烟测试：在 node 里伪造 window / React，真跑一遍 factory、apply()
// 与三个槽组件的渲染路径。手法照抄 dsh-terminal-panel 的 test/client-smoke.test.js
// （见其文件顶部注释的两条硬规矩：迷你 React 必须真的会渲染，effect 的 teardown
// 不能在本轮就调）。
//
// 这个文件额外要守的几条是本插件特有的：
//   1. **浏览器半不再记账**。日/周/月/本次打开四个数字全部来自 host 半的
//      `/api/dsdesktop/balance/usage`（它从 dsh 的会话事件日志现算）。所以这里的
//      断言方向变了：不再喂 usage 进去看累加对不对，而是喂一份路由响应进去，看
//      面板有没有把它原样、分周期地摊出来——顺带守住「浏览器半没有偷偷再算一遍」。
//   2. 唯一还留在浏览器半的计算是**进行中消息的流式估算**：按字符数估输出 token，
//      叠在已结算的数字上显示，回合一结束就丢掉、改拉路由。要真的喂 partial 进去。
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

/** 一格统计（本次打开 / 日 / 周 / 月）的构造器，形状跟 host 半 `aggregate()` 的返回一致。 */
function period(key, cost, tokens = { input: 0, cacheRead: 0, output: 0 }, model = "deepseek-v4-flash") {
	return {
		key,
		currency: "CNY",
		totalCost: cost,
		perModel: cost === 0 && tokens.input === 0 && tokens.cacheRead === 0 && tokens.output === 0
			? []
			: [{ provider: "deepseek-official", model, priced: true, cost, tokens }]
	};
}

const EMPTY_USAGE = {
	ok: true,
	pricing: PRICING,
	session: period(null, 0),
	daily: period("2026-09-05", 0),
	weekly: period("2026-08-31", 0),
	monthly: period("2026-09", 0)
};

// host 半 `/balance/usage` 的当前响应，以及它收到过的请求 URL / `/balance/reset`
// 的 POST 记录——「浏览器半有没有把清零真的写到 host 去」只能从这里看。
let usagePayload = EMPTY_USAGE;
let usageRequests = [];
let resetPosts = [];

function fakeFetch(url, init) {
	const u = String(url);
	if (u.includes("/balance/usage")) {
		usageRequests.push(u);
		return Promise.resolve({ ok: true, json: async () => usagePayload });
	}
	if (u.endsWith("/balance/reset")) {
		resetPosts.push(init && init.body ? JSON.parse(init.body) : null);
		return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
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

function cleanup() {
	Object.assign(globalThis, { window: undefined, document: undefined, fetch: undefined, sessionStorage: undefined });
	usagePayload = EMPTY_USAGE;
	usageRequests = [];
	resetPosts = [];
}

function mount(sessionStorage = createStorage()) {
	const mod = loadModule(sessionStorage);
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

/** 造一个够用的 useSession：可以同时读 nodes / partial / turnTimings。 */
function fakeUseSessionSnapshot(snapshot) {
	return (selector) => selector(snapshot);
}

/** 一个永远开着的面板开关 store。 */
const OPEN_STORE = { subscribe: () => () => {}, getSnapshot: () => true, close() {} };

/** 从面板里把「费用汇总」那一行的四个金额抠出来：本次打开 / 日 / 周 / 月。 */
function costCells(tree) {
	const idx = tree.findIndex((n) => n.props && n.props.children === "balance.cost.title");
	assert.ok(idx >= 0, "费用汇总表头应该在");
	return tree.slice(idx + 1).filter((n) => n.type === "td").slice(0, 4).map((n) => n.props.children);
}

test("冒烟：三个槽都注册到位，turnTail 上不再挂记账探针", async () => {
	try {
		const { mod, captured } = mount();
		assert.strictEqual(typeof mod.apply, "function");

		const liveProbe = captured["conversation.session.header.actions:balance-live"];
		const button = captured["sidebar.footer.action:balance"];
		const panel = captured["shell.overlay:balance-panel"];
		assert.ok(liveProbe, "实时估算探针应注册进 conversation.session.header.actions");
		assert.ok(button, "入口按钮应注册进 sidebar.footer.action");
		assert.ok(panel, "详情面板应注册进 shell.overlay");
		assert.strictEqual(button.opts.order, 120);
		assert.strictEqual(typeof liveProbe.component, "function");
		assert.strictEqual(typeof button.component, "function");
		assert.strictEqual(typeof panel.component, "function");

		// turnTail 上那个逐条记账的探针已经删掉：它只看得见「当前工作区里正好被
		// 渲染出来的回合」，拿它当计费数据源必然漏掉后台会话与没滚到的历史。
		// 这条断言是为了挡住「顺手又把它加回来」。
		assert.ok(!captured["conversation.chat.turnTail:balance"], "不应再往 turnTail 注册记账探针");
	} finally {
		cleanup();
	}
});

test("四格数字全部来自 /balance/usage，浏览器半不自己记账", async () => {
	await withFixedNow(OFF_PEAK_ISO, async () => {
		try {
			usagePayload = {
				ok: true,
				pricing: PRICING,
				session: period(null, 0.5, { input: 10, cacheRead: 20, output: 30 }),
				daily: period("2026-09-05", 8.829, { input: 375876, cacheRead: 89487616, output: 155799 }),
				weekly: period("2026-08-31", 19.5314, { input: 1323247, cacheRead: 152651264, output: 392846 }),
				monthly: period("2026-09", 163.8268, { input: 2822044, cacheRead: 264601856, output: 800757 })
			};
			const { mod, captured, t } = mount();
			const Panel = captured["shell.overlay:balance-panel"].component;
			const tree = flatten(await mod.__render(() => Panel({ t, store: OPEN_STORE })));

			assert.deepStrictEqual(costCells(tree), ["0.50 元", "8.829 元", "19.5314 元", "163.8268 元"]);

			// 请求必须带上「本次打开」的下界，否则 host 半没法算那一格。
			assert.ok(usageRequests.length > 0, "应向 /balance/usage 发过请求");
			assert.match(usageRequests[0], /[?&]since=\d+/, `请求应带 since 参数，实际: ${usageRequests[0]}`);
		} finally {
			cleanup();
		}
	});
});

test("用量汇总按日/周/月三个周期各出一张表，默认看「日」，数字取自对应周期", async () => {
	await withFixedNow(OFF_PEAK_ISO, async () => {
		try {
			// 三份 token 数字刻意不同：真出现串味（三张表读了同一份数据），当场露馅。
			usagePayload = {
				ok: true,
				pricing: PRICING,
				session: period(null, 0),
				daily: period("2026-09-05", 1, { input: 1111, cacheRead: 10, output: 20 }),
				weekly: period("2026-08-31", 2, { input: 2222, cacheRead: 10, output: 20 }),
				monthly: period("2026-09", 3, { input: 3333, cacheRead: 10, output: 20 })
			};
			const { mod, captured, t } = mount();
			const Panel = captured["shell.overlay:balance-panel"].component;

			const render = async () => flatten(await mod.__render(() => Panel({ t, store: OPEN_STORE })));
			let tree = await render();
			assert.ok(textOf(tree).includes("1,111"), "默认应看「日」那份");
			assert.ok(!textOf(tree).includes("2,222"), "默认不该同时摊出周的数字");

			const tabs = tree.filter((n) => n.props && n.props.role === "tab");
			assert.strictEqual(tabs.length, 3, "日/周/月三个分段");
			// 分段控件是受控的：点一下改 useState，下一轮渲染才换数据源。
			tree = flatten(await mod.__render(() => {
				const node = Panel({ t, store: OPEN_STORE });
				const found = flatten(deepFlattenOnce(node)).filter((n) => n.props && n.props.role === "tab");
				if (found[1]) found[1].props.onClick();
				return node;
			}));
			assert.ok(textOf(tree).includes("2,222"), `点「周」之后应换成周的数字，实际: ${textOf(tree).slice(0, 400)}`);
		} finally {
			cleanup();
		}
	});
});

/** 把一棵已经 deepRender 过的树原样返回；这里只是让上面的写法读起来对称。 */
function deepFlattenOnce(node) {
	return node;
}

test("流式生成期间的估算叠在已结算数字上，回合结束后丢掉估算并重新拉取", async () => {
	await withFixedNow(OFF_PEAK_ISO, async () => {
		try {
			usagePayload = {
				ok: true,
				pricing: PRICING,
				session: period(null, 1, { input: 1, cacheRead: 0, output: 1 }),
				daily: period("2026-09-05", 1, { input: 1, cacheRead: 0, output: 1 }),
				weekly: period("2026-08-31", 1, { input: 1, cacheRead: 0, output: 1 }),
				monthly: period("2026-09", 1, { input: 1, cacheRead: 0, output: 1 })
			};
			const { mod, captured, t } = mount();
			const LiveProbe = captured["conversation.session.header.actions:balance-live"].component;
			const Panel = captured["shell.overlay:balance-panel"].component;
			const modelDirectories = fakeModelDirectories({ provider: "deepseek-official", model: "deepseek-v4-flash" });

			// 1000 个 CJK 字符，按我们的启发式 = 1000 个输出 token。
			// 空闲时段 1000 * 4.5 / 1e6 = 0.0045，叠在已结算的 1 上。
			const partial = { turn: 7, step: 1, blocks: [{ kind: "text", text: "你".repeat(1000) }] };
			const tree = await mod.__render(() => LiveProbe({
				sessionId: "s1",
				useSession: fakeUseSessionSnapshot({ nodes: [], partial, turnTimings: undefined }),
				modelDirectories
			}));
			assert.strictEqual(tree, null, "实时探针不该渲染任何东西");

			let cells = costCells(flatten(await mod.__render(() => Panel({ t, store: OPEN_STORE }))));
			assert.strictEqual(cells[0], "1.0045 元", `本次打开应叠上进行中的估算，实际: ${cells[0]}`);
			assert.strictEqual(cells[1], "1.0045 元", `本日同理，实际: ${cells[1]}`);

			// 回合结束：partial 消失。估算立刻丢掉——精确值由 host 半从会话日志读，
			// 不再像旧版那样把估算「折进累计」（那正是重复计费的来源）。
			await mod.__render(() => LiveProbe({
				sessionId: "s1",
				useSession: fakeUseSessionSnapshot({ nodes: [], partial: null, turnTimings: undefined }),
				modelDirectories
			}));
			cells = costCells(flatten(await mod.__render(() => Panel({ t, store: OPEN_STORE }))));
			assert.strictEqual(cells[0], "1.00 元", `估算应被丢掉而不是折进累计，实际: ${cells[0]}`);

			// 并且要安排一次重新拉取，把日志里那条精确的读回来。
			const before = usageRequests.length;
			await new Promise((r) => setTimeout(r, 1800));
			assert.ok(usageRequests.length > before, "回合结束后应重新拉一次统计");
		} finally {
			cleanup();
		}
	});
});

test("高峰时段的流式估算按倍率折算", async () => {
	await withFixedNow(PEAK_ISO, async () => {
		try {
			const { mod, captured, t } = mount();
			const LiveProbe = captured["conversation.session.header.actions:balance-live"].component;
			const Panel = captured["shell.overlay:balance-panel"].component;
			const partial = { turn: 7, step: 1, blocks: [{ kind: "text", text: "你".repeat(1000) }] };
			await mod.__render(() => LiveProbe({
				sessionId: "s1",
				useSession: fakeUseSessionSnapshot({ nodes: [], partial, turnTimings: undefined }),
				modelDirectories: fakeModelDirectories({ provider: "deepseek-official", model: "deepseek-v4-flash" })
			}));
			const cells = costCells(flatten(await mod.__render(() => Panel({ t, store: OPEN_STORE }))));
			assert.strictEqual(cells[0], "0.009 元", `高峰应是空闲价的 2 倍，实际: ${cells[0]}`);
		} finally {
			cleanup();
		}
	});
});

test("翻旧会话翻出来的进行中回合（开始于本次启动之前）不产生估算", async () => {
	await withFixedNow(OFF_PEAK_ISO, async () => {
		try {
			const { mod, captured, t } = mount();
			const LiveProbe = captured["conversation.session.header.actions:balance-live"].component;
			const Panel = captured["shell.overlay:balance-panel"].component;
			const partial = { turn: 7, step: 1, blocks: [{ kind: "text", text: "你".repeat(1000) }] };
			// turn 的开始时刻早于 appOpenTime（= 被钉死的 now）。
			const turnTimings = new Map([[7, { startTime: Date.now() - 60_000 }]]);
			await mod.__render(() => LiveProbe({
				sessionId: "s1",
				useSession: fakeUseSessionSnapshot({ nodes: [], partial, turnTimings }),
				modelDirectories: fakeModelDirectories({ provider: "deepseek-official", model: "deepseek-v4-flash" })
			}));
			const cells = costCells(flatten(await mod.__render(() => Panel({ t, store: OPEN_STORE }))));
			assert.strictEqual(cells[0], "0.00 元", `历史回合不该产生「本次打开」的估算，实际: ${cells[0]}`);
		} finally {
			cleanup();
		}
	});
});

test("标题栏的重置要二次确认：确认后把清零下限写到 host，并清掉「本次打开」", async () => {
	await withFixedNow(OFF_PEAK_ISO, async () => {
		try {
			usagePayload = {
				ok: true,
				pricing: PRICING,
				session: period(null, 5, { input: 1, cacheRead: 0, output: 1 }),
				daily: period("2026-09-05", 5, { input: 1, cacheRead: 0, output: 1 }),
				weekly: period("2026-08-31", 5, { input: 1, cacheRead: 0, output: 1 }),
				monthly: period("2026-09", 5, { input: 1, cacheRead: 0, output: 1 })
			};
			const storage = createStorage();
			const { mod, captured, t } = mount(storage);
			const Panel = captured["shell.overlay:balance-panel"].component;

			// 第一次点「重置」只举确认条，不清任何东西。
			let tree = flatten(await mod.__render(() => {
				const node = Panel({ t, store: OPEN_STORE });
				const btn = flatten(node).find((n) => n.props && n.props.className === "dsbResetBtn");
				btn.props.onClick();
				return node;
			}));
			assert.strictEqual(resetPosts.length, 0, "只点「重置」不该写任何东西到 host");
			assert.ok(tree.some((n) => n.props && n.props.role === "alertdialog"), "应举起二次确认条");

			const sinceBefore = JSON.parse(storage.getItem("dsh-ui-balance/spendSince/v1"));

			// 点确认：写清零下限到 host（当前选中周期是「日」），本地的「本次打开」下界抬到当下。
			// 确认条要等 setConfirmReset 触发的下一轮渲染才出现，所以这里按「有确认条就点
			// 确认、没有就点重置」写，让迷你 React 的收敛循环自己走完两轮。
			usagePayload = { ...usagePayload, session: period(null, 0), daily: period("2026-09-05", 0) };
			let armed = false;
			let confirmed = false;
			await mod.__render(() => {
				const node = Panel({ t, store: OPEN_STORE });
				const nodes = flatten(node);
				const yes = nodes.find((n) => n.props && n.props.className === "dsbConfirmYes");
				if (yes && !confirmed) {
					confirmed = true;
					yes.props.onClick();
				} else if (!armed) {
					armed = true;
					nodes.find((n) => n.props && n.props.className === "dsbResetBtn").props.onClick();
				}
				return node;
			});
			await new Promise((r) => setTimeout(r, 0));

			assert.deepStrictEqual(resetPosts, [{ period: "day" }], `确认后应把「日」的清零下限写到 host，实际: ${JSON.stringify(resetPosts)}`);
			const sinceAfter = JSON.parse(storage.getItem("dsh-ui-balance/spendSince/v1"));
			assert.ok(sinceAfter >= sinceBefore, "「本次打开」的下界应被抬到当下");

			const cells = costCells(flatten(await mod.__render(() => Panel({ t, store: OPEN_STORE }))));
			assert.strictEqual(cells[0], "0.00 元", `清零后「本次打开」应归零，实际: ${cells[0]}`);
			assert.strictEqual(cells[1], "0.00 元", `清零后「本日」应归零，实际: ${cells[1]}`);
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
			usagePayload = { ...EMPTY_USAGE, session: period(null, 0.0037, { input: 1000, cacheRead: 0, output: 500 }) };
			const { mod, captured, t } = mount();
			const Button = captured["sidebar.footer.action:balance"].component;

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
			globalThis.fetch = (url) => (String(url).endsWith("/balance/pricing")
				? Promise.resolve({ ok: true, json: async () => ({ ok: true, pricing }) })
				: Promise.resolve({ ok: true, json: async () => ({ ok: true, value: { balance_infos: [] }, pricing, session: period(null, 0), daily: period("d", 0), weekly: period("w", 0), monthly: period("m", 0) }) }));
			const Panel = captured["shell.overlay:balance-panel"].component;
			const t = tWith({ "balance.price.title": "单价（{period}）", "balance.price.peak": "高峰时段", "balance.price.offpeak": "空闲时段", "balance.price.table.model": "模型", "balance.price.table.hit": "命中", "balance.price.table.miss": "未命中", "balance.price.table.output": "输出（每百万 token）" });
			const text = textOf(flatten(await mod.__render(() => Panel({ t, store: OPEN_STORE }))));
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
			globalThis.fetch = (url) => (String(url).endsWith("/balance/pricing")
				? Promise.resolve({ ok: true, json: async () => ({ ok: true, pricing }) })
				: Promise.resolve({ ok: true, json: async () => ({ ok: true, value: { balance_infos: [] }, pricing }) }));
			const Panel = captured["shell.overlay:balance-panel"].component;
			const t = tWith({ "balance.price.title": "单价（{period}）", "balance.price.peak": "高峰时段", "balance.price.offpeak": "空闲时段", "balance.price.table.model": "模型", "balance.price.table.hit": "命中", "balance.price.table.miss": "未命中", "balance.price.table.output": "输出（每百万 token）" });
			const text = textOf(flatten(await mod.__render(() => Panel({ t, store: OPEN_STORE }))));
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

			// 一笔花费都没有：「—」在这个面板里的含义是「读不出来」，而这里是个
			// 确定的事实——没花钱。
			const btnTree = flatten(await mod.__render(() => Button({ wide: true, t, store: { toggle() {} } })));
			const costNode = btnTree.find((n) => n.props && n.props.className === "dsbSideCost");
			assert.ok(costNode, "花费那一段应该在");
			assert.strictEqual(costNode.props.children, "balance.cost.short 0.00 元",
				`没花过钱时应显示 0（币种取自单价表），实际: ${costNode.props.children}`);

			// 面板里那一行必须跟侧边栏同源，不能一个显示 0、另一个显示「—」。
			const cells = costCells(flatten(await mod.__render(() => Panel({ t, store: OPEN_STORE }))));
			assert.strictEqual(cells[0], "0.00 元", `面板里那一行应与侧边栏同源，实际: ${cells[0]}`);
		} finally {
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
