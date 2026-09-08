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
function pruneFloor(now) {
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
 * 增量扫描全部会话日志，返回本期需要的全部计费记录。
 *
 * 增量的依据是**文件尺寸**：会话日志是追加式的，尺寸没变就一个字节都不用读，
 * 尺寸变大就只从上次停下的偏移往后读。文件变小说明它被重写过（回滚/重建），
 * 那条整份重扫。
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
    if (prior && prior.size === size && Array.isArray(prior.records)) {
      files[file] = prior;
      for (const record of prior.records) records.push(record);
      continue;
    }
    changed = true;
    const resume = prior && typeof prior.scanned === "number" && prior.size <= size ? prior.scanned : 0;
    const kept = resume > 0 && Array.isArray(prior.records) ? prior.records.filter((r) => r[0] >= floor) : [];
    let buf;
    try {
      const whole = await readFile(file);
      buf = resume > 0 ? whole.subarray(resume) : whole;
    } catch {
      // 读不到就当这个文件本轮不存在：下一轮再试，别让一个坏文件废掉整份统计。
      if (prior) files[file] = prior;
      continue;
    }
    const { text, consumed } = zstd ? decodeFrames(buf) : decodePlain(buf);
    const carry = resume > 0 ? String(prior.carry ?? "") : "";
    const full = carry + text;
    // 最后一行可能被截在帧边界上，留到下次和新数据拼起来再解析。
    const cut = full.lastIndexOf("\n");
    const complete = cut < 0 ? "" : full.slice(0, cut + 1);
    const fresh = [];
    extractRecords(complete, fresh);
    const merged = kept.concat(fresh.filter((r) => r[0] >= floor));
    files[file] = { size, scanned: resume + consumed, carry: cut < 0 ? full : full.slice(cut + 1), records: merged };
    for (const record of merged) records.push(record);
  }

  if (Object.keys(previous).length !== Object.keys(files).length) changed = true;
  return { records, cache: { version: 1, files }, changed };
}

/**
 * 北京时间的高峰时段判定，与浏览器半 `isPeakHours` 逐字同一套规则。
 *
 * formatter 提到模块级、结果按**整点**记忆：一次汇总要判上万条消息，而
 * `new Intl.DateTimeFormat(...)` 每次构造都要几十微秒——照着写在循环里，
 * 一次请求就能把 host 进程的事件循环卡住两秒（实测 10367 条 × 4 格 = 2.1s）。
 * 高峰与否只跟「北京时间的星期几 + 第几个小时」有关，同一小时内的消息共用
 * 一个答案，缓存命中率天然接近 100%。
 */
const PEAK_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Shanghai",
  hourCycle: "h23",
  weekday: "short",
  hour: "numeric"
});
const HOUR_MS = 60 * 60 * 1000;
const peakByHour = new Map();

export function isPeakHours(date) {
  const time = date instanceof Date ? date.getTime() : Number(date);
  const bucket = Math.floor(time / HOUR_MS);
  const hit = peakByHour.get(bucket);
  if (hit !== void 0) return hit;
  const parts = PEAK_FORMAT.formatToParts(new Date(time));
  const weekday = parts.find((p) => p.type === "weekday")?.value;
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const isWeekday = weekday !== "Sat" && weekday !== "Sun";
  const peak = isWeekday && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
  peakByHour.set(bucket, peak);
  return peak;
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
 * 把一批记录按模型汇总成一格「费用 + 用量」。
 *
 * 单价在**汇总时**才应用，不在扫描时：官方价是自动同步的，昨天同步到的新价格
 * 今天就该反映在历史统计上，缓存里存的是 token 数而不是金额，正是为了让改价
 * 不需要重扫日志。峰谷倍率按每条消息自己的时刻判定——一整天里既有高峰也有空闲，
 * 拿「现在是不是高峰」去乘一整天的用量是旧实现另一个算错钱的地方。
 */
export function aggregate(records, pricing, { from, to } = {}) {
  const modelPricing = pricing?.modelPricing ?? {};
  const multiplier = pricing?.peakMultiplier ?? 1;
  const perModel = new Map();
  let totalCost = 0;
  for (const [time, key, input, cacheRead, output] of records) {
    if (from !== void 0 && time < from) continue;
    if (to !== void 0 && time >= to) continue;
    const colon = key.indexOf(":");
    const provider = colon < 0 ? null : key.slice(0, colon);
    const model = colon < 0 ? null : key.slice(colon + 1);
    const price = modelPricing[key];
    const entry = perModel.get(key) ?? {
      provider,
      model,
      priced: price !== void 0,
      tokens: { input: 0, cacheRead: 0, output: 0 },
      cost: 0,
      messages: 0
    };
    entry.tokens.input += input;
    entry.tokens.cacheRead += cacheRead;
    entry.tokens.output += output;
    entry.messages += 1;
    if (price !== void 0) {
      const peak = isDeepSeekProvider(provider) && isPeakHours(new Date(time));
      const cost = (
        input * price.cacheMissPerMillion
        + cacheRead * price.cacheHitPerMillion
        + output * price.outputPerMillion
      ) / 1e6 * (peak ? multiplier : 1);
      entry.cost += cost;
      totalCost += cost;
    }
    perModel.set(key, entry);
  }
  return { totalCost, currency: pricing?.currency ?? null, perModel: Array.from(perModel.values()) };
}
