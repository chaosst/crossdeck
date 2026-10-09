import { webContents } from 'electron';
import { IPC } from '@crossdeck/contract';
import type { AgentStreamEvent } from '@crossdeck/contract';
import type { AgentDeps, ModelPort } from '@crossdeck/core';
import { AgentRuntime, DEFAULT_FIRST_FRAME_TIMEOUT_MS, ScriptedModel } from '@crossdeck/core';
import { createNavigateClient } from './navigate/client.js';
import { NavigateModel } from './navigate/model.js';
import { navigateTokenStore } from './navigate/tokenStore.js';

/**
 * 壳侧的 Agent 适配器。
 *
 * M4.5 之前，这个文件里躺着整个 Agent 运行时（产字定时器、帧 flush、队列合并、
 * 暂停语义、事件推送）—— 全是平台无关的逻辑，却只能靠"跑一遍端到端、等几秒、
 * 看 token 数对不对"来验证。搬到 core 之后，那套算法现在由
 * `scripts/verify-core-agent.mjs` 用假调度器在 0ms 内逐帧验完（100 条断言）。
 *
 * 剩下真正属于 Electron 的只有四件事：
 *   1. `setInterval` → core 要的 `every`
 *   2. `Date.now`    → core 要的 `now`
 *   3. `bus.subscribe` → `webContents.send` —— 把事件送到**发起它的那个窗口**
 *   4. **选上游**（T7）：有地址就接 navigate，没地址就退回脚本上游 ——
 *      并把"当前是哪一个"如实暴露出去（`activeUpstream()`），不许假装在连真上游。
 * 前三条三端壳几乎一样，这正是分层的收益；第 4 条是各端各自的选择。
 */

// 提成变量：AgentRuntime 与 ScriptedModel **共用同一份 deps**。
// 为什么必须共用：`ScriptedModel` 靠 `deps.every` 滴流，它的时钟必须与 runtime 的
// 是同一个 —— 否则测试里注入的手动时钟只推进一半，滴流与 flush 的先后就不可控了。
const deps: AgentDeps = {
  now: () => Date.now(),
  every: (intervalMs, fn) => {
    const timer = setInterval(fn, intervalMs);
    return () => clearInterval(timer);
  },
  newId: (prefix) =>
    `${prefix}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
};

/**
 * 上游地址 —— 没配就**退回脚本上游**。
 *
 * 为什么必须保留 `ScriptedModel` 这条分支：自检要能在**没有网络**时也跑通。
 * 但"离线可跑"和"假装在连真上游"是两回事 —— 后者是诚实性缺口，
 * 所以 `activeUpstream()` 会如实报出当前用的是哪一个（UI/自检据此标注）。
 *
 * ⚠️ **T7 的临时注入点**：读环境变量是权宜之计。T10 会把它换成
 *    配置通道（`contract/src/ipc.ts` 的唯一事实源）+ guest 登录。
 *    之所以现在也**不硬编码**：硬编码会让"连的是哪个上游"变成代码里的秘密 ——
 *    同一个二进制在别人机器上连到哪儿，连日志都看不出来。
 */
function configuredUpstreamUrl(): string | null {
  const raw = process.env['CROSSDECK_UPSTREAM_URL'];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * 取当前 token。
 *
 * 优先 `tokenStore`（T10 的 guest 登录会往里写）；
 * T7 阶段额外放行环境变量，好让"连真实 navigate 冒烟"在没有登录通道时也能做。
 * 环境变量是**进程级**的、不落盘，比往 store 里塞一条假凭据干净。
 */
function currentToken(): string | null {
  const stored = navigateTokenStore.get();
  if (stored !== null && stored.length > 0) return stored;
  const fromEnv = process.env['CROSSDECK_NAVIGATE_TOKEN'];
  return fromEnv === undefined || fromEnv === '' ? null : fromEnv;
}

function createModel(upstream: string | null): ModelPort {
  if (upstream === null) return new ScriptedModel({ deps });

  return new NavigateModel({
    deps,
    client: createNavigateClient({
      baseUrl: upstream,
      getToken: currentToken,
      firstFrameTimeoutMs: DEFAULT_FIRST_FRAME_TIMEOUT_MS,
      deps,
    }),
  });
}

const upstream = configuredUpstreamUrl();
const model = createModel(upstream);

const runtime = new AgentRuntime({ deps, model });

/** 当前上游的种类。**UI 与自检必须如实显示它** —— 不许"假装在连真上游"。 */
export type UpstreamKind = 'scripted' | 'navigate';

export function activeUpstream(): UpstreamKind {
  return upstream === null ? 'scripted' : 'navigate';
}

console.log(
  upstream === null
    ? '[crossdeck] 上游：脚本上游（离线可跑；UI 需如实标注，别当成真上游）'
    : `[crossdeck] 上游：navigate @ ${upstream}`,
);

/** runId → 发起它的窗口。事件要回到"自己那个窗口"，不能广播给所有人。 */
const runWindows = new Map<string, number>();

/**
 * 还没登记窗口就到达的事件。
 *
 * 为什么需要它：`startRun()` **同步**发出 `start` 事件（这是有意的 ——
 * 否则渲染层会漏掉首个事件，也就是"订阅晚于派发"的经典竞态）。
 * 但壳要等 `startRun()` 返回拿到 runId 之后才能登记窗口，
 * 于是 `start` 必然早于登记。少了这个缓冲，每次 run 的首个事件都会丢，
 * 渲染层会一直停在"等待首个 token"。
 */
const earlyEvents = new Map<string, AgentStreamEvent[]>();

/**
 * 没人可投递而被丢弃的**终态**事件数 —— 应当恒为 0。
 *
 * 光修 bug 不够：这个失败模式（token 全到齐、done 永远不来）在 UI 上
 * 只表现为"最后一帧卡住"，排查时完全不会往"事件路由写反了"想。
 * 所以给它一个计数器，让它在报告里显性出现。
 */
let undeliveredTerminal = 0;

function deliver(windowId: number, event: AgentStreamEvent): void {
  const wc = webContents.fromId(windowId);
  // 窗口可能在流式过程中被关掉 —— 静默失败是正确的，不该因此中断 run。
  if (!wc || wc.isDestroyed()) return;
  wc.send(IPC.agentStream, event);
}

runtime.bus.subscribe((event) => {
  // ⚠️ 顺序不能反：必须先**查**窗口再删映射。
  // 写成"先删再查"的话，终态事件（done / error）会查不到窗口而掉进缓冲，
  // 于是渲染层收齐了全部 token 却永远等不到 done —— 表现为"流式卡在最后一帧"。
  // 这个坑是真实 E2E 抓出来的，纯单测抓不到（core 那边事件确实发出去了）。
  const windowId = runWindows.get(event.runId);
  if (event.type === 'done' || event.type === 'error') runWindows.delete(event.runId);

  if (windowId === undefined) {
    // 只有非终态事件值得缓冲：终态意味着 run 已经结束，
    // 没有窗口可投递时再缓冲只会变成内存泄漏。
    if (event.type !== 'done' && event.type !== 'error') {
      const buffered = earlyEvents.get(event.runId);
      if (buffered === undefined) earlyEvents.set(event.runId, [event]);
      else buffered.push(event);
    } else {
      undeliveredTerminal += 1;
    }
    return;
  }
  deliver(windowId, event);
});

export interface RunHandle {
  runId: string;
}

export function runScripted(windowId: number, sessionId: string, input: string): RunHandle {
  const { runId } = runtime.startRun({ sessionId, input });

  runWindows.set(runId, windowId);

  // 补发在登记之前到达的事件（正常情况下只有 start 一个）
  const buffered = earlyEvents.get(runId);
  if (buffered !== undefined) {
    earlyEvents.delete(runId);
    for (const event of buffered) deliver(windowId, event);
  }

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
  return runtime.pauseOrResume(runId, type);
}

/** 中断一个 run。核心会补发一个 ABORTED 终结事件，UI 不会卡在"流式中"。 */
export function abortRun(runId: string): boolean {
  return runtime.abort(runId);
}

/** 会话被删 / 窗口关闭时调用，避免调度泄漏。 */
export function stopAllRuns(): void {
  runtime.stopAll();
  runWindows.clear();
  earlyEvents.clear();
}

export function activeRunCount(): number {
  return runtime.activeRunCount;
}

/** 自检用的自查口：终态之后仍被投递的事件数应当恒为 0。 */
export function droppedAfterTerminal(): number {
  return runtime.droppedAfterTerminal;
}

/**
 * 自检用的自查口：找不到窗口而丢弃的终态事件数，应当恒为 0。
 * 非 0 说明事件路由坏了（比如"先删窗口映射再查"），
 * 表现是渲染层收齐 token 却永远等不到 done。
 */
export function undeliveredTerminalCount(): number {
  return undeliveredTerminal;
}
