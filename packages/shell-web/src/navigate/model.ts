/**
 * `ModelPort` 端口适配 —— Web 壳这一份。
 *
 * 只做格式转换，零 IO：一旦这里也开始读时钟 / 起定时器 / 管连接，就会出现两个上下文，
 * "哪一层负责收尾"立刻说不清（core 分层收拢终态归口时踩过的坑）。
 * 签名与 Electron 壳同形 —— 这正是把 `ChatClient` 上提进 core 的判据。
 */

import type { AgentDeps, Cancel, ChatClient, ModelPort, ModelRequest, ModelSink } from '@crossdeck/core';

export interface WebNavigateModelOptions {
  readonly client: ChatClient;
  /** 与 Electron 壳保持签名同形；这一层无时钟、无调度，刻意不使用。 */
  readonly deps: AgentDeps;
}

export class WebNavigateModel implements ModelPort {
  readonly #client: ChatClient;

  constructor(opts: WebNavigateModelOptions) {
    this.#client = opts.client;
  }

  stream(req: ModelRequest, sink: ModelSink): Cancel {
    return this.#client.streamChat({ sessionId: req.sessionId, prompt: req.prompt }, sink);
  }
}
