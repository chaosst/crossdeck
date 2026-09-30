import { IPC, parseIpcError } from '@crossdeck/contract';
import type {
  AgentStreamEvent,
  IpcErrorCode,
  SessionMeta,
  SystemInfo,
  WindowKind,
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
 */
export function describeIpcError(err: unknown): { code: IpcErrorCode | 'UNKNOWN'; text: string } {
  const parsed = parseIpcError(err);
  return {
    code: parsed.code,
    text: parsed.code === 'UNKNOWN' ? parsed.message : `[${parsed.code}] ${parsed.message}`,
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

/**
 * 流式消费：验证 discriminated union 的收窄能力。
 * 注意 `case 'token'` 分支里 `event.text` 合法、`event.name` 会编译报错。
 */
export function attachStreamRenderer(
  onToken: (text: string) => void,
  onToolStart: (name: string) => void,
): () => void {
  return window.bridge.onStream((event) => {
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
  return window.bridge.onStream(handler);
}
