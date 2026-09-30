import { app, BrowserWindow, dialog, webContents } from 'electron';
import { arch, release } from 'node:os';
import { AppError, IPC } from '@crossdeck/contract';
import type { Capability, SessionMeta, SystemInfo, Workspace } from '@crossdeck/contract';
import { SessionStore } from '@crossdeck/core';
import { defineInvoke, markRunAborted } from './ipc.js';
import { registeredChannels } from './ipc.js';
import { runScripted } from './agentRuntime.js';
import { createWindow } from './windows.js';

/**
 * main 侧全部 handler。
 *
 * 分工原则（这条线就是"分层"在代码里的样子）：
 *   - **状态与规则**归 core（SessionStore 是纯 TypeScript，不认平台）
 *   - **平台能力**归壳（对话框、窗口、系统信息 —— 这些只能在 main 里拿到）
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

const sessions = new SessionStore();

/**
 * 工作区授权表。
 *
 * TODO(M4): 这张表最终应下沉到 core —— 授权判定（路径是否在 scope 内、有无 symlink 逃逸）
 * 是**领域规则**，不是平台能力。现在暂放在 main 里，是因为 M4 要连同 PathGuard
 * 一起搬，单独搬一张 Map 没有意义。
 */
const workspaces = new Map<string, Workspace>();

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
    // 新窗口不抢焦点的场景（比如 inspector 面板）留给 M3 处理
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
    markRunAborted(req.runId);
  });

  // ── 工作区授权 ──────────────────────────────────────────
  defineInvoke(IPC.workspaceList, async (): Promise<Workspace[]> => [...workspaces.values()]);

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

    const ws: Workspace = {
      id: `ws_${Date.now().toString(36)}`,
      root,
      label: root.split(/[\\/]/).pop() ?? root,
      grantedAt: Date.now(),
      // 默认只读：写权限必须是用户显式升级，而不是默认给
      mode: 'read',
    };
    workspaces.set(ws.id, ws);
    return ws;
  });

  defineInvoke(IPC.workspaceRevoke, async (req): Promise<void> => {
    workspaces.delete(req.workspaceId);
  });

  return registeredChannels().length;
}

export function registeredChannelList(): string[] {
  return [...registeredChannels()];
}
