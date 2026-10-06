import type { AgentStreamEvent } from '@crossdeck/contract';

export type StreamListener = (event: AgentStreamEvent) => void;
export type Unsubscribe = () => void;

/**
 * StreamBus —— Agent 事件的订阅与分发。
 *
 * 为什么这件事归 core：**谁在听、退订后还能不能收到、一个 run 结束要不要广播**
 * 全是领域逻辑，与"怎么把事件送过 IPC"无关。
 * 壳那一侧因此只剩一行 `bus.subscribe((e) => wc.send(IPC.agentStream, e))`，
 * 而 Electron / Web / 鸿蒙三端这一行几乎一样 —— 这就是分层的收益。
 *
 * 与 EventEmitter 的三处刻意差异：
 *   1. 只能发 `AgentStreamEvent`，不是 `(name: string, ...args: any[])`。
 *      事件名写错是**编译错误**，不是运行时什么都不发生。
 *   2. `subscribe` 直接返回退订函数 —— 退订泄漏是本项目踩过的坑
 *      （自检里有一条专门断言它），把退订做成返回值让"忘了退订"更显眼。
 *   3. `publish` 返回**送达份数** —— 让"事件发出去没人接"可以被断言。
 *      否则一个监听器都没挂时，整个通道看起来运转正常。
 */
export class StreamBus {
  readonly #listeners = new Set<StreamListener>();

  subscribe(listener: StreamListener): Unsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  publish(event: AgentStreamEvent): number {
    // 先快照再遍历。监听器在自己被调用时退订（或订阅新的）会改变 Set 的迭代，
    // 直接遍历 Set 可能漏掉后面的人 —— 这类 bug 只在"派发中途退订"时出现，
    // 极难复现，所以在这里一次付清。
    const snapshot = [...this.#listeners];
    for (const listener of snapshot) listener(event);
    return snapshot.length;
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }
}
