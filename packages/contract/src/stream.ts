/**
 * Agent 流式事件 —— main → renderer 逐块推送的载荷。
 *
 * 为什么用 discriminated union 而不是 `{ type: string; payload: any }`：
 *   renderer 侧 `switch (e.type)` 时 TS 能收窄到具体成员，
 *   `e.text` 只在 `token` 分支合法、`e.callId` 只在 `tool*` 分支合法。
 *   写错访问路径 = 编译错误，而不是运行时 undefined。
 */

export type AgentStreamEvent =
  | { type: 'start'; runId: string; at: number }
  | { type: 'token'; runId: string; text: string }
  | { type: 'tool'; runId: string; callId: string; name: string; args: unknown }
  | { type: 'tool_end'; runId: string; callId: string; ok: boolean; ms: number }
  | { type: 'plan'; runId: string; steps: PlanStep[] }
  | { type: 'done'; runId: string; usage: Usage }
  | { type: 'error'; runId: string; code: ErrorCode; message: string };

/** 事件类型名的联合，便于做 switch 穷尽性检查（never 兜底）。 */
export type AgentStreamEventType = AgentStreamEvent['type'];

export type PlanStepStatus = 'pending' | 'running' | 'done' | 'failed';

export interface PlanStep {
  id: string;
  title: string;
  status: PlanStepStatus;
}

export interface Usage {
  /**
   * ⚠️ **字符数，不是 token 数。**
   *
   * 上游（navigate）**不返回 usage**，所以没有 tokenizer 可依。这两个字段装的是
   * 输入 / 输出的**文本长度**（`run.input.length` / 泵实际吐出的字符数）。
   *
   * 名字沿用了 OpenAI 兼容接口的形状，但**别拿它当计费口径**：
   * 「字符数」与「token 数」在中文下能差出接近一个数量级。
   * 三端 UI 的标签一律写「字符」，不写 tokens。
   */
  promptTokens: number;
  completionTokens: number;
  totalMs: number;
  /**
   * **本地首帧延迟**：从 `pump.start()` 到泵**第一次吐出**一帧的时间（毫秒）。
   *
   * ⚠️ 它**不含上游首 token 延迟** —— 起点在 run 开始，终点在泵的第一次 flush，
   * 中间上游还没吐出任何东西时这个数就已经在计时了。接脚本上游时它约等于
   * `produceIntervalMs + flushIntervalMs`（12+16≈28ms）；接真实上游后它会
   * 变成「上游首 token + 本地泵延迟」，那时它就不再是"本项目自有开销"的度量。
   * 需要区分两者时得另加采集点（当前没有）。
   */
  ttftMs?: number;
  /**
   * 流控健康度：因消费端跟不上而**合并中间态**的次数（M4 背压）。
   *
   * 正常情况下恒为 0。非 0 说明 renderer 那一侧已经开始跟不上推送速率，
   * 应当降频或减少渲染量 —— 关键是把"有点卡"变成**一个可观测的数字**，
   * 而不是等用户来抱怨。可选：缺失不影响任何既有分支。
   */
  mergedChunks?: number;
}

export type ErrorCode =
  | 'ABORTED'
  | 'RATE_LIMIT'
  | 'TOOL_FAILED'
  | 'UPSTREAM'
  | 'UNKNOWN';

/**
 * 穷尽性守卫：给 switch 补 default 时用。
 * 新增一种事件类型而忘处理 → 编译期报错。
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled stream event: ${JSON.stringify(value)}`);
}
