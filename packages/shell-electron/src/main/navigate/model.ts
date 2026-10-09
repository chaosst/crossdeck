/**
 * `ModelPort` 端口适配 —— core 只认 `ModelPort`，不认 HTTP。
 *
 * 只做格式转换，零 IO：一旦这里也开始读时钟 / 起定时器 / 管连接，就会出现两个上下文，
 * "哪一层负责收尾"立刻说不清（core 分层收拢终态归口时踩过的坑）。
 */

import type { AgentDeps, Cancel, ChatClient, ModelPort, ModelRequest, ModelSink } from '@crossdeck/core';

export interface NavigateModelOptions {
  readonly client: ChatClient;
  /** 与 Web 壳保持签名同形；这一层无时钟、无调度，刻意不使用。 */
  readonly deps: AgentDeps;
}

export class NavigateModel implements ModelPort {
  readonly #client: ChatClient;

  constructor(opts: NavigateModelOptions) {
    this.#client = opts.client;
  }

  stream(req: ModelRequest, sink: ModelSink): Cancel {
    // `sessionId` 不发给上游（`/api/resume/chat` 只吃 `{ question }`），保留是为了三端一致。
    return this.#client.streamChat({ sessionId: req.sessionId, prompt: req.prompt }, sink);
  }
}
