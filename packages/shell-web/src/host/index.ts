/**
 * 页内主进程的装配点 —— 这个文件就是 Web 壳的 `main/index.ts`。
 *
 * 桌面壳的启动顺序是「app.whenReady → 建窗口 → 注册 IPC → 加载页面」；
 * 这里换成「建端口 → 建仓储作用域 → 建 agent / navigate → 造 bridge → 交给 UI 挂载」。
 * 顺序本身是承重的：`bridge` 必须在 `mountApp` 之前准备好，而 UI 一挂载就会
 * 立刻问 `navigate:status`（登录闸门）。
 */

import type { BridgeApi, Capability, NavigateStatus, Platform } from '@crossdeck/contract';
import { IPC } from '@crossdeck/contract';
import type { AgentDeps } from '@crossdeck/core';
import { WorkspaceStore, createPathGuard } from '@crossdeck/core';
import { createWebPorts } from '../ports.js';
import { AgentHost } from './agent.js';
import { createBridge } from './bridge.js';
import { NavigateHost } from './navigate.js';
import { PushHub } from './push.js';
import { SessionScope } from './sessions.js';

export interface WebHost {
  readonly bridge: BridgeApi;
  /** 启动时的 navigate 状态 —— 自检/诊断要看"这一页连的是哪个上游"。 */
  readonly status: NavigateStatus;
  readonly platform: Platform;
  readonly capabilities: ReadonlySet<Capability>;
}

/** `?upstream` 的解析 —— `1`/空 表示同源，其余当作前缀写进 baseUrl。 */
function parseUpstreamParam(search: string): string | null {
  const params = new URLSearchParams(search);
  // 自检页连着同源的假上游（`scripts/web-selfcheck.mjs` 在同端口起了它）。
  // 不这么认，自检就只能跑脚本上游，登录闸门与上传闸门整段都验不到。
  if (params.has('selfcheck') && !params.has('upstream')) return '';
  if (!params.has('upstream')) return null;
  const raw = params.get('upstream') ?? '';
  return raw === '1' ? '' : raw;
}

export async function createWebHost(): Promise<WebHost> {
  const deps: AgentDeps = {
    now: () => Date.now(),
    every: (intervalMs, fn) => {
      const timer = setInterval(fn, intervalMs);
      return () => clearInterval(timer);
    },
    newId: (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`,
  };

  const workspaces = new WorkspaceStore({ caseInsensitive: false });
  const shell = await createWebPorts(workspaces);
  const guard = createPathGuard(workspaces, { realpath: (p) => shell.fs.realpath(p) });

  const push = new PushHub();
  const scope = new SessionScope({
    now: deps.now,
    newId: deps.newId,
    onChange: (change) => push.emit(IPC.sessionChanged, change),
  });

  const navigate = new NavigateHost({
    now: deps.now,
    upstreamParam: parseUpstreamParam(location.search),
  });

  const agent = new AgentHost({
    deps,
    baseUrl: () => navigate.baseUrl(),
    repo: () => scope.current(),
    emit: (event) => push.emit(IPC.agentStream, event),
    onSessionChanged: (change) => push.emit(IPC.sessionChanged, change),
  });

  const bridge = createBridge({
    shell,
    workspaces,
    guard,
    scope,
    agent,
    navigate,
    push,
    appVersion: __APP_VERSION__,
  });

  return {
    bridge,
    status: await navigate.status(),
    platform: shell.platform,
    capabilities: shell.capabilities,
  };
}
