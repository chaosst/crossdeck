/**
 * navigate 上游 SSE 帧 → **语义动作** 的映射。
 *
 * 放在 core 而不是壳里：映射规则来自**真帧**（`docs/evidence/navigate-sse/`），
 * 放这里才能用录下来的原始字节做确定性回归；且三端对"这一帧是什么意思"必须一致。
 * 这里**不生成 UI 事件** —— 只回答"这是文本 / 来源 / 结束 / 错误 / 不认识的东西"。
 *
 * 三个坑（每个都有对应负例）：
 *   ① `token` 的 data 是 JSON（带引号），`done` 的 data 是裸字面量 `__DONE__`；
 *      一把梭 `JSON.parse` 会在 done 上抛。
 *   ② `JSON.parse` 失败不能抛、也不能丢帧 —— 解不出来就当原文用。
 *   ③ 未知 event **必须上报**：上游加了新事件而三端静默失灵，是最难查的一类问题。
 */

import type { SseFrame } from './sse.js';

/**
 * 一帧的语义动作。用可辨识联合，消费端 switch 时能拿到各自字段，新增 kind 会被编译器点名。
 */
export type NavigateAction =
  /** 文本增量。**是增量**：调用方负责追加，不是替换。 */
  | { readonly kind: 'text'; readonly text: string }
  /**
   * **权威全文**（`event: answer`）。语义是**替换**而非追加，只在"增量拼接 ≠ 服务端认定的
   * 最终答案"时补发。单独一个 kind 就是为了让调用方不可能把它和 `text` 混用。
   */
  | { readonly kind: 'authoritative'; readonly text: string }
  /** 引用来源（去重前）。**不拼进正文**，由 UI 单独展示。 */
  | { readonly kind: 'sources'; readonly sources: readonly string[] }
  /** 本轮结束。 */
  | { readonly kind: 'done' }
  /** 上游错误（已解出可读消息）。 */
  | { readonly kind: 'error'; readonly message: string }
  /** 未识别的事件名 —— **上报，不静默**。`raw` 是原始 data。 */
  | { readonly kind: 'unknown'; readonly event: string; readonly raw: string };

/** navigate 上游已知的事件名。 */
export const NAVIGATE_EVENTS = {
  token: 'token',
  sources: 'sources',
  done: 'done',
  error: 'error',
  /** done 之前可选的**权威全文**帧（仅当增量拼接 ≠ 权威全文时才出现） */
  answer: 'answer',
} as const;

/** `done` 帧的 data 字面量（**不是** JSON 字符串，见坑 ①）。 */
export const NAVIGATE_DONE_LITERAL = '__DONE__';

/** 把一帧映射成语义动作。纯函数：不抛异常、不依赖外部状态。 */
export function mapNavigateFrame(frame: SseFrame): NavigateAction {
  switch (frame.event) {
    case NAVIGATE_EVENTS.token:
      return { kind: 'text', text: decodeJsonStringOrRaw(frame.data) };

    case NAVIGATE_EVENTS.answer:
      return { kind: 'authoritative', text: decodeJsonStringOrRaw(frame.data) };

    case NAVIGATE_EVENTS.sources:
      return { kind: 'sources', sources: decodeStringArray(frame.data) };

    case NAVIGATE_EVENTS.done:
      // 不走 JSON 分支：字面量比对。上游若写成带引号也认 —— 宽容但不猜测。
      return frame.data === NAVIGATE_DONE_LITERAL || frame.data === `"${NAVIGATE_DONE_LITERAL}"`
        ? { kind: 'done' }
        : { kind: 'unknown', event: frame.event, raw: frame.data };

    case NAVIGATE_EVENTS.error:
      return { kind: 'error', message: decodeJsonStringOrRaw(frame.data) };

    default:
      // 默认分支**必须**产出动作，不能答 null / 什么都不做（坑 ③）。
      return { kind: 'unknown', event: frame.event, raw: frame.data };
  }
}

/** 批量映射，保持顺序。 */
export function mapNavigateFrames(frames: readonly SseFrame[]): NavigateAction[] {
  return frames.map(mapNavigateFrame);
}

/** 解一个 JSON 字符串；失败则**原文返回**（坑 ②）。只接受"解出来是 string"的情况。 */
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
 * 客户端必须自己做：navigate 的注释写"去重保序"，但实测有重复（11 项 → 9 项）。
 * 注释与实现不符时以实测为准。
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
