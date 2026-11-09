/**
 * 推送中心 —— 页内主进程这一侧的 `webContents.send`。
 *
 * 四条推送通道（`IpcPushMap`）在这里汇聚，UI 侧只有一个 `bridge.on(channel, fn)`。
 * 订阅必须能退订：流式 UI 每次挂载都会多留一个监听器，表现为「同一条流被渲染 N 次」。
 */

import type { PushChannel, PushPayload } from '@crossdeck/contract';

type AnyHandler = (payload: never) => void;

export class PushHub {
  readonly #handlers = new Map<PushChannel, Set<AnyHandler>>();

  emit<K extends PushChannel>(channel: K, payload: PushPayload<K>): void {
    const set = this.#handlers.get(channel);
    if (set === undefined) return;
    for (const handler of [...set]) {
      // 一个订阅者抛错不该让其它订阅者收不到 —— 逐个隔离
      try {
        (handler as (p: PushPayload<K>) => void)(payload);
      } catch (err) {
        console.error(`[push] ${channel} 的订阅者抛错：`, err);
      }
    }
  }

  on<K extends PushChannel>(channel: K, handler: (payload: PushPayload<K>) => void): () => void {
    let set = this.#handlers.get(channel);
    if (set === undefined) {
      set = new Set();
      this.#handlers.set(channel, set);
    }
    set.add(handler as AnyHandler);
    return () => {
      set.delete(handler as AnyHandler);
    };
  }

  /** 诊断用：某条通道现在挂了几个订阅者。 */
  listenerCount(channel: PushChannel): number {
    return this.#handlers.get(channel)?.size ?? 0;
  }
}
