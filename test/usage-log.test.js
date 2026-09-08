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

import assert from "node:assert";
import { mkdtemp, mkdir, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";

import { aggregate, decodeFrames, scanUsage } from "../lib/usage-log.js";

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
