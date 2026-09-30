/**
 * 工作区授权模型 —— 整个项目的安全地基。
 *
 * Agent 要读用户的本地项目目录，就必须有 scope 模型，
 * 否则它就是一个「任意文件读取器」。
 */

export type WorkspaceMode = 'read' | 'readwrite';

export interface Workspace {
  id: string;
  /** 用户授权时的绝对路径（桌面端）/ 句柄 id（Web 端） */
  root: string;
  label: string;
  grantedAt: number;
  /** 只读 or 可写；默认只读 */
  mode: WorkspaceMode;
}

/** 拒绝原因，写成字面量联合便于遥测与 UI 提示。 */
export type PathDenyReason =
  | 'NO_WORKSPACE'
  | 'BAD_PATH'
  | 'OUT_OF_SCOPE'
  | 'ESCAPE_ATTEMPT';

export type PathDecision =
  | { allowed: true; resolved: string; workspaceId: string }
  | { allowed: false; reason: PathDenyReason };

/**
 * 路径校验：必须在某个已授权 workspace 的 root 之下，且解析后无 symlink 逃逸。
 *
 * ⚠️ 实现放在 core（平台无关算法），这里只留契约。
 *    core 内**不得** import `node:path` —— Web 壳没有它。
 *    归一化用自写的 POSIX 风格算法（统一 `/` 分隔 + 显式 `..` 解析），
 *    Windows 的 `\` 在边界处（各壳的 Port 实现里）转换。
 */
export interface PathGuard {
  /**
   * @param target  待校验路径（绝对路径，或相对 workspace root 的路径）
   * @param opts.realpath  注入的真实路径解析器（用于解 symlink）。
   *                       由各壳的 FsPort 提供 —— core 自己碰不到文件系统。
   */
  check(
    target: string,
    opts: { realpath?: (p: string) => Promise<string | null> },
  ): Promise<PathDecision>;
}
