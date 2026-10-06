import { IPC } from './ipc.js';
import type { AgentStreamEvent } from './stream.js';
import type { UpdateStatus } from './update.js';

/**
 * 单向推送通道的载荷映射 —— 与 `IpcInvokeMap` 对称的那一半。
 *
 * 为什么要有这张表（而不是给每条推送通道各写一个 `onXxx()`）：
 *   invoke 侧早就有了唯一事实源，推送侧一直是散的 ——
 *   `onStream` 把 `IPC.agentStream` 硬编码在 preload 里，
 *   于是"这条通道是不是推送通道"这件事**只能靠读代码知道**。
 *   加上第二条推送通道（更新进度）时，这个缺口就到了非补不可的关口：
 *   再写一个 `onUpdateStatus`，第三条就会叫 `onSomethingElse`，
 *   而 preload 的白名单会从"两个方法"长成一张没人维护的清单。
 *
 * 有了这张表：
 *   · 推送通道名与载荷类型同处一地，写错 = 编译错误
 *   · preload 只需一个泛型 `on(channel, handler)`，白名单长度恒为 1
 *   · 任何进入这里的通道，**必然**不在 IpcInvokeMap 里（交叉查重见 verify:ipc）
 */
export interface IpcPushMap {
  [IPC.agentStream]: AgentStreamEvent;
  [IPC.updateStatus]: UpdateStatus;
}

/** 走推送的通道名（与 InvokeChannel 互斥）。 */
export type PushChannel = keyof IpcPushMap;

/** 取某条推送通道的载荷类型。 */
export type PushPayload<K extends PushChannel> = IpcPushMap[K];
