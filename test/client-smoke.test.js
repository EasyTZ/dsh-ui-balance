// 客户端半的冒烟测试：在 node 里伪造 window / React，真跑一遍 factory、apply()
// 与三个槽组件的渲染路径。手法照抄 dsh-terminal-panel 的 test/client-smoke.test.js
// （见其文件顶部注释的两条硬规矩：迷你 React 必须真的会渲染，effect 的 teardown
// 不能在本轮就调）。
//
// 这个文件额外要守的几条是本插件特有的：
//   1. **浏览器半不再记账**。日/周/月三个数字全部来自 host 半的
//      `/api/dsdesktop/balance/usage`（它从 dsh 的会话事件日志现算）。所以这里的
//      断言方向变了：不再喂 usage 进去看累加对不对，而是喂一份路由响应进去，看
//      面板有没有把它原样、分周期地摊出来——顺带守住「浏览器半没有偷偷再算一遍」。
//   2. 唯一还留在浏览器半的计算是**进行中消息的流式估算**：按字符数估输出 token，
//      只叠在侧边栏那一行上（那里要求实时跳动），面板里的费用表是「回合结束后更新」
//      的结算口径、不带估算。这条分界线两边都要测，要真的喂 partial 进去。
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

/**
 * 一格统计（日 / 周 / 月）的构造器，形状跟 host 半 `aggregate()` 的返回一致。
 *
 * `costs` 是按 token 类别拆开的金额，host 半算好后随 perModel 一起下发（面板的费用表
 * 每类一列）。默认全摊在输出上，这样「三项之和 = 这一行的合计」始终成立——费用表里
 * 那一行本来就该自己加得起来。
 */
function period(key, cost, tokens = { input: 0, cacheRead: 0, output: 0 }, model = "deepseek-v4-flash", costs) {
	return {
		key,
		currency: "CNY",
		totalCost: cost,
		perModel: cost === 0 && tokens.input === 0 && tokens.cacheRead === 0 && tokens.output === 0
			? []
			: [{ provider: "deepseek-official", model, priced: true, cost, tokens, costs: costs ?? { input: 0, cacheRead: 0, output: cost } }]
	};
}

const EMPTY_USAGE = {
	ok: true,
	pricing: PRICING,
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

/** 费用表最后那行「总计」的五个格子：模型列 / 输入未命中 / 缓存命中 / 输出 / 合计。 */
function totalRow(tree) {
	const row = tree.find((n) => n.type === "tr" && n.props && n.props.className === "dsbTotalRow");
	assert.ok(row, "费用表应该有一行总计");
	return row.props.children.map((td) => td.props.children);
}

/**
 * 这个周期一共花了多少：费用表最后一行最右边那格。
 *
 * 只有一个模型时没有「总计」那一行（它会跟上面那一行一模一样），所以这里按「费用表
 * 里最后一行」取，而不是认死 `dsbTotalRow`。五格是费用表的行，下面那张单价表是四格。
 */
function costTotal(tree) {
	const head = tree.findIndex((n) => n.type === "th" && n.props && n.props.children === "balance.cost.table.total");
	assert.ok(head >= 0, "费用表的表头应该在");
	const rows = tree.slice(head).filter((n) => n.type === "tr" && Array.isArray(n.props?.children)
		&& n.props.children.filter((c) => c && c.type === "td").length === 5);
	assert.ok(rows.length > 0, "费用表应该有内容行");
	return rows[rows.length - 1].props.children[4].props.children;
}

/**
 * 费用表里某个模型那一行的五个格子。
 *
 * 从费用表的表头往后找，不能在整棵树里找：上面那张用量表的行长得一模一样（同样的
 * `dsbPriceModel` 第一格、同样五列），在整棵树里搜必然先撞上用量表那一行。
 */
function costRow(tree, label) {
	const head = tree.findIndex((n) => n.type === "th" && n.props && n.props.children === "balance.cost.table.total");
	assert.ok(head >= 0, "费用表的表头应该在");
	const row = tree.slice(head).find((n) => n.type === "tr" && n.props && Array.isArray(n.props.children)
		&& n.props.className !== "dsbTotalRow"
		&& n.props.children[0]?.props?.children === label);
	assert.ok(row, `费用表里应该有 ${label} 那一行`);
	return row.props.children.map((td) => td.props.children);
}

/** 侧边栏那一行的花费文字。 */
function sideCostText(tree) {
	const node = tree.find((n) => n.props && n.props.className === "dsbSideCost");
	assert.ok(node, "侧边栏应该有独立的花费那一段");
	return String(node.props.children);
}

/** 侧边栏/面板的词条模板：只有真模板才看得出占位符有没有被填上。 */
const SIDE_T = {
	"balance.side.balance": "余额：{value}",
	"balance.side.cost": "花费：{value}/日",
	"balance.daily.title": "本日费用",
	"balance.label": "余额"
};

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

test("三格数字全部来自 /balance/usage，浏览器半不自己记账", async () => {
	await withFixedNow(OFF_PEAK_ISO, async () => {
		try {
			usagePayload = {
				ok: true,
				pricing: PRICING,
				daily: period("2026-09-05", 8.829, { input: 375876, cacheRead: 89487616, output: 155799 }),
				weekly: period("2026-08-31", 19.5314, { input: 1323247, cacheRead: 152651264, output: 392846 }),
				monthly: period("2026-09", 163.8268, { input: 2822044, cacheRead: 264601856, output: 800757 })
			};
			const { mod, captured, t } = mount();
			const Panel = captured["shell.overlay:balance-panel"].component;
			const Button = captured["sidebar.footer.action:balance"].component;

			// 面板：费用表跟着上面那个周期选择器走，默认「日」。
			const tree = flatten(await mod.__render(() => Panel({ t, store: OPEN_STORE })));
			assert.strictEqual(costTotal(tree), "8.829 元");

			// 侧边栏：同一个「日」的数字，跟面板同源。
			const side = flatten(await mod.__render(() => Button({ wide: true, t: tWith(SIDE_T), store: { toggle() {} } })));
			assert.strictEqual(sideCostText(side), "花费：8.829 元/日");

			// 「本次打开」这个口径没有了，请求里不该再有它的下界——host 半也不再算那一格。
			assert.ok(usageRequests.length > 0, "应向 /balance/usage 发过请求");
			assert.ok(usageRequests.every((u) => !u.includes("since=")), `请求不该再带 since 参数，实际: ${usageRequests.join(", ")}`);
		} finally {
			cleanup();
		}
	});
});

test("费用汇总按模型分行，每类 token 一列金额，最后一行总计", async () => {
	await withFixedNow(OFF_PEAK_ISO, async () => {
		try {
			// 两个模型、三类金额都不同：真出现串列（拿输出的钱填了缓存那一格）当场露馅。
			usagePayload = {
				ok: true,
				pricing: PRICING,
				daily: {
					key: "2026-09-05",
					currency: "CNY",
					totalCost: 3.75,
					perModel: [
						{ provider: "deepseek-official", model: "deepseek-v4-flash", priced: true, cost: 1.11, tokens: { input: 100, cacheRead: 200, output: 300 }, costs: { input: 0.5, cacheRead: 0.01, output: 0.6 } },
						{ provider: "deepseek-official", model: "deepseek-v4-pro", priced: true, cost: 2.64, tokens: { input: 10, cacheRead: 20, output: 30 }, costs: { input: 1.2, cacheRead: 0.04, output: 1.4 } }
					]
				},
				weekly: period("2026-08-31", 0),
				monthly: period("2026-09", 0)
			};
			const { mod, captured, t } = mount();
			const Panel = captured["shell.overlay:balance-panel"].component;
			const tree = flatten(await mod.__render(() => Panel({ t, store: OPEN_STORE })));

			assert.deepStrictEqual(costRow(tree, "deepseek-v4-flash"),
				["deepseek-v4-flash", "0.50 元", "0.01 元", "0.60 元", "1.11 元"]);
			assert.deepStrictEqual(costRow(tree, "deepseek-v4-pro"),
				["deepseek-v4-pro", "1.20 元", "0.04 元", "1.40 元", "2.64 元"]);
			// 总计的三个分项是各行相加，最右边那格取周期自己的 totalCost（跟 host 半同源）。
			assert.deepStrictEqual(totalRow(tree),
				["balance.cost.table.all", "1.70 元", "0.05 元", "2.00 元", "3.75 元"]);

			// 表头跟用量表逐列对齐，只有第五列不同：用量那边是缓存命中率，费用这边没有
			// 对应的比率概念，换成这一行的合计。
			const heads = tree.filter((n) => n.type === "th").map((n) => n.props.children);
			assert.deepStrictEqual(heads.slice(0, 5),
				["balance.price.table.model", "balance.usage.table.input", "balance.usage.table.hit", "balance.usage.table.output", "balance.usage.table.hit_rate"]);
			assert.deepStrictEqual(heads.slice(5, 10),
				["balance.price.table.model", "balance.usage.table.input", "balance.usage.table.hit", "balance.usage.table.output", "balance.cost.table.total"]);
		} finally {
			cleanup();
		}
	});
});

test("详情面板里没有「本次打开」：既没有那张用量表，也没有那一格费用", async () => {
	await withFixedNow(OFF_PEAK_ISO, async () => {
		try {
			usagePayload = { ...EMPTY_USAGE, daily: period("2026-09-05", 1, { input: 1, cacheRead: 0, output: 1 }) };
			const { mod, captured, t } = mount();
			const Panel = captured["shell.overlay:balance-panel"].component;
			const tree = flatten(await mod.__render(() => Panel({ t, store: OPEN_STORE })));
			const text = textOf(tree);

			assert.ok(!text.includes("balance.usage.title"), "「本次打开用量」那一节应该删掉了");
			assert.ok(!text.includes("balance.cost.title"), "「本次打开花费」那一格应该删掉了");
			// 用量表只剩一张（汇总那张）：两张表的表头一样，数一下模型列的表头就知道。
			const usageHeads = tree.filter((n) => n.type === "th" && n.props.children === "balance.usage.table.hit_rate");
			assert.strictEqual(usageHeads.length, 1, "用量表应该只剩「用量汇总」那一张");
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

			// 费用表跟用量表共用这一个选择器，所以默认也是「日」那份。
			assert.strictEqual(costTotal(tree), "1.00 元", "费用表默认也该是「日」");
			// 只有一个模型时不出「总计」那一行：它会跟上面那一行一模一样，两行并排像
			// 是渲染坏了，而那个数并没有因此消失。
			assert.ok(!tree.some((n) => n.props && n.props.className === "dsbTotalRow"),
				"只有一个模型时不该出总计那一行");

			const tabs = tree.filter((n) => n.props && n.props.role === "tab");
			assert.strictEqual(tabs.length, 3, "日/周/月三个分段，只此一处");
			// 分段控件是受控的：点一下改 useState，下一轮渲染才换数据源。
			tree = flatten(await mod.__render(() => {
				const node = Panel({ t, store: OPEN_STORE });
				const found = flatten(deepFlattenOnce(node)).filter((n) => n.props && n.props.role === "tab");
				if (found[1]) found[1].props.onClick();
				return node;
			}));
			assert.ok(textOf(tree).includes("2,222"), `点「周」之后应换成周的数字，实际: ${textOf(tree).slice(0, 400)}`);
			// **同一个选择器管两张表**：切到「周」之后费用表也得跟着换，不能还挂着日的数字。
			assert.strictEqual(costTotal(tree), "2.00 元", "切周期后费用表也该跟着换");
		} finally {
			cleanup();
		}
	});
});

/** 把一棵已经 deepRender 过的树原样返回；这里只是让上面的写法读起来对称。 */
function deepFlattenOnce(node) {
	return node;
}

test("流式估算只叠在侧边栏那一行上，面板里的费用表按结算口径不动", async () => {
	await withFixedNow(OFF_PEAK_ISO, async () => {
		try {
			usagePayload = {
				ok: true,
				pricing: PRICING,
				daily: period("2026-09-05", 1, { input: 1, cacheRead: 0, output: 1 }),
				weekly: period("2026-08-31", 1, { input: 1, cacheRead: 0, output: 1 }),
				monthly: period("2026-09", 1, { input: 1, cacheRead: 0, output: 1 })
			};
			const { mod, captured, t } = mount();
			const LiveProbe = captured["conversation.session.header.actions:balance-live"].component;
			const Panel = captured["shell.overlay:balance-panel"].component;
			const Button = captured["sidebar.footer.action:balance"].component;
			const modelDirectories = fakeModelDirectories({ provider: "deepseek-official", model: "deepseek-v4-flash" });
			const side = async () => sideCostText(flatten(await mod.__render(() => Button({ wide: true, t: tWith(SIDE_T), store: { toggle() {} } }))));

			// 1000 个 CJK 字符，按我们的启发式 = 1000 个输出 token。
			// 空闲时段 1000 * 4.5 / 1e6 = 0.0045，叠在已结算的 1 上。
			const partial = { turn: 7, step: 1, blocks: [{ kind: "text", text: "你".repeat(1000) }] };
			const tree = await mod.__render(() => LiveProbe({
				sessionId: "s1",
				useSession: fakeUseSessionSnapshot({ nodes: [], partial, turnTimings: undefined }),
				modelDirectories
			}));
			assert.strictEqual(tree, null, "实时探针不该渲染任何东西");

			assert.strictEqual(await side(), "花费：1.0045 元/日", "侧边栏要实时跳动，得叠上进行中的估算");
			// 面板是「回合结束后更新」的结算口径：估算只有输出、没有输入与缓存，混进去
			// 会让按类别分的那几列失真。
			const panel = flatten(await mod.__render(() => Panel({ t, store: OPEN_STORE })));
			assert.strictEqual(costTotal(panel), "1.00 元", "费用表不该把估算算进去");

			// 回合结束：partial 消失。估算立刻丢掉——精确值由 host 半从会话日志读，
			// 不再像旧版那样把估算「折进累计」（那正是重复计费的来源）。
			await mod.__render(() => LiveProbe({
				sessionId: "s1",
				useSession: fakeUseSessionSnapshot({ nodes: [], partial: null, turnTimings: undefined }),
				modelDirectories
			}));
			assert.strictEqual(await side(), "花费：1.00 元/日", "估算应被丢掉而不是折进累计");

			// 并且要安排一次**强制**重新拉取，把日志里那条精确的读回来：host 半的扫描
			// 结果有 5 秒节流，不带 force 的那一发返回的正是「这条还没算进去」的旧数字。
			const before = usageRequests.length;
			await new Promise((r) => setTimeout(r, 1600));
			assert.ok(usageRequests.length > before, "回合结束后应重新拉一次统计");
			assert.ok(usageRequests.slice(before).some((u) => u.includes("force=1")),
				`补拉那一发必须带 force=1，实际: ${usageRequests.slice(before).join(", ")}`);
		} finally {
			cleanup();
		}
	});
});

test("高峰时段的流式估算按倍率折算", async () => {
	await withFixedNow(PEAK_ISO, async () => {
		try {
			const { mod, captured } = mount();
			const LiveProbe = captured["conversation.session.header.actions:balance-live"].component;
			const Button = captured["sidebar.footer.action:balance"].component;
			const partial = { turn: 7, step: 1, blocks: [{ kind: "text", text: "你".repeat(1000) }] };
			await mod.__render(() => LiveProbe({
				sessionId: "s1",
				useSession: fakeUseSessionSnapshot({ nodes: [], partial, turnTimings: undefined }),
				modelDirectories: fakeModelDirectories({ provider: "deepseek-official", model: "deepseek-v4-flash" })
			}));
			const text = sideCostText(flatten(await mod.__render(() => Button({ wide: true, t: tWith(SIDE_T), store: { toggle() {} } }))));
			assert.strictEqual(text, "花费：0.009 元/日", "高峰应是空闲价的 2 倍");
		} finally {
			cleanup();
		}
	});
});

test("翻旧会话翻出来的进行中回合（开始于本次启动之前）不产生估算", async () => {
	await withFixedNow(OFF_PEAK_ISO, async () => {
		try {
			const { mod, captured } = mount();
			const LiveProbe = captured["conversation.session.header.actions:balance-live"].component;
			const Button = captured["sidebar.footer.action:balance"].component;
			const partial = { turn: 7, step: 1, blocks: [{ kind: "text", text: "你".repeat(1000) }] };
			// turn 的开始时刻早于 appOpenTime（= 被钉死的 now）。真在生成的回合活不过一次
			// 重启，这种 partial 十有八九是从磁盘恢复出来的残留——给它记一笔估算就再没人
			// 来撤销，那笔钱会一直挂在今天的数字上。
			const turnTimings = new Map([[7, { startTime: Date.now() - 60_000 }]]);
			await mod.__render(() => LiveProbe({
				sessionId: "s1",
				useSession: fakeUseSessionSnapshot({ nodes: [], partial, turnTimings }),
				modelDirectories: fakeModelDirectories({ provider: "deepseek-official", model: "deepseek-v4-flash" })
			}));
			const text = sideCostText(flatten(await mod.__render(() => Button({ wide: true, t: tWith(SIDE_T), store: { toggle() {} } }))));
			assert.strictEqual(text, "花费：0.00 元/日", "早于本次启动的回合不该产生估算");
		} finally {
			cleanup();
		}
	});
});

test("标题栏的重置要二次确认：确认后把当前周期的清零下限写到 host", async () => {
	await withFixedNow(OFF_PEAK_ISO, async () => {
		try {
			usagePayload = {
				ok: true,
				pricing: PRICING,
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

			// 点确认：写清零下限到 host（当前选中周期是「日」）。确认条要等 setConfirmReset
			// 触发的下一轮渲染才出现，所以这里按「有确认条就点确认、没有就点重置」写，
			// 让迷你 React 的收敛循环自己走完两轮。
			usagePayload = { ...usagePayload, daily: period("2026-09-05", 0) };
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

			// 清零后「日」这一格没有任何模型了，费用表整张换成那句空态文案。
			const after = textOf(flatten(await mod.__render(() => Panel({ t, store: OPEN_STORE }))));
			assert.ok(after.includes("balance.cost.summary.empty"), `清零后「日」应归零，实际: ${after.slice(0, 300)}`);
			// 清零下限刚写下去，得强制刷一次：不然界面上还是节流窗口里那个旧快照。
			assert.ok(usageRequests.some((u) => u.includes("force=1")), "清零后应强制刷新一次");
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

test("展开态：「余额：x 元」和「花费：y 元/日」是分开的两段，中间由 CSS 撑出空隙", async () => {
	await withFixedNow(OFF_PEAK_ISO, async () => {
		try {
			usagePayload = { ...EMPTY_USAGE, daily: period("2026-09-05", 0.0037, { input: 1000, cacheRead: 0, output: 500 }) };
			const { mod, captured } = mount();
			const Button = captured["sidebar.footer.action:balance"].component;
			const t = tWith(SIDE_T);

			const tree = flatten(await mod.__render(() => Button({ wide: true, t, store: { toggle() {} } })));
			const btn = tree.find((n) => n.type === "button");
			assert.strictEqual(btn.props.className, "dsbSideBtn");

			// **重点是「两个节点」而不是「一个拼起来的字符串」**：靠 `·` 分隔时，
			// CSS 没法在中间撑开空隙，窄栏截断也只能整句一起切。
			const bal = tree.find((n) => n.props && n.props.className === "dsbSideBal");
			const costNode = tree.find((n) => n.props && n.props.className === "dsbSideCost");
			assert.ok(bal, "余额应该是独立的一段");
			assert.ok(costNode, "花费应该是独立的一段");
			assert.strictEqual(String(bal.props.children), "余额：12.34 元");

			// 花费那一段显示的是**本日**花费，而且带上量纲「/日」——不写单位很容易被
			// 当成账户累计消费。
			assert.strictEqual(String(costNode.props.children), "花费：0.0037 元/日");

			// title/aria 用完整那句（「本日费用 …」）：可视标签靠紧挨着「余额」的上下文
			// 加一个量纲就够读懂，悬浮提示没有那个上下文，折叠成图标时它更是唯一能读到
			// 这两个数的地方。两者刻意不同，别顺手改成同一个 key。
			assert.ok(btn.props.title.includes("余额：12.34 元") && btn.props.title.includes("本日费用 0.0037 元"),
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
				: Promise.resolve({ ok: true, json: async () => ({ ok: true, value: { balance_infos: [] }, pricing, daily: period("d", 0), weekly: period("w", 0), monthly: period("m", 0) }) }));
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
			const btnTree = flatten(await mod.__render(() => Button({ wide: true, t: tWith(SIDE_T), store: { toggle() {} } })));
			assert.strictEqual(sideCostText(btnTree), "花费：0.00 元/日",
				"没花过钱时应显示 0（币种取自单价表）");

			// 面板里那张表则是整张换成空态文案——一张只有「总计 0.00 元」的表比一句话
			// 更难读，而且「这个周期没有任何模型产生用量」本身就是要说的那件事。
			const text = textOf(flatten(await mod.__render(() => Panel({ t, store: OPEN_STORE }))));
			assert.ok(text.includes("balance.cost.summary.empty"), `没有用量时应显示空态文案，实际: ${text.slice(0, 300)}`);
		} finally {
			cleanup();
		}
	});
});

/** 面板里所有注释行（`.dsbNote`）的文字，带上它是不是警示色。 */
function notesOf(tree) {
	return tree
		.filter((n) => n.props && typeof n.props.className === "string" && n.props.className.startsWith("dsbNote"))
		.map((n) => ({
			warn: n.props.className.includes("dsbWarn"),
			text: Array.isArray(n.props.children)
				? n.props.children.map((c) => (typeof c === "string" ? c : c?.props?.children ?? "")).join("")
				: String(n.props.children ?? "")
		}));
}

const SYNC_T = {
	"balance.price.synced": "单价同步于 {when}",
	"balance.price.stale": "单价已 {age}没能同步（{reason}），现在用的是 {when} 那份",
	"balance.price.never": "没能同步到官方单价，正在使用插件内置的默认价",
	"balance.price.error.parse": "定价页结构变了，解析不出来",
	"balance.price.error.network": "定价页打不开",
	"balance.price.effective": "自 {when} 起生效",
	"balance.price.pending": "已抓到一份 {when} 起生效的新价，还没开始套用",
	"balance.age.days": "{n} 天",
	"balance.age.hours": "{n} 小时",
	"balance.cost.price_change": "本周期跨越了 {count} 张价表，每条消息都按它发生时的单价计算"
};

/** 一份「一切正常」的同步状态，各用例只改自己关心的那几个字段。 */
function syncStatus(overrides) {
	return {
		source: "official",
		syncedAt: Date.now() - 3600_000,
		attemptedAt: Date.now(),
		error: null,
		stale: false,
		peak: true,
		effectiveFrom: Date.now() - 3600_000,
		effectiveFromSource: "seen",
		pendingFrom: [],
		...overrides
	};
}

test("单价同步正常时只有一行安静的「同步于 x」，不摆警示", async () => {
	await withFixedNow(OFF_PEAK_ISO, async () => {
		try {
			usagePayload = { ...EMPTY_USAGE, pricingStatus: syncStatus({}) };
			const { mod, captured } = mount();
			const Panel = captured["shell.overlay:balance-panel"].component;
			const tree = flatten(await mod.__render(() => Panel({ t: tWith(SYNC_T), store: OPEN_STORE })));
			const notes = notesOf(tree);
			assert.ok(notes.some((n) => !n.warn && n.text.startsWith("单价同步于")), `应有一行安静的同步说明，实际: ${JSON.stringify(notes)}`);
			assert.ok(!notes.some((n) => n.warn), `一切正常时不该有警示行，实际: ${JSON.stringify(notes)}`);
		} finally {
			cleanup();
		}
	});
});

test("单价同步不上时摆一行警示，说清多久没同步、为什么、现在用的是哪份", async () => {
	await withFixedNow(OFF_PEAK_ISO, async () => {
		try {
			const syncedAt = Date.now() - 3 * 24 * 3600_000;
			usagePayload = {
				...EMPTY_USAGE,
				pricingStatus: syncStatus({ syncedAt, error: "parse", stale: true, effectiveFrom: syncedAt })
			};
			const { mod, captured } = mount();
			const Panel = captured["shell.overlay:balance-panel"].component;
			const tree = flatten(await mod.__render(() => Panel({ t: tWith(SYNC_T), store: OPEN_STORE })));
			const warn = notesOf(tree).find((n) => n.warn);
			assert.ok(warn, "同步不上必须在界面上说出来——它是安静失败，数字上看不出来");
			assert.ok(warn.text.includes("3 天"), `要说清多久没同步，实际: ${warn.text}`);
			assert.ok(warn.text.includes("定价页结构变了"), `要区分「打不开」和「解析不出来」，实际: ${warn.text}`);
		} finally {
			cleanup();
		}
	});
});

test("从没同步成功过时说明正在用内置默认价", async () => {
	await withFixedNow(OFF_PEAK_ISO, async () => {
		try {
			usagePayload = {
				...EMPTY_USAGE,
				pricingStatus: syncStatus({ source: "default", syncedAt: null, error: "network", stale: true, effectiveFrom: null })
			};
			const { mod, captured } = mount();
			const Panel = captured["shell.overlay:balance-panel"].component;
			const tree = flatten(await mod.__render(() => Panel({ t: tWith(SYNC_T), store: OPEN_STORE })));
			const warn = notesOf(tree).find((n) => n.warn);
			assert.ok(warn?.text.includes("内置的默认价"), `实际: ${JSON.stringify(notesOf(tree))}`);
		} finally {
			cleanup();
		}
	});
});

test("手工校准过生效时刻、以及抓到一份还没生效的新价，都要说出来", async () => {
	await withFixedNow(OFF_PEAK_ISO, async () => {
		try {
			const pending = Date.now() + 86400_000;
			usagePayload = {
				...EMPTY_USAGE,
				pricingStatus: syncStatus({
					effectiveFrom: Date.now() - 86400_000,
					effectiveFromSource: "config",
					pendingFrom: [pending]
				})
			};
			const { mod, captured } = mount();
			const Panel = captured["shell.overlay:balance-panel"].component;
			const tree = flatten(await mod.__render(() => Panel({ t: tWith(SYNC_T), store: OPEN_STORE })));
			const notes = notesOf(tree);
			assert.ok(notes.some((n) => n.text.includes("起生效") && n.text.includes("同步于")),
				`手工校准过就该把生效时刻一起说出来，实际: ${JSON.stringify(notes)}`);
			assert.ok(notes.some((n) => n.text.includes("还没开始套用")),
				`抓到一份未生效的新价要说明，实际: ${JSON.stringify(notes)}`);
		} finally {
			cleanup();
		}
	});
});

test("周期跨越调价时说明「每条消息按它发生时的单价算」", async () => {
	await withFixedNow(OFF_PEAK_ISO, async () => {
		try {
			const daily = period("2026-09-05", 1, { input: 1, cacheRead: 0, output: 1 });
			usagePayload = {
				...EMPTY_USAGE,
				daily: { ...daily, priceChanges: [Date.now() - 5 * 86400_000, Date.now() - 86400_000] }
			};
			const { mod, captured } = mount();
			const Panel = captured["shell.overlay:balance-panel"].component;
			const tree = flatten(await mod.__render(() => Panel({ t: tWith(SYNC_T), store: OPEN_STORE })));
			const warn = notesOf(tree).find((n) => n.warn);
			assert.ok(warn?.text.includes("2 张价表"),
				`跨了调价要说明，否则数字整体变一档像是算错了，实际: ${JSON.stringify(notesOf(tree))}`);
			cleanup();

			// 只用到一张价表时不该有这句——大多数时候都是这种情况，天天挂着一行说明是噪音。
			usagePayload = { ...EMPTY_USAGE, daily: { ...daily, priceChanges: [Date.now() - 86400_000] } };
			const second = mount();
			const tree2 = flatten(await second.mod.__render(() => second.captured["shell.overlay:balance-panel"].component({ t: tWith(SYNC_T), store: OPEN_STORE })));
			assert.ok(!notesOf(tree2).some((n) => n.text.includes("张价表")), "没跨调价就不该有这句");
		} finally {
			cleanup();
		}
	});
});

test("面板把高峰时段那句规则写出来，手工配的还要转警示色", async () => {
	await withFixedNow(OFF_PEAK_ISO, async () => {
		try {
			const T = {
				...SYNC_T,
				"balance.price.window": "高峰时段：{days} {windows}（北京时间）",
				"balance.price.days_range": "{from}至{to}",
				"balance.price.weekday.1": "周一",
				"balance.price.weekday.5": "周五",
				"balance.price.window_config": "手工配置",
				"balance.price.window_dates": "另有 {offPeak} 天整天按空闲、{peak} 天按工作日",
				"balance.price.holiday_peak": "法定节假日按高峰",
				"balance.price.holiday_offpeak": "法定节假日按空闲",
				"balance.price.holiday_calendar": "依据 {years} 年放假安排",
				"balance.price.holiday_calendar_failed": "放假安排取不到（{reason}），节假日暂按高峰计",
				"balance.price.unmodelled": "定价页这句话里有插件没读懂的计费规则，请核对：{note}"
			};
			usagePayload = {
				...EMPTY_USAGE,
				pricingStatus: syncStatus({
					schedule: { days: [1, 2, 3, 4, 5], windows: [[540, 720], [840, 1080]], source: "official", offPeakDates: 0, peakDates: 0 }
				})
			};
			const { mod, captured } = mount();
			const Panel = captured["shell.overlay:balance-panel"].component;
			let notes = notesOf(flatten(await mod.__render(() => Panel({ t: tWith(T), store: OPEN_STORE }))));
			const window = notes.find((n) => n.text.startsWith("高峰时段："));
			assert.ok(window, `规则本身必须写出来——同一笔用量按峰还是按谷差一倍钱，实际: ${JSON.stringify(notes)}`);
			assert.strictEqual(window.text, "高峰时段：周一至周五 9:00–12:00、14:00–18:00（北京时间） · 法定节假日按高峰",
				"节假日算不算高峰是用户一定会问、数字上又完全看不出来的事，得写在脸上");
			assert.strictEqual(window.warn, false, "跟官方页一致时不必报警");
			cleanup();

			// 手工覆盖过：转警示色，并把「覆盖了几天」也说出来。
			usagePayload = {
				...EMPTY_USAGE,
				pricingStatus: syncStatus({
					schedule: { days: [1, 2, 3, 4, 5], windows: [[510, 720]], source: "config", offPeakDates: 7, peakDates: 1 }
				})
			};
			const second = mount();
			notes = notesOf(flatten(await second.mod.__render(() => second.captured["shell.overlay:balance-panel"].component({ t: tWith(T), store: OPEN_STORE }))));
			const tuned = notes.find((n) => n.text.startsWith("高峰时段："));
			assert.ok(tuned?.warn, `手工覆盖过官方规则要看得出来，实际: ${JSON.stringify(notes)}`);
			assert.ok(tuned.text.includes("8:30–12:00"), `实际: ${tuned.text}`);
			assert.ok(tuned.text.includes("手工配置") && tuned.text.includes("另有 7 天"), `实际: ${tuned.text}`);
			cleanup();

			// 只用日期覆盖（节假日）也是「我不按官方那句话算」的声明，同样要转警示色。
			usagePayload = {
				...EMPTY_USAGE,
				pricingStatus: syncStatus({
					schedule: { days: [1, 2, 3, 4, 5], windows: [[540, 720]], source: "official", offPeakDates: 7, peakDates: 0 }
				})
			};
			const third = mount();
			notes = notesOf(flatten(await third.mod.__render(() => third.captured["shell.overlay:balance-panel"].component({ t: tWith(T), store: OPEN_STORE }))));
			const dated = notes.find((n) => n.text.startsWith("高峰时段："));
			assert.ok(dated?.warn, `拿日期整天覆盖过也要看得出来，实际: ${JSON.stringify(notes)}`);
		} finally {
			cleanup();
		}
	});
});

test("节假日口径写在脸上；官方改口之后面板跟着说「按空闲」并注明依据", async () => {
	await withFixedNow(OFF_PEAK_ISO, async () => {
		try {
			const T = {
				...SYNC_T,
				"balance.price.window": "高峰时段：{days} {windows}（北京时间）",
				"balance.price.days_range": "{from}至{to}",
				"balance.price.weekday.1": "周一",
				"balance.price.weekday.5": "周五",
				"balance.price.holiday_peak": "法定节假日按高峰",
				"balance.price.holiday_offpeak": "法定节假日按空闲",
				"balance.price.holiday_calendar": "依据 {years} 年放假安排",
				"balance.price.holiday_calendar_failed": "放假安排取不到（{reason}），节假日暂按高峰计",
				"balance.price.error.network": "定价页打不开"
			};
			const schedule = (extra) => ({
				days: [1, 2, 3, 4, 5], windows: [[540, 720]], source: "official",
				offPeakDates: 0, peakDates: 0, holidays: "peak", holidaySource: "official",
				note: null, unmodelled: false, calendar: null, ...extra
			});
			const render = async (status) => {
				usagePayload = { ...EMPTY_USAGE, pricingStatus: syncStatus(status) };
				const { mod, captured } = mount();
				const tree = flatten(await mod.__render(() => captured["shell.overlay:balance-panel"].component({ t: tWith(T), store: OPEN_STORE })));
				const notes = notesOf(tree);
				cleanup();
				return notes;
			};

			// 官方现在这句话没提节假日 → 按高峰，而且一次日历都不用取。
			let notes = await render({ schedule: schedule({}) });
			assert.ok(notes.some((n) => n.text.includes("法定节假日按高峰")), `实际: ${JSON.stringify(notes)}`);

			// 官方改口之后：说按空闲，并注明依据哪一年的放假安排。
			notes = await render({
				schedule: schedule({ holidays: "offpeak", calendar: { years: [2026], missing: [], error: null } })
			});
			const line = notes.find((n) => n.text.includes("法定节假日按空闲"));
			assert.ok(line, `实际: ${JSON.stringify(notes)}`);
			assert.ok(line.text.includes("依据 2026 年放假安排"), `要注明依据，实际: ${line.text}`);
			assert.strictEqual(line.warn, false, "跟着官方页走就不该报警");

			// 说好按空闲、日历却没取到：等于又变回按高峰算，必须看得见。
			notes = await render({
				schedule: schedule({ holidays: "offpeak", calendar: { years: [], missing: [2026], error: "network" } })
			});
			const failed = notes.find((n) => n.text.includes("放假安排取不到"));
			assert.ok(failed?.warn, `日历没取到要报警，实际: ${JSON.stringify(notes)}`);
		} finally {
			cleanup();
		}
	});
});

test("定价页出现插件没读懂的计费规则时，把原文摆出来", async () => {
	await withFixedNow(OFF_PEAK_ISO, async () => {
		try {
			const note = "高峰时段为北京时间周一至周五 9:00 - 12:00，单日费用封顶 100 元";
			usagePayload = {
				...EMPTY_USAGE,
				pricingStatus: syncStatus({
					schedule: {
						days: [1, 2, 3, 4, 5], windows: [[540, 720]], source: "official",
						offPeakDates: 0, peakDates: 0, holidays: "peak", holidaySource: "official",
						note, unmodelled: true, calendar: null
					}
				})
			};
			const { mod, captured } = mount();
			const tree = flatten(await mod.__render(() => captured["shell.overlay:balance-panel"].component({
				t: tWith({ ...SYNC_T, "balance.price.unmodelled": "定价页这句话里有插件没读懂的计费规则，请核对：{note}" }),
				store: OPEN_STORE
			})));
			const warn = notesOf(tree).find((n) => n.text.includes("没读懂"));
			assert.ok(warn?.warn, `读不懂就得喊一声，不能装作规则没变，实际: ${JSON.stringify(notesOf(tree))}`);
			assert.ok(warn.text.includes("封顶 100 元"), `要把原文摆出来，实际: ${warn.text}`);
		} finally {
			cleanup();
		}
	});
});

test("侧边栏的峰/谷角标跟着单价表里那套时段规则走", async () => {
	// 周二 8:45 北京时间：官方规则（9:00 起）下是空闲，表里写着 8:30 起就是高峰。
	await withFixedNow("2026-09-01T00:45:00.000Z", async () => {
		try {
			const withWindows = (windows) => ({
				currency: "CNY",
				peakMultiplier: 2,
				peakSchedule: { days: [1, 2, 3, 4, 5], windows },
				modelPricing: {
					"deepseek-official:deepseek-v4-flash": {
						cacheHitPerMillion: 0.05, cacheMissPerMillion: 1.5, outputPerMillion: 4.5,
						peak: { cacheHitPerMillion: 0.1, cacheMissPerMillion: 3, outputPerMillion: 9 }
					}
				}
			});
			const badgeWith = async (windows) => {
				const { mod, captured, t } = mount();
				const pricing = withWindows(windows);
				globalThis.fetch = (url) => (String(url).endsWith("/balance/pricing")
					? Promise.resolve({ ok: true, json: async () => ({ ok: true, pricing }) })
					: Promise.resolve({ ok: true, json: async () => ({ ...EMPTY_USAGE, pricing }) }));
				const Button = captured["sidebar.footer.action:balance"].component;
				const tree = flatten(await mod.__render(() => Button({ wide: true, t, store: { toggle() {} } })));
				const badge = tree.find((n) => n.props?.className === "dsbSidePeak" || n.props?.className === "dsbSideOffpeak");
				cleanup();
				return badge?.props.className ?? null;
			};

			assert.strictEqual(await badgeWith([[540, 720]]), "dsbSideOffpeak", "9:00 起的规则下 8:45 该是「谷」");
			assert.strictEqual(await badgeWith([[510, 720]]), "dsbSidePeak", "8:30 起的规则下 8:45 该是「峰」");
		} finally {
			cleanup();
		}
	});
});

test("单价表按每个模型自己那套峰价折算，不是全表乘一个倍率", async () => {
	await withFixedNow(PEAK_ISO, async () => {
		try {
			const { mod, captured, t } = mount();
			// 输出的峰价只加 50%，输入照旧翻倍——统一倍率算不出这张表。
			const pricing = {
				currency: "CNY",
				peakMultiplier: 2,
				modelPricing: {
					"deepseek-official:deepseek-v4-flash": {
						cacheHitPerMillion: 0.05, cacheMissPerMillion: 1.5, outputPerMillion: 9,
						peak: { cacheHitPerMillion: 0.1, cacheMissPerMillion: 3, outputPerMillion: 13.5 }
					}
				}
			};
			globalThis.fetch = (url) => (String(url).endsWith("/balance/pricing")
				? Promise.resolve({ ok: true, json: async () => ({ ok: true, pricing }) })
				: Promise.resolve({ ok: true, json: async () => ({ ...EMPTY_USAGE, pricing }) }));
			const Panel = captured["shell.overlay:balance-panel"].component;
			const text = textOf(flatten(await mod.__render(() => Panel({ t, store: OPEN_STORE }))));
			assert.ok(text.includes("13.5 元"), `输出该显示页面上那个峰价 13.5，实际: ${text.slice(-400)}`);
			assert.ok(!text.includes("18 元"), "不能拿基准价 9 乘统一倍率 2 算成 18");
			assert.ok(text.includes("3 元") && text.includes("0.1 元"), "输入两项的峰价也要按页面上的来");
		} finally {
			cleanup();
		}
	});
});

test("价表里没有峰价时（官方取消峰谷），侧边栏不再贴峰/谷角标", async () => {
	await withFixedNow(PEAK_ISO, async () => {
		try {
			const { mod, captured, t } = mount();
			const flat = {
				currency: "CNY",
				peakMultiplier: 1,
				modelPricing: { "deepseek-official:deepseek-v4-flash": { cacheHitPerMillion: 0.05, cacheMissPerMillion: 1.5, outputPerMillion: 4.5 } }
			};
			globalThis.fetch = (url) => (String(url).endsWith("/balance/pricing")
				? Promise.resolve({ ok: true, json: async () => ({ ok: true, pricing: flat }) })
				: Promise.resolve({ ok: true, json: async () => ({ ...EMPTY_USAGE, pricing: flat }) }));
			const Button = captured["sidebar.footer.action:balance"].component;
			const tree = flatten(await mod.__render(() => Button({ wide: true, t, store: { toggle() {} } })));
			assert.ok(!tree.some((n) => n.props?.className === "dsbSidePeak" || n.props?.className === "dsbSideOffpeak"),
				"没有峰价就不该继续贴一个已经不存在的计费规则");

			const Panel = captured["shell.overlay:balance-panel"].component;
			const text = textOf(flatten(await mod.__render(() => Panel({ t, store: OPEN_STORE }))));
			assert.ok(!text.includes("balance.price.period_note"), "单价那一节也不该再写「已按高峰时段折算」");
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
