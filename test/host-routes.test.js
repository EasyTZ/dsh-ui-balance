// host 半路由的端到端测试：真跑 `apply()`，拿到注册进 webServer 的 handler，
// 喂真的 req/res 进去。
//
// 这里守的是两件在别处测不到的事：
//   1. **会话日志根目录可配**。`dsh-session-persistence-jsonl` 的 `root` 是
//      `z.string().required()`，dsh-base 的 patch 把它配成 `dshHomePath('sessions')`，
//      但谁在自己的 patch 里换了地方，插件就会扫空——而扫空的表现是「四格全 0、
//      没有任何报错」，比崩溃难查得多。所以留了 `sessionsRoot` 这个口子，它必须真
//      的被用上。
//   2. **清零下限是按周期各记一份的**。清「日」不能顺手把「月」也清了。
//   3. **官方调价不会把调价之前的历史金额改写**。缓存里存的是 token 数、单价是汇总
//      时才套上去的，所以「用哪张价表」必须按每条消息自己的时刻去价格时间线上查。
//      早先这里拿当前那张表套全部历史，一次调价就把整月的历史金额整体改一档。
//   4. **同步不上的时候要看得见**，而且要继续用手上最后那份真实价，不能静默换成
//      代码里写死的默认价。
//
// DSH_HOME 指到临时目录，缓存/清零下限都落在那里，不碰用户真实的 dsh home。

import assert from "node:assert";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";

const PRICING = {
	currency: "CNY",
	peakMultiplier: 2,
	modelPricing: {
		"deepseek-official:deepseek-v4-flash": { cacheHitPerMillion: 0.05, cacheMissPerMillion: 1.5, outputPerMillion: 4.5 }
	}
};

/** 2026-09-05 周六 10:00 北京时间：周末，全天空闲时段——金额不受峰谷影响。 */
const OFF_PEAK = Date.parse("2026-09-05T02:00:00.000Z");
/** 2026-09-01 周二 10:00 北京时间：落在 9-12 高峰窗口内。 */
const PEAK = Date.parse("2026-09-01T02:00:00.000Z");

/** 调价后的价：输出翻一倍，且高峰只加 50%（刻意不是统一的 2 倍）。 */
const PRICING_NEW = {
	currency: "CNY",
	peakMultiplier: 2,
	modelPricing: {
		"deepseek-official:deepseek-v4-flash": {
			cacheHitPerMillion: 0.05,
			cacheMissPerMillion: 1.5,
			outputPerMillion: 9,
			peak: { cacheHitPerMillion: 0.075, cacheMissPerMillion: 2.25, outputPerMillion: 13.5 }
		}
	}
};

function assistantFrame(time, model, usage) {
	const event = {
		type: "assistant/message",
		seq: 1,
		time,
		data: {
			turn: 1,
			step: 1,
			message: { role: "assistant", content: [], source: { kind: "model", provider: "deepseek-official", model }, id: "m" },
			usage
		}
	};
	return zstdCompressSync(Buffer.from(JSON.stringify(event) + "\n", "utf8"));
}

async function seedSessions(root, events) {
	const dir = join(root, "--proj-a--", "session-1");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "session.jsonl.zstd"), Buffer.concat(events));
}

/** 预置一份还没过期的单价缓存，`getPricingBundle` 就不会去打官方定价页。 */
async function seedPricing(home, { pricing = PRICING, fetchedAt = Date.now(), attempt } = {}) {
	await mkdir(join(home, "plugins"), { recursive: true });
	await writeFile(
		join(home, "plugins", "dsh-ui-balance-pricing-cache.json"),
		JSON.stringify(attempt === undefined ? { fetchedAt, pricing } : { fetchedAt, pricing, attempt }),
		"utf8"
	);
}

/** 预置价格时间线：`entries` 是 `[{ seenAt, pricing }]`。 */
async function seedPricingHistory(home, entries) {
	await mkdir(join(home, "plugins"), { recursive: true });
	await writeFile(
		join(home, "plugins", "dsh-ui-balance-pricing-history.json"),
		JSON.stringify({ version: 1, entries }),
		"utf8"
	);
}

/**
 * 官方定价页的最小形状：一张表 + 那句高峰时段脚注。价格和时段都可换——用来驱动
 * 「同步到新价 / 新时段」这条路。
 */
function pricingPage({ idle, peak, note = "高峰时段为北京时间周一至周五 9:00 - 12:00、14:00 - 18:00（其余为空闲时段）。" }) {
	return `<html><body><p>${note}</p><table>`
		+ `<tr><td colspan="3">模型</td><td>deepseek-v4-flash</td></tr>`
		+ `<tr><td rowspan="2">百万tokens输入<br>（缓存命中）</td><td>空闲时段</td><td>${idle[0]}元</td></tr>`
		+ `<tr><td>高峰时段</td><td>${peak[0]}元</td></tr>`
		+ `<tr><td rowspan="2">百万tokens输入<br>（缓存未命中）</td><td>空闲时段</td><td>${idle[1]}元</td></tr>`
		+ `<tr><td>高峰时段</td><td>${peak[1]}元</td></tr>`
		+ `<tr><td rowspan="2">百万tokens输出</td><td>空闲时段</td><td>${idle[2]}元</td></tr>`
		+ `<tr><td>高峰时段</td><td>${peak[2]}元</td></tr>`
		+ `</table></body></html>`;
}

async function readHistory(home) {
	return JSON.parse(await readFile(join(home, "plugins", "dsh-ui-balance-pricing-history.json"), "utf8"));
}

function fakeRequest(url, { method = "GET", body } = {}) {
	return {
		method,
		url,
		headers: body === undefined ? {} : { "content-type": "application/json" },
		async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(body); }
	};
}

function call(routes, url, options) {
	return new Promise((resolve) => {
		const handler = routes.get(url.split("?")[0]);
		assert.ok(handler, `没有注册路由 ${url}`);
		handler(fakeRequest(url, options), {
			statusCode: 0,
			writeHead(code) { this.statusCode = code; },
			end(text) { resolve({ status: this.statusCode, json: text === undefined ? null : JSON.parse(text) }); }
		});
	});
}

/**
 * 每个用例都重新 import 一次 index.js：扫描缓存是模块级的单例，用例之间共用会
 * 让「上一个用例扫过的目录」渗到下一个用例里。查询串加个序号绕开 ESM 模块缓存。
 */
let moduleSeq = 0;
async function mountHost(config) {
	const mod = await import(`../lib/index.js?case=${moduleSeq++}`);
	const routes = new Map();
	mod.apply(
		{
			effect: (fn) => { fn(); return () => {}; },
			webServer: { port: 4321, register: (r) => { routes.set(r.path, r.handler); return () => {}; } },
			get: () => void 0
		},
		new mod.Config(config)
	);
	return routes;
}

async function withHome(fn) {
	const base = await mkdtemp(join(tmpdir(), "dsh-balance-host-"));
	const home = join(base, "home");
	const previousHome = process.env.DSH_HOME;
	const previousFetch = globalThis.fetch;
	// apply() 会后台抓一次官方定价页。测试里不许出网：让它立刻失败，回退到
	// 预置的单价缓存；也免得一个 10 秒超时的 fetch 吊住测试进程。
	globalThis.fetch = () => Promise.reject(new Error("offline in tests"));
	process.env.DSH_HOME = home;
	await mkdir(home, { recursive: true });
	await seedPricing(home);
	try {
		return await fn({ base, home });
	} finally {
		// **先等在场的异步写盘落完，再把 DSH_HOME 还回去。** `apply()` 里那次同步和
		// `getPricingBundle` 里的后台刷新都是 fire-and-forget 的，而落盘路径每次都
		// 重新读 `DSH_HOME`——提前还原环境变量，那些写就会落到用户**真实的** dsh home
		// 里去（实测把测试用的单价缓存写进了真机，把价格时间线也污染了一条）。
		await new Promise((resolve) => setTimeout(resolve, 60));
		if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
		globalThis.fetch = previousFetch;
		await rm(base, { recursive: true, force: true });
	}
}

test("sessionsRoot 留空时从 $DSH_HOME/sessions 读", async () => {
	await withHome(async ({ home }) => {
		await seedSessions(join(home, "sessions"), [
			assistantFrame(OFF_PEAK, "deepseek-v4-flash", { inputTokens: 0, outputTokens: 1000 })
		]);
		const routes = await mountHost({});
		const { status, json } = await call(routes, `/api/dsdesktop/balance/usage?force=1`);
		assert.strictEqual(status, 200);
		// 1000 输出 token，空闲时段：1000 * 4.5 / 1e6 = 0.0045
		assert.ok(Math.abs(json.monthly.totalCost - 0.0045) < 1e-12, `实际: ${json.monthly.totalCost}`);
		assert.strictEqual(json.monthly.perModel[0].model, "deepseek-v4-flash");
	});
});

test("配了 sessionsRoot 就从那里读，不再看 $DSH_HOME/sessions", async () => {
	await withHome(async ({ base, home }) => {
		// 默认位置放一份**不该被读到**的数据，配置指向的位置放真正该读的那份。
		await seedSessions(join(home, "sessions"), [
			assistantFrame(OFF_PEAK, "deepseek-v4-flash", { inputTokens: 0, outputTokens: 999999 })
		]);
		const elsewhere = join(base, "elsewhere", "sessions");
		await seedSessions(elsewhere, [
			assistantFrame(OFF_PEAK, "deepseek-v4-flash", { inputTokens: 0, outputTokens: 2000 })
		]);
		const routes = await mountHost({ sessionsRoot: elsewhere });
		const { json } = await call(routes, `/api/dsdesktop/balance/usage?force=1`);
		assert.ok(Math.abs(json.monthly.totalCost - 0.009) < 1e-12,
			`应只统计配置指向的那份（2000 token = 0.009），实际: ${json.monthly.totalCost}`);
	});
});

test("清零下限按周期各记一份：清「日」不动「月」", async () => {
	await withHome(async ({ home }) => {
		await seedSessions(join(home, "sessions"), [
			assistantFrame(Date.now() - 60_000, "deepseek-v4-flash", { inputTokens: 0, outputTokens: 1000 })
		]);
		const routes = await mountHost({});
		const before = (await call(routes, `/api/dsdesktop/balance/usage?force=1`)).json;
		assert.ok(before.daily.totalCost > 0 && before.monthly.totalCost > 0, "先得有数字可清");

		const reset = await call(routes, "/api/dsdesktop/balance/reset", { method: "POST", body: JSON.stringify({ period: "day" }) });
		assert.strictEqual(reset.status, 200);

		const after = (await call(routes, `/api/dsdesktop/balance/usage?force=1`)).json;
		assert.strictEqual(after.daily.totalCost, 0, "「日」应被清零");
		assert.ok(Math.abs(after.monthly.totalCost - before.monthly.totalCost) < 1e-12, "「月」不该跟着被清");

		const bad = await call(routes, "/api/dsdesktop/balance/reset", { method: "POST", body: JSON.stringify({ period: "year" }) });
		assert.strictEqual(bad.status, 400, "无效周期要拒绝，不能悄悄按「日」处理");
	});
});

test("usage 响应不再有「本次打开」那一格，perModel 带上按类别拆开的金额", async () => {
	await withHome(async ({ home }) => {
		await seedSessions(join(home, "sessions"), [
			assistantFrame(OFF_PEAK, "deepseek-v4-flash", { inputTokens: 1000, cacheReadTokens: 2000, outputTokens: 3000 })
		]);
		const routes = await mountHost({});
		const { json } = await call(routes, `/api/dsdesktop/balance/usage?force=1`);

		// 界面上没有「本次打开」这个口径了，这一格也就不该再算——它是全量记录上的
		// 第四次汇总，白花的是每次请求的 CPU。
		assert.strictEqual(json.session, void 0, "不该再返回 session 那一格");
		assert.ok(json.daily && json.weekly && json.monthly, "日/周/月三格都要在");

		const [entry] = json.monthly.perModel;
		// 空闲时段：未命中 1000 * 1.5 / 1e6、命中 2000 * 0.05 / 1e6、输出 3000 * 4.5 / 1e6
		assert.ok(Math.abs(entry.costs.input - 0.0015) < 1e-12, `实际: ${entry.costs.input}`);
		assert.ok(Math.abs(entry.costs.cacheRead - 0.0001) < 1e-12, `实际: ${entry.costs.cacheRead}`);
		assert.ok(Math.abs(entry.costs.output - 0.0135) < 1e-12, `实际: ${entry.costs.output}`);
		assert.strictEqual(entry.cost, entry.costs.input + entry.costs.cacheRead + entry.costs.output);
	});
});

/** 调价的时刻：9/3 00:00 北京时间。之前的消息按旧价，之后的按新价。 */
const CHANGE_AT = Date.parse("2026-09-02T16:00:00.000Z");
/** 旧价是 8/1 就同步到的。 */
const OLD_SEEN = Date.parse("2026-08-01T00:00:00.000Z");

test("官方调价只影响调价之后的消息，之前的历史金额不被改写", async () => {
	await withHome(async ({ home }) => {
		await seedSessions(join(home, "sessions"), [
			// 9/1 高峰时段一条（旧价）、9/5 空闲时段一条（新价）：两条都是 1000 输出 token。
			assistantFrame(PEAK, "deepseek-v4-flash", { inputTokens: 0, outputTokens: 1000 }),
			assistantFrame(OFF_PEAK, "deepseek-v4-flash", { inputTokens: 0, outputTokens: 1000 })
		]);
		await seedPricing(home, { pricing: PRICING_NEW });
		await seedPricingHistory(home, [
			{ seenAt: OLD_SEEN, pricing: PRICING },
			{ seenAt: CHANGE_AT, pricing: PRICING_NEW }
		]);
		const routes = await mountHost({});
		const { json } = await call(routes, `/api/dsdesktop/balance/usage?force=1`);

		// 旧价 · 高峰（统一 2 倍）：1000 * 4.5 / 1e6 * 2 = 0.009
		// 新价 · 空闲：1000 * 9 / 1e6 = 0.009
		// 两条恰好相等是刻意的：如果代码拿「当前那张表」套全部历史，第一条会变成
		// 1000 * 13.5 / 1e6 = 0.0135（新价的高峰价），总额立刻露馅。
		assert.ok(Math.abs(json.monthly.totalCost - 0.018) < 1e-12,
			`调价前那条应按旧价算，实际总额: ${json.monthly.totalCost}`);
		assert.deepStrictEqual(json.monthly.priceChanges, [OLD_SEEN, CHANGE_AT],
			"本月跨了一次调价，两张价表都该被用到");
		assert.deepStrictEqual(json.daily.priceChanges ?? [], [], "今天一条消息都没有，谈不上跨调价");
		// 界面上摊的是当前生效的那张表。
		assert.strictEqual(json.pricing.modelPricing["deepseek-official:deepseek-v4-flash"].outputPerMillion, 9);
		assert.strictEqual(json.pricingStatus.effectiveFrom, CHANGE_AT);
		assert.strictEqual(json.pricingStatus.effectiveFromSource, "seen");
	});
});

test("pricingEffectiveFrom 能把生效时刻挪到实际公告的那一刻", async () => {
	await withHome(async ({ home }) => {
		await seedSessions(join(home, "sessions"), [
			assistantFrame(PEAK, "deepseek-v4-flash", { inputTokens: 0, outputTokens: 1000 })
		]);
		await seedPricing(home, { pricing: PRICING_NEW });
		// 新价是 9/3 才看到的，但官方说 8/31 就生效了——那 9/1 那条就该按新价算。
		await seedPricingHistory(home, [
			{ seenAt: OLD_SEEN, pricing: PRICING },
			{ seenAt: CHANGE_AT, pricing: PRICING_NEW }
		]);
		const routes = await mountHost({ pricingEffectiveFrom: "2026-08-31T00:00:00+08:00" });
		const { json } = await call(routes, `/api/dsdesktop/balance/usage?force=1`);

		// 新价 · 高峰（那套独立的峰价，不是基准价 × 2）：1000 * 13.5 / 1e6 = 0.0135
		assert.ok(Math.abs(json.monthly.totalCost - 0.0135) < 1e-12,
			`挪了生效时刻之后应按新价算，实际: ${json.monthly.totalCost}`);
		assert.strictEqual(json.pricingStatus.effectiveFrom, Date.parse("2026-08-31T00:00:00+08:00"));
		assert.strictEqual(json.pricingStatus.effectiveFromSource, "config");
	});
});

test("手填的生效时刻离谱或乱序时一律忽略，退回「第一次看到」的时刻", async () => {
	await withHome(async ({ home }) => {
		await seedPricing(home, { pricing: PRICING_NEW });
		await seedPricingHistory(home, [
			{ seenAt: OLD_SEEN, pricing: PRICING },
			{ seenAt: CHANGE_AT, pricing: PRICING_NEW }
		]);
		// 离「第一次看到新价」差了大半年（年份打错是最容易犯的）。认了的话时间线上
		// 最新那条会被推到明年，所有历史都退回按旧价算——数字整体错一档，还不报错。
		const far = await call(await mountHost({ pricingEffectiveFrom: "2027-06-20T00:00:00+08:00" }),
			`/api/dsdesktop/balance/usage?force=1`);
		assert.strictEqual(far.json.pricingStatus.effectiveFrom, CHANGE_AT, "离谱的手填值应被忽略");
		assert.strictEqual(far.json.pricingStatus.effectiveFromSource, "seen");

		// 早于上一条的生效时刻：认了时间线就乱序了。
		const before = await call(await mountHost({ pricingEffectiveFrom: "2026-07-20T00:00:00+08:00" }),
			`/api/dsdesktop/balance/usage?force=1`);
		assert.strictEqual(before.json.pricingStatus.effectiveFrom, CHANGE_AT, "乱序的手填值应被忽略");

		// 落在合理范围内的就认（新价是 9/2 看到的，官方说 9/1 就生效）。
		const good = await call(await mountHost({ pricingEffectiveFrom: "2026-09-01T00:00:00+08:00" }),
			`/api/dsdesktop/balance/usage?force=1`);
		assert.strictEqual(good.json.pricingStatus.effectiveFrom, Date.parse("2026-09-01T00:00:00+08:00"));
		assert.strictEqual(good.json.pricingStatus.effectiveFromSource, "config");
	});
});

test("同步不上时继续用最后那份真实价，并把「多久没同步、为什么」带回去", async () => {
	await withHome(async ({ home }) => {
		await seedSessions(join(home, "sessions"), [
			assistantFrame(OFF_PEAK, "deepseek-v4-flash", { inputTokens: 0, outputTokens: 1000 })
		]);
		// 九天前同步到的价（远超 12 小时 TTL，也超过旧实现那个 7 天上限）。
		const nineDaysAgo = Date.now() - 9 * 24 * 3600_000;
		await seedPricing(home, { pricing: PRICING_NEW, fetchedAt: nineDaysAgo });
		await seedPricingHistory(home, [{ seenAt: nineDaysAgo, pricing: PRICING_NEW }]);
		// 页面打得开、但结构不认识了——调价那几天最可能出现的那种失败。这里必须真的
		// 走一遍解析，不能靠预置一个 attempt：apply() 一启动就会后台抓一次，那一次的
		// 结果才是界面上看到的。
		globalThis.fetch = () => Promise.resolve({ ok: true, text: async () => "<html><body>价格调整通知</body></html>" });
		const routes = await mountHost({});
		await new Promise((r) => setTimeout(r, 20));
		const { json } = await call(routes, `/api/dsdesktop/balance/usage?force=1`);

		assert.strictEqual(json.pricingStatus.stale, true, "超过 TTL 要标成 stale");
		assert.strictEqual(json.pricingStatus.error, "parse", "失败原因要能区分「打不开」和「解析不出来」");
		assert.strictEqual(json.pricingStatus.syncedAt, nineDaysAgo);
		assert.strictEqual(json.pricingStatus.source, "official", "旧价也是真实价，不该被算成内置默认价");
		// 关键：金额仍按最后那份真实价算（1000 * 9 / 1e6），不是内置默认价的 4.5。
		assert.ok(Math.abs(json.monthly.totalCost - 0.009) < 1e-12,
			`应继续用最后同步到的价，实际: ${json.monthly.totalCost}`);
	});
});

test("每个模型自己那套峰价优先于统一倍率", async () => {
	await withHome(async ({ home }) => {
		await seedSessions(join(home, "sessions"), [
			assistantFrame(PEAK, "deepseek-v4-flash", { inputTokens: 1000, cacheReadTokens: 1000, outputTokens: 1000 })
		]);
		await seedPricing(home, { pricing: PRICING_NEW });
		await seedPricingHistory(home, [{ seenAt: PEAK - 1000, pricing: PRICING_NEW }]);
		const routes = await mountHost({});
		const { json } = await call(routes, `/api/dsdesktop/balance/usage?force=1`);
		const [entry] = json.monthly.perModel;
		// 峰价那三项各自摊出来：2.25 / 0.075 / 13.5（都不是基准价 × peakMultiplier=2）。
		assert.ok(Math.abs(entry.costs.input - 0.00225) < 1e-12, `实际: ${entry.costs.input}`);
		assert.ok(Math.abs(entry.costs.cacheRead - 0.000075) < 1e-12, `实际: ${entry.costs.cacheRead}`);
		assert.ok(Math.abs(entry.costs.output - 0.0135) < 1e-12, `实际: ${entry.costs.output}`);
		assert.strictEqual(json.pricingStatus.peak, true);
	});
});

test("价表里没有峰价时，高峰时段也按基准价算，且状态里说明没有峰谷", async () => {
	await withHome(async ({ home }) => {
		const flat = {
			currency: "CNY",
			peakMultiplier: 1,
			modelPricing: {
				"deepseek-official:deepseek-v4-flash": { cacheHitPerMillion: 0.05, cacheMissPerMillion: 1.5, outputPerMillion: 4.5 }
			}
		};
		await seedSessions(join(home, "sessions"), [
			assistantFrame(PEAK, "deepseek-v4-flash", { inputTokens: 0, outputTokens: 1000 })
		]);
		await seedPricing(home, { pricing: flat });
		await seedPricingHistory(home, [{ seenAt: PEAK - 1000, pricing: flat }]);
		const routes = await mountHost({ peakMultiplier: 1 });
		const { json } = await call(routes, `/api/dsdesktop/balance/usage?force=1`);
		assert.ok(Math.abs(json.monthly.totalCost - 0.0045) < 1e-12,
			`官方取消峰谷之后不该再翻倍，实际: ${json.monthly.totalCost}`);
		assert.strictEqual(json.pricingStatus.peak, false, "没有峰价就该说没有，界面上的峰/谷角标要跟着消失");
	});
});

test("同步到新价会在时间线上追加一条；同一份价再同步一次不会重复记", async () => {
	await withHome(async ({ home }) => {
		await seedPricing(home, { pricing: PRICING, fetchedAt: OLD_SEEN });
		await seedPricingHistory(home, [{ seenAt: OLD_SEEN, pricing: PRICING }]);
		// 输出涨到 9 元、高峰只加 50%：跟手上那份不一样，该记一条。
		globalThis.fetch = () => Promise.resolve({
			ok: true,
			text: async () => pricingPage({ idle: [0.05, 1.5, 9], peak: [0.075, 2.25, 13.5] })
		});

		await mountHost({});
		await new Promise((r) => setTimeout(r, 30));
		const after = await readHistory(home);
		assert.strictEqual(after.entries.length, 2, `同步到新价该追加一条，实际: ${JSON.stringify(after.entries.map((e) => e.seenAt))}`);
		assert.strictEqual(after.entries[0].seenAt, OLD_SEEN, "旧价那一条要留着，否则调价之前的历史就没价可用了");
		const fresh = after.entries[1].pricing.modelPricing["deepseek-official:deepseek-v4-flash"];
		assert.strictEqual(fresh.outputPerMillion, 9);
		assert.deepStrictEqual(fresh.peak, { cacheHitPerMillion: 0.075, cacheMissPerMillion: 2.25, outputPerMillion: 13.5 });

		// 再抓一次同一份价：时间线不该长出第三条来（否则每 12 小时一条，几天就废了）。
		await mountHost({});
		await new Promise((r) => setTimeout(r, 30));
		assert.strictEqual((await readHistory(home)).entries.length, 2, "同一份价不该重复记");
	});
});

test("缓存比时间线新时（旧进程刷过缓存）补一条，不会继续摊旧价", async () => {
	await withHome(async ({ home }) => {
		// 场景：还在跑 0.7.x 的那个进程把新价刷进了缓存（它不认识时间线文件），
		// 之后才换成新版本启动。只信时间线的话，界面上会一直摊旧价。
		const seen = Date.parse("2026-09-04T00:00:00+08:00");
		await seedPricingHistory(home, [{ seenAt: OLD_SEEN, pricing: PRICING }]);
		await seedPricing(home, { pricing: PRICING_NEW, fetchedAt: seen });
		await seedSessions(join(home, "sessions"), [
			assistantFrame(OFF_PEAK, "deepseek-v4-flash", { inputTokens: 0, outputTokens: 1000 })
		]);
		const routes = await mountHost({});
		const { json } = await call(routes, `/api/dsdesktop/balance/usage?force=1`);

		assert.strictEqual(json.pricing.modelPricing["deepseek-official:deepseek-v4-flash"].outputPerMillion, 9,
			"界面上该摊缓存里那份新价，不是时间线上的旧价");
		assert.strictEqual(json.pricingStatus.effectiveFrom, seen, "补的那条按缓存的同步时刻记「第一次看到」");
		// 9/5 那条消息在 9/4 之后，按新价算：1000 * 9 / 1e6 = 0.009
		assert.ok(Math.abs(json.monthly.totalCost - 0.009) < 1e-12, `实际: ${json.monthly.totalCost}`);
		// 而且要落盘，别等下一次同步——那条旧价只有在调价之前记下来才有用。
		await new Promise((r) => setTimeout(r, 30));
		const history = await readHistory(home);
		assert.strictEqual(history.entries.length, 2, "时间线要补齐到两条");
		assert.deepStrictEqual(history.entries.map((e) => e.seenAt), [OLD_SEEN, seen]);
	});
});

test("官方只改了高峰时段（价没动）也要在时间线上记一条", async () => {
	await withHome(async ({ home }) => {
		const nine = { ...PRICING, peakSchedule: { days: [1, 2, 3, 4, 5], windows: [[540, 720], [840, 1080]] } };
		await seedPricing(home, { pricing: nine, fetchedAt: OLD_SEEN });
		await seedPricingHistory(home, [{ seenAt: OLD_SEEN, pricing: nine }]);
		// 价一分钱没变，只是高峰时段提前到 8:30——这同样会改变一大批消息的金额，
		// 所以必须在时间线上留一条，否则改时段会把历史一起重算。
		globalThis.fetch = () => Promise.resolve({
			ok: true,
			text: async () => pricingPage({
				idle: [0.05, 1.5, 4.5],
				peak: [0.1, 3, 9],
				note: "高峰时段为北京时间周一至周五 8:30 - 12:00、14:00 - 18:00（其余为空闲时段）。"
			})
		});

		await mountHost({});
		await new Promise((r) => setTimeout(r, 30));
		const history = await readHistory(home);
		assert.strictEqual(history.entries.length, 2, `改时段也是一次变更，实际: ${history.entries.length}`);
		assert.deepStrictEqual(history.entries[1].pricing.peakSchedule.windows, [[510, 720], [840, 1080]]);
	});
});

test("从 0.7.0 升上来时不会凭空多出一条「调价」", async () => {
	await withHome(async ({ home }) => {
		// 0.7.0 解析出来的表长这样：只有一个统一倍率，没有各自的 peak 块。
		const legacy = {
			currency: "CNY",
			peakMultiplier: 2,
			modelPricing: {
				"deepseek-official:deepseek-v4-flash": { cacheHitPerMillion: 0.05, cacheMissPerMillion: 1.5, outputPerMillion: 4.5 }
			}
		};
		await seedPricing(home, { pricing: legacy, fetchedAt: OLD_SEEN });
		await seedPricingHistory(home, [{ seenAt: OLD_SEEN, pricing: legacy }]);
		// 新代码同步到的是同一份价，只是峰价改成逐项存了（0.1/3/9 正好就是 2 倍）。
		globalThis.fetch = () => Promise.resolve({
			ok: true,
			text: async () => pricingPage({ idle: [0.05, 1.5, 4.5], peak: [0.1, 3, 9] })
		});

		await mountHost({});
		await new Promise((r) => setTimeout(r, 30));
		const history = await readHistory(home);
		assert.strictEqual(history.entries.length, 1,
			`价没变、只是存法变了，不该记成一次调价（那会让面板报「本周期跨越了 2 张价表」），实际: ${history.entries.length}`);
	});
});

test("高峰时段可以配：peakDays / peakWindows 覆盖自动同步来的规则", async () => {
	await withHome(async ({ home }) => {
		// 周二 8:45 北京时间：官方规则（9:00 起）下是空闲，配成 8:30 起就是高峰。
		const at = Date.parse("2026-09-01T00:45:00Z");
		await seedSessions(join(home, "sessions"), [
			assistantFrame(at, "deepseek-v4-flash", { inputTokens: 0, outputTokens: 1000 })
		]);
		const official = { ...PRICING, peakSchedule: { days: [1, 2, 3, 4, 5], windows: [[540, 720], [840, 1080]] } };
		await seedPricing(home, { pricing: official });
		await seedPricingHistory(home, [{ seenAt: at - 1000, pricing: official }]);

		const plain = await call(await mountHost({}), `/api/dsdesktop/balance/usage?force=1`);
		assert.ok(Math.abs(plain.json.monthly.totalCost - 0.0045) < 1e-12, `官方规则下应是空闲价，实际: ${plain.json.monthly.totalCost}`);
		assert.strictEqual(plain.json.pricingStatus.schedule.source, "official");
		assert.deepStrictEqual(plain.json.pricingStatus.schedule.windows, [[540, 720], [840, 1080]]);

		const tuned = await call(await mountHost({ peakWindows: "8:30-12:00,14:00-18:00" }), `/api/dsdesktop/balance/usage?force=1`);
		assert.ok(Math.abs(tuned.json.monthly.totalCost - 0.009) < 1e-12, `配了 8:30 起就该按高峰算，实际: ${tuned.json.monthly.totalCost}`);
		assert.strictEqual(tuned.json.pricingStatus.schedule.source, "config", "界面上要能看出这套规则是手工配的");
		assert.deepStrictEqual(tuned.json.pricingStatus.schedule.windows, [[510, 720], [840, 1080]]);

		// 只配星期也算覆盖：把周二排除掉，那条消息就再也不是高峰。
		const days = await call(await mountHost({ peakDays: "3-5" }), `/api/dsdesktop/balance/usage?force=1`);
		assert.deepStrictEqual(days.json.pricingStatus.schedule.days, [3, 4, 5]);

		// 填 none 表示「没有高峰时段」，工作日 10:00 也按基准价。
		await seedSessions(join(home, "sessions"), [
			assistantFrame(PEAK, "deepseek-v4-flash", { inputTokens: 0, outputTokens: 1000 })
		]);
		const none = await call(await mountHost({ peakWindows: "none" }), `/api/dsdesktop/balance/usage?force=1`);
		assert.ok(Math.abs(none.json.monthly.totalCost - 0.0045) < 1e-12, `实际: ${none.json.monthly.totalCost}`);
		assert.strictEqual(none.json.pricingStatus.peak, false, "没有高峰时段就该说没有，峰/谷角标要跟着消失");
	});
});

/** 2026 年放假安排的一小段，形状与 holiday-cn 的年度 JSON 一致。 */
const HOLIDAY_2026 = {
	year: 2026,
	papers: ["https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm"],
	days: [
		{ name: "国庆节", date: "2026-10-01", isOffDay: true },
		{ name: "国庆节", date: "2026-10-02", isOffDay: true },
		{ name: "国庆节", date: "2026-10-10", isOffDay: false }
	]
};

test("官方补一句「法定节假日除外」，插件自己就跟上了——不用发新版、不用填日期", async () => {
	await withHome(async ({ home }) => {
		// 国庆 10/1 是周四、10:00，落在高峰窗口里。
		const nationalDay = Date.parse("2026-10-01T02:00:00Z");
		await seedSessions(join(home, "sessions"), [
			assistantFrame(nationalDay, "deepseek-v4-flash", { inputTokens: 0, outputTokens: 1000 })
		]);
		const literal = { ...PRICING, peakSchedule: { days: [1, 2, 3, 4, 5], windows: [[540, 720], [840, 1080]], holidays: "peak" } };
		await seedPricing(home, { pricing: literal, fetchedAt: nationalDay - 86400_000 });
		await seedPricingHistory(home, [{ seenAt: nationalDay - 86400_000, pricing: literal }]);

		// 改口之前：按字面算，国庆照样是高峰（翻倍）。而且**一次日历请求都不发**。
		const calls = [];
		globalThis.fetch = (url) => {
			calls.push(String(url));
			return Promise.reject(new Error("offline"));
		};
		const before = await call(await mountHost({}), `/api/dsdesktop/balance/usage?force=1`);
		assert.ok(Math.abs(before.json.monthly.totalCost - 0.009) < 1e-12, `实际: ${before.json.monthly.totalCost}`);
		assert.strictEqual(before.json.pricingStatus.schedule.holidays, "peak");
		assert.strictEqual(before.json.pricingStatus.schedule.calendar, null, "没这个需求就不该有日历");
		assert.ok(!calls.some((url) => url.includes("holiday")), `不需要节假日时不该联网取日历，实际请求: ${calls.join(", ")}`);

		// 官方在脚注里补了一句。定价页一同步到，插件就该自己切口径、自己去取放假安排。
		globalThis.fetch = (url) => {
			const target = String(url);
			if (target.includes("2026.json")) return Promise.resolve({ ok: true, json: async () => HOLIDAY_2026 });
			return Promise.resolve({
				ok: true,
				text: async () => pricingPage({
					idle: [0.05, 1.5, 4.5],
					peak: [0.1, 3, 9],
					note: "高峰时段为北京时间周一至周五 9:00 - 12:00、14:00 - 18:00（法定节假日除外）。"
				})
			});
		};
		const routes = await mountHost({});
		// 等 apply() 那次后台同步落完：`force=1` 只强制重扫日志，单价有自己的 TTL。
		await new Promise((r) => setTimeout(r, 60));
		const after = await call(routes, `/api/dsdesktop/balance/usage?force=1`);
		assert.strictEqual(after.json.pricingStatus.schedule.holidays, "offpeak", "解析到那句话就该切口径");
		assert.ok(Math.abs(after.json.monthly.totalCost - 0.0045) < 1e-12,
			`国庆那条该按空闲算了，实际: ${after.json.monthly.totalCost}`);
		assert.deepStrictEqual(after.json.pricingStatus.schedule.calendar.years, [2026]);
		assert.deepStrictEqual(after.json.pricingStatus.schedule.calendar.papers, HOLIDAY_2026.papers,
			"日历依据的政策文件链接要带回去，能一路查到原文");
		assert.strictEqual(after.json.pricingStatus.schedule.holidaySource, "official", "口径是官方页给的，不是手工配的");
	});
});

test("节假日日历拉不到时退回按字面算，并把失败原因带回去", async () => {
	await withHome(async ({ home }) => {
		const nationalDay = Date.parse("2026-10-01T02:00:00Z");
		await seedSessions(join(home, "sessions"), [
			assistantFrame(nationalDay, "deepseek-v4-flash", { inputTokens: 0, outputTokens: 1000 })
		]);
		await seedPricing(home, { pricing: PRICING, fetchedAt: nationalDay - 86400_000 });
		await seedPricingHistory(home, [{ seenAt: nationalDay - 86400_000, pricing: PRICING }]);

		// 手工把口径设成 offpeak，但日历源连不上。
		globalThis.fetch = () => Promise.reject(new Error("offline"));
		const { json } = await call(await mountHost({ peakHolidays: "offpeak" }), `/api/dsdesktop/balance/usage?force=1`);
		assert.strictEqual(json.pricingStatus.schedule.holidays, "offpeak");
		assert.deepStrictEqual(json.pricingStatus.schedule.calendar.years, [], "一年都没取到");
		assert.strictEqual(json.pricingStatus.schedule.calendar.error, "network", "失败原因要能摊到界面上");
		// 没有日历就没有日期覆盖，等于退回按字面算——这是个必须看得见的差别。
		assert.ok(Math.abs(json.monthly.totalCost - 0.009) < 1e-12, `实际: ${json.monthly.totalCost}`);
	});
});

test("peakHolidays 一个词就能定口径，不必手填日期", async () => {
	await withHome(async ({ home }) => {
		const nationalDay = Date.parse("2026-10-01T02:00:00Z");
		await seedSessions(join(home, "sessions"), [
			assistantFrame(nationalDay, "deepseek-v4-flash", { inputTokens: 0, outputTokens: 1000 })
		]);
		await seedPricing(home, { pricing: PRICING, fetchedAt: nationalDay - 86400_000 });
		await seedPricingHistory(home, [{ seenAt: nationalDay - 86400_000, pricing: PRICING }]);
		globalThis.fetch = (url) => (String(url).includes("2026.json")
			? Promise.resolve({ ok: true, json: async () => HOLIDAY_2026 })
			: Promise.reject(new Error("offline")));

		const { json } = await call(await mountHost({ peakHolidays: "offpeak" }), `/api/dsdesktop/balance/usage?force=1`);
		assert.ok(Math.abs(json.monthly.totalCost - 0.0045) < 1e-12,
			`一个 peakHolidays: offpeak 就该够，实际: ${json.monthly.totalCost}`);
		assert.strictEqual(json.pricingStatus.schedule.holidaySource, "config");
		// 日历里的调休上班日也一并生效（10/10 是周六，按工作日看待）。
		assert.ok(json.pricingStatus.schedule.peakDates >= 1, "调休上班日要跟着日历一起进来");
	});
});

test("法定节假日：默认按高峰算，填进 offPeakDates 之后整天按空闲", async () => {
	await withHome(async ({ home }) => {
		// 2026-10-01 是周四，落在 9:00-12:00 里。官方那句话只说周一至周五，没提节假日，
		// 所以默认按字面算 = 高峰。
		const nationalDay = Date.parse("2026-10-01T02:00:00Z");
		await seedSessions(join(home, "sessions"), [
			assistantFrame(nationalDay, "deepseek-v4-flash", { inputTokens: 0, outputTokens: 1000 })
		]);
		await seedPricing(home, { pricing: PRICING, fetchedAt: nationalDay - 86400_000 });
		await seedPricingHistory(home, [{ seenAt: nationalDay - 86400_000, pricing: PRICING }]);

		const literal = await call(await mountHost({}), `/api/dsdesktop/balance/usage?force=1`);
		assert.ok(Math.abs(literal.json.monthly.totalCost - 0.009) < 1e-12,
			`默认应按高峰（翻倍）算，实际: ${literal.json.monthly.totalCost}`);

		const holiday = await call(
			await mountHost({ offPeakDates: ["2026-10-01..2026-10-07"] }),
			`/api/dsdesktop/balance/usage?force=1`
		);
		assert.ok(Math.abs(holiday.json.monthly.totalCost - 0.0045) < 1e-12,
			`填进 offPeakDates 之后应按空闲算，实际: ${holiday.json.monthly.totalCost}`);
		assert.strictEqual(holiday.json.pricingStatus.schedule.offPeakDates, 7, "界面上要能看出覆盖了几天");
	});
});

test("官方改了高峰时段也在时间线上留一条，历史消息仍按当时的时段判", async () => {
	await withHome(async ({ home }) => {
		// 两条消息都在周二 8:45（官方 9:00 起的规则下是空闲）：一条在改时段之前、
		// 一条在之后。改成 8:30 起之后，只有后面那条变成高峰。
		const before = Date.parse("2026-09-01T00:45:00Z");
		const after = Date.parse("2026-09-08T00:45:00Z");
		const changeAt = Date.parse("2026-09-04T00:00:00Z");
		await seedSessions(join(home, "sessions"), [
			assistantFrame(before, "deepseek-v4-flash", { inputTokens: 0, outputTokens: 1000 }),
			assistantFrame(after, "deepseek-v4-flash", { inputTokens: 0, outputTokens: 1000 })
		]);
		const nine = { ...PRICING, peakSchedule: { days: [1, 2, 3, 4, 5], windows: [[540, 720]] } };
		const halfPast = { ...PRICING, peakSchedule: { days: [1, 2, 3, 4, 5], windows: [[510, 720]] } };
		await seedPricing(home, { pricing: halfPast, fetchedAt: changeAt });
		await seedPricingHistory(home, [
			{ seenAt: before - 86400_000, pricing: nine },
			{ seenAt: changeAt, pricing: halfPast }
		]);
		const routes = await mountHost({});
		const { json } = await call(routes, `/api/dsdesktop/balance/usage?force=1`);
		// 改时段前那条 0.0045（空闲）+ 改后那条 0.009（高峰）= 0.0135
		assert.ok(Math.abs(json.monthly.totalCost - 0.0135) < 1e-12,
			`改时段之前那条要按旧时段判，实际: ${json.monthly.totalCost}`);
		assert.strictEqual(json.monthly.priceChanges.length, 2, "改时段也算时间线上的一次变更");
	});
});

test("usage 路由只收 GET，POST 一律 405", async () => {
	await withHome(async () => {
		const routes = await mountHost({});
		const { status } = await call(routes, "/api/dsdesktop/balance/usage", { method: "POST", body: "{}" });
		assert.strictEqual(status, 405);
	});
});
