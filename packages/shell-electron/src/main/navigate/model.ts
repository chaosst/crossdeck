/**
 * `ModelPort` 端口适配 —— core 只认 `ModelPort`，不认 HTTP。
 *
 * 这一层**只做格式转换，零 IO**：请求形状从 `ModelRequest` 翻成 `ChatRequest`，
 * 然后把回调原样转下去。刻意保持"薄"是有理由的 ——
 * 一旦这里也开始读时钟 / 起定时器 / 管连接，就会出现**两个**上下文，
 * 而"哪一层负责收尾"会立刻变成说不清的问题（T6-a/T6-b 的教训都在这上面）。
 */

import type { AgentDeps, Cancel, ChatClient, ModelPort, ModelRequest, ModelSink } from '@crossdeck/core';

export interface NavigateModelOptions {
  readonly client: ChatClient;
  /**
   * 保留这个参数是为了与 T8 的 Web 壳**签名同形**。
   *
   * 它**刻意不被使用**：这一层不需要时钟，也不需要调度。
   * 删掉它会省一行，但会让两端签名不同 —— 而"同形"正是 T8 上提接口的判据本身。
   */
  readonly deps: AgentDeps;
}

export class NavigateModel implements ModelPort {
  readonly #client: ChatClient;

  constructor(opts: NavigateModelOptions) {
    this.#client = opts.client;
  }

  stream(req: ModelRequest, sink: ModelSink): Cancel {
    // `sessionId` 目前**不发给上游**：`/api/resume/chat` 只吃 `{ question }`（T3 实测）。
    // 保留在 `ChatRequest` 里是为了两端接口一致，T10 接会话恢复时才会用到。
    return this.#client.streamChat({ sessionId: req.sessionId, prompt: req.prompt }, sink);
  }
}
