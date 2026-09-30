import type { IpcInvokeMap, InvokeChannel } from './invoke-map.js';
import type { AgentStreamEvent } from './stream.js';

/**
 * handler 上下文 —— main 侧每个 handler 都能拿到。
 * isAborted 让长耗时的流式 handler 有机会在中途退出（配合 agentAbort）。
 */
export interface HandlerCtx {
  readonly senderWindowId: number;
  isAborted(runId: string): boolean;
}

/** main 侧 handler 签名：入参/出参由 IpcInvokeMap 自动推导。 */
export type InvokeHandler<K extends InvokeChannel> = (
  req: IpcInvokeMap[K]['req'],
  ctx: HandlerCtx,
) => Promise<IpcInvokeMap[K]['res']>;

/**
 * 由 req 类型推导调用侧参数元组。
 *   req: void        → []
 *   req: { ... }     → [req: { ... }]
 *
 * 这样 `invoke(IPC.sessionList)` 可以省略实参，
 * 而 `invoke(IPC.agentRun)` 少传 req 会直接编译报错。
 * 这是 TS 类型体操在本项目里最实用的一个落点。
 */
export type InvokeArgs<K extends InvokeChannel> =
  IpcInvokeMap[K]['req'] extends void ? [] : [req: IpcInvokeMap[K]['req']];

/**
 * preload 通过 contextBridge 暴露给 renderer 的 API 面。
 * renderer 侧 `window.bridge` 就是这个类型。
 *
 * 注意：这里是**纯类型**。真正的 contextBridge.exposeInMainWorld 调用
 * 必须写在 preload 里（那里才能 import electron）。
 */
export interface BridgeApi {
  invoke<K extends InvokeChannel>(
    channel: K,
    ...args: InvokeArgs<K>
  ): Promise<IpcInvokeMap[K]['res']>;

  /** 订阅流式事件，返回取消订阅函数 */
  onStream(handler: (event: AgentStreamEvent) => void): () => void;
}
