/**
 * navigate 流式问答的**壳无关状态机** —— 三端共用的那一半。
 *
 * 分界线画在**「已解码的文本」**上：核心的约束是 core 的 `lib` 只有 ES2022
 * （拿不到 `Response` / `AbortController` / `URL` 的类型），所以
 * `fetch` / `reader` / `TextDecoder` / `AbortController` 全留在壳里。
 * 壳把解码后的文本 `feed()` 进来；需要真断连接时引擎喊 `abortUpstream()`。
 */

import type { AgentDeps, Cancel } from '../agent/deps.js';
import type { ModelSink } from '../agent/model.js';
import { SseParser } from './sse.js';
import { dedupeSources, mapNavigateFrames } from './navigate.js';
import type { NavigateAction } from './navigate.js';

/** 上游路径。只接 `/api/resume/chat`（权限最低、真逐 token 流）。 */
export const NAVIGATE_CHAT_PATH = '/api/resume/chat';

/** 首帧超时默认值。没有它，"上游没起来"会表现为界面永远转圈。 */
export const DEFAULT_FIRST_FRAME_TIMEOUT_MS = 15_000;

/** 诊断事件。把"计数"做成可注入回调，断言才抓得住"确实上报了"。 */
export type NavigateDiagnostic =
  /** 请求已发出。刻意只记 endpoint —— 凭据不许进日志。 */
  | { readonly type: 'request'; readonly at: number; readonly endpoint: string; readonly auth: 'token' | 'cookie' }
  /** 一片增量到达。`at` 用于确认"是逐帧到的，不是一次性到齐"。 */
  | { readonly type: 'chunk'; readonly at: number; readonly len: number; readonly total: number }
  /** 收到引用来源（已去重）。 */
  | { readonly type: 'sources'; readonly at: number; readonly sources: readonly string[] }
  /** 未识别的事件名 —— **上报，不静默**。 */
  | { readonly type: 'unknown-event'; readonly at: number; readonly event: string; readonly raw: string }
  /** `authoritative` 前缀成立 → 只补吐了尾巴。 */
  | { readonly type: 'authoritative-delta'; readonly at: number; readonly added: number }
  /** `authoritative` 前缀**不成立** → 按全文补吐（可能重复），需要回来对契约。 */
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
  /** 需要**硬断连接**时引擎喊这一声；引擎自己不碰网络。 */
  readonly abortUpstream: () => void;
  readonly report: NavigateReport;
}

/**
 * 一次流式问答的**会话状态**。与壳的调用顺序：
 *   1. 构造
 *   2. `await fetch` **之前**调 `armFirstFrameTimer()`
 *   3. 每读到一片字节 → `markFirstByte()` → `feed(decodedText)`
 *   4. reader 结束 → 若 `settled` 就放掉 body；否则 `finishStream()`
 *   5. 外部取消 → `cancel()`，然后壳自己 `abort()` 连接
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
  /** 已经交过终态。**幂等位** —— sink 契约要求"恰好一次"。 */
  #settled = false;
  /** 是否已有**字节**到达（首帧超时的判据）。 */
  #firstByteSeen = false;
  /** 已经 `onChunk` 出去的内容累计 —— 差量补齐的基准。 */
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

  /** 已吐出的全文。壳与断言用它，**不要在壳里再记一份**。 */
  get emitted(): string {
    return this.#emitted;
  }

  /**
   * 挂上首帧计时器。**必须在 `await fetch` 之前调**：
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
   * 有字节到达（幂等）。判据是**字节**，不是"解出文本没有" ——
   * 被切开的多字节字符解出来是空串，但它确实到了。
   */
  markFirstByte(): void {
    if (this.#firstByteSeen) return;
    this.#firstByteSeen = true;
    this.#clearTimer();
  }

  /** 喂一片**已解码**的文本。@returns true = 已收到终态，该停止读流。 */
  feed(text: string): boolean {
    for (const action of mapNavigateFrames(this.#parser.push(text))) {
      if (this.#dispatch(action)) return true;
    }
    return false;
  }

  /**
   * reader 结束了。此前没有终态 → 判定"被截断"：
   * 正常路径**一定**发 `done`，所以走到这里且没终态 = 上游提前关闭连接。
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

  /** 外部取消。**只标记 + 摘计时器，绝不碰 sink**；壳随后自己断连接。 */
  cancel(): void {
    if (this.#cancelled) return;
    this.#cancelled = true;
    this.#clearTimer();
  }

  /** 交一个**错误**终态。壳在还没开始读流时也用它（连不上 / 非 2xx / 没凭据）。 */
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

  /** @returns true = 本次流该停了（已收到终态）。 */
  #dispatch(action: NavigateAction): boolean {
    switch (action.kind) {
      case 'text':
        this.#pushChunk(action.text);
        return false;

      case 'authoritative': {
        // 语义是**替换**，而 `ModelSink` 只有增量 `onChunk`，表达不了替换。
        // 正常路径不发这个帧，只有上游退化成"一次性到齐"时才补发 —— 兜底路径，但不能省。
        if (action.text.startsWith(this.#emitted)) {
          const tail = action.text.slice(this.#emitted.length);
          this.#report({ type: 'authoritative-delta', at: this.#deps.now(), added: tail.length });
          this.#pushChunk(tail);
        } else {
          // 前缀不成立 → 增量表达不了替换。**宁可重复也不静默丢内容**，但留下可观测痕迹。
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
        // ⚠️ 只能上报，**送不进 sink**：`ModelSink` 没有"来源"通道，
        //    `contract` 的 `AgentStreamEvent` 也没有 `sources` 事件。
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

/** 把 HTTP 状态翻成**能区分的**人话：401（凭据）/ 429（限流）/ 503（没启用）下一步完全不同。 */
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

export interface NavigateReportLine {
  readonly level: 'log' | 'warn';
  readonly text: string;
}

/** 壳侧的日志出口（`console` 结构化地满足它）。 */
export interface LogSink {
  log(...data: readonly unknown[]): void;
  warn(...data: readonly unknown[]): void;
}

/** 诊断 → "级别 + 文本"。纯函数，可断言（core 里写不了 `console`，落日志是 IO）。 */
export function formatNavigateDiagnostic(d: NavigateDiagnostic): NavigateReportLine {
  switch (d.type) {
    case 'request':
      return { level: 'log', text: `[navigate] 请求 ${d.endpoint}（认证：${d.auth}）` };
    case 'chunk':
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

/** 默认诊断出口：壳里就是 `cfg.onDiagnostic ?? createNavigateReporter(console)`。 */
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
