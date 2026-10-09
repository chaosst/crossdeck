/**
 * 端口形状对照 spike：**回调式** vs **异步可迭代**
 *
 * ## 要回答的问题
 *
 * crossdeck 要把 ModelPort 从 `Promise<ModelReply>`（一次性）改成流式。
 * 两种候选形状：
 *   A 组 · 回调式      —— sink 带三个无返回值回调，`stream()` 返回取消函数
 *   B 组 · 异步可迭代  —— `stream()` 返回 `AsyncIterable<string>`，外面 `for await`
 *
 * 为什么这件事必须先做：`contract` 里目前 **零** `AsyncIterable` / `for await` 先例，
 * 而 `FsPort.watch(): Promise<() => void>` 与 `StreamBus.subscribe()` 两个
 * **同形状的**回调式先例已经过 ArkTS 实测。用已被证明的形状，比引入未验证的形状便宜。
 * 但"便宜"不是证据 —— 这个文件就是证据。
 *
 * ## 为什么必须是 `.ts` 而不是 `.ets`
 *
 * M6-0 已实测：同一份内容改成 `.ets` 会被 ArkTS 拒绝（`arkts-no-conditional-types`）。
 * `.ts` 走 TypeScript 规则（宽松）。反例留档见 `spike/ets-rejects-conditional-types.ets.txt`。
 *
 * ## ⚠️ 只 import 不调用 = 没测
 *
 * 泛型/接口若不被实例化，编译器可能根本不检查。所以本文件提供两个**真的会被调用**
 * 的探针入口，且由 `pages/Index.ets` 在 `aboutToAppear` 里真实调用。
 */

// ═══════════════════════════════════════════════════════════════════
// A 组 · 回调式（crossdeck 现有先例的同形状）
// ═══════════════════════════════════════════════════════════════════

export interface ModelRequest {
  readonly sessionId: string;
  readonly input: string;
}

/** 三个回调，**都无返回值** —— 与 `FsPort.watch` 的 `() => void` 同构。 */
export interface ModelSink {
  onChunk(text: string): void;
  onEnd(): void;
  onError(err: unknown): void;
}

/** 取消函数 —— 与 `FsPort.watch()` 的返回形状一致。 */
export type Cancel = () => void;

export interface CallbackModelPort {
  stream(req: ModelRequest, sink: ModelSink): Cancel;
}

export class ScriptedCallbackModel implements CallbackModelPort {
  stream(req: ModelRequest, sink: ModelSink): Cancel {
    // 真的调三次回调（覆盖"数据 / 结束 / 错误"三条通路）
    sink.onChunk('A1');
    sink.onChunk(req.input);
    sink.onEnd();
    return (): void => {
      // 真实的取消实现会 abort 上游；探针里只需证明这个形状能表达
    };
  }
}

/** 消费点：同步驱动，返回可断言的字符串。 */
export function runCallbackProbe(input: string): string {
  const port: CallbackModelPort = new ScriptedCallbackModel();
  let acc = '';
  let ended = false;
  const cancel: Cancel = port.stream(
    { sessionId: 'probe', input },
    {
      onChunk(text: string): void {
        acc = acc + text;
      },
      onEnd(): void {
        ended = true;
      },
      onError(err: unknown): void {
        acc = acc + '!' + String(err);
      },
    },
  );
  cancel();
  return acc + '|ended=' + (ended ? 'Y' : 'N');
}

// ═══════════════════════════════════════════════════════════════════
// B 组 · 异步可迭代（**contract 里零先例**，风险项）
// ═══════════════════════════════════════════════════════════════════

export interface AsyncModelPort {
  stream(req: ModelRequest): AsyncIterable<string>;
}

export class ScriptedAsyncModel implements AsyncModelPort {
  async *stream(req: ModelRequest): AsyncIterable<string> {
    yield 'B1';
    yield req.input;
  }
}

/** 消费点：`for await` —— 这是 contract 里**从未出现过**的语法。 */
export async function runAsyncProbe(input: string): Promise<string> {
  const port: AsyncModelPort = new ScriptedAsyncModel();
  let acc = '';
  for await (const chunk of port.stream({ sessionId: 'probe', input })) {
    acc = acc + chunk;
  }
  return acc + '|forAwait=Y';
}

