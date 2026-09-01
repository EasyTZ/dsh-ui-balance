// 客户端半的冒烟测试：在 node 里伪造 window / React，真跑一遍 factory、apply()
// 与两个槽组件的渲染路径。手法照抄 dsh-terminal-panel 的 test/client-smoke.test.js
// （见其文件顶部注释的两条硬规矩：迷你 React 必须真的会渲染，effect 的 teardown
// 不能在本轮就调）。
//
// 这个文件额外要守的一条是本插件特有的：`appSpendStore` 是模块级单例，
// BalanceTail（写）和 BalanceSidebarInfo（读）之间隔着没有 props 传递的共享状态
// ——纯逻辑单测覆盖不到「两个槽组件之间通过模块级 store 真的对上账」这件事，
// 只有把两者都真的渲染一遍、检查渲染结果，才能证明这条线路是通的。

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

function fakePricing() {
	return { currency: "CNY", cacheHitPerMillion: 0.5, cacheMissPerMillion: 2, outputPerMillion: 8 };
}

function fakeFetch() {
	return Promise.resolve({
		ok: true,
		json: async () => ({
			ok: true,
			value: { balance_infos: [{ currency: "CNY", total_balance: "12.34" }] },
			pricing: fakePricing()
		})
	});
}

function loadModule() {
	const src = fs.readFileSync(CLIENT, "utf8");
	const registrations = [];
	const docListeners = [];
	Object.assign(globalThis, {
		window: { __ModuleLoader__: { load: (reg) => registrations.push(reg) } },
		document: {
			querySelector: () => null,
			createElement: () => ({ dataset: {}, style: {} }),
			head: { appendChild() {} },
			addEventListener: (type, fn) => docListeners.push({ type, fn })
		},
		fetch: fakeFetch
	});

	const reactJsx = {
		jsx: (type, props, key) => ({ type, props: props || {}, key }),
		jsxs: (type, props, key) => ({ type, props: props || {}, key }),
		Fragment: Symbol("Fragment")
	};

	// —— 一个够用的迷你 React ——
	// 每次 __render() 都重置 cells：BalanceTail / BalanceSidebarInfo 是两棵完全
	// 独立的组件树，共用同一份 cells 数组会把后一棵树的 hook 状态错读成前一棵的。
	// 只在同一次 __render 内部的多轮收敛循环里，hook 状态才需要跨轮持久。
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
	reactHooks.__render = async (render) => {
		cells = [];
		const teardowns = [];
		let last;
		for (let round = 0; round < 12; round += 1) {
			cursor = 0;
			dirty = false;
			effects.length = 0;
			last = render();
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

const cleanup = () => Object.assign(globalThis, { window: undefined, document: undefined, fetch: undefined });

function mount() {
	const mod = loadModule();
	const captured = {};
	const ctx = {
		effect: (fn) => { fn(); return () => {}; },
		locale: { register() {} },
		slots: {
			inject: (key, cb) => { cb(); return () => {}; },
			register: (o, comp) => { captured[o.name + ":" + o.id] = { opts: o, component: comp }; return () => {}; }
		}
	};
	mod.apply(ctx);
	return { mod, captured, t: (k) => k };
}

test("冒烟：两个槽都注册到位，且分别真的渲染出内容", async () => {
	try {
		const { mod, captured, t } = mount();
		assert.strictEqual(typeof mod.apply, "function");

		const tailEntry = captured["conversation.chat.turnTail:balance"];
		const sideEntry = captured["sidebar.footer.action:balance"];
		assert.ok(tailEntry, "余额应注册进 conversation.chat.turnTail");
		assert.ok(sideEntry, "余额应注册进 sidebar.footer.action");
		assert.strictEqual(sideEntry.opts.order, 120);
		assert.strictEqual(typeof tailEntry.component, "function");
		assert.strictEqual(typeof sideEntry.component, "function");
	} finally {
		cleanup();
	}
});

test("本次对话花费：token 用量按单价折算，渲染里能看到金额", async () => {
	try {
		const { mod, captured, t } = mount();
		const TailComp = captured["conversation.chat.turnTail:balance"].component;

		const usage = { uncachedInputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 };
		const tree = flatten(await mod.__render(() => TailComp({
			t,
			sessionId: "s1",
			useProjection: () => usage
		})));

		const text = textOf(tree);
		assert.ok(text.includes("12.34"), "应渲染出余额数值");
		// (1000*2 + 500*8) / 1e6 = 0.006
		assert.ok(text.includes("0.006"), `应渲染出本次对话花费，实际:\n${text}`);
	} finally {
		cleanup();
	}
});

test("本次打开共消费：按 Turn 时间戳分辨「历史」与「刚发生」，单轮新对话不漏算、旧会话历史不误算", async () => {
	try {
		const { mod, captured, t } = mount();
		const Tail = captured["conversation.chat.turnTail:balance"].component;
		const Side = captured["sidebar.footer.action:balance"].component;

		const historical = (offsetMs) => ({ start: { time: Date.now() - 100000 - offsetMs } });
		const justNow = () => ({ start: { time: Date.now() + 10 } });

		// 会话 sA：全新对话，只有一轮，turn.start.time 晚于 appOpenTime——没有任何
		// 历史证据，必须全额计入，不能因为「第一次看到这个会话」就被当基线滤掉
		// （单轮问答问完就关，是最常见的使用方式，漏算这个就是漏算大多数场景）。
		// (1000*2 + 500*8)/1e6 = 0.006
		await mod.__render(() => Tail({
			t, sessionId: "sA", turn: justNow(),
			useProjection: () => ({ uncachedInputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 })
		}));
		let side = flatten(await mod.__render(() => Side({ t, wide: true })));
		assert.ok(textOf(side).includes("0.006"), `全新单轮对话应全额计入，实际:\n${textOf(side)}`);

		// 会话 sB：重新打开一个老会话，历史上的两轮 turnTail 同时挂载（时间戳都早于
		// appOpenTime），读到的是同一个当前累计值——应该被当基线滤掉，不计费，
		// 且两次同值上报不能互相重复累加。
		const oldUsage = () => ({ uncachedInputTokens: 100000, outputTokens: 50000, cacheReadTokens: 0, cacheWriteTokens: 0 });
		await mod.__render(() => Tail({ t, sessionId: "sB", turn: historical(1000), useProjection: oldUsage }));
		await mod.__render(() => Tail({ t, sessionId: "sB", turn: historical(2000), useProjection: oldUsage }));
		side = flatten(await mod.__render(() => Side({ t, wide: true })));
		assert.ok(textOf(side).includes("0.006") && !textOf(side).includes("0.606"), `翻旧会话的历史不该计费，实际:\n${textOf(side)}`);

		// 同一个老会话 sB 现在收工了新的一轮（turn.start.time 晚于 appOpenTime），
		// 增量才是这次启动期间真正花的钱：(1000*2+500*8)/1e6=0.006。
		await mod.__render(() => Tail({
			t, sessionId: "sB", turn: justNow(),
			useProjection: () => ({ uncachedInputTokens: 101000, outputTokens: 50500, cacheReadTokens: 0, cacheWriteTokens: 0 })
		}));
		side = flatten(await mod.__render(() => Side({ t, wide: true })));
		// 累计应为 sA 的 0.006 + sB 新一轮的 0.006 = 0.012
		assert.ok(textOf(side).includes("0.012"), `旧会话的新一轮应按增量计入，累计应为 0.012，实际:\n${textOf(side)}`);
	} finally {
		cleanup();
	}
});
