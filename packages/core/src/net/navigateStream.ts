/**
 * navigate 流式问答的**壳无关状态机** —— 三端共用的那一半。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么它在 core，而 fetch 在壳
 * ══════════════════════════════════════════════════════════════════
 * 分界线画在**「已解码的文本」**上，与 `SseParser` 只吃 string 是同一条线：
 *
 *   core（这里）：首帧超时的判据、SSE 帧 → 语义动作、权威全文的差量补齐、
 *                终态的**幂等**收口、取消的记账、诊断词汇。
 *   壳（各一份）：`fetch` / `reader` / `TextDecoder` / `AbortController` ——
 *                Electron 走 node fetch + `?token=`，Web 走浏览器 fetch +
 *                同源 httpOnly cookie，鸿蒙走 `@ohos.net.http`。
 *
 * ⚠️ 这条线**不是风格选择，是编译期约束**：core 的 `lib` 只有 ES2022，
 *    压根拿不到 `Response` / `RequestInit` / `AbortController` / `URL` 的类型
 *    （见 tsconfig.base.json）。想让 core 自己 fetch，就得给 core 加 DOM lib ——
 *    那会同时毁掉两件事：Web 壳这个「试金石」不再能证明 core 无平台假设，
 *    以及 contract/core 被 ArkTS 直接消费的前提。
 *
 * 所以状态机必须与网络解耦：壳把解码后的文本 `feed()` 进来，
 * 需要**真断连接**时引擎喊一声 `abortUpstream()`（它不碰网络，只通知壳）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 五个坑，每个都有对应断言（改之前先读）
 * ══════════════════════════════════════════════════════════════════
 *
 * ① **认证不是这里的事**，但「认证失败要能区分人话」是 —— 见 `describeHttpStatus`。
 *
 * ② **首帧超时不能等 runtime 的 60s 兜底。** 而且计时器要在 `await fetch`
 *    **之前**就挂上：服务端连响应头都不给时，`await fetch` 永远不 resolve。
 *
 * ③ **正常路径一定发 `done`；没收到 done 就断 = 被截断，必须报错。**
 *    把它当正常收尾，用户看到的是"答案莫名其妙只有半截"，且没有任何信号。
 *
 * ④ **`#settleError` / `#settleEnd` 必须幂等**，且 `cancel()` **绝不碰 sink** ——
 *    "取消"（我不听了）与"结束"（上游说完了）是两回事，终态归 runtime 决定。
 *
 * ⑤ **`authoritative` 的语义是替换，不是追加。** `ModelSink` 只有增量回调，
 *    表达不了替换，所以我们做前缀差量；前缀不成立时**宁可重复也不静默丢**。
 */

import type { AgentDeps, Cancel } from '../agent/deps.js';
import type { ModelSink } from '../agent/model.js';
import { SseParser } from './sse.js';
import { dedupeSources, mapNavigateFrames } from './navigate.js';
import type { NavigateAction } from './navigate.js';

/** 上游路径。**已定决策：只接 `/api/resume/chat`**（权限最低、真逐 token 流）。 */
export const NAVIGATE_CHAT_PATH = '/api/resume/chat';

/** 首帧超时默认值。**必须有** —— 没有它，"上游根本没起来"会表现为界面永远转圈。 */
export const DEFAULT_FIRST_FRAME_TIMEOUT_MS = 15_000;

/**
 * 诊断事件。
 *
 * 计划里写的是"计数 + 日志"。把"计数"做成可注入的回调，断言才抓得住
 * "确实上报了"；不给回调时落到 console（`defaultNavigateReport`）。
 *
 * 刻意**不把 `sources` / `unknown` 塞进 `ModelSink`** —— 那是 core 的端口契约，
 * 为了一端的诊断需求去改它会污染三端。
 */
export type NavigateDiagnostic =
  /**
   * 请求已发出。**刻意只记 endpoint** —— 凭据不许进日志。
   * `auth` 只说"用了哪种凭据"，不含凭据本身。
   */
  | { readonly type: 'request'; readonly at: number; readonly endpoint: string; readonly auth: 'token' | 'cookie' }
  /** 一片增量到达。`at` 用于肉眼确认"是逐帧到的，不是一次性到齐"。 */
  | { readonly type: 'chunk'; readonly at: number; readonly len: number; readonly total: number }
  /** 收到引用来源（已去重）。 */
  | { readonly type: 'sources'; readonly at: number; readonly sources: readonly string[] }
  /** 未识别的事件名 —— **上报，不静默**（上游加新事件时三端不该静默失灵）。 */
  | { readonly type: 'unknown-event'; readonly at: number; readonly event: string; readonly raw: string }
  /** `authoritative` 前缀成立 → 只补吐了尾巴。 */
  | { readonly type: 'authoritative-delta'; readonly at: number; readonly added: number }
  /**
   * `authoritative` 前缀**不成立** → 增量表达不了替换，只能按全文补吐（可能重复）。
   * 这是"契约理解可能错了"的信号：正常路径压根不发 `answer`，
   * 所以这个分支不该频繁出现 —— 频繁出现就要回来对契约。
   */
  | {
      readonly type: 'authoritative-replace';
      readonly at: number;
      readonly emittedLen: number;
      readonly textLen: number;
    }
  /** 终态。`message` 在 `kind === 'end'` 时为 null。 */
  | { readonly type: 'terminal'; readonly at: number; readonly kind: 'end' | 'error'; readonly message: string | null };

/** 诊断出口。 */
export type NavigateReport = (d: NavigateDiagnostic) => void;

export interface NavigateStreamOptions {
  readonly sink: ModelSink;
  readonly deps: AgentDeps;
  readonly firstFrameTimeoutMs: number;
  /**
   * 需要**硬断连接**时引擎喊这一声。引擎自己不碰网络 ——
   * `AbortController` 归壳（它也才知道怎么断：fetch 是 `abort()`，
   * 鸿蒙是 `http.destroy()`）。
   */
  readonly abortUpstream: () => void;
  /** 诊断出口。壳一般传 `cfg.onDiagnostic ?? defaultNavigateReport`。 */
  readonly report: NavigateReport;
}

/**
 * 一次流式问答的**会话状态**。
 *
 * 与壳的契约（顺序很关键）：
 *   1. 构造它
 *   2. `await fetch` **之前**调 `armFirstFrameTimer()`
 *   3. 每读到一片字节 → `markFirstByte()` → `feed(decodedText)`
 *      （`feed` 返回 true = 已终态，停止读流）
 *   4. reader 结束 → 若 `settled` 为真就放掉 body；否则 `finishStream()`
 *   5. 外部取消 → `cancel()` 然后壳自己 `abort()` 连接
 */
export class NavigateStream {
  readonly #sink: ModelSink;
  readonly #deps: AgentDeps;
  readonly #firstFrameTimeoutMs: number;
  readonly #abortUpstream: () => void;
  readonly #report: NavigateReport;
  readonly #parser = new SseParser();

  /** 外部调过 cancel。此后不再交任何终态给 sink（终态归 runtime 决定）。 */
  #cancelled = false;
  /** 已经交过终态（onEnd / onError）。**幂等位** —— sink 契约要求"恰好一次"。 */
  #settled = false;
  /** 是否已有**字节**到达（首帧超时的判据）。 */
  #firstByteSeen = false;
  /** 已经 `onChunk` 出去的内容累计 —— `authoritative` 差量补齐的基准。 */
  #emitted = '';
  #timer: Cancel | null = null;

  constructor(opts: NavigateStreamOptions) {
    this.#sink = opts.sink;
    this.#deps = opts.deps;
    this.#firstFrameTimeoutMs = opts.firstFrameTimeoutMs;
    this.#abortUpstream = opts.abortUpstream;
    this.#report = opts.report;
  }

  get cancelled(): boolean {
    return this.#cancelled;
  }

  get settled(): boolean {
    return this.#settled;
  }

  /** 已吐出的全文。壳与断言用它，**不要在壳里再记一份**（那会出现两个真相）。 */
  get emitted(): string {
    return this.#emitted;
  }

  /**
   * 挂上首帧计时器。**必须在 `await fetch` 之前调**（坑 ②）：
   * 服务端不给响应头时 `await fetch` 永不 resolve，计时器挂在里面就永不启动。
   */
  armFirstFrameTimer(): void {
    this.#timer = this.#deps.every(this.#firstFrameTimeoutMs, () => {
      this.#clearTimer();
      this.#abortUpstream();
      this.settleError(`上游首帧超时：${this.#firstFrameTimeoutMs}ms 内没有收到任何数据`);
    });
  }

  /**
   * 有字节到达（幂等）。
   *
   * 判据是**字节**有没有到，不是"解出文本没有"：一个被切开的多字节字符
   * 解出来是空串，但它确实到了 —— 拿"文本非空"当判据会把一次正常的多字节
   * 分片误判成"还没连上"。
   */
  markFirstByte(): void {
    if (this.#firstByteSeen) return;
    this.#firstByteSeen = true;
    this.#clearTimer();
  }

  /**
   * 喂一片**已解码**的文本（解码归壳 —— `TextDecoder` 不在 ES2022 lib 里）。
   *
   * @returns true = 本次流该停了（已收到终态）。
   */
  feed(text: string): boolean {
    for (const action of mapNavigateFrames(this.#parser.push(text))) {
      if (this.#dispatch(action)) return true;
    }
    return false;
  }

  /**
   * reader 结束了。若此前没有终态 → 判定"被截断"（坑 ③）。
   *
   * 正常路径**一定**发 `done`，所以走到这里且没终态 = 上游提前关闭连接。
   * 顺手把 SSE 残帧的信息带进错误消息 —— 排查时"残帧有多少字符"往往就是线索。
   */
  finishStream(): void {
    if (this.#cancelled || this.#settled) return;
    const tail = this.#parser.end();
    this.settleError(
      '上游提前关闭连接：没收到 done 帧' +
        (tail.hasPending ? `（缓冲区还有 ${tail.pendingChars} 个字符的残帧）` : '') +
        ' —— 回答可能被截断',
    );
  }

  /**
   * 外部取消。**只标记 + 摘计时器，绝不碰 sink**（坑 ④）——
   * 壳随后自己断连接（`abort()` / `http.destroy()`）。
   */
  cancel(): void {
    if (this.#cancelled) return;
    this.#cancelled = true;
    this.#clearTimer();
  }

  /**
   * 交一个**错误**终态。壳在还没开始读流时也用它
   * （连不上 / 非 2xx / 没凭据 / 读取抛错）。
   */
  settleError(message: string): void {
    if (this.#cancelled || this.#settled) return;
    this.#settled = true;
    this.#clearTimer();
    this.#report({ type: 'terminal', at: this.#deps.now(), kind: 'error', message });
    this.#sink.onError(message);
  }

  /** 交一个**正常**终态。只有 `done` 帧会走到这里。 */
  settleEnd(): void {
    if (this.#cancelled || this.#settled) return;
    this.#settled = true;
    this.#clearTimer();
    this.#report({ type: 'terminal', at: this.#deps.now(), kind: 'end', message: null });
    this.#sink.onEnd();
  }

  /** 处理一个语义动作。@returns true = 本次流该停了（已收到终态）。 */
  #dispatch(action: NavigateAction): boolean {
    switch (action.kind) {
      case 'text':
        this.#pushChunk(action.text);
        return false;

      case 'authoritative': {
        // 语义是**替换**，但 `ModelSink` 只有增量 `onChunk` —— 无法表达替换。
        // 正常路径压根不发这个帧（T3 revA 语料是 token×105 → sources → done），
        // 只有上游退化成"一次性到齐"时才补发。所以这里处理的是**兜底路径**，
        // 但不能省 —— 省了就是"上游一退化就出拼接错误"。
        if (action.text.startsWith(this.#emitted)) {
          const tail = action.text.slice(this.#emitted.length);
          this.#report({ type: 'authoritative-delta', at: this.#deps.now(), added: tail.length });
          this.#pushChunk(tail);
        } else {
          // 前缀不成立 → 无法用增量表达。**宁可重复，也不静默丢内容**，
          // 但必须留下可观测的痕迹（计数 + 日志）。
          this.#report({
            type: 'authoritative-replace',
            at: this.#deps.now(),
            emittedLen: this.#emitted.length,
            textLen: action.text.length,
          });
          this.#pushChunk(action.text);
        }
        return false;
      }

      case 'sources':
        // ⚠️ 这里**只能上报**，送不进 sink：`ModelSink` 没有"来源"通道，
        //    `contract` 的 `AgentStreamEvent` 目前也没有 `sources` 事件。
        //    要让 UI 展示引用来源，得先在 contract 加事件 —— 那是另一张卡的事。
        //    现在假装"已经送给 UI 了"才是诚实性缺口。
        this.#report({ type: 'sources', at: this.#deps.now(), sources: dedupeSources(action.sources) });
        return false;

      case 'done':
        this.settleEnd();
        return true;

      case 'error':
        this.settleError(`上游报错：${action.message}`);
        return true;

      case 'unknown':
        this.#report({ type: 'unknown-event', at: this.#deps.now(), event: action.event, raw: action.raw });
        return false;
    }
  }

  #pushChunk(text: string): void {
    if (text.length === 0) return;
    this.#emitted += text;
    this.#report({ type: 'chunk', at: this.#deps.now(), len: text.length, total: this.#emitted.length });
    this.#sink.onChunk(text);
  }

  #clearTimer(): void {
    if (this.#timer === null) return;
    this.#timer();
    this.#timer = null;
  }
}

/**
 * 把 HTTP 状态翻成**能区分的**人话。
 *
 * 全都压成"请求失败"等于让排查去猜 —— 而 401（凭据）与 429（限流）与
 * 503（服务端没启用）该做的下一步完全不同。项目既有做法：错误码不许拍平。
 */
export function describeNavigateHttpStatus(status: number, retryAfter: string | null): string {
  if (status === 401 || status === 403) {
    return `上游拒绝：凭据无效或已过期（HTTP ${status}）—— 请重新登录`;
  }
  if (status === 404) {
    return `上游没有这个接口（HTTP 404）—— 确认地址确实是 navigate 的 ${NAVIGATE_CHAT_PATH}`;
  }
  if (status === 429) {
    return `上游限流（HTTP 429）${retryAfter === null ? '' : `，建议 ${retryAfter}s 后重试`}`;
  }
  if (status === 503) {
    return '上游未启用该能力（HTTP 503）—— 服务端可能没配体验账号';
  }
  return `上游返回 HTTP ${status}`;
}

/**
 * 诊断的**结构化文本**。
 *
 * 为什么 core 不直接 `console.log`（第一版就是这么写的，被编译期拦下了）：
 * core 的 lib 只有 ES2022 —— `console` 既不在 ES2022 也不该被 core 假设存在。
 * 硬要写得给 core 加个 `declare const console`，那正是项目一贯拒绝的
 * "假装统一"。落控制台是 **IO**，IO 归壳；core 只负责把一条诊断
 * 变成"该用哪个级别、该打什么字"—— 这部分是纯逻辑，可以被断言。
 */
export interface NavigateReportLine {
  readonly level: 'log' | 'warn';
  readonly text: string;
}

/** 壳侧的日志出口（`console` 结构化地满足它，无需适配层）。 */
export interface LogSink {
  log(...data: readonly unknown[]): void;
  warn(...data: readonly unknown[]): void;
}

/** 把一条诊断翻成"级别 + 文本"。纯函数，可断言。 */
export function formatNavigateDiagnostic(d: NavigateDiagnostic): NavigateReportLine {
  switch (d.type) {
    case 'request':
      return { level: 'log', text: `[navigate] 请求 ${d.endpoint}（认证：${d.auth}）` };
    case 'chunk':
      // `chunk@<ms> len=<n>` 就是"逐帧到达"的肉眼证据
      return { level: 'log', text: `[navigate] chunk@${d.at} len=${d.len} total=${d.total}` };
    case 'sources':
      return { level: 'log', text: `[navigate] sources×${d.sources.length}（已去重）` };
    case 'unknown-event':
      return {
        level: 'warn',
        text: `[navigate] 未识别的事件 "${d.event}"，原文：${truncateForLog(d.raw)}`,
      };
    case 'authoritative-delta':
      return { level: 'log', text: `[navigate] authoritative 差量补齐 +${d.added}` };
    case 'authoritative-replace':
      return {
        level: 'warn',
        text:
          `[navigate] authoritative 前缀不成立（已吐 ${d.emittedLen} 字符 / 全文 ${d.textLen}）` +
          ' → 按全文补吐，可能出现重复；若频繁出现请对契约',
      };
    case 'terminal':
      return {
        level: 'log',
        text: `[navigate] 终态 ${d.kind}${d.message === null ? '' : `：${d.message}`}`,
      };
  }
}

/**
 * 默认诊断出口：把结构化文本写进给定的日志口。
 *
 * 壳里就是 `cfg.onDiagnostic ?? createNavigateReporter(console)` ——
 * core 不知道 `console` 是什么，壳也不需要重复写那套 switch。
 */
export function createNavigateReporter(out: LogSink): NavigateReport {
  return (d) => {
    const line = formatNavigateDiagnostic(d);
    if (line.level === 'warn') out.warn(line.text);
    else out.log(line.text);
  };
}

/** 日志截断 —— 上游 raw 可能是整帧，不该把控制台刷爆。 */
export function truncateForLog(s: string): string {
  return s.length <= 160 ? s : `${s.slice(0, 160)}…`;
}

