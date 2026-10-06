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

/** 拒绝原因的常量表 —— 让「校验 detail」这类用法不必手抄字符串。 */
export const PATH_DENY_REASONS: readonly PathDenyReason[] = [
  'NO_WORKSPACE',
  'BAD_PATH',
  'OUT_OF_SCOPE',
  'ESCAPE_ATTEMPT',
];

/** 收窄守卫。跨进程解出来的 detail 是 string，必须先过这里再当枚举用。 */
export function isPathDenyReason(value: unknown): value is PathDenyReason {
  return typeof value === 'string' && (PATH_DENY_REASONS as readonly string[]).includes(value);
}

/**
 * 面向用户的解释文案 —— 放在契约层是因为**每一端都要说同一句话**。
 * 各壳自己抄一份的结果是同一件事在不同端有不同说法，排查时对不上号。
 */
export const PATH_DENY_MESSAGES: Record<PathDenyReason, string> = {
  NO_WORKSPACE: '还没有授权任何工作区 —— 先在上方授权一个目录',
  BAD_PATH: '路径不合法（盘符相对形式 / 解析后越出根 / 无法解析）',
  OUT_OF_SCOPE: '目标路径不在已授权的工作区之内',
  ESCAPE_ATTEMPT: '路径经符号链接解析后逃出了授权范围',
};

/** 路径校验的可选项。 */
export interface PathCheckOptions {
  /**
   * 注入的真实路径解析器（用于解 symlink）。
   * 缺省时用构造 PathGuard 时注入的那个；两者都没有则跳过 symlink 校验。
   */
  realpath?: (p: string) => Promise<string | null>;
  /**
   * 限定只允许落在该工作区内。
   * ⚠️ 不传时的语义是「任一已授权工作区即可」—— 文件系统通道**必须**传，
   *    否则 A 工作区里的 `../` 恰好落进同样已授权的 B 工作区时会被放行。
   */
  withinWorkspaceId?: string;
}

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
   * @param target 待校验路径。
   *   ⚠️ **必须是绝对路径** —— 相对路径无从判断归属哪个工作区，一律 BAD_PATH。
   *      调用方（各壳的 FsPort）先用 `joinPosixPath(workspace.root, rel)` 拼成绝对路径。
   * @returns 放行时 `resolved` 是**归一化后的逻辑绝对路径**（不是 realpath）。
   *  刻意不回写 realpath：`lstat` 还要靠它把 symlink 如实报成 `kind: 'symlink'`，
   *  换成 realpath 之后就永远看不到链接本身了。逃逸判定用 realpath 单独做。
   */
  check(target: string, opts?: PathCheckOptions): Promise<PathDecision>;
}
