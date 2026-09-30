import { IPC } from './ipc.js';
import type { DirEntry, FileStat, SessionMeta, SystemInfo } from './entities.js';
import type { WindowKind } from './capability.js';
import type { Workspace } from './workspace.js';

/**
 * 请求/响应类型映射 —— 类型安全 IPC 的核心。
 *
 * 设计要点：
 *   1. `req: void` 表示无参 channel（调用侧由 InvokeArgs 推导成空参数元组）。
 *   2. `res` 存**最终值**类型，不要写成 `Promise<...>` ——
 *      invoke 天然返回 Promise，由 helper 统一包装。写错会让调用侧多 await 一层。
 *   3. 单向推送通道（IPC.agentStream）**不在这里**，它不走 invoke，见 stream.ts。
 */
export interface IpcInvokeMap {
  [IPC.sessionCreate]: { req: { title?: string }; res: SessionMeta };
  [IPC.sessionList]: { req: void; res: SessionMeta[] };
  [IPC.sessionDelete]: { req: { sessionId: string }; res: void };

  [IPC.agentRun]: { req: { sessionId: string; input: string }; res: { runId: string } };
  [IPC.agentAbort]: { req: { runId: string }; res: void };

  [IPC.workspaceGrant]: { req: void; res: Workspace | null };
  [IPC.workspaceList]: { req: void; res: Workspace[] };
  [IPC.workspaceRevoke]: { req: { workspaceId: string }; res: void };

  [IPC.systemInfo]: { req: void; res: SystemInfo };
  [IPC.windowOpen]: { req: { kind: WindowKind; payload?: unknown }; res: { windowId: number } };
}

/** 走 invoke 的通道名（单向推送通道已被排除）。 */
export type InvokeChannel = keyof IpcInvokeMap;

/** 取某个通道的请求类型 / 响应类型，供窄场景使用。 */
export type Req<K extends InvokeChannel> = IpcInvokeMap[K]['req'];
export type Res<K extends InvokeChannel> = IpcInvokeMap[K]['res'];
