/**
 * 中国法定节假日日历。
 *
 * **为什么插件里要有这个东西。** DeepSeek 的高峰时段规则是「北京时间周一至周五
 * 9:00-12:00、14:00-18:00」，一个字都没提法定节假日——所以插件默认严格照字面算，
 * 国庆、春节落在周一至周五就是高峰。但官方随时可能补一句「法定节假日按空闲时段
 * 计价」；那一天到来时，插件必须**自己就能跟上**：定价页脚注里认出那句话
 * （`parsePeakSchedule` 的 `holidays`），然后从这里取当年的放假安排。
 *
 * 让用户自己往配置里抄日期不是答案：放假安排每年由国务院单独公布、还带调休，
 * 抄一次错一次，而且它跟「这个插件」毫无关系。
 *
 * **数据从哪来。** 默认取 holiday-cn 这份公开数据集（GitHub 上按年一个 JSON，
 * 每条记着 `date` 和 `isOffDay`，并在 `papers` 里列出它依据的 gov.cn 政策文件原文
 * 链接）。它同时给出**调休上班日**（`isOffDay: false`），那些日子反过来要按工作日
 * 判——两个方向一份数据全覆盖。地址可配（`holidayCalendarUrl`），公司内网可以换成
 * 自己的镜像。
 *
 * **只在需要的时候才联网。** 官方没说节假日免峰价、用户也没手工开启时，这个模块
 * 一次请求都不会发。抓失败也不影响算钱：退回「按字面算」，并在界面上说明。
 */

/** 按年取，`{year}` 会被替换成四位年份。 */
export const DEFAULT_HOLIDAY_CALENDAR_URL = "https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json";

const FETCH_TIMEOUT_MS = 10 * 1000;

/**
 * 校验并抽出需要的两组日期。
 *
 * 校验得严：这份数据直接参与算钱，宁可整年作废（退回按字面算）也不能把半份脏数据
 * 喂进计价——少判几天高峰是少算钱，而少算钱是看不出来的。
 *
 * @param {unknown} data 远端返回的 JSON
 * @param {number} year 期望的年份
 * @returns {{ offDays: string[], workDays: string[] }|null}
 */
export function parseHolidayCalendar(data, year) {
  if (data === null || typeof data !== "object") return null;
  if (Number(data.year) !== Number(year)) return null;
  if (!Array.isArray(data.days) || data.days.length === 0) return null;
  const offDays = [];
  const workDays = [];
  for (const day of data.days) {
    const date = String(day?.date ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    if (!date.startsWith(`${year}-`)) return null;
    if (typeof day.isOffDay !== "boolean") return null;
    (day.isOffDay ? offDays : workDays).push(date);
  }
  return { offDays: offDays.sort(), workDays: workDays.sort() };
}

/**
 * 抓一年的放假安排。返回 `{ offDays, workDays, papers }` 或 `{ error }`——失败原因要
 * 留下来，界面上得能区分「拉不到」和「格式不认识」。
 */
export async function fetchHolidayCalendar(year, urlTemplate = DEFAULT_HOLIDAY_CALENDAR_URL) {
  const url = String(urlTemplate).replace(/\{year\}/g, String(year));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!res.ok) return { error: `http-${res.status}` };
    const data = await res.json();
    const parsed = parseHolidayCalendar(data, year);
    if (parsed === null) return { error: "parse" };
    return { ...parsed, papers: Array.isArray(data.papers) ? data.papers.map(String) : [] };
  } catch {
    return { error: "network" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 统计窗口最远只到上个月 1 日（`pruneFloor`），所以最多跨两个年份：一月份的时候
 * 「上个月」还在去年。按需要取年份，别为了凑整把整个日历都拉一遍。
 */
export function yearsInRange(from, to) {
  const years = new Set([new Date(from).getFullYear(), new Date(to).getFullYear()]);
  return [...years].sort();
}
