import type { AgentStreamEvent, Usage } from '@crossdeck/contract';
import { StreamBus } from '../events/streamBus.js';
import { BACKPRESSURE_DEFAULTS, BackpressurePump } from './backpressure.js';
import type { BackpressureConfig, DrainingSummary } from './backpressure.js';
import type { AgentDeps } from './deps.js';
import type { ModelPort, ModelReply, ModelToolCall } from './model.js';
import { ToolRegistry, echoTool } from './tools.js';

/**
 * Agent 运行时 —— 一次 run 的完整生命周期。
 *
 * 它替换了 M3 里那个写在壳里的 `runScripted()`。区别不是"代码搬到哪了"，
 * 而是搬完之后**这些约束第一次可以被断言**：
 *
 *   · 一个 run **恰好**一个终态事件（重复收尾会被挡住）
 *   · 背压算法不再绑定真实定时器，可以逐帧确定性验证
 *   · 工具失败的语义是 `tool_end.ok = false`，而不是把整个 run 打挂
 *   · 事件分发（谁在听、退订后还收不收）与传输（怎么过 IPC）彻底分开
 *
 * 壳那一侧因此只剩三行适配：`setInterval` → `every`、`Date.now` → `now`、
 * `bus.subscribe` → `webContents.send`。三端壳的这三行几乎一样。
 */

export type TerminalEvent = Extract<AgentStreamEvent, { type: 'done' | 'error' }>;

export interface StartRunInput {
  readonly sessionId: string;
  readonly input: string;
}

export interface AgentRuntimeOptions {
  readonly deps: AgentDeps;
  readonly model: ModelPort;
  /** 缺省只有一个 `echo`；真实工具由壳注册进来。 */
  readonly tools?: ToolRegistry;
  readonly pumpConfig?: BackpressureConfig;
}

interface ActiveRun {
  readonly runId: string;
  readonly sessionId: string;
  readonly input: string;
  readonly startedAt: number;
  pump: BackpressurePump | null;
  aborted: boolean;
  /** 已经发过终态事件 —— 之后任何事件都必须被丢弃并计数 */
  settled: boolean;
}

export class AgentRuntime {
  readonly #bus = new StreamBus();
  readonly #deps: AgentDeps;
  readonly #model: ModelPort;
  readonly #tools: ToolRegistry;
  readonly #pumpConfig: BackpressureConfig;
  readonly #runs = new Map<string, ActiveRun>();
  #droppedAfterTerminal = 0;

  constructor(opts: AgentRuntimeOptions) {
    this.#deps = opts.deps;
    this.#model = opts.model;
    this.#pumpConfig = opts.pumpConfig ?? BACKPRESSURE_DEFAULTS;

    if (opts.tools !== undefined) {
      this.#tools = opts.tools;
    } else {
      const tools = new ToolRegistry();
      tools.register(echoTool);
      this.#tools = tools;
    }
  }

  /** 事件订阅入口。壳把它接到 `webContents.send(IPC.agentStream, e)`。 */
  get bus(): StreamBus {
    return this.#bus;
  }

  get tools(): ToolRegistry {
    return this.#tools;
  }

  startRun(input: StartRunInput): { runId: string } {
    const runId = this.#deps.newId('run');
    const run: ActiveRun = {
      runId,
      sessionId: input.sessionId,
      input: input.input,
      startedAt: this.#deps.now(),
      pump: null,
      aborted: false,
      settled: false,
    };
    this.#runs.set(runId, run);

    // `start` 必须**同步**发出去，不能等到第一个 await 之后。
    // 调用方（IPC handler）拿到 runId 返回给渲染进程时，
    // 渲染进程那边的订阅就该已经见过 start 了 —— 否则会漏掉首个事件，
    // 也就是"订阅晚于派发"这个经典竞态。
    this.#bus.publish({ type: 'start', runId, at: run.startedAt });

    void this.#drive(run);
    return { runId };
  }

  /**
   * 反向流控。
   *
   * @returns false 表示该 run 不存在或已终结 —— 调用方应当把它当 NOT_FOUND 抛出去。
   *   **不要**静默返回成功：那会让 renderer 以为"暂停生效了"，
   *   而实际上那个 run 早就结束，UI 状态与真实状态不一致。
   */
  pause(runId: string): boolean {
    const run = this.#runs.get(runId);
    if (run === undefined || run.pump === null || run.settled) return false;
    run.pump.pause();
    return true;
  }

  resume(runId: string): boolean {
    const run = this.#runs.get(runId);
    if (run === undefined || run.pump === null || run.settled) return false;
    run.pump.resume();
    return true;
  }

  pauseOrResume(runId: string, type: 'pause' | 'resume'): boolean {
    return type === 'pause' ? this.pause(runId) : this.resume(runId);
  }

  abort(runId: string): boolean {
    const run = this.#runs.get(runId);
    if (run === undefined || run.settled) return false;
    run.aborted = true;
    this.#settle(run, { type: 'error', runId, code: 'ABORTED', message: '已被用户中断' });
    return true;
  }

  /**
   * 会话被删 / 窗口关闭时调用，避免调度泄漏。
   *
   * 刻意**不发**终态事件：走到这里说明接收方正在消失，
   * 往一个已经关掉的 webContents 发事件只会浪费一次序列化。
   */
  stopAll(): void {
    for (const run of this.#runs.values()) run.pump?.stop();
    this.#runs.clear();
  }

  get activeRunCount(): number {
    return this.#runs.size;
  }

  /**
   * 终态之后仍被投递的事件数 —— 应当恒为 0。
   * 非 0 说明有调度没摘干净（定时器泄漏），而且它**不会**表现为崩溃，
   * 只会表现为"偶尔多收到一个 token"，所以必须有地方把它记下来。
   */
  get droppedAfterTerminal(): number {
    return this.#droppedAfterTerminal;
  }

  async #drive(run: ActiveRun): Promise<void> {
    const pump = new BackpressurePump(
      {
        flush: (text) => {
          this.#emit(run, { type: 'token', runId: run.runId, text });
        },
        drained: (summary) => {
          this.#settle(run, {
            type: 'done',
            runId: run.runId,
            usage: this.#usage(run, summary),
          });
        },
      },
      this.#deps,
      this.#pumpConfig,
    );
    run.pump = pump;
    pump.start();

    let reply: ModelReply | null = null;
    try {
      reply = await this.#model.complete({ sessionId: run.sessionId, prompt: run.input });
    } catch (err) {
      // 上游挂了是**一次 run 的失败**，不是进程的失败 ——
      // 必须走 error 事件让 UI 显性化，而不是让这个 Promise 静默 rejection。
      if (!run.settled) {
        this.#settle(run, {
          type: 'error',
          runId: run.runId,
          code: 'UPSTREAM',
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (reply === null || run.aborted || run.settled) return;

    // 工具在前、正文在后 —— 模型的"先干活再回答"。
    for (const call of reply.toolCalls ?? []) {
      await this.#runTool(run, call);
      if (run.aborted || run.settled) return;
    }

    if (reply.text.length > 0) pump.push(reply.text);
    // 顺序不能反：先 closeUpstream 再 push 的话，下一次搬运就会看到
    // "上游已关 + 队列空"而提前收尾，最后这段正文会被丢掉。
    pump.closeUpstream();
  }

  async #runTool(run: ActiveRun, call: ModelToolCall): Promise<void> {
    const callId = this.#deps.newId('call');
    this.#emit(run, {
      type: 'tool',
      runId: run.runId,
      callId,
      name: call.name,
      args: call.args,
    });

    const startedAt = this.#deps.now();
    const result = await this.#tools.invoke(call.name, call.args);
    const ms = this.#deps.now() - startedAt;

    this.#emit(run, { type: 'tool_end', runId: run.runId, callId, ok: result.ok, ms });
    // 工具输出**不**直接塞进下行文本：那是模型的职责（它要决定怎么表述）。
    // 内核只负责把结果作为事件如实报出去。
  }

  #emit(run: ActiveRun, event: AgentStreamEvent): void {
    if (run.settled) {
      this.#droppedAfterTerminal += 1;
      return;
    }
    this.#bus.publish(event);
  }

  #settle(run: ActiveRun, terminal: TerminalEvent): boolean {
    if (run.settled) return false;
    run.settled = true;
    run.pump?.stop();
    this.#runs.delete(run.runId);
    this.#bus.publish(terminal);
    return true;
  }

  #usage(run: ActiveRun, summary: DrainingSummary): Usage {
    const usage: Usage = {
      promptTokens: run.input.length,
      completionTokens: summary.acceptedChars,
      totalMs: this.#deps.now() - run.startedAt,
      mergedChunks: summary.mergedChunks,
    };
    // exactOptionalPropertyTypes 开着：字段可能 undefined 时不能直接写进去。
    if (summary.ttftMs !== undefined) usage.ttftMs = summary.ttftMs;
    return usage;
  }
}
