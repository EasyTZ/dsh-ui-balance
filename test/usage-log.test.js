// host 半日志扫描器的测试。这是整个插件里唯一的计费数据源，所以它要守住的是
// 「算出来的钱对不对」，而不只是「函数别抛异常」：
//
//   1. 会话日志是**追加式多帧 zstd**，一次追加一个独立帧。`zstdDecompressSync`
//      只认第一帧，`createZstdDecompress` 撞上第二帧的帧头会直接报
//      "Unknown frame descriptor"——写这个测试之前，正是这一点让第一版扫描器
//      只读到每个会话的第一行（`session` 头），一条用量都抽不出来。
//   2. 增量恢复必须能跨**写了一半的帧**：应用正在追加时文件尾巴就是半个帧，
//      停在那里、下次接着读，结果要跟一次性全量扫描逐字相同。
//   3. 峰谷倍率按**每条消息自己的时刻**判，不是按「现在是不是高峰」——一整天里
//      两种时段都有，用当下时刻去乘一整天的用量，正是旧实现算错钱的地方之一。
//   4. 高峰时段的判定是**算术**的（北京时间 = UTC+8 固定偏移），不走 `Intl`。
//      那个假设必须有一条用例拿 `Intl` 逐个时刻对账守着。

import assert from "node:assert";
import { mkdtemp, mkdir, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";

import { DEFAULT_PEAK_SCHEDULE, aggregate, compilePeakSchedule, decodeFrames, scanUsage } from "../lib/usage-log.js";

const PRICING = {
	currency: "CNY",
	peakMultiplier: 2,
	modelPricing: {
		"deepseek-official:deepseek-v4-flash": { cacheHitPerMillion: 0.05, cacheMissPerMillion: 1.5, outputPerMillion: 4.5 },
		"deepseek-official:deepseek-v4-pro": { cacheHitPerMillion: 0.15, cacheMissPerMillion: 4.5, outputPerMillion: 13.5 }
	}
};

/** 2026-09-05 周六 10:00 北京时间：周末，全天空闲时段。 */
const OFF_PEAK = Date.parse("2026-09-05T02:00:00.000Z");
/** 2026-09-01 周二 10:00 北京时间：落在 9-12 高峰窗口内。 */
const PEAK = Date.parse("2026-09-01T02:00:00.000Z");

function assistantEvent(time, model, usage) {
	return {
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
}

/** 把每个事件单独压成一帧追加进去——真实日志就是这么长的。 */
function framesOf(events) {
	return Buffer.concat(events.map((e) => zstdCompressSync(Buffer.from(JSON.stringify(e) + "\n", "utf8"))));
}

async function makeSession(root, project, id, events) {
	const dir = join(root, project, id);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "session.jsonl.zstd"), framesOf(events));
	return join(dir, "session.jsonl.zstd");
}

async function withTempRoot(fn) {
	const root = await mkdtemp(join(tmpdir(), "dsh-balance-test-"));
	try {
		return await fn(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("decodeFrames 解得开追加式多帧，并把写了一半的尾帧留到下次", () => {
	const events = [
		assistantEvent(OFF_PEAK, "deepseek-v4-flash", { inputTokens: 1, outputTokens: 2 }),
		assistantEvent(OFF_PEAK + 1, "deepseek-v4-flash", { inputTokens: 3, outputTokens: 4 })
	];
	const buf = framesOf(events);
	const whole = decodeFrames(buf);
	assert.strictEqual(whole.consumed, buf.length, "完整文件应全部消费掉");
	assert.strictEqual(whole.text.split("\n").filter(Boolean).length, 2);

	// 砍掉最后一帧的一半：前一帧照解，consumed 停在完整帧的边界上。
	const truncated = buf.subarray(0, buf.length - 5);
	const partial = decodeFrames(truncated);
	assert.strictEqual(partial.text.split("\n").filter(Boolean).length, 1, "半个帧不该被当成数据解出来");
	assert.ok(partial.consumed < truncated.length, "consumed 应停在最后一个完整帧的尾巴上");
});

test("扫描抽出每条 assistant 消息的精确用量与逐条精确的模型归属", async () => {
	await withTempRoot(async (root) => {
		await makeSession(root, "--proj-a--", "session-1", [
			{ type: "session", version: 1, id: "session-1" },
			assistantEvent(OFF_PEAK, "deepseek-v4-flash", { inputTokens: 100, outputTokens: 200, cacheReadTokens: 1000 }),
			{ type: "assistant/chunk", seq: 2, time: OFF_PEAK, data: {} },
			assistantEvent(OFF_PEAK + 1, "deepseek-v4-pro", { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30 })
		]);
		const { records } = await scanUsage(root, null, OFF_PEAK);
		assert.strictEqual(records.length, 2, "只抽 assistant/message，chunk 与 session 头都不算");
		assert.deepStrictEqual(records[0], [OFF_PEAK, "deepseek-official:deepseek-v4-flash", 100, 1000, 200]);
		assert.deepStrictEqual(records[1], [OFF_PEAK + 1, "deepseek-official:deepseek-v4-pro", 10, 30, 20]);

		// 同一批记录按两种单价分开计价，一条都不能串到另一个模型头上。
		const agg = aggregate(records, PRICING);
		const flash = agg.perModel.find((m) => m.model === "deepseek-v4-flash");
		const pro = agg.perModel.find((m) => m.model === "deepseek-v4-pro");
		assert.ok(Math.abs(flash.cost - (100 * 1.5 + 1000 * 0.05 + 200 * 4.5) / 1e6) < 1e-12);
		assert.ok(Math.abs(pro.cost - (10 * 4.5 + 30 * 0.15 + 20 * 13.5) / 1e6) < 1e-12);
		assert.ok(Math.abs(agg.totalCost - (flash.cost + pro.cost)) < 1e-12);
	});
});

test("增量扫描能跨「写了一半的帧」恢复，结果与全量扫描逐字相同", async () => {
	await withTempRoot(async (root) => {
		const events = [
			{ type: "session", version: 1, id: "session-1" },
			assistantEvent(OFF_PEAK, "deepseek-v4-flash", { inputTokens: 1, outputTokens: 1 }),
			assistantEvent(OFF_PEAK + 1, "deepseek-v4-flash", { inputTokens: 2, outputTokens: 2 }),
			assistantEvent(OFF_PEAK + 2, "deepseek-v4-flash", { inputTokens: 3, outputTokens: 3 })
		];
		const file = await makeSession(root, "--proj-a--", "session-1", events);
		const complete = await readFile(file);
		const full = await scanUsage(root, null, OFF_PEAK);

		// 只写到某个帧的一半，先扫一遍；再把剩下的追加上去，带着缓存增量扫。
		await writeFile(file, complete.subarray(0, complete.length - 7));
		const first = await scanUsage(root, null, OFF_PEAK);
		assert.ok(first.records.length < full.records.length, "半个帧那条不该被算进来");
		await writeFile(file, complete);
		const second = await scanUsage(root, first.cache, OFF_PEAK);
		assert.deepStrictEqual(second.records, full.records, "增量结果必须与全量逐字相同");
	});
});

test("尺寸没变就一个字节都不读，变大只读新增的那一段", async () => {
	await withTempRoot(async (root) => {
		const file = await makeSession(root, "--proj-a--", "session-1", [
			assistantEvent(OFF_PEAK, "deepseek-v4-flash", { inputTokens: 1, outputTokens: 1 })
		]);
		const first = await scanUsage(root, null, OFF_PEAK);
		assert.strictEqual(first.changed, true);

		const again = await scanUsage(root, first.cache, OFF_PEAK);
		assert.strictEqual(again.changed, false, "尺寸没变时不该报告有改动（否则每次都要重写缓存文件）");
		assert.deepStrictEqual(again.records, first.records);
		const scannedBefore = first.cache.files[file].scanned;

		await appendFile(file, framesOf([assistantEvent(OFF_PEAK + 1, "deepseek-v4-flash", { inputTokens: 5, outputTokens: 5 })]));
		const grown = await scanUsage(root, again.cache, OFF_PEAK);
		assert.strictEqual(grown.records.length, 2);
		assert.ok(grown.cache.files[file].scanned > scannedBefore, "读到的字节数应往前推进");
	});
});

test("续读偏移前面的内容变过就整份重扫，不从失效的偏移接着读", async () => {
	await withTempRoot(async (root) => {
		// 场景：追加失败回滚（rollbackAppend）把文件砍到 scanned 之下，又在下一次
		// 扫描之前长回超过原尺寸——只比尺寸的话「变大了」成立，会从一个已经失效的
		// 偏移续读，把中间那段悄悄漏掉。锚点就是为了挡这一下。
		const file = await makeSession(root, "--proj-a--", "session-1", [
			assistantEvent(OFF_PEAK, "deepseek-v4-flash", { inputTokens: 1, outputTokens: 1 }),
			assistantEvent(OFF_PEAK + 1, "deepseek-v4-flash", { inputTokens: 2, outputTokens: 2 })
		]);
		const first = await scanUsage(root, null, OFF_PEAK);
		assert.strictEqual(first.records.length, 2);
		assert.strictEqual(typeof first.cache.files[file].anchor, "string", "缓存里要存下续读锚点");

		// 整份换成一批**不同**的事件，且总长度大于原来：尺寸判据会误判成「只是追加了」。
		const rewritten = [
			assistantEvent(OFF_PEAK + 10, "deepseek-v4-pro", { inputTokens: 7, outputTokens: 7 }),
			assistantEvent(OFF_PEAK + 11, "deepseek-v4-pro", { inputTokens: 8, outputTokens: 8 }),
			assistantEvent(OFF_PEAK + 12, "deepseek-v4-pro", { inputTokens: 9, outputTokens: 9 }),
			assistantEvent(OFF_PEAK + 13, "deepseek-v4-pro", { inputTokens: 10, outputTokens: 10 })
		];
		await writeFile(file, framesOf(rewritten));
		const second = await scanUsage(root, first.cache, OFF_PEAK);
		assert.strictEqual(second.records.length, 4, "锚点对不上就应整份重扫");
		assert.ok(second.records.every((r) => r[1].endsWith("deepseek-v4-pro")), "重扫出来的应是新内容，不能混进旧记录");
	});
});

test("老版本缓存（没有锚点）触发一次整份重扫，而不是拿旧偏移硬续", async () => {
	await withTempRoot(async (root) => {
		const file = await makeSession(root, "--proj-a--", "session-1", [
			assistantEvent(OFF_PEAK, "deepseek-v4-flash", { inputTokens: 1, outputTokens: 1 }),
			assistantEvent(OFF_PEAK + 1, "deepseek-v4-flash", { inputTokens: 2, outputTokens: 2 })
		]);
		const fresh = await scanUsage(root, null, OFF_PEAK);
		// 模拟 0.7.0 写下的缓存：有 size/scanned/records，就是没有 anchor。
		const legacy = { version: 1, files: { [file]: { ...fresh.cache.files[file], anchor: undefined, records: [] } } };
		const next = await scanUsage(root, legacy, OFF_PEAK);
		assert.strictEqual(next.records.length, 2, "没有锚点就不该相信那个偏移，要重扫");
		assert.strictEqual(typeof next.cache.files[file].anchor, "string", "重扫之后要补上锚点");
	});
});

test("默认规则就是官方那句话：周一至周五 9-12、14-18（北京时间）", () => {
	const { isPeak } = compilePeakSchedule(DEFAULT_PEAK_SCHEDULE);
	const at = (iso) => isPeak(Date.parse(iso));
	assert.strictEqual(at("2026-09-01T00:59:00Z"), false, "8:59 差一分钟不算");
	assert.strictEqual(at("2026-09-01T01:00:00Z"), true, "周二 9:00 起算");
	assert.strictEqual(at("2026-09-01T02:00:00Z"), true, "周二 10:00 算");
	assert.strictEqual(at("2026-09-01T04:00:00Z"), false, "周二 12:00 是上界，左闭右开");
	assert.strictEqual(at("2026-09-01T05:59:00Z"), false, "13:59 不算");
	assert.strictEqual(at("2026-09-01T06:00:00Z"), true, "周二 14:00 算");
	assert.strictEqual(at("2026-09-01T09:59:00Z"), true, "17:59 还算");
	assert.strictEqual(at("2026-09-01T10:00:00Z"), false, "18:00 起不算");
	assert.strictEqual(at("2026-09-05T02:00:00Z"), false, "周六不算");
	assert.strictEqual(at("2026-09-06T02:00:00Z"), false, "周日不算");

	// **法定节假日按高峰算**，因为官方那句话只说周一至周五、一个字没提节假日。
	// 这条不是「大概如此」，是这个插件明确选择的口径：不替官方发明规则，需要的人
	// 用 `offPeakDates` 自己覆盖（见下一条用例）。
	assert.strictEqual(at("2026-10-01T02:00:00Z"), true, "国庆 10/1 是周四，字面上算高峰");
	assert.strictEqual(at("2026-01-01T02:00:00Z"), true, "元旦 1/1 是周四，同理");
	assert.strictEqual(at("2026-10-10T02:00:00Z"), false, "调休上班的周六，字面上仍算空闲");
});

test("北京时间用固定偏移算，结果与 Intl 按 Asia/Shanghai 取的逐个对得上", () => {
	// 整套判定建立在「中国全境 UTC+8、不实行夏令时」之上。这条用例是那个假设的看门人：
	// 哪天 Node 的时区库改了、或者假设本身不成立，这里会先红。
	const format = new Intl.DateTimeFormat("en-US", {
		timeZone: "Asia/Shanghai", hourCycle: "h23", weekday: "short", hour: "numeric", minute: "numeric"
	});
	const NAMES = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
	const offset = 8 * 60 * 60 * 1000;
	// 跨一整年、每 7 小时 13 分取一个点（刻意不是整数天/整点，好扫到各种边界）。
	for (let at = Date.parse("2026-01-01T00:00:00Z"); at < Date.parse("2027-01-01T00:00:00Z"); at += 7 * 3600_000 + 13 * 60_000) {
		const parts = format.formatToParts(new Date(at));
		const pick = (type) => parts.find((p) => p.type === type)?.value;
		const shifted = new Date(at + offset);
		assert.strictEqual(shifted.getUTCDay() === 0 ? 7 : shifted.getUTCDay(), NAMES[pick("weekday")], `星期对不上 @ ${new Date(at).toISOString()}`);
		assert.strictEqual(shifted.getUTCHours(), Number(pick("hour")), `小时对不上 @ ${new Date(at).toISOString()}`);
		assert.strictEqual(shifted.getUTCMinutes(), Number(pick("minute")), `分钟对不上 @ ${new Date(at).toISOString()}`);
	}
});

test("时段窗可以精确到分钟，不再受「按整点判」的限制", () => {
	// 官方哪天把 9:00 改成 8:30，按整点缓存的老实现会把 8:30-9:00 这半小时判错。
	const { isPeak } = compilePeakSchedule({ days: [1, 2, 3, 4, 5], windows: [[8 * 60 + 30, 12 * 60]] });
	assert.strictEqual(isPeak(Date.parse("2026-09-01T00:29:00Z")), false, "8:29 不算");
	assert.strictEqual(isPeak(Date.parse("2026-09-01T00:30:00Z")), true, "8:30 起算");
	assert.strictEqual(isPeak(Date.parse("2026-09-01T00:45:00Z")), true, "8:45 算");
});

test("按日期整天覆盖：节假日算空闲、调休的周末算工作日", () => {
	const { isPeak } = compilePeakSchedule({
		...DEFAULT_PEAK_SCHEDULE,
		offPeakDates: ["2026-10-01", "2026-10-02"],
		peakDates: ["2026-10-10"]
	});
	assert.strictEqual(isPeak(Date.parse("2026-10-01T02:00:00Z")), false, "填进 offPeakDates 的节假日整天按空闲");
	assert.strictEqual(isPeak(Date.parse("2026-10-02T07:00:00Z")), false, "同上，15:00 也一样");
	assert.strictEqual(isPeak(Date.parse("2026-10-05T02:00:00Z")), true, "没填的那几天仍按字面算");
	assert.strictEqual(isPeak(Date.parse("2026-10-10T02:00:00Z")), true, "调休上班的周六 10:00 算高峰");
	assert.strictEqual(isPeak(Date.parse("2026-10-10T13:00:00Z")), false, "但那天 21:00 不在时间窗里，照样是空闲");

	// 两边都填了同一天：整天放假优先。
	const both = compilePeakSchedule({ ...DEFAULT_PEAK_SCHEDULE, offPeakDates: ["2026-10-10"], peakDates: ["2026-10-10"] });
	assert.strictEqual(both.isPeak(Date.parse("2026-10-10T02:00:00Z")), false);
});

test("时段窗为空表示「没有高峰时段」，什么时候都按基准价", () => {
	const { isPeak } = compilePeakSchedule({ days: [1, 2, 3, 4, 5], windows: [] });
	assert.strictEqual(isPeak(PEAK), false, "官方取消峰谷之后，工作日 10:00 也不该翻倍");
});

test("汇总按每张价表自己的时段规则判峰谷", () => {
	// 同一条消息（周二 8:45 北京时间），两张价表的时段规则不同：一张 9:00 起，一张
	// 8:30 起。金额必须跟着各自的规则走——时段规则是跟着价表进时间线的。
	const records = [[Date.parse("2026-09-01T00:45:00Z"), "deepseek-official:deepseek-v4-flash", 0, 0, 1000]];
	const nine = { ...PRICING, peakSchedule: { days: [1, 2, 3, 4, 5], windows: [[540, 720]] } };
	const halfPast = { ...PRICING, peakSchedule: { days: [1, 2, 3, 4, 5], windows: [[510, 720]] } };
	assert.ok(Math.abs(aggregate(records, nine).totalCost - 0.0045) < 1e-12, "9:00 起的规则下 8:45 是空闲");
	assert.ok(Math.abs(aggregate(records, halfPast).totalCost - 0.009) < 1e-12, "8:30 起的规则下 8:45 是高峰");
});

test("峰谷倍率按每条消息自己的时刻判，不是按「现在」", async () => {
	const records = [
		[PEAK, "deepseek-official:deepseek-v4-flash", 0, 0, 1000],
		[OFF_PEAK, "deepseek-official:deepseek-v4-flash", 0, 0, 1000]
	];
	const agg = aggregate(records, PRICING);
	// 高峰那条 1000 * 4.5 / 1e6 * 2 = 0.009；空闲那条 0.0045。
	assert.ok(Math.abs(agg.totalCost - 0.0135) < 1e-12, `实际: ${agg.totalCost}`);

	// 只取高峰那条的窗口，金额必须正好是它自己那一份——统计窗口不能把倍率算歪。
	const peakOnly = aggregate(records, PRICING, { from: PEAK, to: PEAK + 1 });
	assert.ok(Math.abs(peakOnly.totalCost - 0.009) < 1e-12, `实际: ${peakOnly.totalCost}`);
});

test("金额按 token 类别拆开给出，且三项之和等于这个模型的合计", async () => {
	// 同一个模型、一条高峰一条空闲：拆分必须逐条按各自的倍率算，不能拿汇总后的
	// token 数乘一个「平均倍率」——面板的费用表每类一列，摊出来的就是这三个数。
	const records = [
		[PEAK, "deepseek-official:deepseek-v4-flash", 1000, 2000, 3000],
		[OFF_PEAK, "deepseek-official:deepseek-v4-flash", 1000, 2000, 3000]
	];
	const [entry] = aggregate(records, PRICING).perModel;
	// 未命中 1000 * 1.5 / 1e6 = 0.0015，高峰那条翻倍：0.0015 + 0.003 = 0.0045
	assert.ok(Math.abs(entry.costs.input - 0.0045) < 1e-12, `实际: ${entry.costs.input}`);
	// 命中 2000 * 0.05 / 1e6 = 0.0001，加高峰的 0.0002
	assert.ok(Math.abs(entry.costs.cacheRead - 0.0003) < 1e-12, `实际: ${entry.costs.cacheRead}`);
	// 输出 3000 * 4.5 / 1e6 = 0.0135，加高峰的 0.027
	assert.ok(Math.abs(entry.costs.output - 0.0405) < 1e-12, `实际: ${entry.costs.output}`);
	// **严格相等**，不是「差得够小」：合计必须是三个分项相加出来的，不能另攒一遍
	// （那样攒的是 `Σ(a+b+c)`，跟界面上摊的 `Σa+Σb+Σc` 浮点顺序不同，上万条消息
	// 之后就会差出一个说不清的尾数）。
	assert.strictEqual(entry.cost, entry.costs.input + entry.costs.cacheRead + entry.costs.output);
});

test("没配置单价的模型只统计用量、不瞎猜金额", async () => {
	const records = [["1", "someone-else:mystery-v1", 100, 0, 100].slice(0)];
	records[0][0] = OFF_PEAK;
	const agg = aggregate(records, PRICING);
	assert.strictEqual(agg.totalCost, 0, "没有单价就不计金额");
	assert.strictEqual(agg.perModel.length, 1);
	assert.strictEqual(agg.perModel[0].priced, false);
	assert.deepStrictEqual(agg.perModel[0].tokens, { input: 100, cacheRead: 0, output: 100 });
});

test("多个项目目录下的会话一起统计，不受「当前打开哪个工作区」影响", async () => {
	await withTempRoot(async (root) => {
		await makeSession(root, "--proj-a--", "session-1", [assistantEvent(OFF_PEAK, "deepseek-v4-flash", { inputTokens: 0, outputTokens: 1000 })]);
		await makeSession(root, "--proj-b--", "session-2", [assistantEvent(OFF_PEAK, "deepseek-v4-flash", { inputTokens: 0, outputTokens: 1000 })]);
		const { records } = await scanUsage(root, null, OFF_PEAK);
		assert.strictEqual(records.length, 2, "两个工作区的会话都要算——旧实现漏掉后台会话正是最大的偏差来源");
		assert.ok(Math.abs(aggregate(records, PRICING).totalCost - 0.009) < 1e-12);
	});
});
