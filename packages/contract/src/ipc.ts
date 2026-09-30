/**
 * IPC 通道名单 —— 全局唯一事实源。
 *
 * 三处（main / preload / renderer）都从这里取通道名。
 * 任何一处写错字符串字面量都会在编译期报错，而不是运行时静默失败。
 */

export const IPC = {
  // ── 会话 ────────────────────────────────────────────────
  sessionCreate: 'session:create',
  sessionList: 'session:list',
  sessionDelete: 'session:delete',

  // ── Agent 运行 ──────────────────────────────────────────
  agentRun: 'agent:run',
  agentAbort: 'agent:abort',
  /** 单向推送通道（main → renderer），**不**走 invoke，故不进入 IpcInvokeMap */
  agentStream: 'agent:stream',

  // ── 工作区授权 ──────────────────────────────────────────
  workspaceGrant: 'workspace:grant',
  workspaceList: 'workspace:list',
  workspaceRevoke: 'workspace:revoke',

  // ── 系统 ────────────────────────────────────────────────
  systemInfo: 'system:info',
  windowOpen: 'window:open',
} as const;

/** 全部通道名的联合类型。 */
export type IpcChannel = (typeof IPC)[keyof typeof IPC];
