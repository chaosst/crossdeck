/**
 * `ModelPort` 端口适配 —— Web 壳这一份。
 *
 * 与 Electron 壳的 `navigate/model.ts` **签名同形**，这是刻意的：
 * 「两端同形」正是把 `ChatClient` 上提进 core 的判据本身（T8）。
 *
 * 这一层**只做格式转换，零 IO** —— 一旦这里也开始读时钟 / 起定时器 / 管连接，
 * 就会出现**两个**上下文，"哪一层负责收尾"立刻变成说不清的问题
 * （T6-a / T6-b 的教训都在这上面）。
 *
 * `deps` 刻意不被使用：这一层不需要时钟，也不需要调度。删掉能省一行，
 * 但会让两端签名不同 —— 而"同形"是接口上提的依据。
 */

import type { AgentDeps, Cancel, ChatClient, ModelPort, ModelRequest, ModelSink } from '@crossdeck/core';

export interface WebNavigateModelOptions {
  readonly client: ChatClient;
  /** 保留以与 Electron 壳签名同形；**刻意不使用**（本层无时钟、无调度）。 */
  readonly deps: AgentDeps;
}

export class WebNavigateModel implements ModelPort {
  readonly #client: ChatClient;

  constructor(opts: WebNavigateModelOptions) {
    this.#client = opts.client;
  }

  stream(req: ModelRequest, sink: ModelSink): Cancel {
    // `sessionId` 目前**不发给上游**：`/api/resume/chat` 只吃 `{ question }`（T3 实测）。
    // 保留在 `ChatRequest` 里是为了三端接口一致，T10 接会话恢复时才会用到。
    return this.#client.streamChat({ sessionId: req.sessionId, prompt: req.prompt }, sink);
  }
}
