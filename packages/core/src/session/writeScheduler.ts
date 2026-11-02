/** 周期调度的形状。与 `AgentDeps.every` 同形，但不引上层模块。 */
export type Schedule = (intervalMs: number, fn: () => void) => () => void;

/** 这次落盘由谁触发，用于诊断与断言。 */
export type FlushReason = 'interval' | 'chars' | 'terminal' | 'manual' | 'stop';

export interface WriteSchedulerOptions {
  readonly now: () => number;
  readonly every: Schedule;
  /** 静默多久必须落盘一次。默认 200ms。 */
  readonly intervalMs?: number;
  /** 未落盘字符达到多少就必须落盘。默认 512。 */
  readonly maxPendingChars?: number;
  /** 真正的写动作，由仓储注入。 */
  readonly write: (reason: FlushReason) => void;
}

export interface SchedulerStats {
  readonly writes: number;
  readonly pendingChars: number;
  readonly dropped: number;
}

const DEFAULT_INTERVAL_MS = 200;
const DEFAULT_MAX_PENDING_CHARS = 512;

/** 流式写入的节流器：时间优先、字符兜底。 */
export class WriteScheduler {
  readonly #now: () => number;
  readonly #intervalMs: number;
  readonly #maxPendingChars: number;
  readonly #write: (reason: FlushReason) => void;
  readonly #stopTick: () => void;

  #pendingChars = 0;
  #lastWriteAt: number;
  #dirty = false;
  #writes = 0;
  #dropped = 0;
  #closed = false;

  constructor(opts: WriteSchedulerOptions) {
    const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    const maxPendingChars = opts.maxPendingChars ?? DEFAULT_MAX_PENDING_CHARS;
    if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
      throw new Error(`intervalMs 必须是正整数：${intervalMs}`);
    }
    if (!Number.isInteger(maxPendingChars) || maxPendingChars <= 0) {
      throw new Error(`maxPendingChars 必须是正整数：${maxPendingChars}`);
    }

    this.#now = opts.now;
    this.#intervalMs = intervalMs;
    this.#maxPendingChars = maxPendingChars;
    this.#write = opts.write;
    this.#lastWriteAt = opts.now();
    this.#stopTick = opts.every(intervalMs, () => this.#tick());
  }

  /** 记一次增量。`terminal` 表示这一轮已到终态，必须立刻落盘。 */
  mark(chars: number, terminal: boolean): void {
    if (this.#closed) {
      this.#dropped += 1;
      return;
    }
    if (!Number.isInteger(chars) || chars < 0) {
      throw new Error(`增量字符数必须是非负整数：${chars}`);
    }

    this.#pendingChars += chars;
    // 零增量且非终态 ⇒ 什么都没变，不标脏（否则 stop 会多写一次空记录）
    if (chars > 0 || terminal) this.#dirty = true;

    if (terminal) {
      this.flush('terminal');
      return;
    }
    if (this.#pendingChars >= this.#maxPendingChars) {
      this.flush('chars');
      return;
    }
    // 时间优先：静默够久就把第一个增量立刻写出去，不等下一个周期
    if (this.#now() - this.#lastWriteAt >= this.#intervalMs) {
      this.flush('interval');
    }
  }

  /** 立刻落盘。没有未写内容时返回 false —— 重复调用不会产生空写。 */
  flush(reason: FlushReason = 'manual'): boolean {
    if (!this.#dirty) return false;
    this.#write(reason);
    this.#dirty = false;
    this.#pendingChars = 0;
    this.#lastWriteAt = this.#now();
    this.#writes += 1;
    return true;
  }

  /** 关窗 / 退出：把残留写出去再停掉周期调度。之后 mark 只计数不再写。 */
  stop(): void {
    if (this.#closed) return;
    try {
      this.flush('stop');
    } finally {
      this.#closed = true;
      this.#stopTick();
    }
  }

  get stats(): SchedulerStats {
    return { writes: this.#writes, pendingChars: this.#pendingChars, dropped: this.#dropped };
  }

  #tick(): void {
    if (this.#closed || !this.#dirty) return;
    if (this.#now() - this.#lastWriteAt >= this.#intervalMs) this.flush('interval');
  }
}
