export type Cancel = () => void;

/**
 * Agent 运行时的注入面。
 *
 * 与 `SessionStore` 同一种风格：注入的是**函数**而不是对象，且 core 一个
 * 平台 API 都不碰 —— 这里没有 `setInterval`，也没有 `Date.now` 的类型依赖
 * （core 的 `lib` 只有 ES2022，想写也编译不过）。
 *
 * 收益不是"看起来优雅"，而是**可确定性测试**：
 * 测试注入一个手动推进的 `every()`，就能在没有一个真实定时器的情况下，
 * 把背压算法（帧对齐、暂停零推送、队列超限合并、上游耗尽收尾）逐帧验完。
 * 见 `scripts/verify-core-agent.mjs` —— 它跑的 0ms 真实等待。
 *
 * 反过来说：如果哪天有人为了"方便"在 core 里直接写 `setInterval`，
 * 这个文件就失去意义了，而背压会变回"只能靠端到端碰运气验"。
 */
export interface AgentDeps {
  /** 单调时钟。测试里可快进，不必真等。 */
  readonly now: () => number;
  /** 周期调度；返回取消函数。Electron 壳传 setInterval，测试传手动泵。 */
  readonly every: (intervalMs: number, fn: () => void) => Cancel;
  /** id 生成器（前缀用于日志里一眼看出是什么 run）。 */
  readonly newId: (prefix: string) => string;
}
