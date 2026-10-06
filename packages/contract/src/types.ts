import type { IpcInvokeMap, InvokeChannel } from './invoke-map.js';
import type { PushChannel, PushPayload } from './push-map.js';

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
 *
 * 暴露面刻意只有两个方法 —— invoke 与 on。宁可泛型化，也不随通道数量增长：
 * 每多一个 `onXxx()` 都要多一条 preload 白名单，而白名单是越短越安全的东西。
 */
export interface BridgeApi {
  invoke<K extends InvokeChannel>(
    channel: K,
    ...args: InvokeArgs<K>
  ): Promise<IpcInvokeMap[K]['res']>;

  /**
   * 订阅某条推送通道，返回**取消订阅函数**。
   *
   * 不返回取消函数是流式 UI 最典型的泄漏形态：React 组件每次挂载都会多留一个
   * 监听器，表现为「同一条流被渲染 N 次」，而组件已经卸载了。
   * 所以这里把"必须能退订"写进签名，而不是写进注释。
   */
  on<K extends PushChannel>(
    channel: K,
    handler: (payload: PushPayload<K>) => void,
  ): () => void;
}
