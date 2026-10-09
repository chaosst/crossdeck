import { IPC, parseIpcError } from '@crossdeck/contract';
import type {
  AgentStreamEvent,
  DirEntry,
  GuestLoginResult,
  IpcErrorCode,
  NavigateStatus,
  PerfSampleInput,
  PerfSnapshot,
  SessionMeta,
  SystemInfo,
  UpdateInfo,
  UpdateStatus,
  WindowKind,
  Workspace,
} from '@crossdeck/contract';

/**
 * renderer 侧的桥消费层 —— 类型对齐验证的第三处引用。
 *
 * 这里刻意**不**做任何类型断言：每个返回值都由 IpcInvokeMap 推导而来。
 * 一旦某处签名漂移，这个文件会最先编译失败。
 */

/**
 * 把 catch 到的任意东西变成可展示的错误串。
 *
 * 为什么不能直接读 `err.code`：
 *   错误对象穿过 contextBridge 后自定义属性会被丢弃（实测见 selfcheck 探针），
 *   所以 code 是由 preload 编码进 message 前缀的，必须用 parseIpcError 解出来。
 *   直接读 err.code 会永远拿到 undefined —— 而且不报错，只是静默丢失语义。
 *
 * `detail` 同理走前缀（`[SCOPE_DENIED:OUT_OF_SCOPE] …`）：它存在的意义是让 UI
 * 不必去猜 message 文本 —— 「还没授权任何目录」和「越界了」要引导用户做不同的事。
 */
export function describeIpcError(err: unknown): {
  code: IpcErrorCode | 'UNKNOWN';
  detail?: string;
  text: string;
} {
  const parsed = parseIpcError(err);
  const tag = parsed.detail === undefined ? parsed.code : `${parsed.code}:${parsed.detail}`;
  return {
    code: parsed.code,
    ...(parsed.detail === undefined ? {} : { detail: parsed.detail }),
    text: parsed.code === 'UNKNOWN' ? parsed.message : `[${tag}] ${parsed.message}`,
  };
}

/** 启动快照：一次性把首屏需要的三份数据取回来。 */
export interface BootSnapshot {
  info: SystemInfo;
  sessions: SessionMeta[];
  created: SessionMeta;
}

export async function getSystemInfo(): Promise<SystemInfo> {
  return window.bridge.invoke(IPC.systemInfo);
}

export async function listSessions(): Promise<SessionMeta[]> {
  return window.bridge.invoke(IPC.sessionList);
}

export async function createSession(title?: string): Promise<SessionMeta> {
  // 无 title 时省略整个 req 字段（exactOptionalPropertyTypes 下不能传 undefined）
  return title === undefined
    ? window.bridge.invoke(IPC.sessionCreate, {})
    : window.bridge.invoke(IPC.sessionCreate, { title });
}

export async function deleteSession(sessionId: string): Promise<void> {
  return window.bridge.invoke(IPC.sessionDelete, { sessionId });
}

export async function startAgentRun(sessionId: string, input: string): Promise<{ runId: string }> {
  return window.bridge.invoke(IPC.agentRun, { sessionId, input });
}

export async function abortAgentRun(runId: string): Promise<void> {
  return window.bridge.invoke(IPC.agentAbort, { runId });
}

export async function openWindow(kind: WindowKind): Promise<{ windowId: number }> {
  return window.bridge.invoke(IPC.windowOpen, { kind });
}

// ── M4：工作区授权 + 文件系统 ────────────────────────────────
// 注意所有 fs 调用都必须带上 workspaceId —— 通道契约就是这么定义的，
// 少传会在**编译期**报错（负例 H 验证的正是这一点）。

export async function listWorkspaces(): Promise<Workspace[]> {
  return window.bridge.invoke(IPC.workspaceList);
}

export async function grantWorkspace(): Promise<Workspace | null> {
  return window.bridge.invoke(IPC.workspaceGrant);
}

export async function revokeWorkspace(workspaceId: string): Promise<void> {
  return window.bridge.invoke(IPC.workspaceRevoke, { workspaceId });
}

export async function listDir(workspaceId: string, path: string): Promise<DirEntry[]> {
  return window.bridge.invoke(IPC.fsListDir, { workspaceId, path });
}

export async function readFileText(
  workspaceId: string,
  path: string,
): Promise<{ text: string; truncated: boolean }> {
  return window.bridge.invoke(IPC.fsReadFile, { workspaceId, path });
}

export async function controlAgentRun(runId: string, type: 'pause' | 'resume'): Promise<void> {
  return window.bridge.invoke(IPC.agentControl, { runId, type });
}

// ── navigate：上游配置 + 登录 ────────────────────────────────
// 这四条**没有任何让 token 进出的余地**：凭据停在主进程，
// 响应类型（contract 的 GuestLoginResult / NavigateLoginStatus）里压根没有这个字段。
// 负例 N 断言的正是"在渲染层写 res.token 必须编译失败"。

export async function getNavigateStatus(): Promise<NavigateStatus> {
  return window.bridge.invoke(IPC.navigateStatus);
}

export async function setNavigateUpstream(upstreamUrl: string | null): Promise<NavigateStatus> {
  return window.bridge.invoke(IPC.navigateSetUpstream, { upstreamUrl });
}

export async function loginNavigateGuest(): Promise<GuestLoginResult> {
  return window.bridge.invoke(IPC.navigateLoginGuest);
}

export async function logoutNavigate(): Promise<NavigateStatus> {
  return window.bridge.invoke(IPC.navigateLogout);
}

/**
 * 流式消费：验证 discriminated union 的收窄能力。
 * 注意 `case 'token'` 分支里 `event.text` 合法、`event.name` 会编译报错。
 */
export function attachStreamRenderer(
  onToken: (text: string) => void,
  onToolStart: (name: string) => void,
): () => void {
  return window.bridge.on(IPC.agentStream, (event) => {
    switch (event.type) {
      case 'token':
        onToken(event.text);
        break;
      case 'tool':
        onToolStart(event.name);
        break;
      case 'tool_end':
      case 'plan':
      case 'start':
      case 'done':
      case 'error':
        break;
    }
  });
}

/** 订阅原始事件流（App 用这个，需要看到全部事件类型）。 */
export function onAgentEvent(handler: (event: AgentStreamEvent) => void): () => void {
  return window.bridge.on(IPC.agentStream, handler);
}

// ── M5：自动更新 ─────────────────────────────────────────────
// 注意 renderer 这侧**不知道** electron-updater 的存在，也不知道 feed 长什么样。
// 它只认识 UpdateStatus 这个判别联合 —— 这正是 contract 存在的意义：
// 换一个壳（鸿蒙走 AppGallery）时，这几行一行都不用改。

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  return window.bridge.invoke(IPC.updateCheck);
}

export async function downloadUpdate(): Promise<void> {
  return window.bridge.invoke(IPC.updateDownload);
}

export async function installUpdate(): Promise<void> {
  return window.bridge.invoke(IPC.updateInstall);
}

/** 订阅更新进度。返回取消函数 —— 与 agent 流同一个理由：卸载不摘会泄漏。 */
export function onUpdateStatus(handler: (status: UpdateStatus) => void): () => void {
  return window.bridge.on(IPC.updateStatus, handler);
}

// ── M6-1：性能采样 ───────────────────────────────────────────
// 首帧与帧率只有渲染层测得到，所以它们由这里**报上去**，而不是由 main 猜。
// 时钟不用管：main 用的是自己的 Date.now()，这里只负责说"这件事刚刚发生了"。

export async function samplePerf(input: PerfSampleInput = {}): Promise<PerfSnapshot> {
  return window.bridge.invoke(IPC.perfSample, input);
}

/**
 * 帧率探针 —— 流式期间实测 requestAnimationFrame 的回调频率。
 *
 * 为什么不用 `setInterval(…, 16)` 数次数：那测的是**定时器**有没有按时触发，
 * 与画面有没有真的刷出来是两件事。rAF 的回调频率直接等于浏览器愿意给的帧机会，
 * 掉帧时它会同步下降 —— 这才是"卡不卡"的判据。
 *
 * 探针是模块级的（不挂在组件上）：它跨越多次 render，且必须能在事件回调里
 * 同步启停 —— 放进 state 会让 'done' 那一刻读到旧值。
 */
let fpsProbe: { frames: number; startedAt: number; raf: number } | null = null;

export function startStreamFpsProbe(): void {
  stopStreamFpsProbe(); // 上一次没停干净时先收尾，避免两个探针同时计数
  const probe = { frames: 0, startedAt: performance.now(), raf: 0 };
  const tick = (): void => {
    probe.frames += 1;
    probe.raf = requestAnimationFrame(tick);
  };
  probe.raf = requestAnimationFrame(tick);
  fpsProbe = probe;
}

/** 停止探针并返回实测帧率（没在测时返回 0 —— 语义是"没测到"，不是"帧率 0"）。 */
export function stopStreamFpsProbe(): number {
  const probe = fpsProbe;
  fpsProbe = null;
  if (probe === null) return 0;
  cancelAnimationFrame(probe.raf);
  const elapsed = performance.now() - probe.startedAt;
  if (elapsed <= 0) return 0;
  return Math.round((probe.frames * 1000) / elapsed);
}
