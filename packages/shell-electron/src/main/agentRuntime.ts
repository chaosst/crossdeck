import { webContents } from 'electron';
import { IPC } from '@crossdeck/contract';
import type { AgentStreamEvent, Usage } from '@crossdeck/contract';
import { isRunAborted } from './ipc.js';

/**
 * 脚本化的 Agent 运行时。
 *
 * ⚠️ 这里**不是**真的 Agent。它的唯一职责是把「main → renderer 的单向流式通道」
 *    跑通并可被验证：事件顺序、跨进程序列化、中断、结束统计。
 *    M3 会把 runScripted() 换成真正接 core Agent 内核的调用
 *    （届时 core 的 events 模块产出的就是同一套 AgentStreamEvent）。
 *
 * 为什么现在就要做这一步而不是留空：
 *    `agent:stream` 是不走 invoke 的**单向推送**通道，它和 invoke 是两套完全不同的
 *    失败模式（背压、乱序、监听泄漏）。如果留到 M3 再验证，M0 那套类型对齐
 *    其实只覆盖了一半的 IPC 面。
 */

const activeRuns = new Map<string, ReturnType<typeof setInterval>>();

const REPLY =
  '这是 crossdeck 的流式通道自检输出：main 进程逐块推送，renderer 逐块累积。' +
  '它证明了三件事——单向推送通道可用、事件类型跨进程保真、中断可以被观察到。';

export interface RunHandle {
  runId: string;
}

function emit(runId: string, windowId: number, event: AgentStreamEvent): void {
  const wc = webContents.fromId(windowId);
  // 窗口可能在流式过程中被关掉 —— 静默失败是正确的，不该因此中断 run。
  if (!wc || wc.isDestroyed()) return;
  wc.send(IPC.agentStream, event);
}

export function runScripted(windowId: number, sessionId: string, input: string): RunHandle {
  const runId = `run_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const startedAt = Date.now();

  emit(runId, windowId, { type: 'start', runId, at: startedAt });

  // 按「字」切块，模拟 token 流；每 24ms 一块，肉眼可见但不至于太慢。
  const chunks = [...REPLY];
  let cursor = 0;
  let ttftMs: number | undefined;

  const timer = setInterval(() => {
    if (isRunAborted(runId)) {
      clearInterval(timer);
      activeRuns.delete(runId);
      emit(runId, windowId, {
        type: 'error',
        runId,
        code: 'ABORTED',
        message: '已被用户中断',
      });
      return;
    }

    if (cursor >= chunks.length) {
      clearInterval(timer);
      activeRuns.delete(runId);

      const usage: Usage = {
        promptTokens: input.length,
        completionTokens: chunks.length,
        totalMs: Date.now() - startedAt,
      };
      // exactOptionalPropertyTypes 开着：字段可能 undefined 时不能直接写进去。
      if (ttftMs !== undefined) usage.ttftMs = ttftMs;

      emit(runId, windowId, { type: 'done', runId, usage });
      return;
    }

    const batchSize = 3;
    const text = chunks.slice(cursor, cursor + batchSize).join('');
    cursor += batchSize;

    if (ttftMs === undefined) ttftMs = Date.now() - startedAt;
    emit(runId, windowId, { type: 'token', runId, text });
  }, 24);

  activeRuns.set(runId, timer);
  return { runId };
}

/** 会话被删 / 窗口关闭时调用，避免定时器泄漏。 */
export function stopAllRuns(): void {
  for (const timer of activeRuns.values()) clearInterval(timer);
  activeRuns.clear();
}

export function activeRunCount(): number {
  return activeRuns.size;
}
