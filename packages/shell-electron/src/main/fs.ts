import { promises as fsp, watch as watchFs } from 'node:fs';
import { AppError, PATH_DENY_MESSAGES } from '@crossdeck/contract';
import type { DirEntry, FileStat, PathGuard, Workspace } from '@crossdeck/contract';
import { joinPath, type FsPort, type WorkspaceStore } from '@crossdeck/core';

/**
 * FsPort 的 Electron 实现 —— core 眼中「文件系统能力」的全部。
 *
 * 一条硬规矩：**校验先于 IO**。
 *   每个方法在碰 `node:fs` 之前都必须先过 `authorize()`。
 *   把它放在 FsPort 内部而不是调用方，是因为「调用方记得校验」这种东西
 *   迟早会有人忘；焊在唯一的 IO 出口上，就忘不了。
 *   反过来写成「先读出来再判断能不能读」是最糟的形态：数据已经进内存了。
 */

export interface FsPortDeps {
  guard: PathGuard;
  workspaces: WorkspaceStore;
  /** 单文件读取上限，默认 1 MiB */
  maxReadBytes?: number;
}

const DEFAULT_MAX_READ_BYTES = 1 << 20;

/** 把绝对路径折成相对授权根的 POSIX 路径 —— 跨端一致，快照测试也稳定。 */
function toWorkspaceRelative(root: string, abs: string): string {
  const r = root.endsWith('/') ? root.slice(0, -1) : root;
  if (abs === r) return '.';
  return abs.startsWith(`${r}/`) ? abs.slice(r.length + 1) : abs;
}

function causeMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createFsPort(deps: FsPortDeps): FsPort {
  const { guard, workspaces } = deps;
  const maxRead = deps.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;

  async function authorize(target: string): Promise<{ resolved: string; workspace: Workspace }> {
    const decision = await guard.check(target);
    if (!decision.allowed) {
      throw new AppError('SCOPE_DENIED', PATH_DENY_MESSAGES[decision.reason], decision.reason);
    }
    const workspace = workspaces.get(decision.workspaceId);
    if (workspace === undefined) {
      // PathGuard 刚说这个 id 存在，这里却拿不到 —— 只可能是并发撤销，
      // 仍然按「没有授权」处理，不要放行。
      throw new AppError('SCOPE_DENIED', PATH_DENY_MESSAGES.NO_WORKSPACE, 'NO_WORKSPACE');
    }
    return { resolved: decision.resolved, workspace };
  }

  async function statRaw(abs: string): Promise<{ size: number; mtimeMs: number; kind: DirEntry['kind'] }> {
    // lstat 而不是 stat：symlink 要如实报出来，跟随链接之后就没法区分了
    const st = await fsp.lstat(abs);
    return {
      size: st.size,
      mtimeMs: st.mtimeMs,
      kind: st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'directory' : 'file',
    };
  }

  return {
    async readFile(path, opts) {
      const { resolved } = await authorize(path);
      const st = await fsp.stat(resolved);
      if (st.isDirectory()) {
        throw new AppError('BAD_REQUEST', `目标是目录，不是文件：${resolved}`);
      }

      const limit = Math.max(0, Math.min(st.size, opts?.maxBytes ?? maxRead));
      const fh = await fsp.open(resolved, 'r');
      try {
        const buf = Buffer.alloc(limit);
        const { bytesRead } = await fh.read(buf, 0, limit, 0);
        // 截断按字节切，末尾可能落在多字节字符中间 —— TextDecoder 会给出 U+FFFD。
        // 这是可接受的：`truncated` 已经如实告诉调用方「后面还有」。
        return {
          text: new TextDecoder('utf-8').decode(buf.subarray(0, bytesRead)),
          truncated: st.size > limit,
        };
      } finally {
        await fh.close();
      }
    },

    async writeFile(path, data) {
      const { resolved, workspace } = await authorize(path);
      if (workspace.mode !== 'readwrite') {
        // 默认只读是刻意的：写权限必须是一次显式升级，
        // 而不是"授权目录时顺手给的"。
        throw new AppError(
          'READONLY',
          `工作区「${workspace.label}」是只读的（授权时默认只读，需要显式升级为 readwrite）`,
        );
      }
      await fsp.writeFile(resolved, data, 'utf8');
    },

    async listDir(path) {
      const { resolved, workspace } = await authorize(path);
      const dirents = await fsp.readdir(resolved, { withFileTypes: true });

      const entries: DirEntry[] = [];
      for (const dirent of dirents) {
        const abs = joinPath(resolved, dirent.name);
        if (abs === null) continue; // 名字本身非法（含 NUL 之类）—— 跳过而不是整体失败

        let size = 0;
        let mtimeMs = 0;
        try {
          const st = await statRaw(abs);
          size = st.size;
          mtimeMs = st.mtimeMs;
        } catch (err) {
          // 竞态消失 / 权限不足：条目仍然列出，只是没有大小。
          // 直接抛会让「有一个坏文件就读不了整个目录」，对文件树是灾难性的。
          if (isHardFailure(err)) throw err;
        }

        entries.push({
          name: dirent.name,
          path: toWorkspaceRelative(workspace.root, abs),
          kind: dirent.isSymbolicLink() ? 'symlink' : dirent.isDirectory() ? 'directory' : 'file',
          size,
          mtimeMs,
        });
      }

      // 目录在前、同类按名字 —— 顺序稳定，快照与肉眼都好读
      entries.sort((a, b) => {
        const aDir = a.kind === 'directory' ? 0 : 1;
        const bDir = b.kind === 'directory' ? 0 : 1;
        return aDir === bDir ? a.name.localeCompare(b.name) : aDir - bDir;
      });
      return entries;
    },

    async stat(path) {
      const { resolved } = await authorize(path);
      const st = await statRaw(resolved);
      const stat: FileStat = { kind: st.kind, size: st.size, mtimeMs: st.mtimeMs };
      return stat;
    },

    async watch(path, onChange) {
      const { resolved } = await authorize(path);
      // fs.watch 是同步构造的，但校验是异步的 —— 顺序反过来的话，
      // 越界路径会先建立好监听，再被拒绝，中间那段时间窗口是漏的。
      const watcher = watchFs(resolved, { persistent: false }, () => onChange());
      return () => {
        watcher.close();
      };
    },

    async realpath(path) {
      try {
        return await fsp.realpath(path);
      } catch {
        // 路径不存在是**正常情况**（写新文件），返回 null 让 PathGuard 走祖先兜底。
        // 不区分 ENOENT 与 EPERM：两者都意味着「解析不出来」。
        return null;
      }
    },
  };
}

/**
 * 区分「一个条目坏了」和「整个目录读不了」。
 * 前者跳过继续，后者必须往上抛 —— 静默返回空目录会让 UI 显示"空文件夹"，
 * 而真实情况是权限没了，这是两件完全不同的事。
 */
function isHardFailure(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'EACCES' || code === 'EPERM' || code === 'ENOTDIR' || code === 'ELOOP';
}

/** 把底层 fs 错误翻译成契约错误码，避免 ENOENT 这类裸字符串漏到 renderer。 */
export function toFsAppError(err: unknown, what: string): AppError {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'ENOENT') return new AppError('NOT_FOUND', `${what}：路径不存在`);
  if (code === 'EISDIR') return new AppError('BAD_REQUEST', `${what}：目标是目录`);
  if (code === 'ENOTDIR') return new AppError('BAD_REQUEST', `${what}：路径中有一段不是目录`);
  if (code === 'ELOOP') return new AppError('BAD_REQUEST', `${what}：符号链接成环`);
  if (code === 'EACCES' || code === 'EPERM') return new AppError('FORBIDDEN', `${what}：权限不足`);
  return new AppError('INTERNAL', `${what}：${causeMessage(err)}`);
}
