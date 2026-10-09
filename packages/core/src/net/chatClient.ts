/**
 * `ChatClient` —— 比 `ModelPort` 更低的一层 **IO 端口**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么它现在才进 core（判据是"第二次出现"，不是"怕重复"）
 * ══════════════════════════════════════════════════════════════════
 * T7 只在 Electron 壳里定义了它。那时它只出现一次 —— 只出现一次的抽象
 * 就是把"还没想清楚的边界"固化下来（`errorMessage` 那次是同一条准则的正面例子：
 * 散落 15+ 处之后才抽）。
 *
 * T8 的 Web 壳也要一份 → **第二次出现**，且两端**同形**（都是
 * `streamChat(req, sink) → Cancel`）。这时上提，接口只有一份，实现各端一份。
 * 名字逐字不变，只是换个文件放。
 *
 * ⚠️ 只放**类型**：core 对 contract 也只做 `import type`、零运行时依赖，
 *    这个文件编译出来的 JS 是空的（`export {}`），不增加任何运行时负担。
 */

import type { Cancel } from '../agent/deps.js';
import type { ModelSink } from '../agent/model.js';

/** 一次问答请求。`sessionId` 目前不发给 navigate（它只吃 `{question}`），
 *  保留是为了三端接口一致 —— T10 接会话恢复时才会用到。 */
export interface ChatRequest {
  readonly sessionId: string;
  readonly prompt: string;
}

/** 各壳各写一份实现（Electron 走 node fetch、Web 走浏览器 fetch + cookie、
 *  鸿蒙走 `@ohos.net.http`），**接口只有一份**。 */
export interface ChatClient {
  /** 同步返回取消函数；数据经 sink 回调推。 */
  streamChat(req: ChatRequest, sink: ModelSink): Cancel;
}
