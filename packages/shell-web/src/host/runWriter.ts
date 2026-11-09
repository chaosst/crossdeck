/**
 * 一次 run 的落库写入器 —— Web 壳这一份。
 *
 * 与桌面壳的差别**只有一处，但很关键**：这里的仓储是异步的（IndexedDB），
 * 而 `WriteScheduler` 的 `write` 是同步回调。所以节流器只负责"什么时候该写"，
 * 真正的写动作排进一条串行队列：
 *
 *   队列一旦并发，两个 flush 会交错 —— 后一个带着全量正文，前一个带着更早的全量正文，
 *   落地顺序反了就把正文写回旧版本（看起来像"打字打丢了"）。
 *
 * 判定逻辑（events 装配 / 终态幂等）仍在 core：`foldStreamEvent` 一行没改。
 */

import { WriteScheduler, createDraft, foldStreamEvent, isTerminalStatus } from '@crossdeck/core';
import type { FlushMessageInput, MessageDraft, Schedule, SessionRepository } from '@crossdeck/core';
import type { AgentStreamEvent, SessionEvent } from '@crossdeck/contract';

export interface WebRunWriterOptions {
  readonly repo: SessionRepository;
  readonly sessionId: string;
  readonly messageId: string;
  readonly now: () => number;
  readonly every: Schedule;
  readonly newId: (prefix: string) => string;
  /** 终态那一次真的落盘之后调用（广播 `session:changed`）。 */
  readonly onTerminal: () => void;
}

export class WebRunWriter {
  readonly sessionId: string;
  readonly messageId: string;
  /** run id 在 `startRun` 返回后才拿得到，之前为 null。 */
  runId: string | null = null;

  readonly #options: WebRunWriterOptions;
  readonly #scheduler: WriteScheduler;

  #draft: MessageDraft = createDraft();
  #pending: SessionEvent[] = [];
  #queue: Promise<void> = Promise.resolve();
  #closed = false;
  #terminalNotified = false;

  constructor(options: WebRunWriterOptions) {
    this.sessionId = options.sessionId;
    this.messageId = options.messageId;
    this.#options = options;
    this.#scheduler = new WriteScheduler({
      now: options.now,
      every: options.every,
      write: () => this.#enqueue(),
    });
  }

  push(event: AgentStreamEvent): void {
    if (this.#closed) return;

    const chars = event.type === 'token' ? event.text.length : 0;
    const result = foldStreamEvent(this.#draft, event, {
      messageId: this.messageId,
      newId: this.#options.newId,
      now: this.#options.now,
    });
    this.#draft = result.draft;
    if (result.append !== null) this.#pending.push(result.append);

    this.#scheduler.mark(chars, result.terminal);
  }

  /** 收尾：把残留写完，再停掉周期调度。 */
  stop(): void {
    if (this.#closed) return;
    this.#scheduler.stop();
    this.#closed = true;
  }

  /** 等已排队的落盘全部完成 —— 切库 / 读回历史之前必须等它，否则读到半截。 */
  async settled(): Promise<void> {
    await this.#queue;
  }

  #enqueue(): void {
    const events = this.#pending;
    this.#pending = [];
    const terminal = isTerminalStatus(this.#draft.status);

    const payload: FlushMessageInput = {
      messageId: this.messageId,
      content: this.#draft.content,
      status: this.#draft.status,
      usage: this.#draft.usage,
      error: this.#draft.error,
      events,
      terminal,
      runId: this.runId,
    };

    this.#queue = this.#queue.then(async () => {
      try {
        await this.#options.repo.flushMessage(payload);
      } catch (err) {
        // 写失败不许把事件丢掉：放回队列，下一次 flush 还会带上。
        this.#pending = events.concat(this.#pending);
        console.error(`[session] 落盘失败（${this.messageId}）：`, err);
        return;
      }
      if (terminal && !this.#terminalNotified) {
        this.#terminalNotified = true;
        this.#options.onTerminal();
      }
    });
  }
}
