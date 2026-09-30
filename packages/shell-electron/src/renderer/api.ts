import { IPC } from '@crossdeck/contract';
import type {
  BridgeApi,
  SessionMeta,
  SystemInfo,
  Workspace,
} from '@crossdeck/contract';

declare global {
  interface Window {
    bridge: BridgeApi;
  }
}

/**
 * renderer 侧的消费样本 —— 类型对齐验证的第三处引用。
 *
 * M0 关注两件事：
 *   1. `invoke` 的 req 有无由 InvokeArgs 自动推导（无参通道可省略实参）
 *   2. 流式事件 switch 能被 TS 正确收窄
 */

export interface BootSnapshot {
  info: SystemInfo;
  sessions: SessionMeta[];
  created: SessionMeta;
  workspaces: Workspace[];
}

export async function bootSnapshot(): Promise<BootSnapshot> {
  // 无参通道：省略实参应当合法
  const info: SystemInfo = await window.bridge.invoke(IPC.systemInfo);
  const sessions: SessionMeta[] = await window.bridge.invoke(IPC.sessionList);
  const workspaces: Workspace[] = await window.bridge.invoke(IPC.workspaceList);

  // 有参通道：req 形状由 map 约束，少字段 / 错类型都应在编译期报错
  const created: SessionMeta = await window.bridge.invoke(IPC.sessionCreate, {
    title: 'New chat',
  });

  return { info, sessions, created, workspaces };
}

/** 流式消费：验证 discriminated union 的收窄能力。 */
export function attachStreamRenderer(
  onToken: (text: string) => void,
  onToolStart: (name: string) => void,
): () => void {
  return window.bridge.onStream((event) => {
    switch (event.type) {
      case 'token':
        // 此分支内 event.text 合法；换成 event.name 应编译报错
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
