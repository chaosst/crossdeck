/**
 * `ChatClient` —— 比 `ModelPort` 更低的一层 **IO 端口**。
 *
 * 只放类型：core 对 contract 也只做 `import type`，这个文件编译出来是空的。
 * 上提的判据是"第二次出现"：只有 Electron 一份时不提，Web 壳也出现且两端同形才提。
 */

import type { Cancel } from '../agent/deps.js';
import type { ModelSink } from '../agent/model.js';

/** 一次问答请求。`sessionId` 目前不发给 navigate（它只吃 `{question}`），保留是为了三端一致。 */
export interface ChatRequest {
  readonly sessionId: string;
  readonly prompt: string;
}

/** 各壳各写一份实现，**接口只有一份**。 */
export interface ChatClient {
  /** 同步返回取消函数；数据经 sink 回调推。 */
  streamChat(req: ChatRequest, sink: ModelSink): Cancel;
}
