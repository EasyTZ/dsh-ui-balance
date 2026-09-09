// 放假安排日历的测试。
//
// 这份数据**直接参与算钱**：一天被判成节假日，那天的高峰时段就整天按空闲价算，
// 差一倍。所以这里守的重点不是「能不能解析」，而是**脏数据必须被整份拒掉**——
// 少判几天高峰是少算钱，而少算钱在界面上是看不出来的。

import assert from "node:assert";
import test from "node:test";
import { DEFAULT_HOLIDAY_CALENDAR_URL, fetchHolidayCalendar, parseHolidayCalendar, yearsInRange } from "../lib/holidays.js";

/** holiday-cn 年度 JSON 的形状（真实数据的一小段）。 */
const GOOD = {
	year: 2026,
	papers: ["https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm"],
	days: [
		{ name: "元旦", date: "2026-01-01", isOffDay: true },
		{ name: "元旦", date: "2026-01-04", isOffDay: false },
		{ name: "国庆节", date: "2026-10-01", isOffDay: true }
	]
};

test("放假日与调休上班日分开取，一份数据覆盖两个方向", () => {
	const parsed = parseHolidayCalendar(GOOD, 2026);
	assert.deepStrictEqual(parsed.offDays, ["2026-01-01", "2026-10-01"]);
	// 调休上班的日子反过来要按工作日判，`isOffDay: false` 正是它。
	assert.deepStrictEqual(parsed.workDays, ["2026-01-04"]);
});

test("脏数据整份拒掉，不吃半份", () => {
	// 年份对不上：多半是 URL 模板写错了、或者镜像返回了别年的文件。用错年份的日历
	// 会把一整年的节假日判到错误的日期上。
	assert.strictEqual(parseHolidayCalendar(GOOD, 2027), null);
	// 日期格式不对 / 混进别年的日期 / isOffDay 不是布尔：都可能让某几天被静默漏判。
	assert.strictEqual(parseHolidayCalendar({ ...GOOD, days: [{ date: "2026/01/01", isOffDay: true }] }, 2026), null);
	assert.strictEqual(parseHolidayCalendar({ ...GOOD, days: [{ date: "2025-01-01", isOffDay: true }] }, 2026), null);
	assert.strictEqual(parseHolidayCalendar({ ...GOOD, days: [{ date: "2026-01-01", isOffDay: "true" }] }, 2026), null);
	assert.strictEqual(parseHolidayCalendar({ ...GOOD, days: [] }, 2026), null, "空日历不如没有：会被当成「今年没有节假日」");
	assert.strictEqual(parseHolidayCalendar({ year: 2026 }, 2026), null);
	// 没有 `year` 字段：日期看着还对，但这已经不是我们认识的那份 schema 了——
	// 多半是数据源换了结构，别猜，整份拒掉。
	assert.strictEqual(parseHolidayCalendar({ days: GOOD.days }, 2026), null);
	assert.strictEqual(parseHolidayCalendar(null, 2026), null);
	assert.strictEqual(parseHolidayCalendar("nope", 2026), null);
});

test("抓取失败带回原因，能区分「拉不到」和「格式不认识」", async () => {
	const previous = globalThis.fetch;
	try {
		globalThis.fetch = () => Promise.reject(new Error("offline"));
		assert.deepStrictEqual(await fetchHolidayCalendar(2026), { error: "network" });

		globalThis.fetch = () => Promise.resolve({ ok: false, status: 503 });
		assert.deepStrictEqual(await fetchHolidayCalendar(2026), { error: "http-503" });

		globalThis.fetch = () => Promise.resolve({ ok: true, json: async () => ({ year: 2099, days: [] }) });
		assert.deepStrictEqual(await fetchHolidayCalendar(2026), { error: "parse" });

		let requested = null;
		globalThis.fetch = (url) => {
			requested = String(url);
			return Promise.resolve({ ok: true, json: async () => GOOD });
		};
		const ok = await fetchHolidayCalendar(2026);
		assert.deepStrictEqual(ok.offDays, ["2026-01-01", "2026-10-01"]);
		assert.deepStrictEqual(ok.papers, GOOD.papers, "依据的政策文件链接要带回去，能一路查到原文");
		assert.ok(requested.includes("2026.json"), `{year} 要被替换掉，实际: ${requested}`);
		assert.ok(DEFAULT_HOLIDAY_CALENDAR_URL.includes("{year}"));

		// 换成自己的镜像（公司内网）也认。
		await fetchHolidayCalendar(2026, "https://mirror.example.com/holidays/{year}.json");
		assert.strictEqual(requested, "https://mirror.example.com/holidays/2026.json");
	} finally {
		globalThis.fetch = previous;
	}
});

test("只取统计窗口真正覆盖到的年份", () => {
	// 窗口最远到上个月 1 日，所以平时就一年，跨年那阵子才是两年。
	assert.deepStrictEqual(yearsInRange(Date.parse("2026-08-01T00:00:00Z"), Date.parse("2026-09-09T00:00:00Z")), [2026]);
	assert.deepStrictEqual(yearsInRange(Date.parse("2025-12-01T00:00:00Z"), Date.parse("2026-01-09T00:00:00Z")), [2025, 2026]);
});
