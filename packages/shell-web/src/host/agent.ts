/**
 * Agent 宿主 —— 页内主进程这一侧的 `agentRuntime.ts`。
 *
 * 与桌面壳的差别只在"投递"那一步：那边是 `webContents.send` 送到发起窗口，
 * 这里是往推送中心发（页面里只有一个窗口，不需要按窗口路由）。
 * 选上游的逻辑同形：每次开跑现取地址，脚本上游与真上游各是一条路。
 */

import {
  AgentRuntime,
  DEFAULT_FIRST_FRAME_TIMEOUT_MS,
  ScriptedModel,
} from '@crossdeck/core';
import type { AgentDeps, ModelPort, SessionRepository } from '@crossdeck/core';
import type { AgentStreamEvent, SessionChange } from '@crossdeck/contract';
import { createWebNavigateClient } from '../navigate/client.js';
import { WebNavigateModel } from '../navigate/model.js';
import { fail } from './errors.js';
import { WebRunWriter } from './runWriter.js';

export interface AgentHostOptions {
  readonly deps: AgentDeps;
  /** 当前上游根地址；`null` = 脚本上游，`''` = 同源。每次开跑现取。 */
  readonly baseUrl: () => string | null;
  readonly repo: () => Promise<SessionRepository>;
  readonly emit: (event: AgentStreamEvent) => void;
  readonly onSessionChanged: (change: SessionChange) => void;
}

export class AgentHost {
  readonly #options: AgentHostOptions;
  readonly #runtime: AgentRuntime;

  /** runId → 落库写入器 */
  readonly #writers = new Map<string, WebRunWriter>();
  /** 已建好、但还没拿到 runId 的写入器（`startRun` 同步发 start，会早于登记）。 */
  #pendingWriter: WebRunWriter | null = null;

  constructor(options: AgentHostOptions) {
    this.#options = options;

    const deps = options.deps;
    const scripted = new ScriptedModel({ deps });
    let cached: { url: string; model: ModelPort } | null = null;

    const navigateModelFor = (url: string): ModelPort => {
      if (cached?.url === url) return cached.model;
      const model = new WebNavigateModel({
        deps,
        client: createWebNavigateClient({
          baseUrl: url,
          firstFrameTimeoutMs: DEFAULT_FIRST_FRAME_TIMEOUT_MS,
          deps,
        }),
      });
      cached = { url, model };
      return model;
    };

    const model: ModelPort = {
      stream(req, sink) {
        const url = options.baseUrl();
        return url === null ? scripted.stream(req, sink) : navigateModelFor(url).stream(req, sink);
      },
    };

    this.#runtime = new AgentRuntime({ deps, model });
    this.#runtime.bus.subscribe((event) => {
      // 投递与落库互不影响：写失败不该让用户看不到已经收到的字。
      options.emit(event);
      this.#record(event);
    });
  }

  /** 开一次 run：先落两条消息（用户那句 + 助理占位），再启动。 */
  async run(sessionId: string, input: string): Promise<{ runId: string }> {
    const repo = await this.#options.repo();
    if ((await repo.getSession(sessionId)) === null) {
      fail('NOT_FOUND', `会话不存在：${sessionId}`);
    }

    await repo.insertMessage({ sessionId, role: 'user', content: input, status: 'done', runId: null });
    // 占位必须先写：流到一半被关掉，下次要靠它认出"上次异常退出"。
    const assistant = await repo.insertMessage({
      sessionId,
      role: 'assistant',
      content: '',
      status: 'streaming',
      runId: null,
    });

    const writer = new WebRunWriter({
      repo,
      sessionId,
      messageId: assistant.messageId,
      now: this.#options.deps.now,
      every: this.#options.deps.every,
      newId: this.#options.deps.newId,
      onTerminal: () => this.#options.onSessionChanged({ sessionId, reason: 'updated' }),
    });

    this.#pendingWriter = writer;
    const { runId } = this.#runtime.startRun({ sessionId, input });
    writer.runId = runId;
    // 首个事件（start）已经在 startRun 里同步发出并认领了 writer，这里只补齐映射。
    this.#writers.set(runId, writer);
    this.#pendingWriter = null;

    return { runId };
  }

  /** @returns false = run 不存在或已结束，调用方要当 NOT_FOUND 抛。 */
  control(runId: string, type: 'pause' | 'resume'): boolean {
    return this.#runtime.pauseOrResume(runId, type);
  }

  abort(runId: string): boolean {
    return this.#runtime.abort(runId);
  }

  stopAll(): void {
    this.#runtime.stopAll();
    for (const writer of this.#writers.values()) writer.stop();
    this.#writers.clear();
    this.#pendingWriter = null;
  }

  get activeRunCount(): number {
    return this.#runtime.activeRunCount;
  }

  #record(event: AgentStreamEvent): void {
    const writer = this.#writerFor(event.runId);
    if (writer === null) return;
    writer.push(event);
    if (event.type === 'done' || event.type === 'error') {
      this.#writers.delete(event.runId);
      writer.stop();
    }
  }

  #writerFor(runId: string): WebRunWriter | null {
    const known = this.#writers.get(runId);
    if (known !== undefined) return known;
    const pending = this.#pendingWriter;
    if (pending === null) return null;
    // 首个事件到达时就认领：`start` 是在 startRun 里同步发出的，早于 writers.set。
    pending.runId = runId;
    this.#writers.set(runId, pending);
    this.#pendingWriter = null;
    return pending;
  }
}
