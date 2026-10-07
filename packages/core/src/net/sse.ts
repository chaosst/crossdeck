/**
 * SSE（Server-Sent Events）文本帧解析 —— core 的"线上协议 → 帧"地基层。
 *
 * 为什么它必须在 core 而不是各壳里：
 *   三端（Electron / Web / 鸿蒙）都要解析同一个上游的同一套帧。
 *   放三份 = 三份会**静默漂移** —— 某天只在鸿蒙上出现的 off-by-one ，
 *   排查成本远高于把它写在这里跑确定性单测。
 *   与 posixPath.ts / resolveInWorkspace.ts 是同一条理由。
 *
 * ══════════════════════════════════════════════════════════════════
 * 三条"看着更自然的写法"是错的，改之前先读完这段
 * ══════════════════════════════════════════════════════════════════
 *
 * ① **只吃 string，不吃 Uint8Array。**
 *    字节 → 文本要用 `TextDecoder`，而 core 的 `lib` 只有 ES2022 —— 拿不到它。
 *    解码（含"多字节字符被切两半"的跨片拼接）是**壳侧**的职责：
 *    壳先 decode 成 string，再喂进来。
 *    ⚠️ 所以这里**不做**任何 UTF-8 拼接 —— 若强行塞一个 TextDecoder 进来，
 *       `pnpm verify:core-purity` 会报"使用了平台/宿主全局"，
 *       而那个报错看起来极像误报，会被人顺手加进白名单。
 *
 * ② **末尾残帧绝不吐出。**
 *    没有终结分隔符（空行）的半截帧必须留在缓冲里等下一片。
 *    吐出去的后果不是"多一帧"这么轻 —— 是**半截 JSON 被当帧**，
 *    下游 `JSON.parse` 抛错，或者更糟：解析成功但内容是残缺的答案。
 *
 * ③ **`data:` 行之间用换行拼接，且只剥一个前导空格。**
 *    SSE 规范：`data: x` 与 `data:x` 都是 `x`（剥一个空格，不是 trim）。
 *    而 `data:a` + `data:b` 是一条载荷 `a\nb`（换行拼接），**不是** `ab`，
 *    也**不是** `b`（覆盖）。这三者差一个字符就全错。
 */

/** 一帧解析结果。`data` 字段按规范已做过换行拼接与单空格剥离。 */
export interface SseFrame {
  /** 事件名。缺 `event:` 时按规范取默认值 `message`。 */
  readonly event: string;
  /** 载荷。多行 `data:` 已用 `\n` 拼接；无 data 行时为空串。 */
  readonly data: string;
}

/** 收尾时对"未完成残帧"的观测结果，用于诊断**而不是**当成帧发出去。 */
export interface SseTailInfo {
  /** 缓冲里还剩多少字符（>0 说明有未完成残帧） */
  readonly pendingChars: number;
  /** 是否确实存在未完成残帧（等价于 pendingChars > 0，留个语义化名字） */
  readonly hasPending: boolean;
  /** 已忽略的注释行（`:` 开头，心跳常见）总数 —— 用于诊断"心脏还在跳但没数据" */
  readonly commentLines: number;
}

interface ParsedLine {
  /** 字段名；`null` 表示这是注释行或空行 */
  field: string | null;
  /** 字段值（已剥一个前导空格） */
  value: string;
}

/**
 * SSE 解析器。**增量式**：可以喂任意大小的切片（包括 1 字符一片）。
 *
 * 用法（壳侧）：
 * ```ts
 * const p = new SseParser();
 * for (let i = 0; i < text.length; i += 7) {
 *   for (const frame of p.push(text.slice(i, i + 7))) { ... }
 * }
 * const tail = p.end();  // 观测残帧，而不必（也不该）把它当帧
 * ```
 */
export class SseParser {
  /** 尚未见到空行分隔符的原始文本。**这是"残帧不吐"的物理实现**。 */
  #buffer = '';
  #commentLines = 0;

  /**
   * 喂一片文本，返回**本次能确定完整的所有帧**（按出现顺序）。
   *
   * 关键：返回的帧一定以空行结尾。任何"还没等到空行"的内容留在内部缓冲。
   */
  push(chunk: string): SseFrame[] {
    if (chunk.length === 0) return [];
    this.#buffer += chunk;

    const frames: SseFrame[] = [];
    // 逐帧切：帧分隔符是「空行」。这里用索引扫描而不是 split，
    // 因为 split 会把"最后一段残帧"也当成一段返回 —— 那正是 ② 要防的事。
    for (;;) {
      const sep = findFrameBoundary(this.#buffer);
      if (sep === null) break;

      const rawFrame = this.#buffer.slice(0, sep.index);
      this.#buffer = this.#buffer.slice(sep.next);

      const frame = buildFrame(rawFrame, () => {
        this.#commentLines += 1;
      });
      // 完全由空行/注释构成的块不产出帧（注释只计数）
      if (frame !== null) frames.push(frame);
    }
    return frames;
  }

  /** 收尾：观测剩余缓冲，**不产出帧**。 */
  end(): SseTailInfo {
    return {
      pendingChars: this.#buffer.length,
      hasPending: this.#buffer.length > 0,
      commentLines: this.#commentLines,
    };
  }
}

const COMMENT_COUNT = Symbol('comment');

/**
 * 找下一个帧边界。
 *
 * SSE 规范里 `\r\n` / `\n` / `\r` 都算行结束。所以"空行"有三种形态：
 * `\n\n`、`\r\n\r\n`、`\n\r\n`（混用）等。
 * 这里的做法是**先定位行**，再判断"这一行是不是空行"，而不是去枚举分隔符组合
 * —— 枚举组合会漏掉混用情况（用例 6 就是专门盯这个的）。
 *
 * @returns `{ index, next }`：`index` 是空行起始位置（帧内容到此为止），
 *          `next` 是下一帧的起始位置（跳过整个空行）。
 */
function findFrameBoundary(s: string): { index: number; next: number } | null {
  let i = 0;
  // `contentEnd` 记录"上一行行结束符的起点"——遇到空行时，帧内容应当**截到这里**，
  // 而不是截到空行起点。两者在 LF 情形下相等（行结束符就是 `\n`），
  // 但在**裸 CR** 情形下不等：`...\r\r` 里第一个 `\r` 是上一行的终结符，
  // 若截到第二个 `\r` 就会把那个 `\r` 算进 data（曾因此产出一条错帧）。
  let contentEnd = 0;
  while (i < s.length) {
    const lineEnd = findLineEnd(s, i);
    if (lineEnd === null) return null; // 最后一行还不完整，整体留缓冲
    if (lineEnd.end === i) {
      // 遇到空行 → 边界。帧内容截到上一行结束符处。
      return { index: contentEnd, next: lineEnd.next };
    }
    contentEnd = lineEnd.end;
    i = lineEnd.next;
  }
  return null;
}

/** 从 `from` 起找一行的结束位置。 */
function findLineEnd(s: string, from: number): { end: number; next: number } | null {
  for (let j = from; j < s.length; j++) {
    const ch = s[j];
    if (ch === '\n') return { end: j, next: j + 1 };
    if (ch === '\r') {
      // `\r` 可能是裸 CR（行结束）或 CRLF 的前半 —— 看下一个字符是不是 `\n`。
      if (j + 1 >= s.length) {
        // ⚠️ `\r` 是缓冲里的最后一个字符：**无法判定**它是裸 CR 还是 CRLF 的前半。
        //   必须等下一片。否则 CRLF 会被当成「一个空行」→ 凭空多出帧边界 → 帧被劈开。
        return null;
      }
      return s[j + 1] === '\n' ? { end: j, next: j + 2 } : { end: j, next: j + 1 };
    }
  }
  return null;
}

/** 解析一个完整帧块（不含结尾空行）为 SseFrame，或 null（无有效字段）。 */
function buildFrame(rawFrame: string, onComment: () => void): SseFrame | null {
  const lines = splitLines(rawFrame);
  let event: string | null = null;
  const dataLines: string[] = [];
  let sawField = false;

  for (const line of lines) {
    const parsed = parseLine(line);
    if (parsed === COMMENT_COUNT) {
      onComment();
      continue;
    }
    if (parsed.field === null) continue; // 空行（帧内理论上不会出现，稳妥忽略）
    sawField = true;
    if (parsed.field === 'event') {
      event = parsed.value;
    } else if (parsed.field === 'data') {
      dataLines.push(parsed.value);
    }
    // 其它字段（id / retry）本期上游不发，既然不消费就不解析 —— 但要**留痕**：
    // 将来若上游开始发 id，这里不解析不会出错，只是无法用于断线续传。
    // 真要用到时，加在这里并在 verify-core-sse.mjs 补用例，别在壳里另写一份。
  }

  if (!sawField) return null;
  return {
    event: event === null || event === '' ? 'message' : event,
    data: dataLines.join('\n'),
  };
}

/** 把一个帧块按行切开（不含行结束符）。 */
function splitLines(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const end = findLineEnd(s, i);
    if (end === null) {
      out.push(s.slice(i));
      break;
    }
    out.push(s.slice(i, end.end));
    i = end.next;
  }
  return out;
}

/**
 * 解析单行。
 *
 * 规范：
 *   - 空行 → 无字段
 *   - `:` 开头（含单独一个 `:`）→ 注释
 *   - `field: value` → 剥**一个**前导空格
 *   - `field`（无冒号）→ 字段值为空串
 */
function parseLine(line: string): ParsedLine | typeof COMMENT_COUNT {
  if (line.length === 0) return { field: null, value: '' };
  if (line[0] === ':') return COMMENT_COUNT;

  const colon = line.indexOf(':');
  if (colon === -1) return { field: line, value: '' };

  const field = line.slice(0, colon);
  let value = line.slice(colon + 1);
  if (value.startsWith(' ')) value = value.slice(1); // 只剥一个，不做 trim
  return { field, value };
}
