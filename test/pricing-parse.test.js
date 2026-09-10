// 官方定价页解析器的测试。
//
// 这个函数是整个插件里最容易被上游一次改版打断的地方，而它失败的方式是**安静的**：
// 解析不出来就继续用上一次同步到的价，界面上原先什么都不说。所以这里既要守住
// 「现在的页面解析得对」，也要守住几种可预见的改版形状：
//
//   1. 峰谷倍率不再统一（某一类单独打个不一样的折）——原实现校验不过就整份放弃。
//   2. 官方取消峰谷、每类只剩一个价。
//   3. 页面结构面目全非 / 少了半张表——这时必须返回 null（继续用旧价），
//      **不能**摊出一张半截的表，那算出来的钱是错的而且看不出错。

import assert from "node:assert";
import test from "node:test";
import { applyBillingRoutes, parseBillingRoutes, parseOfficialPricing, parsePeakSchedule } from "../lib/index.js";

/**
 * 2026-09-09 官方定价页上那张表，原样抄下来（含 rowspan/colspan 与 <br> 换行）。
 *
 * 唯一改动：页面上「Tool Calls」那一格里真的夹着一个 NUL 字节，这里换成了空格
 * ——它落在跟价格无关的功能行里，但留着会让 git 把整个测试文件当成二进制。
 */
const REAL_TABLE = `<table style="text-align:center"><tr><td colspan="3" style="text-align:center">模型</td><td>deepseek-v4-flash</td><td>deepseek-v4-pro</td><td>deepseek-v4-flash-vision-exp</td></tr><tr><td colspan="3">BASE URL (OpenAI 格式)</td><td colspan="3"><a href="https://api.deepseek.com" target="_blank" rel="noopener noreferrer">https://api.deepseek.com</a></td></tr><tr><td colspan="3">BASE URL (Anthropic 格式)</td><td colspan="3"><a href="https://api.deepseek.com/anthropic" target="_blank" rel="noopener noreferrer">https://api.deepseek.com/anthropic</a></td></tr><tr><td colspan="3" style="text-align:center">模型版本</td><td>DeepSeek-V4-Flash-0731</td><td>DeepSeek-V4-Pro-0813</td><td>DeepSeek-V4-Flash-Vision-Exp</td></tr><tr><td colspan="3">思考模式</td><td colspan="3">支持非思考与思考模式（默认）<br>切换方式详见<a href="/zh-cn/guides/thinking_mode">思考模式</a></td></tr><tr><td colspan="3">上下文长度</td><td colspan="3">1M</td></tr><tr><td colspan="3">输出长度</td><td colspan="3">最大 384K</td></tr><tr><td rowspan="6">功能</td><td colspan="2"><a href="/zh-cn/guides/json_mode">Json Output</a></td><td>支持</td><td>支持</td><td>支持</td></tr><tr><td colspan="2"><a href="/zh-cn/guides/tool_calls">Tool Calls</a></td><td> 支持</td><td>支持</td><td>支持</td></tr><tr><td colspan="2"><a href="/zh-cn/guides/responses_api">Responses API</a></td><td>支持</td><td>支持</td><td>支持</td></tr><tr><td colspan="2"><a href="/zh-cn/guides/anthropic_api">Anthropic API</a></td><td>支持</td><td>支持</td><td>支持</td></tr><tr><td colspan="2"><a href="/zh-cn/guides/chat_prefix_completion">对话前缀续写（Beta）</a></td><td>支持</td><td>支持</td><td>支持</td></tr><tr><td colspan="2"><a href="/zh-cn/guides/fim_completion">FIM 补全（Beta）</a></td><td>仅非思考模式支持</td><td>仅非思考模式支持</td><td>不支持</td></tr><tr><td rowspan="6">价格<sup>(1)(2)</sup></td><td rowspan="2">百万tokens输入<br>（缓存命中）</td><td>空闲时段</td><td>0.05元</td><td>0.15元</td><td>0.05元</td></tr><tr><td>高峰时段</td><td>0.10元</td><td>0.30元</td><td>0.10元</td></tr><tr><td rowspan="2">百万tokens输入<br>（缓存未命中）</td><td>空闲时段</td><td>1.5元</td><td>4.5元</td><td>1.5元</td></tr><tr><td>高峰时段</td><td>3.0元</td><td>9.0元</td><td>3.0元</td></tr><tr><td rowspan="2">百万tokens输出</td><td>空闲时段</td><td>4.5元</td><td>13.5元</td><td>4.5元</td></tr><tr><td>高峰时段</td><td>9.0元</td><td>27.0元</td><td>9.0元</td></tr><tr><td colspan="3">并发限制<sup>(3)</sup></td><td>2500</td><td>500</td><td>2500</td></tr></table>`;

const wrap = (table) => `<html><body><h1>价格</h1>${table}</body></html>`;

/**
 * 按官方那张表的形状造一张表：`kinds` 是三组行，每组给 `{ idle, peak }` 两串价，
 * `peak` 省略就不生成高峰那一行（模拟官方取消峰谷）。
 */
function buildTable(models, kinds) {
	const labels = {
		cacheHit: "百万tokens输入<br>（缓存命中）",
		cacheMiss: "百万tokens输入<br>（缓存未命中）",
		output: "百万tokens输出"
	};
	const rows = [`<tr><td colspan="3">模型</td>${models.map((m) => `<td>${m}</td>`).join("")}</tr>`];
	for (const kind of ["cacheHit", "cacheMiss", "output"]) {
		const spec = kinds[kind];
		if (spec === undefined) continue;
		const cells = (values) => values.map((v) => `<td>${v}元</td>`).join("");
		if (spec.peak === undefined) {
			rows.push(`<tr><td rowspan="1">${labels[kind]}</td>${cells(spec.idle)}</tr>`);
			continue;
		}
		rows.push(`<tr><td rowspan="2">${labels[kind]}</td><td>空闲时段</td>${cells(spec.idle)}</tr>`);
		rows.push(`<tr><td>高峰时段</td>${cells(spec.peak)}</tr>`);
	}
	return `<table>${rows.join("")}</table>`;
}

test("解析现在这张官方表：空闲价 + 各自的高峰价，倍率统一时 peakMultiplier 就是那个值", () => {
	const pricing = parseOfficialPricing(wrap(REAL_TABLE));
	assert.ok(pricing, "现在的页面必须解析得出来");
	assert.strictEqual(pricing.currency, "CNY");
	assert.strictEqual(pricing.peakMultiplier, 2);
	assert.deepStrictEqual(pricing.modelPricing["deepseek-official:deepseek-v4-flash"], {
		cacheHitPerMillion: 0.05,
		cacheMissPerMillion: 1.5,
		outputPerMillion: 4.5,
		peak: { cacheHitPerMillion: 0.1, cacheMissPerMillion: 3, outputPerMillion: 9 }
	});
	assert.deepStrictEqual(pricing.modelPricing["deepseek-official:deepseek-v4-pro"], {
		cacheHitPerMillion: 0.15,
		cacheMissPerMillion: 4.5,
		outputPerMillion: 13.5,
		peak: { cacheHitPerMillion: 0.3, cacheMissPerMillion: 9, outputPerMillion: 27 }
	});
	assert.deepStrictEqual(Object.keys(pricing.modelPricing), [
		"deepseek-official:deepseek-v4-flash",
		"deepseek-official:deepseek-v4-pro",
		"deepseek-official:deepseek-v4-flash-vision-exp"
	]);
	// 表里那些「支持 / 1M / 2500」之类的行不能被当成价格读进来。
	assert.strictEqual(Object.keys(pricing.modelPricing).length, 3);
});

test("峰谷倍率不统一也照样解析：每个模型每一类各存自己的峰价", () => {
	// 输出只打 1.5 倍、输入照旧 2 倍：旧实现在这里会整份放弃自动同步、静默用写死的价。
	const html = wrap(buildTable(["deepseek-v4-flash", "deepseek-v4-pro"], {
		cacheHit: { idle: [0.05, 0.15], peak: [0.1, 0.3] },
		cacheMiss: { idle: [1.5, 4.5], peak: [3, 9] },
		output: { idle: [4.5, 13.5], peak: [6.75, 20.25] }
	}));
	const pricing = parseOfficialPricing(html);
	assert.ok(pricing, "倍率不统一不该导致整份放弃");
	const flash = pricing.modelPricing["deepseek-official:deepseek-v4-flash"];
	assert.strictEqual(flash.peak.outputPerMillion, 6.75, "输出的峰价要按页面上的来，不是基准价乘一个统一倍率");
	assert.strictEqual(flash.peak.cacheMissPerMillion, 3);
	// 兜底倍率取所有比值的平均数（2,2,1.5 各两份 → 1.8333…），只给没有自己峰价的条目用。
	assert.ok(Math.abs(pricing.peakMultiplier - (2 + 2 + 1.5) / 3) < 1e-4, `实际: ${pricing.peakMultiplier}`);
});

test("官方取消峰谷（每类只剩一个价）：peak 留空、倍率记 1", () => {
	const html = wrap(buildTable(["deepseek-v4-flash"], {
		cacheHit: { idle: [0.05] },
		cacheMiss: { idle: [1.5] },
		output: { idle: [4.5] }
	}));
	const pricing = parseOfficialPricing(html);
	assert.ok(pricing, "没有峰谷两行也要解析得出来");
	assert.deepStrictEqual(pricing.modelPricing["deepseek-official:deepseek-v4-flash"], {
		cacheHitPerMillion: 0.05,
		cacheMissPerMillion: 1.5,
		outputPerMillion: 4.5
	});
	assert.strictEqual(pricing.peakMultiplier, 1, "没有峰价就不该留一个会让金额翻倍的倍率");
});

test("少了半张表就返回 null（继续用旧价），不摊出一张半截的表", () => {
	// 输出那一组整组消失：半截的表算出来的钱是错的，而且错得看不出来。
	const html = wrap(buildTable(["deepseek-v4-flash"], {
		cacheHit: { idle: [0.05], peak: [0.1] },
		cacheMiss: { idle: [1.5], peak: [3] }
	}));
	assert.strictEqual(parseOfficialPricing(html), null);
});

test("模型列数与价格列数对不上时返回 null", () => {
	// 三个模型，但价格行只给了两个数——多半是页面加了一列而我们还没跟上。
	const html = wrap(`<table>`
		+ `<tr><td colspan="3">模型</td><td>deepseek-v4-flash</td><td>deepseek-v4-pro</td><td>deepseek-v4-new</td></tr>`
		+ `<tr><td rowspan="2">百万tokens输入<br>（缓存命中）</td><td>空闲时段</td><td>0.05元</td><td>0.15元</td></tr>`
		+ `<tr><td>高峰时段</td><td>0.10元</td><td>0.30元</td></tr>`
		+ `<tr><td rowspan="2">百万tokens输入<br>（缓存未命中）</td><td>空闲时段</td><td>1.5元</td><td>4.5元</td></tr>`
		+ `<tr><td>高峰时段</td><td>3.0元</td><td>9.0元</td></tr>`
		+ `<tr><td rowspan="2">百万tokens输出</td><td>空闲时段</td><td>4.5元</td><td>13.5元</td></tr>`
		+ `<tr><td>高峰时段</td><td>9.0元</td><td>27.0元</td></tr>`
		+ `</table>`);
	assert.strictEqual(parseOfficialPricing(html), null);
});

test("页面上没有那张表、或者没有模型行时返回 null", () => {
	assert.strictEqual(parseOfficialPricing("<html><body>价格调整通知</body></html>"), null);
	assert.strictEqual(parseOfficialPricing(wrap("<table><tr><td>百万tokens输入</td><td>0.05元</td></tr></table>")), null);
});

/** 定价页脚注现在那句话，原样抄下来。 */
const REAL_NOTE = "<p>(1) 空闲时段价格为高峰时段价格的一半。高峰时段为北京时间周一至周五 9:00 - 12:00、14:00 - 18:00（其余为空闲时段）。</p>";

test("解析脚注里的高峰时段：现在这句话读出周一至周五 9-12、14-18", () => {
	const parsed = parsePeakSchedule(REAL_NOTE);
	assert.deepStrictEqual(parsed.days, [1, 2, 3, 4, 5]);
	assert.deepStrictEqual(parsed.windows, [[9 * 60, 12 * 60], [14 * 60, 18 * 60]]);
	// 官方现在一个字都没提节假日，所以口径就是「按字面算」= 节假日照样算高峰。
	assert.strictEqual(parsed.holidays, "peak");
	assert.strictEqual(parsed.unmodelled, false, "这句话里没有我没建模的计费词");
	// 原文要带回去，界面上原样摆出来。
	assert.ok(parsed.note.includes("周一至周五"), `实际: ${parsed.note}`);

	// 整页里也要读得到（前面还有一堆无关文字和那张表）。
	const schedule = parseOfficialPricing(wrap(REAL_TABLE) + REAL_NOTE)?.peakSchedule;
	assert.deepStrictEqual(schedule?.windows, [[540, 720], [840, 1080]]);
});

test("脚注换几种写法照样读得出来", () => {
	const cases = [
		["高峰时段为北京时间周一至周六 8:30 - 12:00。", { days: [1, 2, 3, 4, 5, 6], windows: [[510, 720]] }],
		["高峰时段为北京时间每天 0:00 - 6:00、20:00 - 24:00。", { days: [1, 2, 3, 4, 5, 6, 7], windows: [[0, 360], [1200, 1440]] }],
		["高峰时段为北京时间周一、周三、周五 9:00 - 18:00。", { days: [1, 3, 5], windows: [[540, 1080]] }],
		["高峰时段为北京时间星期一至星期五 9：00－12：00。", { days: [1, 2, 3, 4, 5], windows: [[540, 720]] }]
	];
	for (const [note, expected] of cases) {
		const parsed = parsePeakSchedule(`<p>${note}</p>`);
		assert.deepStrictEqual({ days: parsed?.days, windows: parsed?.windows }, expected, `没读对: ${note}`);
	}
});

test("官方哪天补一句「法定节假日按空闲计价」，解析器要认得出来", () => {
	// 这是整件事的关键：官方**现在**没说，但说了之后插件得自己跟上——不用等我发新版，
	// 更不该让用户去手填放假日期。下面几种写法都得认。
	const yes = [
		"高峰时段为北京时间周一至周五 9:00 - 12:00（法定节假日除外）。",
		"高峰时段为北京时间周一至周五 9:00 - 12:00。法定节假日全天为空闲时段。",
		"高峰时段为北京时间周一至周五 9:00 - 12:00，不含法定节假日。",
		"高峰时段为北京时间周一至周五 9:00 - 12:00。法定节假日按空闲时段计价。"
	];
	for (const note of yes) {
		const parsed = parsePeakSchedule(`<p>${note}</p>`);
		assert.strictEqual(parsed?.holidays, "offpeak", `没认出节假日规则: ${note}`);
		assert.strictEqual(parsed.unmodelled, false, `认出来了就不该再报「读不懂」: ${note}`);
	}
	// 没提节假日的那句仍然是「按字面算」，不能自作主张。
	assert.strictEqual(parsePeakSchedule(REAL_NOTE).holidays, "peak");
});

test("脚注里出现我没建模的计费词就标出来，不装作规则没变", () => {
	// 兜底：我只认识「周几 + 时间窗 + 节假日」。官方以后加别的（换时区、阶梯价、
	// 封顶……）我一定读不懂，那时宁可让人看见一句读不懂的话。
	const parsed = parsePeakSchedule("<p>高峰时段为北京时间周一至周五 9:00 - 12:00，单日费用封顶 100 元。</p>");
	assert.deepStrictEqual(parsed.windows, [[540, 720]], "读得懂的部分照常读");
	assert.strictEqual(parsed.unmodelled, true, "「封顶」是会影响金额、而我没建模的规则");
});

test("脚注读不出来就返回 null（继续用上一份规则），几种危险写法都不能瞎猜", () => {
	// 没写「北京时间」：整套判定是按 UTC+8 固定偏移算的，时区表述一变就可能整体
	// 搬错八小时——那种错算出来的钱看不出问题，宁可退回上一份规则。
	assert.strictEqual(parsePeakSchedule("<p>高峰时段为 9:00 - 12:00。</p>"), null);
	assert.strictEqual(parsePeakSchedule("<p>高峰时段为 UTC 时间周一至周五 1:00 - 4:00。</p>"), null);
	// 反着写的那句（「空闲时段为…」）不能被当成高峰时段读走。
	assert.strictEqual(parsePeakSchedule("<p>空闲时段为北京时间周一至周五 18:00 - 24:00。</p>"), null);
	// 只提了「高峰时段价格是空闲的两倍」这类句子，没有时间窗。
	assert.strictEqual(parsePeakSchedule("<p>空闲时段价格为高峰时段价格的一半。</p>"), null);
	assert.strictEqual(parsePeakSchedule("<p>价格调整通知</p>"), null);
});

test("新增模型会自动出现在价表里，不需要改代码", () => {
	const html = wrap(buildTable(["deepseek-v4-flash", "deepseek-v5-pro"], {
		cacheHit: { idle: [0.05, 0.2], peak: [0.1, 0.4] },
		cacheMiss: { idle: [1.5, 6], peak: [3, 12] },
		output: { idle: [4.5, 18], peak: [9, 36] }
	}));
	const pricing = parseOfficialPricing(html);
	assert.ok(pricing?.modelPricing["deepseek-official:deepseek-v5-pro"], "页面上多一个模型就该多一条单价");
	assert.strictEqual(pricing.modelPricing["deepseek-official:deepseek-v5-pro"].outputPerMillion, 18);
});

// ---------------------------------------------------------------------------
// 2026-09-10 那次改版：模型改名 + 计费路由
// ---------------------------------------------------------------------------

/**
 * 2026-09-10 官方定价页上那张表，原样抄下来。
 *
 * 跟上面那张 2026-09-09 的差别不只是价：**模型名那一格里多了脚注角标**
 * （`deepseek-flash<sup>(1)</sup>`）。这一处足以让整份表判成解析失败——而失败是
 * 安静的，插件会继续按早就下线的 V4 Flash 的价算钱。所以这张表必须留在测试里。
 */
const REAL_TABLE_0910 = `<table style="text-align:center"><tr><td colspan="3" style="text-align:center">模型</td><td>deepseek-flash<sup>(1)</sup></td><td>deepseek-v4-pro<sup>(2)</sup></td></tr><tr><td colspan="3">BASE URL (OpenAI 格式)</td><td colspan="2"><a href="https://api.deepseek.com" target="_blank" rel="noopener noreferrer">https://api.deepseek.com</a></td></tr><tr><td colspan="3">BASE URL (Anthropic 格式)</td><td colspan="2"><a href="https://api.deepseek.com/anthropic" target="_blank" rel="noopener noreferrer">https://api.deepseek.com/anthropic</a></td></tr><tr><td colspan="3" style="text-align:center">模型版本</td><td>DeepSeek-V4.1-Flash</td><td>DeepSeek-V4-Pro-0813</td></tr><tr><td colspan="3">思考模式</td><td colspan="2">支持非思考与思考模式（默认）<br>切换方式详见<a href="/zh-cn/guides/thinking_mode">思考模式</a></td></tr><tr><td colspan="3">上下文长度</td><td colspan="2">1M</td></tr><tr><td colspan="3">输出长度</td><td colspan="2">最大 384K</td></tr><tr><td rowspan="7">功能</td><td colspan="2"><a href="/zh-cn/guides/json_mode">Json Output</a></td><td>支持</td><td>支持</td></tr><tr><td colspan="2"><a href="/zh-cn/guides/tool_calls">Tool Calls</a></td><td>支持</td><td>支持</td></tr><tr><td colspan="2"><a href="/zh-cn/guides/responses_api">Responses API</a></td><td>支持</td><td>支持</td></tr><tr><td colspan="2"><a href="/zh-cn/guides/anthropic_api">Anthropic API</a></td><td>支持</td><td>支持</td></tr><tr><td colspan="2"><a href="/zh-cn/guides/chat_prefix_completion">对话前缀续写（Beta）</a></td><td>支持</td><td>支持</td></tr><tr><td colspan="2"><a href="/zh-cn/guides/fim_completion">FIM 补全（Beta）</a></td><td>仅非思考模式支持</td><td>仅非思考模式支持</td></tr><tr><td colspan="2"><a href="/zh-cn/guides/vision">图像理解</a></td><td>支持</td><td>不支持</td></tr><tr><td rowspan="6">价格<sup>(3)</sup></td><td rowspan="2">百万tokens输入<br>（缓存命中）</td><td>空闲时段</td><td>0.02元</td><td>0.15元</td></tr><tr><td>高峰时段</td><td>0.04元</td><td>0.30元</td></tr><tr><td rowspan="2">百万tokens输入<br>（缓存未命中）</td><td>空闲时段</td><td>1元</td><td>4.5元</td></tr><tr><td>高峰时段</td><td>2元</td><td>9.0元</td></tr><tr><td rowspan="2">百万tokens输出</td><td>空闲时段</td><td>4元</td><td>13.5元</td></tr><tr><td>高峰时段</td><td>8元</td><td>27.0元</td></tr><tr><td colspan="3">并发限制<sup>(4)</sup></td><td>2500</td><td>500</td></tr></table>`;

/** 同一版页面的脚注，原样抄下来：(1)(2) 是计费路由，(3) 是峰谷时段。 */
const REAL_FOOTNOTES_0910 = `<div style="font-size:14px"><p>(1) 模型名请使用 <code>deepseek-flash</code>。旧模型名 <code>deepseek-v4-flash</code>、<code>deepseek-v4-flash-vision-exp</code> 仍可调用，但对应模型已下线，请求将由 DeepSeek-V4.1-Flash 模型提供服务，并按 Flash 价格计费。</p><p>(2) 经多方测试，V4.1 Flash 在性能、费用、速度、总用时等各项指标上已全面超越 V4 Pro，因此我们计划有序下线 V4 Pro。北京时间 2026 年 9 月 14 日 12:00 之后，至未来 V4.1 Pro 上线之前，您访问 <code>deepseek-v4-pro</code> 的请求将全部路由到 V4.1 Flash，并按 V4.1 Flash 价格计费。</p><p>(3) 空闲时段价格为高峰时段价格的一半。高峰时段为北京时间周一至周五 9:00 - 12:00、14:00 - 18:00（其余为空闲时段）。</p><p>(4) 更多并发限制细节，请参考<a href="/zh-cn/quick_start/rate_limit">限速与隔离</a>。</p></div>`;

const REAL_PAGE_0910 = wrap(REAL_TABLE_0910 + REAL_FOOTNOTES_0910);

/** 北京时间 2026-09-14 12:00，公告里 pro 改按 flash 计费的那一刻。 */
const PRO_ROUTE_FROM = Date.UTC(2026, 8, 14, 4, 0);

test("模型名那一格里的脚注角标不能把整份表读废", () => {
	const pricing = parseOfficialPricing(REAL_PAGE_0910);
	assert.ok(pricing, "页面给模型名加个 <sup>(1)</sup> 不该让同步整份失败");
	assert.deepStrictEqual(Object.keys(pricing.modelPricing), [
		"deepseek-official:deepseek-flash",
		"deepseek-official:deepseek-v4-pro"
	]);
	assert.deepStrictEqual(pricing.modelPricing["deepseek-official:deepseek-flash"], {
		cacheHitPerMillion: 0.02,
		cacheMissPerMillion: 1,
		outputPerMillion: 4,
		peak: { cacheHitPerMillion: 0.04, cacheMissPerMillion: 2, outputPerMillion: 8 }
	});
	// 峰谷脚注还在同一版页面上，别被前面两条脚注挤掉。
	assert.deepStrictEqual(pricing.peakSchedule.days, [1, 2, 3, 4, 5]);
	assert.deepStrictEqual(pricing.peakSchedule.windows, [[540, 720], [840, 1080]]);
});

test("脚注里的计费路由读得出来：旧模型名按 flash 计费，pro 从 9/14 12:00 起按 flash 计费", () => {
	const pricing = parseOfficialPricing(REAL_PAGE_0910);
	assert.deepStrictEqual(pricing.billing.unparsed, [], "这一版页面上没有读不懂的计费规则");
	assert.deepStrictEqual(
		pricing.billing.routes.map((route) => [route.model, route.billedAs, route.from]),
		[
			["deepseek-v4-flash", "deepseek-flash", null],
			["deepseek-v4-flash-vision-exp", "deepseek-flash", null],
			["deepseek-v4-pro", "deepseek-flash", PRO_ROUTE_FROM]
		]
	);
	// 原文要留着：界面上得能读到插件照的是哪句话。
	assert.match(pricing.billing.routes[2].note, /2026 年 9 月 14 日 12:00/);
	// 「DeepSeek-V4.1-Flash」是模型版本号、不是能拿去调用的模型名，不能被当成路由目标。
	assert.ok(pricing.billing.routes.every((route) => route.billedAs === "deepseek-flash"));
});

test("路由按每条消息自己的时刻套：9/14 12:00 之前 pro 还是 Pro 价，之后才是 Flash 价", () => {
	const pricing = parseOfficialPricing(REAL_PAGE_0910);
	const flash = pricing.modelPricing["deepseek-official:deepseek-flash"];

	const before = applyBillingRoutes(pricing, PRO_ROUTE_FROM - 1);
	assert.deepStrictEqual(
		before.modelPricing["deepseek-official:deepseek-v4-pro"],
		pricing.modelPricing["deepseek-official:deepseek-v4-pro"],
		"分界点之前 pro 按价表上的 Pro 价，一分不能少算"
	);
	// 旧模型名那两条没有生效时刻，任何时候都算数——否则它们在新版价表里根本没有
	// 对应的行，那批用量会变成「未配置单价」、金额直接算 0。
	assert.deepStrictEqual(before.modelPricing["deepseek-official:deepseek-v4-flash"], flash);
	assert.deepStrictEqual(before.modelPricing["deepseek-official:deepseek-v4-flash-vision-exp"], flash);
	assert.strictEqual(before.routedModels["deepseek-official:deepseek-v4-pro"], undefined);

	const after = applyBillingRoutes(pricing, PRO_ROUTE_FROM);
	assert.deepStrictEqual(after.modelPricing["deepseek-official:deepseek-v4-pro"], flash, "分界点当刻就该按 Flash 价");
	assert.strictEqual(after.routedModels["deepseek-official:deepseek-v4-pro"], "deepseek-flash");
	// 峰价也跟着走：路由过去的是整份单价，不是只有空闲那三项。
	assert.strictEqual(after.modelPricing["deepseek-official:deepseek-v4-pro"].peak.outputPerMillion, 8);
	// 原表不能被改：时间线上每一段都从同一份原始价表算起。
	assert.strictEqual(pricing.modelPricing["deepseek-official:deepseek-v4-pro"].outputPerMillion, 13.5);
});

test("「按 Flash 价格计费」在一张没有 deepseek-flash 的表上不能猜到别的模型头上", () => {
	// 2026-09-09 那张表上只有 deepseek-v4-flash。按后缀猜的话「Flash」会落到它头上，
	// 那是一次看不出来的错价——所以宁可整条读不懂，把原句交给界面。
	const old = parseOfficialPricing(wrap(REAL_TABLE + REAL_FOOTNOTES_0910));
	assert.deepStrictEqual(old.billing.routes, []);
	assert.strictEqual(old.billing.unparsed.length, 2, "两条脚注都该原样留下来给人看");
	const routed = applyBillingRoutes(old, PRO_ROUTE_FROM + 1);
	assert.strictEqual(routed.modelPricing["deepseek-official:deepseek-v4-flash"].outputPerMillion, 4.5);
	assert.strictEqual(routed.modelPricing["deepseek-official:deepseek-v4-pro"].outputPerMillion, 13.5);
	assert.strictEqual(routed.routedModels, undefined, "一条都没套上就别在界面上标路由");
});

test("翻旧账时老价表不受影响：目标模型不在那张表里就跳过这条规则", () => {
	// 价格时间线上每一张历史价表都会被套一遍路由。老表上根本没有目标模型那一行时，
	// 当时的用量就该按它自己那份价算——正是当时的实情，不能拿今天的规则改写。
	const old = {
		currency: "CNY",
		modelPricing: {
			"deepseek-official:deepseek-v4-flash": { cacheHitPerMillion: 0.05, cacheMissPerMillion: 1.5, outputPerMillion: 4.5 }
		},
		billing: { routes: [{ model: "deepseek-v4-flash", billedAs: "deepseek-flash", from: null, note: "" }], unparsed: [] }
	};
	const routed = applyBillingRoutes(old, PRO_ROUTE_FROM + 1);
	assert.strictEqual(routed.modelPricing["deepseek-official:deepseek-v4-flash"].outputPerMillion, 4.5);
	assert.strictEqual(routed.routedModels, undefined);
});

test("读不懂的计费规则一律不套用，但要把原文交出来", () => {
	const models = ["deepseek-flash", "deepseek-v4-pro"];

	// 有时间界限却读不出来（写成了「9月14日中午」）：套用与否两个方向都是错的，
	// 那就不套用、把原话摆出来让人判。
	const vague = parseBillingRoutes(
		"<p>9月14日中午之后，访问 deepseek-v4-pro 的请求将全部路由到 V4.1 Flash，并按 V4.1 Flash 价格计费。</p>",
		models
	);
	assert.deepStrictEqual(vague.routes, []);
	assert.strictEqual(vague.unparsed.length, 1);

	// 「Flash」这个口语称呼在表上找不到逐字对得上的模型名：不猜，当读不懂。
	const ambiguous = parseBillingRoutes(
		"<p>旧模型名 deepseek-v4-flash-vision-exp 已下线，并按 Flash 价格计费。</p>",
		["deepseek-v4-flash", "deepseek-v5-flash"]
	);
	assert.deepStrictEqual(ambiguous.routes, []);
	assert.strictEqual(ambiguous.unparsed.length, 1);

	// 日期不是「生效时刻」的那种句子，不能被当成分界点。
	const announced = parseBillingRoutes(
		"<p>北京时间 2026 年 9 月 14 日 12:00 发布公告，deepseek-v4-pro 将路由到 V4.1 Flash 并按 Flash 价格计费。</p>",
		models
	);
	assert.deepStrictEqual(announced.routes, []);
});

test("只是提到「计费」的句子不能被当成计费路由", () => {
	const html = "<p>扣减费用 = token 消耗量 × 模型单价，对应的费用将直接从充值余额或赠送余额中进行扣减。</p>"
		+ "<p>产品价格可能发生变动，DeepSeek 保留修改价格的权利。</p>";
	const parsed = parseBillingRoutes(html, ["deepseek-flash"]);
	assert.deepStrictEqual(parsed.routes, []);
	assert.deepStrictEqual(parsed.unparsed, []);
});

test("官方撤掉那条脚注（V4.1 Pro 上线）之后，pro 自动回到按价表算，不用改代码", () => {
	const withoutRoute = parseOfficialPricing(wrap(
		REAL_TABLE_0910
		+ "<p>(3) 高峰时段为北京时间周一至周五 9:00 - 12:00、14:00 - 18:00（其余为空闲时段）。</p>"
	));
	assert.strictEqual(withoutRoute.billing, undefined, "没有规则就别带这个字段，免得指纹凭空变一次");
	const routed = applyBillingRoutes(withoutRoute, PRO_ROUTE_FROM + 86400000);
	assert.strictEqual(routed.modelPricing["deepseek-official:deepseek-v4-pro"].outputPerMillion, 13.5);
});

test("规则只认它自己那句话点名的模型，不会把价格表那一列名字收进来", () => {
	// 脱完标签之后，`</table>` 和 `<p>` 两边的文字会挤成一句——表格里排着的那一列
	// 模型名于是全都落在「按 Flash 价格计费」这句话里。真发生过：`deepseek-v4-pro`
	// 被一起路由走，pro 的调用从此按 Flash 价算，而面板一个字都不会说。
	const html = `<table><tr><td>模型</td><td>deepseek-flash</td><td>deepseek-v4-pro</td></tr></table>`
		+ `<p>(1) 旧模型名 deepseek-v4-flash 已下线，并按 Flash 价格计费。</p>`;
	const parsed = parseBillingRoutes(html, ["deepseek-flash", "deepseek-v4-pro"]);
	assert.deepStrictEqual(parsed.routes.map((route) => route.model), ["deepseek-v4-flash"]);
});

test("带起止的规则（A 之后至 B 之前）不套用：只建模了「起」，认下来会一直套到天荒地老", () => {
	const parsed = parseBillingRoutes(
		"<p>北京时间 2026 年 9 月 14 日 12:00 之后至北京时间 2026 年 11 月 1 日 00:00 之前，"
		+ "您访问 deepseek-v4-pro 的请求将路由到 V4.1 Flash，并按 V4.1 Flash 价格计费。</p>",
		["deepseek-flash", "deepseek-v4-pro"]
	);
	assert.deepStrictEqual(parsed.routes, []);
	assert.strictEqual(parsed.unparsed.length, 1, "读不懂也要把原句交出来");
});

test("「按 X 计费」少了「价格」两个字也认——目标必须逐字对上表里的模型名，这层就是防线", () => {
	const parsed = parseBillingRoutes(
		"<p>北京时间 2026 年 9 月 14 日 12:00 之后，deepseek-v4-pro 的请求将路由到 V4.1 Flash，并按 Flash 模型计费。</p>",
		["deepseek-flash", "deepseek-v4-pro"]
	);
	assert.deepStrictEqual(parsed.routes.map((route) => [route.model, route.billedAs]), [["deepseek-v4-pro", "deepseek-flash"]]);
});
