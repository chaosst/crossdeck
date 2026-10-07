import { app, BrowserWindow, dialog, webContents } from 'electron';
import { promises as fsp } from 'node:fs';
import { arch, release } from 'node:os';
import { AppError, IPC, PATH_DENY_MESSAGES } from '@crossdeck/contract';
import type {
  Capability,
  DirEntry,
  FileStat,
  PerfSnapshot,
  SessionMeta,
  SystemInfo,
  Workspace,
} from '@crossdeck/contract';
import { SessionStore, WorkspaceStore, createPathGuard, resolveInWorkspace } from '@crossdeck/core';
import { abortRun, controlRun, runScripted } from './agentRuntime.js';
import { createFsPort, toFsAppError } from './fs.js';
import { defineInvoke, markRunAborted, registeredChannels } from './ipc.js';
import { notePerfSample, readPerfSnapshot } from './perf.js';
import { checkForUpdates, downloadUpdate, installUpdate } from './updater.js';
import { createWindow } from './windows.js';

/**
 * main 侧全部 handler。
 *
 * 分工原则（这条线就是"分层"在代码里的样子）：
 *   - **状态与规则**归 core（SessionStore / WorkspaceStore / PathGuard 都是纯 TypeScript）
 *   - **平台能力**归壳（对话框、窗口、系统信息、真正的文件 IO）
 *   - handler 只做"翻译"：把 IpcRequest 转成 core 调用，把结果转回契约类型
 */

/** 由 Electron 壳实际具备的能力。Web 壳那份会短很多，鸿蒙壳又会不同。 */
const ELECTRON_CAPABILITIES: readonly Capability[] = [
  'fs.scope',
  'window.multi',
  'shortcut.global',
  'update.auto',
  'tray',
  'notify.system',
];

/**
 * Windows / macOS 的默认文件系统大小写不敏感。
 * ⚠️ 这是**平台事实**，所以由壳算出来再注入 —— core 自己不去读 process.platform，
 *    那条铁律防的就是这个。
 */
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

const sessions = new SessionStore();

/**
 * 工作区授权表（M4 从 main 下沉到 core）。
 *
 * 下沉的理由：授权判定是**领域规则**，不是平台能力。
 * 留在壳里意味着每加一个壳就要把「路径在不在 scope 内、有没有 symlink 逃逸」
 * 重写一遍 —— 而这是全项目最不能写错的一段代码。
 */
const workspaces = new WorkspaceStore({ caseInsensitive: CASE_INSENSITIVE_FS });

const guard = createPathGuard(workspaces, {
  // PathGuard 需要解 symlink，但 core 碰不到文件系统 —— 由壳把原语注入进去。
  // 刻意用裸 fsp.realpath 而不是 FsPort.realpath：校验本身需要它，套一层会递归。
  realpath: (p) => fsp.realpath(p).then((real) => real, () => null),
  caseInsensitive: CASE_INSENSITIVE_FS,
});

const fsPort = createFsPort({ guard, workspaces });

/**
 * 把 `{ workspaceId, path }` 变成一条**已授权的绝对路径**。
 *
 * 拼接 + 限定工作区 + 判定这三步已下沉 core（`resolveInWorkspace`）——
 * Web 壳要用同一段逻辑的那一刻就到了二选一的关口：抄一份，或者下沉。
 * 抄一份的代价不是多写 15 行，而是**两端的授权语义从此可能走散**，
 * 而这是全项目最不能走散的一段代码。
 *
 * 这里只负责**把领域结果翻译成 IPC 错误**：那是壳才知道的事。
 */
async function resolveOrThrow(workspaceId: string, relPath: string): Promise<string> {
  const resolved = await resolveInWorkspace(workspaces, guard, workspaceId, relPath);
  if (!resolved.ok) {
    throw new AppError('SCOPE_DENIED', PATH_DENY_MESSAGES[resolved.reason], resolved.reason);
  }
  return resolved.absolute;
}

/**
 * 把底层 fs 的裸错误（ENOENT / EACCES / ELOOP…）翻译成契约错误码。
 * 不翻译的话它们都会落到 `toSerializedError` 的兜底分支变成 INTERNAL ——
 * renderer 就再也分不清「文件不存在」和「真的出错了」。
 */
async function withFsErrors<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw toFsAppError(err, what);
  }
}

function focusWindow(windowId: number): BrowserWindow | null {
  const wc = webContents.fromId(windowId);
  if (!wc || wc.isDestroyed()) return null;
  return BrowserWindow.fromWebContents(wc);
}

export function registerHandlers(): number {
  // ── 系统 ────────────────────────────────────────────────
  defineInvoke(IPC.systemInfo, async (): Promise<SystemInfo> => {
    return {
      platform: 'electron',
      appVersion: app.getVersion(),
      osVersion: `${process.platform} ${release()} (${arch()})`,
      locale: app.getLocale(),
      capabilities: ELECTRON_CAPABILITIES,
    };
  });

  defineInvoke(IPC.windowOpen, async (req, ctx) => {
    const child = createWindow(req.kind);
    // 新窗口不抢焦点的场景（比如 inspector 面板）留给 M4.5 处理
    void focusWindow(ctx.senderWindowId);
    return { windowId: child.id };
  });

  // ── 会话 ────────────────────────────────────────────────
  defineInvoke(IPC.sessionList, async (): Promise<SessionMeta[]> => sessions.list());

  defineInvoke(IPC.sessionCreate, async (req) => sessions.create(req));

  defineInvoke(IPC.sessionDelete, async (req): Promise<void> => {
    if (!sessions.delete(req.sessionId)) {
      // 明确用 NOT_FOUND 而不是静默成功 —— 删不掉和删成功是两件事，
      // 前端需要能区分（前者要提示用户刷新列表）。
      throw new AppError('NOT_FOUND', `会话不存在：${req.sessionId}`);
    }
  });

  // ── Agent 运行 ──────────────────────────────────────────
  defineInvoke(IPC.agentRun, async (req, ctx) => {
    if (!sessions.get(req.sessionId)) {
      throw new AppError('NOT_FOUND', `会话不存在：${req.sessionId}`);
    }
    const { runId } = runScripted(ctx.senderWindowId, req.sessionId, req.input);
    return { runId };
  });

  defineInvoke(IPC.agentAbort, async (req): Promise<void> => {
    // 两件事都做，理由不同：
    //   markRunAborted → 供 handler 里轮询 ctx.isAborted 的长任务自行退出
    //   abortRun       → 让核心立刻摘掉调度，并**补发一个 ABORTED 终结事件**
    // 只做前者的话，被中断的 run 不发终结事件，UI 会永远停在"流式中"。
    markRunAborted(req.runId);
    // 但**不**在这里抛 NOT_FOUND，与 agent:control 有意不同：
    //   · pause/resume 的诉求是"改变状态"。静默成功会让 UI 以为自己暂停了、
    //     而真实状态是"早就结束了" —— 两边不一致，所以必须抛。
    //   · abort 的诉求是"让它别跑了"。run 已经结束 = 目标已经达成，就是成功。
    //     抛错反而会让"点了停止但刚好跑完"这个常见竞态弹出一个莫名其妙的错误。
    abortRun(req.runId);
  });

  defineInvoke(IPC.agentControl, async (req): Promise<void> => {
    // 走 invoke 而不是 send：背压需要 ack —— 「pause 到底生效了没有」
    // 必须能被调用方观察到，否则 renderer 以为自己暂停了，main 还在灌。
    if (!controlRun(req.runId, req.type)) {
      throw new AppError('NOT_FOUND', `run 不存在或已结束：${req.runId}`);
    }
  });

  // ── 工作区授权 ──────────────────────────────────────────
  defineInvoke(IPC.workspaceList, async (): Promise<Workspace[]> => workspaces.list());

  defineInvoke(IPC.workspaceGrant, async (_req, ctx): Promise<Workspace | null> => {
    const parent = focusWindow(ctx.senderWindowId);
    const picked = parent
      ? await dialog.showOpenDialog(parent, {
          title: '授权一个工作区目录',
          properties: ['openDirectory', 'createDirectory'],
        })
      : await dialog.showOpenDialog({
          title: '授权一个工作区目录',
          properties: ['openDirectory', 'createDirectory'],
        });

    const root = picked.canceled ? undefined : picked.filePaths[0];
    if (!root) return null;

    const granted = workspaces.grant({ root });
    if (!granted.ok) {
      throw new AppError('SCOPE_DENIED', PATH_DENY_MESSAGES[granted.reason], granted.reason);
    }
    return granted.workspace;
  });

  defineInvoke(IPC.workspaceRevoke, async (req): Promise<void> => {
    workspaces.revoke(req.workspaceId);
  });

  // ── 文件系统（每条都必须先过 scope 校验）────────────────
  defineInvoke(IPC.fsListDir, async (req): Promise<DirEntry[]> => {
    const abs = await resolveOrThrow(req.workspaceId, req.path);
    return withFsErrors('列目录', () => fsPort.listDir(abs));
  });

  defineInvoke(IPC.fsReadFile, async (req) => {
    const abs = await resolveOrThrow(req.workspaceId, req.path);
    return withFsErrors('读文件', () => fsPort.readFile(abs));
  });

  defineInvoke(IPC.fsWriteFile, async (req): Promise<void> => {
    const abs = await resolveOrThrow(req.workspaceId, req.path);
    await withFsErrors('写文件', () => fsPort.writeFile(abs, req.data));
  });

  defineInvoke(IPC.fsStat, async (req): Promise<FileStat> => {
    const abs = await resolveOrThrow(req.workspaceId, req.path);
    return withFsErrors('取文件信息', () => fsPort.stat(abs));
  });

  // ── 自动更新（M5）────────────────────────────────────────
  // 三条通道都**不做**能力判断：判断在 updater.ts 里，且判定失败时抛
  // UNSUPPORTED 而不是返回 null —— handler 只负责转发，不替它决定"能不能"。
  defineInvoke(IPC.updateCheck, async () => checkForUpdates());

  defineInvoke(IPC.updateDownload, async (): Promise<void> => downloadUpdate());

  defineInvoke(IPC.updateInstall, async (): Promise<void> => installUpdate());

  // ── 性能采样（M6-1）──────────────────────────────────────
  // 一次调用两件事：把渲染层带上来的采样点记账，再返回当前快照。
  // 分开成两条通道会让调用方必须记住"先报再读"，而顺序错了不会报错 ——
  // 只会得到一个缺字段的快照。
  defineInvoke(IPC.perfSample, async (req, ctx): Promise<PerfSnapshot> => {
    notePerfSample(req);
    return readPerfSnapshot(ctx.senderWindowId);
  });

  return registeredChannels().length;
}

export function registeredChannelList(): string[] {
  return [...registeredChannels()];
}

/**
 * 自检用的前置授权 —— 走与用户点击「授权目录」**完全相同**的代码路径
 * （同一个 `workspaces.grant`），只是跳过了无法在无头环境弹出来的系统对话框。
 * 用别的捷径会给自检造出一条用户永远走不到的分支。
 */
export function grantWorkspaceForSelfCheck(root: string): Workspace {
  const granted = workspaces.grant({ root, label: 'selfcheck-fixture' });
  if (!granted.ok) {
    throw new Error(`自检夹具目录不合法（${granted.reason}）：${root}`);
  }
  return granted.workspace;
}
