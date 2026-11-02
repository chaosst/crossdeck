/**
 * 一次 run 落库的写入器：事件 → 装配器 → 节流调度器 → 仓储。
 *
 * 判定逻辑全在 core（`foldStreamEvent` / `WriteScheduler`），这里只做三件 IO：
 * 装配器要的 id 与时钟、落盘、以及终态后通知窗口。
 */

import { createDraft, foldStreamEvent, isTerminalStatus } from '@crossdeck/core';
import type { MessageDraft } from '@crossdeck/core';
import { WriteScheduler } from '@crossdeck/core';
import type { AgentStreamEvent, SessionEvent } from '@crossdeck/contract';
import type { SessionRepo } from './sessionDb/repo.js';
import { broadcastSessionChange } from './sessionEvents.js';

export interface RunWriterOptions {
  readonly repo: SessionRepo;
  readonly sessionId: string;
  readonly messageId: string;
  readonly now: () => number;
  readonly every: (intervalMs: number, fn: () => void) => () => void;
  readonly newId: (prefix: string) => string;
}

export class RunWriter {
  readonly sessionId: string;
  readonly messageId: string;
  /** run id 在 `runtime.startRun` 返回后才拿得到，之前为 null。 */
  runId: string | null = null;

  readonly #repo: SessionRepo;
  readonly #now: () => number;
  readonly #newId: (prefix: string) => string;
  readonly #scheduler: WriteScheduler;

  #draft: MessageDraft = createDraft();
  #pending: SessionEvent[] = [];
  #closed = false;
  /** 最近一次落盘是否已经因为终态广播过。 */
  #terminalWritten = false;

  constructor(opts: RunWriterOptions) {
    this.sessionId = opts.sessionId;
    this.messageId = opts.messageId;
    this.#repo = opts.repo;
    this.#now = opts.now;
    this.#newId = opts.newId;

    this.#scheduler = new WriteScheduler({
      now: opts.now,
      every: opts.every,
      write: () => this.#flush(),
    });
  }

  /** 喂一个流事件。装配器决定要不要落事件、是否已到终态。 */
  push(event: AgentStreamEvent): void {
    if (this.#closed) return;

    const chars = event.type === 'token' ? event.text.length : 0;
    const result = foldStreamEvent(this.#draft, event, {
      messageId: this.messageId,
      newId: this.#newId,
      now: this.#now,
    });
    this.#draft = result.draft;
    if (result.append !== null) this.#pending.push(result.append);

    this.#scheduler.mark(chars, result.terminal);
  }

  /** 关窗 / 退出：把残留写完再停掉周期调度。 */
  stop(): void {
    if (this.#closed) return;
    this.#scheduler.stop();
    this.#closed = true;
  }

  get writtenBytes(): number {
    return this.#draft.content.length;
  }

  #flush(): void {
    const events = this.#pending;
    this.#pending = [];
    const terminal = isTerminalStatus(this.#draft.status);

    try {
      this.#repo.flushMessage({
        messageId: this.messageId,
        content: this.#draft.content,
        status: this.#draft.status,
        usage: this.#draft.usage,
        error: this.#draft.error,
        events,
        terminal,
        runId: this.runId,
      });
    } catch (err) {
      // 写失败不许把事件丢掉：放回队列，下一次 flush 还会带上它们。
      this.#pending = events.concat(this.#pending);
      console.error(`[session] 落盘失败（${this.messageId}）：`, err);
      return;
    }

    if (terminal && !this.#terminalWritten) {
      this.#terminalWritten = true;
      broadcastSessionChange({ sessionId: this.sessionId, reason: 'updated' });
    }
  }
}
