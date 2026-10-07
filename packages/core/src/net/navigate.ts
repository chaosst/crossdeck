/**
 * navigate 上游 SSE 帧 → **语义动作** 的映射。
 *
 * 为什么单独一层（而不是在壳里直接 if/else）：
 *   ① 映射规则来自**真帧**（docs/evidence/navigate-sse/），不是来自文档猜测 ——
 *      放 core 就能用录下来的原始字节做确定性回归；
 *   ② 三端必须对"这一帧是什么意思"有一致理解，不一致就是静默漂移；
 *   ③ 这里**不生成 UI 事件**。UI 是各壳的事，core 只回答"这是文本 / 这是来源 /
 *      这是结束 / 这是错误 / 这是我不认识的东西"。
 *
 * ══════════════════════════════════════════════════════════════════
 * 三个坑（每个都有对应负例，改之前先读）
 * ══════════════════════════════════════════════════════════════════
 *
 * ① **`token` 的 data 是 JSON，`done` 的 data 不是。**
 *    服务端：`token` 写的是 `JSON.stringify(text)`（带引号），
 *    `done` 写的是字面量 `__DONE__`（裸的，不是 `"__DONE__"`）。
 *    一把梭 `JSON.parse` 会在 done 上抛。
 *
 * ② **`JSON.parse` 失败不能抛，也不能丢帧。**
 *    解不出来就当原文用。上游哪天改成裸文本（不发引号），
 *    客户端应当"少一层转义"而不是"整个回答消失"。
 *
 * ③ **未知 event 必须上报。**
 *    静默丢弃的后果是：上游加了新事件（比如 `thinking`），
 *    三端界面全部静默失灵，而且**不报错** —— 最难查的一类问题。
 */

import type { SseFrame } from './sse.js';

/**
 * 一帧的语义动作。
 *
 * 用可辨识联合（discriminated union）而不是 `{ kind, payload? }`：
 * 消费端 switch 时能拿到各自字段的类型，且新增 kind 会让所有 switch 被编译器点名。
 */
export type NavigateAction =
  /** 文本增量。**注意是增量**：调用方负责追加，不是替换。 */
  | { readonly kind: 'text'; readonly text: string }
  /**
   * **权威全文**（rev-token-stream 的 `event: answer`）。
   *
   * ⚠️ 语义是**替换**而不是追加 —— 它只在"客户端收到的增量拼接 ≠ 服务端认定的最终答案"
   *    时才由服务端补发。单独一个 kind 就是为了让调用方不可能把它和 `text` 混用：
   *    混用的后果是最终答案变成"全文 + 尾巴"。
   * 收到它就应当用它的内容**整体替换**当前答案。
   */
  | { readonly kind: 'authoritative'; readonly text: string }
  /** 引用来源（去重前）。**不拼进正文**，由 UI 单独展示。 */
  | { readonly kind: 'sources'; readonly sources: readonly string[] }
  /** 本轮结束。收到它 = 可以收尾了。 */
  | { readonly kind: 'done' }
  /** 上游错误（已解出可读消息）。 */
  | { readonly kind: 'error'; readonly message: string }
  /** 未识别的事件名 —— **上报，不静默**。`raw` 是原始 data，便于排查。 */
  | { readonly kind: 'unknown'; readonly event: string; readonly raw: string };

/** navigate 上游已知的事件名。 */
export const NAVIGATE_EVENTS = {
  token: 'token',
  sources: 'sources',
  done: 'done',
  error: 'error',
  /** rev-token-stream 新增：done 之前可选的**权威全文**帧（仅当增量拼接 ≠ 权威全文时才出现） */
  answer: 'answer',
} as const;

/** `done` 帧的 data 字面量（**不是** JSON 字符串，见坑 ①）。 */
export const NAVIGATE_DONE_LITERAL = '__DONE__';

/**
 * 把一帧映射成语义动作。
 *
 * 纯函数：不抛异常、不依赖外部状态。任何"解不出来"的情况都降级成可用的动作。
 */
export function mapNavigateFrame(frame: SseFrame): NavigateAction {
  switch (frame.event) {
    case NAVIGATE_EVENTS.token:
      // 坑 ①③：token 是 JSON 字符串，但解不出来要降级成原文（坑 ②）
      return { kind: 'text', text: decodeJsonStringOrRaw(frame.data) };

    case NAVIGATE_EVENTS.answer:
      // 权威全文帧：语义上也是"文本"，但它**替换**而非追加。
      // 用单独 kind 是为了让调用方不能把它和增量混在一起 —— 一旦混了，
      // 最终答案会出现"全文 + 尾巴"这种拼接错误。
      return { kind: 'authoritative', text: decodeJsonStringOrRaw(frame.data) };

    case NAVIGATE_EVENTS.sources:
      return { kind: 'sources', sources: decodeStringArray(frame.data) };

    case NAVIGATE_EVENTS.done:
      // 坑 ①：这里**不允许**走 JSON 分支。字面量比对即可。
      // 即便上游把 data 写成 `"__DONE__"`（带引号），也认 —— 宽容但不猜测。
      return frame.data === NAVIGATE_DONE_LITERAL || frame.data === `"${NAVIGATE_DONE_LITERAL}"`
        ? { kind: 'done' }
        : { kind: 'unknown', event: frame.event, raw: frame.data };

    case NAVIGATE_EVENTS.error:
      return { kind: 'error', message: decodeJsonStringOrRaw(frame.data) };

    default:
      // 坑 ③：默认分支**必须产出动作**。这里 return 一个 'unknown'，
      // 而不是 `return null` / 什么都不做。
      return { kind: 'unknown', event: frame.event, raw: frame.data };
  }
}

/** 批量映射，保持顺序。 */
export function mapNavigateFrames(frames: readonly SseFrame[]): NavigateAction[] {
  return frames.map(mapNavigateFrame);
}

/**
 * 解一个 JSON 字符串；失败则**原文返回**（坑 ②）。
 *
 * ⚠️ 只接受"解出来是 string"的情况：`data: 123` 解出来是 number，
 * 那不是文本增量，当原文更诚实（否则会把 `123` 变成 `123` 丢掉引号来源，难以排查）。
 */
function decodeJsonStringOrRaw(data: string): string {
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === 'string' ? parsed : data;
  } catch {
    return data;
  }
}

/** 解一个字符串数组；失败/形状不对则返回空数组（宁少不炸）。 */
function decodeStringArray(data: string): string[] {
  try {
    const parsed: unknown = JSON.parse(data);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

/**
 * `sources` 去重（保序）。
 *
 * **为什么客户端必须自己做**：navigate 那句注释写的是"去重保序"，但 T3 实测
 * 有重复（plain 样本 11 项 → 去重 9 项）。注释与实现不符时以实测为准。
 */
export function dedupeSources(sources: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of sources) {
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}
