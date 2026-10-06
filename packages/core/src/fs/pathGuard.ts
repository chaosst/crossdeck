import type { PathCheckOptions, PathDecision, PathGuard, Workspace } from '@crossdeck/contract';
import { isAbsolutePath, isWithinPath, normalizePath, parentPath } from './posixPath.js';

/**
 * PathGuard —— 整个项目安全性的地基。
 *
 * Agent 要读用户的本地项目目录，就必须有 scope 模型，否则它就是一个
 * 「任意文件读取器」。这段逻辑放在 core（平台无关算法），实现上不碰任何文件系统：
 * 需要真实路径时由各壳把 `realpath` **注入**进来。
 *
 * ⚠️ core 内不得 import `node:path` —— Web 壳没有它。
 *    归一化统一走 posixPath.ts，`\` 的转换在边界处发生。
 */

export interface PathGuardDeps {
  /**
   * 注入的真实路径解析器（各壳的 FsPort 提供）。缺省时**跳过 symlink 校验**。
   *
   * 命名对齐既有约定：`FsPort.realpath` 与旧契约里的 `opts.realpath` 都是小写，
   * 这里保持一致，避免同一个概念在三个地方出现两种拼写。
   */
  realpath?: (p: string) => Promise<string | null>;
  /**
   * Windows / macOS 默认大小写不敏感。
   * **由壳注入平台事实** —— core 自己不去判断平台（那正是铁律要防的事）。
   */
  caseInsensitive?: boolean;
}

export interface WorkspaceLookup {
  /** 返回 root 与 target 匹配最长的那个工作区（**不是**「第一个匹配」） */
  findOwning(target: string, onlyId?: string): Workspace | null;
  /** 已授权工作区数量 —— 用来区分「一个都没授权」与「越界」 */
  readonly size: number;
}

/** 上溯层数上限。纯字符串父级运算不会死循环，但外部注入的 realpath 可能不收敛。 */
const MAX_ASCENT = 64;

export function createPathGuard(lookup: WorkspaceLookup, deps: PathGuardDeps = {}): PathGuard {
  const caseInsensitive = deps.caseInsensitive ?? false;

  /**
   * 上溯到**最近一个能解析出真实路径的祖先**。
   *
   * 为什么需要它：目标可能还不存在（写新文件）。此时 `realpath(target)` 返回 null，
   * 而"返回 null 就放行"等于把新建文件的整条路径都变成免检 —— 逃逸正是从
   * 一个指向外部的 symlink 目录开始的。所以退而校验最近存在的祖先。
   */
  async function nearestExistingRealpath(
    realpath: (p: string) => Promise<string | null>,
    target: string,
  ): Promise<string | null> {
    let cur = target;
    for (let i = 0; i < MAX_ASCENT; i += 1) {
      const real = await realpath(cur);
      if (real !== null) return real;
      const up = parentPath(cur);
      if (up === cur) return null; // 到根了仍解析不出来
      cur = up;
    }
    return null;
  }

  return {
    async check(target: string, opts: PathCheckOptions = {}): Promise<PathDecision> {
      const realpath = opts.realpath ?? deps.realpath;

      // ① 归一化。相对路径一律判非法 —— 它无从判断归属哪个工作区，
      //    调用方必须先 joinPath(workspace.root, rel) 拼成绝对路径。
      const resolved = normalizePath(target);
      if (resolved === null || !isAbsolutePath(resolved)) {
        return { allowed: false, reason: 'BAD_PATH' };
      }

      // ② 归属判定（最长 root 匹配）
      const owner = lookup.findOwning(resolved, opts.withinWorkspaceId);
      if (owner === null) {
        return { allowed: false, reason: lookup.size === 0 ? 'NO_WORKSPACE' : 'OUT_OF_SCOPE' };
      }

      // ③ 拿不到 realpath 就不做 symlink 校验 —— 这一层是「额外一道」，
      //    没有它前缀判定仍然成立（这也让 Web 壳可以只做纯字符串校验）。
      if (realpath === undefined) {
        return { allowed: true, resolved, workspaceId: owner.id };
      }

      const realRoot = await realpath(owner.root);
      if (realRoot === null) {
        // 授权根本身解析不出来（被删 / 权限不足）：此时任何 IO 都会失败，
        // 但**不能因此放行** —— 宁可在这一层拒绝，也不要把判定权交给文件系统。
        return { allowed: false, reason: 'BAD_PATH' };
      }

      const realTarget = await realpath(resolved);
      const probe = realTarget ?? (await nearestExistingRealpath(realpath, resolved));
      if (probe === null) return { allowed: false, reason: 'BAD_PATH' };

      if (!isWithinPath(probe, realRoot, caseInsensitive)) {
        return { allowed: false, reason: 'ESCAPE_ATTEMPT' };
      }

      // 刻意**不回写** realpath 到 resolved：`lstat` 还要靠逻辑路径把 symlink
      // 如实报成 `kind: 'symlink'`，换成 realpath 之后就永远看不到链接本身了。
      // 逃逸判定已经在这里单独做完，IO 用逻辑路径是安全的。
      return { allowed: true, resolved, workspaceId: owner.id };
    },
  };
}
