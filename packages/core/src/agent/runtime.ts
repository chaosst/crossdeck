import type { AgentStreamEvent, Usage } from '@crossdeck/contract';
import { StreamBus } from '../events/streamBus.js';
import { errorMessage } from '../errorMessage.js';
import { BACKPRESSURE_DEFAULTS, BackpressurePump } from './backpressure.js';
import type { BackpressureConfig, DrainingSummary } from './backpressure.js';
import type { AgentDeps, Cancel } from './deps.js';
import type { ModelPort, ModelToolCall } from './model.js';
import { ToolRegistry, echoTool } from './tools.js';

/**
 * 断流兜底守卫的默认参数（**运行时半边**；另一半在壳的 HTTP 实现里，见计划 T6-b）。
 *
 * 上游既没说结束也没报错就断了 → 仍必须收尾出一个终态，
 * 否则失败模式是"token 全到齐、UI 永远转圈"。
 *
 * ⚠️ 只有一半兜不住全部：`stream()` 是**同步返回**的，上游不发回调它也不会"抛" ——
 * runtime 只能靠"多久没动静"来猜。真正的断流信号在壳那一半
 * （HTTP 实现要在关流 / 首帧超时时主动调 `sink.onError`）。两半都要有。
 *
 * 超时取 60s 是**刻意保守**：这是粗粒度后备，宁可晚发现，也不要误杀
 * 上游正常的"思考停顿"（工具调用期间可能长时间没有 onChunk）。
 */
export const STALL_GUARD_DEFAULTS = {
  /** 多久查一次"还有没有进展"（用注入的 `every`，不许 setTimeout） */
  checkIntervalMs: 1000,
  /** 连续多久无 `onChunk` / `onToolCall` 视为断流，兜底收尾 */
  timeoutMs: 60_000,
} as const;

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
  /** 上游取消函数（`model.stream()` 同步返回的那个）—— abort 时真的调它 */
  cancel: Cancel | null;
  /** 断流兜底守卫的摘除函数 —— 收尾时必须调，否则会留下一个永不停的定时器 */
  guard: Cancel | null;
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
      cancel: null,
      guard: null,
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
    // 断上游（真的断连接）由 `#settle` 这个**单一出口**统一做 ——
    // 所有终态路径都必须释放上游，兜底守卫那条尤其重要：
    // 它是在"上游还挂着"的情况下强行收尾的，不 cancel 就把连接晾在那儿了。
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
    for (const run of this.#runs.values()) {
      // 三样都要摘：上游（定时器 / HTTP 连接）、泵、断流守卫。
      // 少摘上游就会留下一个永不停的定时器 —— 这正是本方法存在的意义（"避免调度泄漏"）。
      run.cancel?.();
      run.pump?.stop();
      run.guard?.();
    }
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

    // 上游是否已经"表过态"（说过 onEnd 或报过 onError）。
    let ended = false;
    // 最近一次"有进展"（onChunk / onToolCall）的时刻 —— 断流守卫的判据。
    let lastProgressAt = this.#deps.now();

    try {
      run.cancel = this.#model.stream(
        { sessionId: run.sessionId, prompt: run.input },
        {
          onChunk: (text: string) => {
            lastProgressAt = this.#deps.now();
            pump.push(text);
          },
          // 工具调用时机由**上游**决定，而不是"整段回答回来之后"。
          onToolCall: (call: ModelToolCall) => {
            lastProgressAt = this.#deps.now();
            void this.#runTool(run, call);
          },
          onEnd: () => {
            ended = true;
            pump.closeUpstream();
          },
          onError: (message: string) => {
            ended = true;
            // 上游报错 ≠ 用户中断，不能用 ABORTED ——
            // 那会让 UI 把"服务器 500"显示成"你取消了"。
            this.#settle(run, { type: 'error', runId: run.runId, code: 'UPSTREAM', message });
          },
        },
      );

      // ── 断流兜底守卫（**运行时半边**；壳那半由 HTTP 实现在关流/首帧超时时调 onError）──
      // 判据：既没 onEnd 也没 onError，且 onChunk / onToolCall 也停了 → 主动收尾。
      // ⚠️ 极性要害：是"**还没**表态"才兜底。
      //    写成 `if (!ended) return` 就是把判据反了过来 ——
      //    变成"正常结束之后"才触发，去和 drained 抢终态（把 done 压成 error ABORTED
      //    并丢掉队列里最后一段），而真正该管的静默断流一个都兜不到（UI 永远转圈）。
      const guard = STALL_GUARD_DEFAULTS;
      run.guard = this.#deps.every(guard.checkIntervalMs, () => {
        if (ended || run.settled) return;
        if (this.#deps.now() - lastProgressAt < guard.timeoutMs) return;
        this.#settle(run, {
          type: 'error',
          runId: run.runId,
          code: 'UPSTREAM',
          message: `上游 ${guard.timeoutMs}ms 无任何数据（疑似断流）`,
        });
      });

      // 上游可能在 `stream()` 里就**同步**调了 onError（例如"参数校验失败立刻报错"）。
      // 那种情况下上面的 `#settle` 已经跑完了，而守卫是**后**注册的 —— 它错过了
      // `#settle` 里的那次摘除，会变成一个永不停的定时器（不崩不报错，只是泄漏）。
      // 所以注册完必须自查一次。
      if (run.settled) {
        run.guard();
        run.guard = null;
      }
    } catch (err) {
      // 上游挂了是**一次 run 的失败**，不是进程的失败 ——
      // 必须走 error 事件让 UI 显性化，而不是让这个 Promise 静默 rejection。
      if (!run.settled) {
        this.#settle(run, {
          type: 'error',
          runId: run.runId,
          code: 'UPSTREAM',
          message: errorMessage(err),
        });
      }
      return;
    }
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
    // 一个 run 走到终态时，"三样调度"都必须收干净，一个都不能漏：
    //   ① 上游（HTTP 连接 / 它的定时器）—— 最容易漏，兜底守卫那条路径尤其明显
    //   ② 背压泵（produce / flush 两个定时器）
    //   ③ 断流守卫（deps.every 注册的检查循环）
    // 漏掉任何一个都不崩不报错，只表现为"收尾后还在空转"，很难被发现。
    run.cancel?.();
    run.pump?.stop();
    run.guard?.();
    run.guard = null;
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
