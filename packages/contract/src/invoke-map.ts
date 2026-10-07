import { IPC } from './ipc.js';
import type { DirEntry, FileStat, SessionMeta, SystemInfo } from './entities.js';
import type { WindowKind } from './capability.js';
import type { UpdateInfo } from './update.js';
import type { PerfSampleInput, PerfSnapshot } from './perf.js';
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

  [IPC.fsListDir]: { req: { workspaceId: string; path: string }; res: DirEntry[] };
  [IPC.fsReadFile]: { req: { workspaceId: string; path: string }; res: { text: string; truncated: boolean } };
  [IPC.fsWriteFile]: { req: { workspaceId: string; path: string; data: string }; res: void };
  [IPC.fsStat]: { req: { workspaceId: string; path: string }; res: FileStat };
  [IPC.agentControl]: { req: { runId: string; type: 'pause' | 'resume' }; res: void };

  /**
   * 检查更新。**已是最新返回 null** —— 空结果的语义就是"没有可装的新版本"。
   *
   * 检查失败（feed 不可达 / feed 给了畸形版本号）走抛错，
   * 与"查到了、只是没有新版"分成两条路 —— 前者要提示用户，后者不该提示。
   */
  [IPC.updateCheck]: { req: void; res: UpdateInfo | null };
  /** 开始下载。真正的进度经 updateStatus 推送，这里只回"已受理"。 */
  [IPC.updateDownload]: { req: void; res: void };
  [IPC.updateInstall]: { req: void; res: void };

  /**
   * 性能采样。**注意 req 不是 void** —— 渲染层要在首帧/流式结束时
   * 把只有它测得到的数字带上来（见 perf.ts 里关于"帧率只能在渲染层测"的注释）。
   * 调用侧只读快照时传 `{}` 即可。
   */
  [IPC.perfSample]: { req: PerfSampleInput; res: PerfSnapshot };
}

/** 走 invoke 的通道名（单向推送通道已被排除）。 */
export type InvokeChannel = keyof IpcInvokeMap;

/** 取某个通道的请求类型 / 响应类型，供窄场景使用。 */
export type Req<K extends InvokeChannel> = IpcInvokeMap[K]['req'];
export type Res<K extends InvokeChannel> = IpcInvokeMap[K]['res'];
