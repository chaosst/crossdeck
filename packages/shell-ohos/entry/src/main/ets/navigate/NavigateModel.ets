import type { AgentDeps, Cancel, ChatClient, ModelPort, ModelRequest, ModelSink } from '../shared/core/index';

export interface NavigateModelOptions {
  readonly client: ChatClient;
  /** 与 Electron / Web 两端保持签名同形；这一层不需要时钟，刻意不使用。 */
  readonly deps: AgentDeps;
}

export class OhosNavigateModel implements ModelPort {
  private readonly client: ChatClient;

  constructor(opts: NavigateModelOptions) {
    this.client = opts.client;
  }

  stream(req: ModelRequest, sink: ModelSink): Cancel {
    return this.client.streamChat({ sessionId: req.sessionId, prompt: req.prompt }, sink);
  }
}
