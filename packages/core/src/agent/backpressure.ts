import type { AgentDeps, Cancel } from './deps.js';

/**
 * 下行背压泵 —— 产字与推字**解耦**，推字按帧节流，且可被反向暂停。
 *
 * 为什么必须有它，而不是"上游一有字就 send 出去"：
 *   Agent 的输出是 token 流，但 `ipcMain.handle` 只能返回一次。
 *   裸 `webContents.send` 逐块推**没有任何背压** —— 上游快、渲染慢时事件会在
 *   渲染进程的队列里堆积，表现为"UI 越来越卡直到假死"，而 main 侧毫无感知
 *   （它只是"发出去了"，从那一步起就不再关心）。
 *
 * 四个参数都不是拍脑袋定的：
 *
 * | 参数        | 值        | 理由                                  |
 * |-----------|----------|-------------------------------------|
 * | flush 间隔  | 16ms     | 对齐一帧，避免同一帧内多次 setState             |
 * | 搬运粒度      | 3 字符     | 模拟上游 token 粒度，让"逐字"这件事真的发生         |
 * | 队列上限      | 2000 字符  | 超限时**合并中间态**，而不是丢尾部                 |
 * | 暂停语义      | 一个都不推    | 这是"背压"和"降速"的区别 —— 后者只是在骗自己       |
 *
 * 为什么超限是"合并中间态"而不是"丢尾部"：
 *   丢尾部会让 UI 的内容缺一块，用户看不出少了什么，只觉得"这答案不对"；
 *   合并只是让中间的字跳过去，长度感和语义都还在。
 *   代价是答案可能不精确 —— 所以合并次数被计入 `Usage.mergedChunks`，
 *   **把一个会骗人的行为变成一个可观测的数字**。
 */

export interface BackpressureConfig {
  readonly produceIntervalMs: number;
  readonly produceChunkSize: number;
  readonly flushIntervalMs: number;
  readonly queueTextLimit: number;
  readonly keepHead: number;
  readonly keepTail: number;
}

export const BACKPRESSURE_DEFAULTS: BackpressureConfig = {
  produceIntervalMs: 12,
  produceChunkSize: 3,
  flushIntervalMs: 16,
  queueTextLimit: 2000,
  keepHead: 512,
  keepTail: 512,
};

export interface DrainingSummary {
  /** 因消费端跟不上而合并中间态的次数。正常恒为 0。 */
  readonly mergedChunks: number;
  /** 首 token 延迟；上游一个字都没产出时为 undefined */
  readonly ttftMs: number | undefined;
  /** 从上游接收到的总字符数（合并**不会**减少它） */
  readonly acceptedChars: number;
}

export interface BackpressureHooks {
  /**
   * 推出一帧的文本。合并了多块时也可能是一大段。
   * ⚠️ 暂停期间**不会被调用** —— 调用方可以据此确知"暂停时下行是零"。
   */
  flush(text: string): void;
  /**
   * 上游耗尽 **且** 队列已排空。保证只调用一次 ——
   * 这是"调用方一定能收到终结事件"的实现基础，否则 UI 会永远停在流式中。
   */
  drained(summary: DrainingSummary): void;
}

export class BackpressurePump {
  readonly #hooks: BackpressureHooks;
  readonly #deps: AgentDeps;
  readonly #cfg: BackpressureConfig;

  #incoming = '';
  #incomingCursor = 0;
  #upstreamClosed = false;
  #pending = '';

  #paused = false;
  #mergedChunks = 0;
  #acceptedChars = 0;
  #ttftMs: number | undefined;
  #startedAt = 0;

  #produceStop: Cancel | null = null;
  #flushStop: Cancel | null = null;
  #finished = false;

  constructor(
    hooks: BackpressureHooks,
    deps: AgentDeps,
    cfg: BackpressureConfig = BACKPRESSURE_DEFAULTS,
  ) {
    this.#hooks = hooks;
    this.#deps = deps;
    this.#cfg = cfg;
  }

  start(): void {
    this.#startedAt = this.#deps.now();
    this.#produceStop = this.#deps.every(this.#cfg.produceIntervalMs, () => {
      this.#produce();
    });
    this.#flushStop = this.#deps.every(this.#cfg.flushIntervalMs, () => {
      this.#flush();
    });
  }

  /**
   * 上游喂入一段文本。
   *
   * 刻意设计成**增量**接口：真实 LLM 的流式响应可以直接逐 token 喂进来，
   * 不必等全文就绪 —— 等全文再喂会把首 token 延迟拉到最差。
   */
  push(text: string): void {
    if (this.#finished || text.length === 0) return;
    this.#incoming += text;
    this.#acceptedChars += text.length;
  }

  /** 上游不再产字。泵会在队列排空后自行收尾。 */
  closeUpstream(): void {
    this.#upstreamClosed = true;
  }

  pause(): void {
    this.#paused = true;
  }

  resume(): void {
    this.#paused = false;
  }

  /**
   * 硬停：摘掉调度并清空队列。**不触发 drained** ——
   * 中断/关窗时调用方自己会发终结事件，这里再发一个是重复。
   */
  stop(): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#clearTimers();
    this.#pending = '';
    this.#incoming = '';
  }

  get paused(): boolean {
    return this.#paused;
  }

  get pendingLength(): number {
    return this.#pending.length;
  }

  get mergedChunks(): number {
    return this.#mergedChunks;
  }

  get ttftMs(): number | undefined {
    return this.#ttftMs;
  }

  get acceptedChars(): number {
    return this.#acceptedChars;
  }

  get finished(): boolean {
    return this.#finished;
  }

  #clearTimers(): void {
    if (this.#produceStop !== null) this.#produceStop();
    if (this.#flushStop !== null) this.#flushStop();
    this.#produceStop = null;
    this.#flushStop = null;
  }

  #produce(): void {
    if (this.#finished) return;

    if (this.#incomingCursor >= this.#incoming.length) {
      // 上游没字了。只有**队列也空了**才能收尾 —— 否则最后一段会被吞掉。
      if (this.#upstreamClosed && this.#pending === '') this.#finishDrained();
      return;
    }

    const next = this.#incoming.slice(
      this.#incomingCursor,
      this.#incomingCursor + this.#cfg.produceChunkSize,
    );
    // 🔴 游标必须按**实际取到的长度**推进，不能固定加 `produceChunkSize`。
    //
    // 上游是"来一段喂一段"，某一拍缓冲区里可能不足一块 —— 固定加会**跳过中间的字符**，
    // 而且是静默的：`acceptedChars` 照样报全量，界面上那段答案"看着完整、其实缺字"。
    // 实测：23 字符只吐出 15（`SELFCHECK-NAVIGATE-OK!!` → `SELFECK-VATE-!!`）。
    //
    // 为什么这个 bug 藏了很久：脚本上游 12ms 产 3 字、泵 12ms 取 3 字，节奏**等长**，
    // 缓冲区里永远恰好攒够一块；只有到达节奏不规则（真上游 / 假 SSE 上游）时才现形。
    this.#incomingCursor += next.length;
    this.#pending += next;

    if (this.#pending.length > this.#cfg.queueTextLimit) {
      this.#pending =
        this.#pending.slice(0, this.#cfg.keepHead) + this.#pending.slice(-this.#cfg.keepTail);
      this.#mergedChunks += 1;
    }
  }

  #flush(): void {
    if (this.#finished || this.#paused || this.#pending === '') return;
    if (this.#ttftMs === undefined) this.#ttftMs = this.#deps.now() - this.#startedAt;
    const text = this.#pending;
    this.#pending = '';
    this.#hooks.flush(text);
  }

  #finishDrained(): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#clearTimers();
    const summary: DrainingSummary = {
      mergedChunks: this.#mergedChunks,
      ttftMs: this.#ttftMs,
      acceptedChars: this.#acceptedChars,
    };
    this.#hooks.drained(summary);
  }
}
