/**
 * 工具注册表。
 *
 * 它存在的意义是让"Agent 能干活"这件事有结构，而不是让模型吐一段文字就完事：
 * 一次 run 的事件序列因此是 `start → (plan?) → tool → tool_end → token* → done`，
 * 每一段都能被独立断言。
 *
 * 一条刻意的设计：`invoke()` **不抛异常**。
 * 工具失败是**正常业务结果**（要变成 `tool_end.ok = false` 让 UI 显示一个红叉，
 * 并让模型有机会换个工具重试），而不是把整个 run 打挂。
 * 把"工具炸了"和"框架炸了"混成同一个信号，是 Agent 系统里最常见的诊断灾难。
 */

import { errorMessage } from '../errorMessage.js';

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  /** 参数的人类可读提示（用于工具卡片展示）。刻意不上 JSON Schema —— 那是 M6 的事 */
  readonly argsHint?: string;
  run(args: unknown): Promise<string> | string;
}

export interface ToolCallResult {
  readonly ok: boolean;
  readonly output: string;
}

export class ToolRegistry {
  readonly #tools = new Map<string, ToolSpec>();

  register(spec: ToolSpec): void {
    // 重复注册会让后注册的静默覆盖前者 —— 那种 bug 只在"调用时行为和预期不符"
    // 时才暴露，所以在注册期直接抛。
    if (this.#tools.has(spec.name)) {
      throw new Error(`工具重复注册：${spec.name}（后者会静默覆盖前者）`);
    }
    this.#tools.set(spec.name, spec);
  }

  get(name: string): ToolSpec | undefined {
    return this.#tools.get(name);
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  /** 注册顺序即声明顺序 —— 送给模型的工具列表要保持稳定，便于缓存与快照测试。 */
  names(): string[] {
    return [...this.#tools.keys()];
  }

  get size(): number {
    return this.#tools.size;
  }

  async invoke(name: string, args: unknown): Promise<ToolCallResult> {
    const tool = this.#tools.get(name);
    if (tool === undefined) {
      return { ok: false, output: `未知工具：${name}` };
    }
    try {
      return { ok: true, output: await tool.run(args) };
    } catch (err) {
      return { ok: false, output: errorMessage(err) };
    }
  }
}

/**
 * 内置的 `echo` 工具 —— 最小可用的工具实现，用于验证工具链路。
 *
 * 它不是"占位符"：让自检能在**真通道**上跑出 `tool` / `tool_end` 事件，
 * 而不是只在单测里跑。没有它，工具链路直到第一次接真模型之前都是纸面设计。
 */
export const echoTool: ToolSpec = {
  name: 'echo',
  description: '把入参原样返回。用于验证工具调用链路。',
  argsHint: 'text: string',
  run(args: unknown): string {
    if (typeof args === 'string') return args;
    if (args !== null && typeof args === 'object' && 'text' in args) {
      return String((args as { text: unknown }).text);
    }
    return JSON.stringify(args);
  },
};
