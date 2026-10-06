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

  // ── 文件系统（全部经 scope 校验，不接受绝对路径直通）────────
  fsListDir: 'fs:list-dir',
  fsReadFile: 'fs:read-file',
  fsWriteFile: 'fs:write-file',
  fsStat: 'fs:stat',
  /**
   * 单向推送（main → renderer），**不**走 invoke，故不进入 IpcInvokeMap。
   *
   * ⚠️ 状态：**已声明、未接线**。`FsPort.watch` 已有 Electron 实现，
   *    但还没有任何地方往这条通道推事件，preload 也没暴露订阅入口。
   *    刻意保留是因为它记录了下一条推送通道的形状；
   *    `registeredChannels()` 取的是真实注册表，所以它不会被算进「已注册通道数」。
   *    接线（或删除）留到 M4.5 与 fs 事件流一起做。
   */
  fsWatch: 'fs:watch',

  // ── Agent 流控（背压，走 invoke 才有 ack 语义）─────────────
  agentControl: 'agent:control',

  // ── 自动更新 ────────────────────────────────────────────
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  /** 重启并安装。这是唯一"调用后进程会消失"的通道，调用侧不要 await 它再做事。 */
  updateInstall: 'update:install',
  /**
   * 单向推送（main → renderer），**不**走 invoke。
   *
   * 进度必须推：否则下载几十兆的这段时间里，用户面对的只是一个点了没反应的按钮。
   * 载荷见 update.ts 的 `UpdateStatus`。
   */
  updateStatus: 'update:status',
} as const;

/** 全部通道名的联合类型。 */
export type IpcChannel = (typeof IPC)[keyof typeof IPC];
