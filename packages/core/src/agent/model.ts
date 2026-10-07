/**
 * 上游模型的抽象。
 *
 * 现在只有脚本实现；接真实 LLM 时实现同一个接口即可，**runtime 一行不用改**。
 * 这就是"能力探测 / 端口注入"在 Agent 内核里的样子：
 * core 不知道对面是 DeepSeek、ollama 还是本地小模型。
 */

import type { AgentDeps, Cancel } from './deps.js';
import { errorMessage } from '../errorMessage.js';

export interface ModelRequest {
  readonly sessionId: string;
  readonly prompt: string;
}

export interface ModelToolCall {
  readonly name: string;
  readonly args: unknown;
}

/**
 * 流式回调。**主回调都无返回值** —— 这是 T1 spike 实测能过 ArkTS 的形状。
 * ⚠️ 形参类型必须是 string：T1 的反向断言就是拿 `onChunk(number)` 撞出来的。
 */
export interface ModelSink {
  /** 收到一段文本增量。**是增量，调用方负责追加**。 */
  onChunk(text: string): void;
  /**
   * 模型决定调工具。**可选** —— 只有真会调工具的上游才需要实现它。
   */
  onToolCall?(call: ModelToolCall): void;
  /** 上游正常说完。恰好调用一次。 */
  onEnd(): void;
  /** 上游出错。恰好调用一次，与 onEnd 互斥。 */
  onError(message: string): void;
}


export interface ModelPort {
  /**
   * 发起一次流式补全。
   *
   * @returns 取消函数。调用方 abort / 关窗时**必须真的调用它** ——
   *   否则 HTTP 连接会悬着，而且没有任何地方能断言"连接已断"。
   */
  stream(req: ModelRequest, sink: ModelSink): Cancel; // Cancel 来自 agent/deps.ts
}

/**
 * 脚本化模型 —— **故意不是真的模型**。
 *
 * 它在项目里的位置很像测试替身，但作用不止是测试：
 *   · 让流式通道 / 背压 / 工具链路在没有 API key、没有网络的机器上就能被验证
 *   · 让自检的产物是可复现的（真模型每次吐的字都不一样，断言只能写得很弱）
 *
 * 剧本按输入里的标记选择，而不是随机 —— 自检要的是**确定性**。
 */
export const SCRIPTED_REPLY =
  '这是 crossdeck 的流式通道输出：core 的 Agent 内核按 16ms 一帧批量 flush，' +
  'renderer 逐帧累积。这段文本同时验证三件事——单向推送通道可用、' +
  '事件类型跨进程保真、以及暂停/恢复真的能卡住下行流量（而不是"看起来变慢了"）。';

/** 输入里带上它，脚本模型就改为先调一次 echo 工具再回答。 */
export const TOOL_SCENARIO_MARKER = '[[tool:echo]]';

export interface ScriptedModelOptions {
  readonly reply?: string;
  /** 工具调用返回的内容，会被拼进回复文本（便于断言"工具结果确实被用上了"） */
  readonly toolOutputPrefix?: string;
  readonly deps: AgentDeps;
}

export class ScriptedModel implements ModelPort {
  readonly #reply: string;
  readonly #toolOutputPrefix: string;
  readonly #deps: AgentDeps;

  constructor(opts: ScriptedModelOptions) {
    this.#reply = opts.reply ?? SCRIPTED_REPLY;
    this.#toolOutputPrefix = opts.toolOutputPrefix ?? '工具返回：';
    this.#deps = opts.deps
  }

  stream(req: ModelRequest, sink: ModelSink): Cancel {
    let reply = ''
    let cancelStream: Cancel | undefined

    // onEnd 的**幂等收口**。为什么必须幂等：
    //   自然吐完（every 回调里）与外部 cancel() 是**两条都可能到达**的收尾路径。
    //   壳在 run 收尾 / 关窗时都会调一次 cancel()，而它无从知道"其实已经自然结束了"
    //   → 没有这个幂等位，onEnd 就会发两次，直接违反 sink 契约
    //   （"恰好一次、与 onError 互斥"）。实测过：3 字符回复先自然结束再 cancel() → onEnd=2。
    let ended = false
    const finish = (): void => {
      if (ended) return
      ended = true
      sink.onEnd()
    }

    try {
      reply = this.#reply
      if (req.prompt.includes(TOOL_SCENARIO_MARKER)) {
        const asked = req.prompt.split(TOOL_SCENARIO_MARKER).join('').trim()
        reply = `${this.#toolOutputPrefix}${asked} —— 然后这是我的回答。${this.#reply}`
        sink.onToolCall?.({ name: 'echo', args: { text: asked } })
      }

      // 空回复：没有字可滴，但契约要求"恰好一个终态" —— 直接收尾，别让定时器空转。
      if (reply.length === 0) {
        finish()
        return () => {}
      }

      cancelStream = this.#deps.every(10, () => {
        const str = reply.slice(0, 3)
        reply = reply.slice(3)
        sink.onChunk(str)
        if (reply === '') {
          // 切完就**自摘调度**，否则每 10ms 吐一个空串、永不停止（定时器泄漏）。
          cancelStream?.()
          finish()
        }
      })
    } catch (err) {
      // 取消息统一走 core 的 errorMessage —— 这段判断在仓库里有十几处，
      // 就地手写等于把它复制 N 份（改一次要改 N 处、必漏几处）。
      sink.onError(errorMessage(err))
    }

    // 取消函数**只负责"停住上游"，不碰 sink**。
    //   "取消"（我不听了）与"结束"（上游说完了）是两回事：abort 时终态应由 runtime 决定，
    //   它才知道这是中断（error/ABORTED）还是正常收尾。这里若自作主张 onEnd，
    //   runtime 的 abort 再发一个 error → 两个终态。
    return () => {
      cancelStream?.()
    }
  }
}
