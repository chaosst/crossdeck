import { webContents } from 'electron';
import { IPC } from '@crossdeck/contract';
import type { AgentStreamEvent, Usage } from '@crossdeck/contract';
import { isRunAborted } from './ipc.js';

/**
 * 脚本化的 Agent 运行时 + **下行流控（背压）**。
 *
 * ⚠️ 这里**不是**真的 Agent。它的唯一职责是把「main → renderer 的单向流式通道」
 *    跑通并可被验证：事件顺序、跨进程序列化、批量 flush、暂停/恢复、中断、结束统计。
 *    M4.5 会把 runScripted() 换成真正接 core Agent 内核的调用
 *    （届时 core 的 events 模块产出的就是同一套 AgentStreamEvent）。
 *
 * 为什么要做背压，而不是「一路 wc.send 就完了」：
 *   `ipcMain.handle` 只能返回一次，但 Agent 输出是 token 流。裸 `webContents.send`
 *   逐块推**没有任何背压** —— 上游快、渲染慢时事件会在渲染进程的队列里堆积，
 *   表现为 UI 越来越卡直到假死，而 main 侧毫无感知（它只是"发出去了"）。
 *   所以：产字与推字**解耦**，推字按帧节流，且可以被反向暂停。
 *
 * 三个参数都不是拍脑袋定的：
 *   - flush 16ms   → 对齐一帧，避免同一帧内多次 setState
 *   - 队列上限 2000 字符 → 超过就**合并中间态**（不是丢尾部）
 *   - pause 期间一个 token 都不推 → 这是"背压"与"降速"的区别
 */

/** 模拟上游产字：每 12ms 产 3 个字符（约 250 字符/秒） */
const PRODUCE_INTERVAL_MS = 12;
const PRODUCE_CHUNK_SIZE = 3;

/** 下行 flush：每 16ms 一帧 */
const FLUSH_INTERVAL_MS = 16;

/** 待 flush 文本的上限；超过就合并中间态 */
const QUEUE_TEXT_LIMIT = 2000;
const QUEUE_KEEP_HEAD = 512;
const QUEUE_KEEP_TAIL = 512;

const REPLY =
  '这是 crossdeck 的流式通道自检输出：main 侧按 16ms 一帧批量 flush，' +
  'renderer 逐帧累积。这段文本同时用来验证三件事——单向推送通道可用、' +
  '事件类型跨进程保真、以及暂停/恢复真的能卡住下行流量（而不是"看起来变慢了"）。';

export interface RunHandle {
  runId: string;
}

interface ActiveRun {
  runId: string;
  windowId: number;
  /** 反向流控：true 时 flush 一帧都不发 */
  paused: boolean;
  cursor: number;
  /** 已产出但还没 flush 的文本 —— 这就是"队列" */
  pending: string;
  /** 因超过上限被合并掉的次数（可观测的流控健康度） */
  mergedChunks: number;
  ttftMs: number | undefined;
  startedAt: number;
  /** 构造期先留空，随后立刻被真正的定时器覆盖 */
  produceTimer: ReturnType<typeof setInterval> | null;
  flushTimer: ReturnType<typeof setInterval> | null;
}

const activeRuns = new Map<string, ActiveRun>();

function emit(runId: string, windowId: number, event: AgentStreamEvent): void {
  const wc = webContents.fromId(windowId);
  // 窗口可能在流式过程中被关掉 —— 静默失败是正确的，不该因此中断 run。
  if (!wc || wc.isDestroyed()) return;
  wc.send(IPC.agentStream, event);
}

/** 收尾：**必须**两条定时器一起清，并保证调用方一定能收到一个终结事件。 */
function finish(run: ActiveRun, terminal: AgentStreamEvent): void {
  if (run.produceTimer !== null) clearInterval(run.produceTimer);
  if (run.flushTimer !== null) clearInterval(run.flushTimer);
  run.pending = '';
  activeRuns.delete(run.runId);
  emit(run.runId, run.windowId, terminal);
}

function buildUsage(run: ActiveRun, input: string, total: number): Usage {
  const usage: Usage = {
    promptTokens: input.length,
    completionTokens: total,
    totalMs: Date.now() - run.startedAt,
    mergedChunks: run.mergedChunks,
  };
  // exactOptionalPropertyTypes 开着：字段可能 undefined 时不能直接写进去。
  if (run.ttftMs !== undefined) usage.ttftMs = run.ttftMs;
  return usage;
}

export function runScripted(windowId: number, sessionId: string, input: string): RunHandle {
  const runId = `run_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const startedAt = Date.now();

  emit(runId, windowId, { type: 'start', runId, at: startedAt });

  const chunks = [...REPLY];
  const run: ActiveRun = {
    runId,
    windowId,
    paused: false,
    cursor: 0,
    pending: '',
    mergedChunks: 0,
    ttftMs: undefined,
    startedAt,
    produceTimer: null,
    flushTimer: null,
  };

  // ── 上游：产字。只往队列里塞，**不发事件** ──────────────
  run.produceTimer = setInterval(() => {
    if (isRunAborted(runId)) {
      finish(run, { type: 'error', runId, code: 'ABORTED', message: '已被用户中断' });
      return;
    }

    if (run.cursor >= chunks.length) {
      // 上游产完了：等 flush 把队列清空再收尾，否则最后一段文本会被吞掉
      if (run.pending === '') {
        finish(run, { type: 'done', runId, usage: buildUsage(run, input, chunks.length) });
      }
      return;
    }

    run.pending += chunks.slice(run.cursor, run.cursor + PRODUCE_CHUNK_SIZE).join('');
    run.cursor += PRODUCE_CHUNK_SIZE;

    if (run.pending.length > QUEUE_TEXT_LIMIT) {
      // 消费端跟不上：**合并中间态**（保留头尾）而不是丢尾部。
      // 丢尾部会让 UI 的内容缺一块（用户看不出来少了什么，只觉得"答案不对"）；
      // 合并只是让中间的字跳过去，语义与长度感都还在。
      run.pending = run.pending.slice(0, QUEUE_KEEP_HEAD) + run.pending.slice(-QUEUE_KEEP_TAIL);
      run.mergedChunks += 1;
    }
  }, PRODUCE_INTERVAL_MS);

  // ── 下行：每帧一次 flush。暂停时直接返回，一个 token 都不推 ──
  run.flushTimer = setInterval(() => {
    if (run.paused || run.pending === '') return;
    if (run.ttftMs === undefined) run.ttftMs = Date.now() - run.startedAt;
    const text = run.pending;
    run.pending = '';
    emit(runId, windowId, { type: 'token', runId, text });
  }, FLUSH_INTERVAL_MS);

  activeRuns.set(runId, run);
  return { runId };
}

/**
 * 反向流控（`agent:control`）。
 *
 * @returns false 表示该 run 不存在或已结束 —— 调用方应把它当 NOT_FOUND 抛出去，
 *   而不是静默成功：静默成功会让 renderer 以为"暂停成功了"，
 *   实际那个 run 早就结束，用户看到的是 UI 状态和真实状态不一致。
 */
export function controlRun(runId: string, type: 'pause' | 'resume'): boolean {
  const run = activeRuns.get(runId);
  if (run === undefined) return false;
  run.paused = type === 'pause';
  return true;
}

/** 会话被删 / 窗口关闭时调用，避免定时器泄漏。 */
export function stopAllRuns(): void {
  for (const run of activeRuns.values()) {
    if (run.produceTimer !== null) clearInterval(run.produceTimer);
    if (run.flushTimer !== null) clearInterval(run.flushTimer);
  }
  activeRuns.clear();
}

export function activeRunCount(): number {
  return activeRuns.size;
}
