import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

/**
 * 从 dsh 的会话事件日志里直接汇总真实用量与花费。
 *
 * **为什么不再用浏览器半的探针记账。** 旧实现把每条 assistant 消息的 usage 记在
 * 一本浏览器侧的账本里，靠挂在 `conversation.chat.turnTail` 的探针触发。那条路
 * 只看得见「当前工作区里正好被渲染出来的那些消息」：后台会话、没滚到的历史、
 * 应用重启前发生的一切全都漏掉。实测本月真实产生 6147 条 assistant 消息，账本
 * 里只有 21 条，金额差了约 90 倍。这不是某个 bug 修一修就能补上的偏差，是那个
 * 数据源本身就不完整。
 *
 * 事件日志是 dsh 自己的持久化真相：`assistant/message` 事件既带 provider 报上来
 * 的精确 `usage`，也带 `data.message.source` 里逐条精确的 `{provider, model}`。
 * 有了它，去重、unknown 模型迁移、流式估算撤销这一整套账本逻辑连同它们的 bug
 * 一起不存在了——每次都从日志重新算，算出来的就是当下的正确答案。
 *
 * 日志路径与 `@deepseek-ai/dsh-session-persistence-jsonl` 的 `logPath` 一致：
 * `<dsh home>/sessions/<项目目录键>/<会话 id>/session.jsonl[.zstd]`。项目目录键
 * 的编码规则由那个包决定，这里不需要反解——只按两层目录枚举即可。
 */

/** zstd 帧头魔数。会话日志是**追加式多帧**文件，每次落盘追加一个独立帧。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 缓存里保留多久的记录。上月 1 日起——月度统计最远只要到本月 1 日，多留一个月
 * 是为了跨月那一刻不至于突然空掉。再早的直接丢，缓存文件不会无限长大。 */
export function pruneFloor(now) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime();
}

/**
 * 解码一段追加式 zstd 字节流里所有**完整**的帧。
 *
 * 逐帧解，而不是整个文件一把梭：`zstdDecompressSync` 只认第一帧，
 * `createZstdDecompress` 遇到第二帧的帧头会直接报 "Unknown frame descriptor"。
 *
 * 魔数是 4 字节，压缩数据里理论上可能撞出同样的字节序列，所以不能把「下一个魔数
 * 位置」无条件当作帧尾：解不出来就把边界往后一个魔数挪，直到解开或者没得挪。
 *
 * **解得开不等于帧是完整的**：Node 的 zstd 对被截断的帧不报错，会把已经解出来的
 * 部分（常常是空串）原样返回。所以完整性另外判——日志的每一帧都是若干条完整
 * JSONL 行，一定以换行收尾；解出来的文本不以 `\n` 结束，就当这一帧还在写，
 * 既不吐出内容也不推进 `consumed`，下次从这一帧的开头重读。没有这条判定的话，
 * 半个帧会被当成「读完了」，它剩下的那一半永远不会再被读到——那是一笔算不到的钱。
 *
 * @param {Buffer} buf 待解码字节
 * @returns {{ text: string, consumed: number }} 解出的文本与已消费字节数
 */
export function decodeFrames(buf) {
  const starts = [];
  for (let i = buf.indexOf(ZSTD_MAGIC); i >= 0; i = buf.indexOf(ZSTD_MAGIC, i + 1)) starts.push(i);
  if (starts.length === 0) return { text: "", consumed: 0 };

  const parts = [];
  let consumed = starts[0];
  let index = 0;
  while (index < starts.length) {
    const start = starts[index];
    let text = null;
    let next = index + 1;
    for (; next <= starts.length; next += 1) {
      const end = next < starts.length ? starts[next] : buf.length;
      let decoded;
      try {
        decoded = zstdDecompressSync(buf.subarray(start, end));
      } catch {
        // 这个边界不是真的帧尾（魔数撞在压缩数据里），往后再找一个。
        continue;
      }
      const candidate = decoded.toString("utf8");
      if (!candidate.endsWith("\n")) break; // 半个帧，停在这里
      text = candidate;
      break;
    }
    if (text === null) break;
    parts.push(text);
    consumed = next < starts.length ? starts[next] : buf.length;
    index = next;
  }
  return { text: parts.join(""), consumed };
}

/** 明文日志（compression 关掉时）直接就是文本，不用解帧。 */
function decodePlain(buf) {
  return { text: buf.toString("utf8"), consumed: buf.length };
}

/**
 * 从日志文本里抽出计费需要的那几个字段。
 * 一条记录压成定长数组 `[time, modelKey, inputMiss, cacheRead, output]`——缓存文件
 * 里一个月有上万条，用对象存字段名会把文件撑到几兆。
 */
function extractRecords(text, out) {
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    // 一行一个事件，绝大多数是 chunk 流水，先按子串筛掉再 JSON.parse——
    // 全量 parse 一个 9000 行的日志要慢一个数量级。
    if (!line.includes('"assistant/message"')) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== "assistant/message") continue;
    const usage = event.data?.usage;
    if (usage === void 0 || usage === null) continue;
    const source = event.data?.message?.source;
    const key = source?.provider && source?.model ? `${source.provider}:${source.model}` : "unknown";
    out.push([
      Number(event.time) || 0,
      key,
      (usage.inputTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
      usage.cacheReadTokens ?? 0,
      usage.outputTokens ?? 0
    ]);
  }
}

/** 枚举 `<root>/<项目目录>/<会话目录>/session.jsonl[.zstd]`。 */
async function listLogFiles(root) {
  const files = [];
  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = join(root, project.name);
    let sessions;
    try {
      sessions = await readdir(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      for (const name of ["session.jsonl.zstd", "session.jsonl"]) {
        const file = join(projectDir, session.name, name);
        try {
          const info = await stat(file);
          if (info.isFile()) files.push({ file, size: info.size, zstd: name.endsWith(".zstd") });
        } catch {
          // 这个会话没有这种编码的日志，试下一个后缀。
        }
      }
    }
  }
  return files;
}

/**
 * 续读锚点的长度。取 `scanned` 之前的这么多字节存进缓存，下次续读前比对一遍，
 * 确认那个偏移前面的内容**还是上次读过的那份**。压缩数据是高熵的，16 字节
 * 恰好撞上的概率可以忽略。
 */
const ANCHOR_BYTES = 16;

function anchorOf(buf, end) {
  return buf.subarray(Math.max(0, end - ANCHOR_BYTES), end).toString("base64");
}

/**
 * 增量扫描全部会话日志，返回本期需要的全部计费记录。
 *
 * 增量的依据是**文件尺寸**：会话日志是追加式的，尺寸没变就一个字节都不用读，
 * 尺寸变大就只从上次停下的偏移往后读。文件变小说明它被重写过，整份重扫。
 *
 * 光比尺寸不够。日志虽然是追加式的，但 `dsh-session-persistence-jsonl` 有两条
 * 会把文件**变短**的路径：崩溃修复砍掉写坏的尾巴（`repair`）、追加失败回滚到
 * 原尺寸（`rollbackAppend`）。前者砍掉的是不完整的帧——那种帧我本来就不会消费，
 * 所以砍点一定在 `scanned` 之后，续读仍然对。后者理论上可能砍到 `scanned` 之前，
 * 而如果在我下一次扫描之前文件又长回超过原尺寸，「尺寸变大」这个判据就会成立，
 * 于是从一个已经失效的偏移续读，把中间那段悄悄漏掉——漏掉的是钱。
 *
 * 所以额外存一个锚点：`scanned` 前 16 字节的内容。对不上就整份重扫。老版本的
 * 缓存没有这个字段，也一律重扫一次（后台跑一趟，之后就都带锚点了）。
 *
 * @param {string} root 会话日志根目录
 * @param {object|null} cache 上次的缓存对象（可为 null）
 * @param {number} now 当前时刻，用来决定裁剪下限
 * @returns {{ records: number[][], cache: object, changed: boolean }}
 */
export async function scanUsage(root, cache, now = Date.now()) {
  const floor = pruneFloor(now);
  const previous = cache?.files && typeof cache.files === "object" ? cache.files : {};
  const files = {};
  const records = [];
  let changed = false;

  for (const { file, size, zstd } of await listLogFiles(root)) {
    const prior = previous[file];
    if (prior && prior.size === size && Array.isArray(prior.records) && typeof prior.anchor === "string") {
      files[file] = prior;
      for (const record of prior.records) records.push(record);
      continue;
    }
    changed = true;
    let whole;
    try {
      whole = await readFile(file);
    } catch {
      // 读不到就当这个文件本轮不存在：下一轮再试，别让一个坏文件废掉整份统计。
      if (prior) files[file] = prior;
      continue;
    }
    const resumable = prior
      && typeof prior.scanned === "number"
      && typeof prior.anchor === "string"
      && prior.scanned <= size
      && anchorOf(whole, prior.scanned) === prior.anchor;
    const resume = resumable ? prior.scanned : 0;
    const kept = resume > 0 && Array.isArray(prior.records) ? prior.records.filter((r) => r[0] >= floor) : [];
    const buf = resume > 0 ? whole.subarray(resume) : whole;
    const { text, consumed } = zstd ? decodeFrames(buf) : decodePlain(buf);
    const carry = resume > 0 ? String(prior.carry ?? "") : "";
    const full = carry + text;
    // 最后一行可能被截在帧边界上，留到下次和新数据拼起来再解析。
    const cut = full.lastIndexOf("\n");
    const complete = cut < 0 ? "" : full.slice(0, cut + 1);
    const fresh = [];
    extractRecords(complete, fresh);
    const merged = kept.concat(fresh.filter((r) => r[0] >= floor));
    const scanned = resume + consumed;
    files[file] = {
      size,
      scanned,
      anchor: anchorOf(whole, scanned),
      carry: cut < 0 ? full : full.slice(cut + 1),
      records: merged
    };
    for (const record of merged) records.push(record);
  }

  if (Object.keys(previous).length !== Object.keys(files).length) changed = true;
  return { records, cache: { version: 2, files }, changed };
}

/**
 * 高峰时段的判定规则。**只描述规则，不写死规则**——官方原话是
 *
 *   「高峰时段为北京时间周一至周五 9:00 - 12:00、14:00 - 18:00（其余为空闲时段）」
 *
 * 这句话里的每一样都可能被改：星期、时段、乃至有没有峰谷。所以规则本身跟着价表一起
 * 从定价页解析出来、一起进价格时间线（见 `parsePeakSchedule` 与 `pricingFingerprint`），
 * 改了时段就是新的一条，历史消息仍按当时的时段判定。
 *
 * - `days`：1=周一 … 7=周日。
 * - `windows`：`[起, 止]` 的分钟数（从当天 0:00 起算），左闭右开。
 * - `offPeakDates` / `peakDates`：**按日期**整天覆盖，`YYYY-MM-DD`（北京时间的日期）。
 *   官方那句话只说周一至周五，一个字都没提法定节假日——所以字面上国庆、春节落在
 *   周一至周五就是高峰。真实账单是否给节假日免峰价，定价页上查不到，所以这里不替
 *   官方发明规则：默认严格照字面算，谁核对过账单就把那些日期填进 `offPeakDates`
 *   （调休上班的周末反过来填 `peakDates`）。
 */
export const DEFAULT_PEAK_SCHEDULE = Object.freeze({
  days: Object.freeze([1, 2, 3, 4, 5]),
  windows: Object.freeze([Object.freeze([9 * 60, 12 * 60]), Object.freeze([14 * 60, 18 * 60])]),
  offPeakDates: Object.freeze([]),
  peakDates: Object.freeze([])
});

/**
 * 北京时间与 UTC 的固定时差。
 *
 * **可以直接加 8 小时再用 UTC 取值**，不必走 `Intl`：中国自 1991 年起全境统一
 * UTC+8、不实行夏令时，所以北京时间是 UTC 的一个纯偏移。这条不只是省事——
 * 原先那版用 `Intl.DateTimeFormat` 逐条判定，一次汇总（上万条 × 四格）能把事件
 * 循环卡住两秒，于是又加了一层「按整点记忆」的缓存；而按整点缓存的前提是时段边界
 * 落在整点上，一旦官方把时段改成 8:30 这种，缓存就会把半个小时判错。算术做法两个
 * 问题一起没有了：既快，又能精确到分钟。
 *
 * `test/usage-log.test.js` 里有一条用例拿 `Intl` 逐个时刻对账，守住这个假设。
 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 某个时刻在北京时间下的「哪一天 / 星期几 / 当天第几分钟」。 */
function beijingParts(time) {
  const d = new Date(Number(time) + BEIJING_OFFSET_MS);
  const day = d.getUTCDay();
  return {
    dateKey: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`,
    // getUTCDay 是 0=周日；换成 1=周一 … 7=周日，跟中文里「周几」对得上。
    day: day === 0 ? 7 : day,
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes()
  };
}

/** `[起, 止]` 分钟数；只留下有效且非空的区间。 */
function normalizeWindows(windows) {
  return (Array.isArray(windows) ? windows : [])
    .map((window) => (Array.isArray(window) ? [Number(window[0]), Number(window[1])] : null))
    .filter((window) => window !== null
      && Number.isFinite(window[0]) && Number.isFinite(window[1])
      && window[0] >= 0 && window[1] <= 24 * 60 && window[0] < window[1]);
}

/**
 * 把一份规则编译成 `{ isPeak(time) }`。
 *
 * 编译一次、汇总时反复用：`aggregate` 里每条消息都要判一次，而 Set 的构造不该
 * 进那个循环。缺项一律退回 `DEFAULT_PEAK_SCHEDULE`（就是官方现在这句话），而
 * **窗口为空表示「没有高峰时段」**——官方哪天取消峰谷，解析出来就是这个样子。
 */
export function compilePeakSchedule(schedule) {
  const days = new Set(
    (Array.isArray(schedule?.days) ? schedule.days : DEFAULT_PEAK_SCHEDULE.days)
      .map(Number)
      .filter((day) => Number.isInteger(day) && day >= 1 && day <= 7)
  );
  const windows = normalizeWindows(schedule?.windows ?? DEFAULT_PEAK_SCHEDULE.windows);
  const offPeakDates = new Set(Array.isArray(schedule?.offPeakDates) ? schedule.offPeakDates : []);
  const peakDates = new Set(Array.isArray(schedule?.peakDates) ? schedule.peakDates : []);
  return {
    days: Array.from(days).sort((a, b) => a - b),
    windows,
    isPeak(time) {
      if (windows.length === 0) return false;
      const { dateKey, day, minutes } = beijingParts(time);
      // 日期级覆盖优先于星期：整天放假 > 「周三本来是工作日」。
      if (offPeakDates.has(dateKey)) return false;
      if (!peakDates.has(dateKey) && !days.has(day)) return false;
      return windows.some(([start, end]) => minutes >= start && minutes < end);
    }
  };
}

function isDeepSeekProvider(provider) {
  return provider === "deepseek-official" || provider === "deepseek";
}

export function dayKeyOf(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function weekKeyOf(date) {
  const d = date instanceof Date ? date : new Date(date);
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  return dayKeyOf(monday);
}

export function monthKeyOf(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * 一条时间线上、某个时刻生效的那张价表。
 *
 * `timeline` 是升序的 `[{ from, pricing }]`。取 `from <= time` 里最靠后的那条；
 * 比最早一条还早的消息只能用最早那张表——那时候的真实单价我们没有记录，拿手上
 * 最老的一份去算是唯一诚实的近似（第一次装插件之前发生的调用都属于这一类）。
 */
function entryAt(timeline, time) {
  let hit = timeline[0];
  for (const entry of timeline) {
    if (entry.from > time) break;
    hit = entry;
  }
  return hit;
}

export function pricingAt(timeline, time) {
  return entryAt(timeline, time)?.pricing ?? null;
}

/** 三项都是有限正数才算一套能用的价——半截的 `peak` 块宁可不用，也不能算出 NaN。 */
function usableTriple(triple) {
  return triple !== null && typeof triple === "object"
    && [triple.cacheHitPerMillion, triple.cacheMissPerMillion, triple.outputPerMillion]
      .every((v) => Number.isFinite(v) && v >= 0);
}

/**
 * 某个模型在指定时刻的三个单价（已判过峰谷）。
 *
 * 官方页上峰谷是**两套独立的价**，不保证是一个统一倍率（不同模型、不同 token 类别
 * 都可能打不同的折，历史上「一律 2 倍」只是当时恰好如此）。所以优先用解析出来的
 * 那套峰价；只有手工配置这种只给了一套基准价的条目，才退回「基准价 × 倍率」。
 */
function ratesOf(price, peak, multiplier) {
  if (!peak) return price;
  if (usableTriple(price.peak)) return price.peak;
  return {
    cacheHitPerMillion: price.cacheHitPerMillion * multiplier,
    cacheMissPerMillion: price.cacheMissPerMillion * multiplier,
    outputPerMillion: price.outputPerMillion * multiplier
  };
}

/**
 * 把一批记录按模型汇总成一格「费用 + 用量」。
 *
 * 单价在**汇总时**才应用，不在扫描时：缓存里存的是 token 数而不是金额，改价不需要
 * 重扫日志。但「用哪张价表」是按**每条消息自己的时刻**去价格时间线上查的
 * （`pricing.timeline`）——官方调价之后，改价之前发生的调用仍然按旧价算。早先这里
 * 拿「当前那张表」套全部历史，一次调价就会把整月的历史金额凭空改掉一遍。
 *
 * 峰谷同理按每条消息自己的时刻判定：一整天里既有高峰也有空闲，拿「现在是不是高峰」
 * 去乘一整天的用量是旧实现另一个算错钱的地方。
 *
 * `pricing` 可以是单张价表（`{currency, peakMultiplier, modelPricing}`），也可以带
 * 一条 `timeline`。给单张表时就是「这段时间只有这一个价」，测试和老调用点都还能用。
 */
export function aggregate(records, pricing, { from, to } = {}) {
  const timeline = Array.isArray(pricing?.timeline) && pricing.timeline.length > 0
    ? pricing.timeline.slice().sort((a, b) => a.from - b.from)
    : null;
  const perModel = new Map();
  const usedFrom = new Set();
  // 每张价表自带一份高峰时段规则（官方可能连时段一起调）。按表的对象身份缓存编译
  // 结果：编译要建几个 Set，不该进这个每条消息都要跑一遍的循环。
  const schedules = new Map();
  const scheduleFor = (table) => {
    let compiled = schedules.get(table);
    if (compiled === void 0) {
      compiled = compilePeakSchedule(table?.peakSchedule);
      schedules.set(table, compiled);
    }
    return compiled;
  };
  for (const [time, key, input, cacheRead, output] of records) {
    if (from !== void 0 && time < from) continue;
    if (to !== void 0 && time >= to) continue;
    let table = pricing;
    if (timeline !== null) {
      const hit = entryAt(timeline, time);
      table = hit.pricing;
      usedFrom.add(hit.from);
    }
    const modelPricing = table?.modelPricing ?? {};
    const multiplier = table?.peakMultiplier ?? 1;
    const colon = key.indexOf(":");
    const provider = colon < 0 ? null : key.slice(0, colon);
    const model = colon < 0 ? null : key.slice(colon + 1);
    const price = modelPricing[key];
    const entry = perModel.get(key) ?? {
      provider,
      model,
      priced: price !== void 0,
      tokens: { input: 0, cacheRead: 0, output: 0 },
      // 按 token 类别分开记的金额。面板的「费用汇总」要按模型分行、每类一列，
      // 而这个拆分**只能在这里做**：峰谷倍率是逐条消息判的，同一天里既有高峰
      // 也有空闲，浏览器半拿汇总后的 token 数去乘单价必然反推错。
      costs: { input: 0, cacheRead: 0, output: 0 },
      cost: 0,
      messages: 0
    };
    entry.tokens.input += input;
    entry.tokens.cacheRead += cacheRead;
    entry.tokens.output += output;
    entry.messages += 1;
    if (price !== void 0) {
      const peak = isDeepSeekProvider(provider) && scheduleFor(table).isPeak(time);
      const rates = ratesOf(price, peak, multiplier);
      const inputCost = input * rates.cacheMissPerMillion / 1e6;
      const hitCost = cacheRead * rates.cacheHitPerMillion / 1e6;
      const outputCost = output * rates.outputPerMillion / 1e6;
      entry.costs.input += inputCost;
      entry.costs.cacheRead += hitCost;
      entry.costs.output += outputCost;
    }
    perModel.set(key, entry);
  }
  // 合计**最后由分项推出来**，不在循环里另攒一份：那样攒出来的是 `Σ(a+b+c)`，
  // 而界面上摊的是 `Σa`、`Σb`、`Σc` 三个数，两者的浮点求和顺序不同，上万条消息
  // 之后差到 1e-13。数值上无所谓，但「三个分项加起来不等于合计」是个说不清的
  // 差异，不如从构造上就不让它发生。同理，总计就是各行合计相加。
  const entries = Array.from(perModel.values());
  let totalCost = 0;
  for (const entry of entries) {
    entry.cost = entry.costs.input + entry.costs.cacheRead + entry.costs.output;
    totalCost += entry.cost;
  }
  // 这个窗口里实际用到过几张价表。多于一张说明它跨越了一次调价——界面要说明一句，
  // 否则「本月费用」跟着调价整体变一档，看起来像是算错了。
  const priceChanges = Array.from(usedFrom).sort((a, b) => a - b);
  const currency = (timeline === null ? pricing : timeline[timeline.length - 1].pricing)?.currency ?? null;
  return { totalCost, currency, perModel: entries, priceChanges };
}
