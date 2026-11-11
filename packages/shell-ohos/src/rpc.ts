/**
 * 页面 → ArkTS 端口的 RPC 层。
 *
 * 职责清单（各归各行，别混）：
 *   · 帧编解码 —— CallFrame / ResFrame / PushFrame，一律 JSON 字符串（双编码，
 *     ArkTS 侧只解一层取顶层标量，见 P3 文档 §11 S-A）
 *   · 端口未到达时**排队**，不能 reject —— bundle 顶层会立刻调 navigate:status
 *   · 请求 id 配对 + 超时（流式 run 不适用超时——它靠 push 帧，返回的是 runId）
 *   · push 帧的**多订阅者分发 + 订阅者抛错隔离**（streamBinding 与 store 都会
 *     订 agent:stream —— Web 壳的 PushHub 职责在这层由 on() 承担，不另建类）
 */

import { PORT_FRAME_VERSION } from '@crossdeck/contract';
import type { PushFrame, ResFrame, ShellPortName } from '@crossdeck/contract';

export interface PortCaller {
  call<T>(port: ShellPortName, method: string, args: unknown): Promise<T>;
  on(channel: string, handler: (payload: unknown) => void): () => void;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (err: Error) => void;
  readonly timer: number;
}

/** 单条通道的订阅者清单 —— 抛错逐个隔离，一个坏订阅者不能连坐别人。 */
type Listener = (payload: unknown) => void;

/** 默认请求超时。上传走 document 端口，单次调用可能远超 30s —— 单独放宽。 */
const CALL_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 600_000;

function timeoutFor(port: ShellPortName): number {
  return port === 'document' ? UPLOAD_TIMEOUT_MS : CALL_TIMEOUT_MS;
}

export function createRpc(): PortCaller {
  let seq = 0;
  const pending = new Map<number, Pending>();
  const listeners = new Map<string, Set<Listener>>();

  let port: MessagePort | null = null;
  /** 端口到达前排队的帧 —— 到达后按序发出，顺序即调用顺序。 */
  const queue: string[] = [];

  function deliver(raw: string): void {
    let msg: ResFrame | PushFrame;
    try {
      msg = JSON.parse(raw) as ResFrame | PushFrame;
    } catch {
      return;
    }
    if (msg === null || msg.v !== PORT_FRAME_VERSION) return;

    if (msg.kind === 'res') {
      const p = pending.get(msg.id);
      if (p === undefined) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.err !== null) {
        p.reject(new Error(msg.err));
        return;
      }
      // 载荷在字符串字段里，这里统一解一层；调用方拿到的就是普通对象
      p.resolve(msg.res === null ? null : (JSON.parse(msg.res) as unknown));
      return;
    }

    if (msg.kind === 'push') {
      const set = listeners.get(msg.channel);
      if (set === undefined) return;
      let payload: unknown = msg.payload;
      try {
        payload = JSON.parse(msg.payload) as unknown;
      } catch {
        // 解不开就原样给 —— 订阅者自己决定要不要管
      }
      for (const listener of [...set]) {
        try {
          listener(payload);
        } catch (err) {
          console.error(`[rpc] push 订阅者抛错（${msg.channel}）：`, err);
        }
      }
    }
  }

  function attach(p: MessagePort): void {
    port = p;
    p.onmessage = (ev: MessageEvent) => {
      const data = ev.data;
      deliver(typeof data === 'string' ? data : String(data));
    };
    for (const frame of queue.splice(0)) p.postMessage(frame);
  }

  // 端口由 index.html 的内联 classic script 接住并 park（那里注册得最早，
  // ArkTS 的 onPageEnd 投递才不会丢）；这里只从 park 点取，**不许再注册第二个监听**。
  window.__whenPort(attach);

  return {
    call<T>(portName: ShellPortName, method: string, args: unknown): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        seq += 1;
        const id = seq;
        const timer = window.setTimeout(() => {
          pending.delete(id);
          reject(new Error(`[UPSTREAM:PORT_TIMEOUT] 端口 ${portName}.${method} 在 ${timeoutFor(portName)}ms 内没有应答`));
        }, timeoutFor(portName));
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });

        const frame = JSON.stringify({
          v: PORT_FRAME_VERSION,
          kind: 'call',
          id,
          port: portName,
          method,
          args: args === undefined ? 'null' : JSON.stringify(args),
        });

        if (port === null) queue.push(frame);
        else port.postMessage(frame);
      });
    },

    on(channel: string, handler: Listener): () => void {
      let set = listeners.get(channel);
      if (set === undefined) {
        set = new Set<Listener>();
        listeners.set(channel, set);
      }
      set.add(handler);
      return () => {
        set?.delete(handler);
      };
    },
  };
}
