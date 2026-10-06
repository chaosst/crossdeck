/**
 * 上游模型的抽象。
 *
 * 现在只有脚本实现；接真实 LLM 时实现同一个接口即可，**runtime 一行不用改**。
 * 这就是"能力探测 / 端口注入"在 Agent 内核里的样子：
 * core 不知道对面是 DeepSeek、ollama 还是本地小模型。
 */

export interface ModelRequest {
  readonly sessionId: string;
  readonly prompt: string;
}

export interface ModelToolCall {
  readonly name: string;
  readonly args: unknown;
}

export interface ModelReply {
  readonly text: string;
  /** 模型决定先调工具再回答时给出；空数组与缺省等价。 */
  readonly toolCalls?: readonly ModelToolCall[];
}

export interface ModelPort {
  complete(req: ModelRequest): Promise<ModelReply>;
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
}

export class ScriptedModel implements ModelPort {
  readonly #reply: string;
  readonly #toolOutputPrefix: string;

  constructor(opts: ScriptedModelOptions = {}) {
    this.#reply = opts.reply ?? SCRIPTED_REPLY;
    this.#toolOutputPrefix = opts.toolOutputPrefix ?? '工具返回：';
  }

  complete(req: ModelRequest): Promise<ModelReply> {
    if (req.prompt.includes(TOOL_SCENARIO_MARKER)) {
      const asked = req.prompt.split(TOOL_SCENARIO_MARKER).join('').trim();
      const reply: ModelReply = {
        text: `${this.#toolOutputPrefix}${asked} —— 然后这是我的回答。${this.#reply}`,
        toolCalls: [{ name: 'echo', args: { text: asked } }],
      };
      return Promise.resolve(reply);
    }
    return Promise.resolve({ text: this.#reply });
  }
}
