/**
 * Web 壳自检 —— 「core 真的能在浏览器里跑」的机器可验证据。
 *
 * 它回答的问题与 Electron 壳的自检**不同**。那边问「跨进程链路通不通」，
 * 这边问「同一个 core 换一个运行时还成立吗」。所以断言分三组：
 *
 *   ① 能力**如实降级**   —— 浏览器没有的能力必须报「没有」，不能给假实现
 *   ② scope 算法仍成立   —— 同一个 PathGuard，换了个文件系统后端
 *   ③ 内核仍能跑         —— AgentRuntime 的流式 / 背压 / 工具链路在浏览器里跑通
 *   ④ 上游链路仍成立     —— 接**真实 HTTP/SSE 上游**（同源假服务器）跑通
 *
 * ④ 只验三件事（与 Electron 壳同一口径，分工见开发计划）：真的连上了 /
 * 终态恰好一个（含两条断流路径）/ abort 有效。**帧解析的细粒度断言只在
 * `scripts/verify-core-sse.mjs`** —— 在三个壳里各抄一套，三套会各自漂移。
 *
 * 为什么不用 `verify-core-agent.mjs` 那套假调度器：那套是**确定性**验证，
 * 已经覆盖了背压的逐帧语义。这里要证明的是另一件事 —— 真实 `setInterval`
 * 也接得上、真实 DOM 也收得到。两者缺一不可：前者证明算法对，
 * 后者证明「在浏览器里真的能跑」。
 *
 * ⚠️ 本文件是 `types: []` 约束下的浏览器代码。它连 `process` 都写不出来 ——
 *    这正是它能当试金石的原因。
 */

import type { AgentStreamEvent, Capability } from '@crossdeck/contract';
import {
  AgentRuntime,
  BackpressurePump,
  DEFAULT_FIRST_FRAME_TIMEOUT_MS,
  ScriptedModel,
  SessionStore,
  StreamBus,
  TOOL_SCENARIO_MARKER,
  ToolRegistry,
  WorkspaceStore,
  createPathGuard,
  echoTool,
  resolveInWorkspace,
} from '@crossdeck/core';
import type { AgentDeps, NavigateDiagnostic } from '@crossdeck/core';
import { createWebNavigateClient } from './navigate/client.js';
import { WebNavigateModel } from './navigate/model.js';
import { createWebPorts, detectCapabilities } from './ports.js';

export interface WebSelfCheckReport {
  readonly ranAt: string;
  readonly shell: 'web';
  readonly ok: boolean;
  readonly platform: string;
  readonly userAgent: string;
  readonly capabilities: readonly Capability[];
  /** 本文件从 `@crossdeck/core` import 的绑定名（源码事实，由运行器对真实产物核验） */
  readonly coreBindingsImported: readonly string[];
  readonly probe: Record<string, unknown>;
  readonly failures: readonly string[];
  readonly warnings: readonly string[];
}

/** 单次 run 的事件记录。 */
interface RunTrace {
  readonly events: AgentStreamEvent[];
  readonly types: string[];
  tokenCount: number;
  text: string;
}

const RUN_TIMEOUT_MS = 8000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 订阅必须在 `startRun` **之前**建立 —— 顺序反了会漏掉首个事件。 */
function traceRun(agent: AgentRuntime, input: string): Promise<RunTrace> {
  return new Promise((resolve, reject) => {
    const trace: RunTrace = { events: [], types: [], tokenCount: 0, text: '' };
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      off();
      reject(new Error(`run 在 ${RUN_TIMEOUT_MS}ms 内没有终结（事件序列：${trace.types.join(',')}）`));
    }, RUN_TIMEOUT_MS);

    const off = agent.bus.subscribe((event) => {
      trace.events.push(event);
      trace.types.push(event.type);
      if (event.type === 'token') {
        trace.tokenCount += 1;
        trace.text += event.text;
      }
      if ((event.type === 'done' || event.type === 'error') && !settled) {
        settled = true;
        clearTimeout(timer);
        off();
        resolve(trace);
      }
    });

    agent.startRun({ sessionId: 'selfcheck', input });
  });
}

/** 轮询直到条件成立 —— 不引测试框架，浏览器里这十行就够了。 */
async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(25);
  }
  return false;
}

/**
 * 手动推进的调度器 —— 与 `scripts/verify-core-agent.mjs` 同一套做法。
 *
 * 在浏览器里再建一个，是为了证明**注入式调度真的与平台无关**：
 * 同一份背压泵，在 Node 里配假调度器能被逐帧验证，在浏览器里同样可以。
 * 如果"可确定性测试"这件事依赖 node 的某种特性，它就不是平台无关的。
 */
function fakeScheduler(): { deps: AgentDeps; advance: (ms: number) => void } {
  let t = 0;
  interface Timer {
    next: number;
    readonly ms: number;
    readonly fn: () => void;
    live: boolean;
  }
  const timers: Timer[] = [];
  return {
    deps: {
      now: () => t,
      every: (ms, fn) => {
        const rec: Timer = { next: t + ms, ms, fn, live: true };
        timers.push(rec);
        return () => {
          rec.live = false;
        };
      },
      newId: (prefix) => `${prefix}_fake`,
    },
    advance: (ms) => {
      const end = t + ms;
      for (;;) {
        const live = timers.filter((r) => r.live && r.next <= end);
        if (live.length === 0) break;
        live.sort((a, b) => a.next - b.next);
        const next = live[0]!;
        t = next.next;
        next.next += next.ms;
        next.fn();
      }
      t = end;
    },
  };
}

/** 收到终态后再多收一会儿的窗口 —— 见 `navRun` 里的说明。 */
const TERMINAL_GRACE_MS = 200;

interface NavTerminal {
  readonly type: 'done' | 'error';
  readonly code?: string;
  readonly message?: string;
}

interface NavRunTrace {
  /** 订阅到的完整事件序列（类型名） */
  types: string[];
  /** 终态事件**全量**（不是"第一个"）—— `terminals.length !== 1` 就是要抓的 bug */
  terminals: NavTerminal[];
  textLength: number;
  tokenTexts: string[];
  usageCompletion: number | null;
}

/** 假上游自己的账本（由 `GET /__selfcheck/nav-stats` 下发）。 */
interface NavUpstreamStats {
  logins: number;
  frames: Record<string, number>;
  ended: string[];
  doneSent: string[];
  clientGone: string[];
  unknown: string[];
}

/**
 * 跑一次**真实上游链路**，并在订阅点收全量事件。
 *
 * ⚠️ 收到终态后**不立刻退订** —— 一收到就 `off()` 的话，「终态恰好一个」这条断言
 *    永远为真（第二个终态根本没人听），那等于没有断言。留一个短窗口继续收，
 *    才有机会抓到它 —— 而"跑出两个终态"正是最该被抓到的那类 bug。
 */
function navRun(agent: AgentRuntime, prompt: string, opts: { abortAfterMs?: number } = {}): Promise<NavRunTrace> {
  return new Promise((resolve, reject) => {
    const trace: NavRunTrace = { types: [], terminals: [], textLength: 0, tokenTexts: [], usageCompletion: null };
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      off();
      reject(new Error(`上游 run 在 ${RUN_TIMEOUT_MS}ms 内没有终结（事件序列：${trace.types.join(',')}）`));
    }, RUN_TIMEOUT_MS);

    const off = agent.bus.subscribe((event) => {
      trace.types.push(event.type);
      if (event.type === 'token') {
        trace.textLength += event.text.length;
        trace.tokenTexts.push(event.text);
      } else if (event.type === 'done') {
        trace.terminals.push({ type: 'done' });
        trace.usageCompletion = event.usage.completionTokens;
      } else if (event.type === 'error') {
        trace.terminals.push({ type: 'error', code: event.code, message: event.message });
      }
      if ((event.type === 'done' || event.type === 'error') && !settled) {
        settled = true;
        clearTimeout(timer);
        setTimeout(() => {
          off();
          resolve(trace);
        }, TERMINAL_GRACE_MS);
      }
    });

    const handle = agent.startRun({ sessionId: 'selfcheck-nav', input: prompt });
    if (opts.abortAfterMs !== undefined) {
      // 等它真的滴了几帧再停 —— 停得太早测的是"还没开始就取消"，不是"中途中断"。
      setTimeout(() => {
        agent.abort(handle.runId);
      }, opts.abortAfterMs);
    }
  });
}

export async function runWebSelfCheck(): Promise<WebSelfCheckReport> {
  const ranAt = new Date().toISOString();
  const failures: string[] = [];
  const warnings: string[] = [];
  const probe: Record<string, unknown> = {};

  const check = (name: string, condition: boolean, detail?: unknown): void => {
    if (!condition) failures.push(name);
    probe[name] = detail === undefined ? condition : detail;
  };

  // 与 main.ts **同一种接线**：授权表和 fs 端口共用同一个 store。
  // 不共用的话 WebFsPort 折不出工作区相对路径（它要靠 findOwning 找 root）。
  const workspaces = new WorkspaceStore({ caseInsensitive: false });
  const shell = await createWebPorts(workspaces);
  const guard = createPathGuard(workspaces, { realpath: (p) => shell.fs.realpath(p) });

  const capabilities = [...shell.capabilities].sort();
  probe.platform = shell.ports.env.platform;
  probe.detectedCapabilities = [...detectCapabilities()].sort();

  // ───────────────────────────────────────────────────────────
  // ① 能力如实降级
  //    这里断言的是**「没有」**。一个把能力表填满的 Web 壳看起来更"完整"，
  //    但 UI 会据此渲染出永远点不动的按钮 —— 假实现比没有实现更糟。
  // ───────────────────────────────────────────────────────────
  check('capability.fsScope', capabilities.includes('fs.scope'), capabilities);
  check('capability.noWindowMulti', !capabilities.includes('window.multi'), '浏览器只有页面内面板，不是真窗口');
  check('capability.noGlobalShortcut', !capabilities.includes('shortcut.global'), '网页不允许注册全局快捷键');
  check('capability.noTray', !capabilities.includes('tray'), '不存在');
  check('capability.noAutoUpdate', !capabilities.includes('update.auto'), '刷新即最新');
  check('capability.platformIsWeb', shell.ports.env.platform === 'web', shell.ports.env.platform);
  // 能力探测的实现本身也要能被证伪：它读的是运行时，不是一张硬编码表
  check(
    'capability.detectionIsRuntimeBased',
    capabilities.includes('fs.scope') ===
      (typeof navigator.storage?.getDirectory === 'function'),
    `getDirectory=${typeof navigator.storage?.getDirectory}`,
  );

  // ───────────────────────────────────────────────────────────
  // ② scope —— 与 Electron 壳**同一份** WorkspaceStore + PathGuard
  // ───────────────────────────────────────────────────────────

  // 反向：一个工作区都没授权时，报的必须是 NO_WORKSPACE（"去授权"）
  // 而不是 OUT_OF_SCOPE（"你越界了"）—— 两者在 UI 上是完全不同的引导。
  {
    const none = await resolveInWorkspace(workspaces, guard, 'ws_missing', '.');
    check('scope.noWorkspaceIsDistinct', !none.ok && none.reason === 'NO_WORKSPACE', none.ok ? 'ok' : none.reason);
  }

  const granted = workspaces.grant({ root: '/ws/demo', mode: 'readwrite' });
  check('scope.grantOk', granted.ok, granted.ok ? granted.workspace.root : granted.reason);

  let demoId: string | null = null;
  if (granted.ok) {
    demoId = granted.workspace.id;

    // 幂等：同一目录重复授权必须复用 id，否则列表里会出现两条指向同一目录的授权
    const regranted = workspaces.grant({ root: '/ws/demo', mode: 'read' });
    check(
      'scope.regrantIsIdempotent',
      regranted.ok && regranted.workspace.id === demoId && regranted.workspace.mode === 'read',
      regranted.ok ? `sameId=${regranted.workspace.id === demoId} mode=${regranted.workspace.mode}` : regranted.reason,
    );
    workspaces.setMode(demoId, 'readwrite'); // 还原

    // 正向：读得到
    const inside = await resolveInWorkspace(workspaces, guard, demoId, '.');
    check('scope.insideOk', inside.ok, inside.ok ? inside.absolute : inside.reason);
    if (inside.ok) {
      try {
        const entries = await shell.fs.listDir(inside.absolute);
        const names = entries.map((e) => e.name);
        probe.scopeEntries = entries.map((e) => `${e.kind}:${e.name}`);
        check('scope.listDirHasFixture', names.includes('hello.txt') && names.includes('notes'), names);
        // path 必须是**工作区相对**路径 —— fs 端口与授权表共用同一 store 才会有这个结果
        probe.scopeEntryPaths = entries.map((e) => e.path);
        check('scope.entriesAreWorkspaceRelative', entries.every((e) => !e.path.startsWith('/ws/demo')), probe.scopeEntryPaths);
        check(
          'scope.listDirSortedDirsFirst',
          entries.every((e, i) => i === 0 || !(entries[i - 1]!.kind === 'file' && e.kind === 'directory')),
          entries.map((e) => e.kind).join(','),
        );
      } catch (err) {
        check('scope.listDirHasFixture', false, err instanceof Error ? err.message : String(err));
      }
    } else {
      check('scope.listDirHasFixture', false, 'inside 未通过');
    }

    // 反向 1：`..` 越界
    {
      const up = await resolveInWorkspace(workspaces, guard, demoId, '..');
      check('scope.dotdotDenied', !up.ok && up.reason === 'OUT_OF_SCOPE', up.ok ? up.absolute : up.reason);
    }

    // 反向 2：**前缀陷阱** —— `/ws/demo` 的授权不该顺带覆盖 `/ws/demo-sibling`。
    //    朴素的 startsWith 会在这里静默放行。带上 withinWorkspaceId 才会被挡住。
    {
      const sibling = workspaces.grant({ root: '/ws/demo-sibling', mode: 'readwrite' });
      check('scope.siblingGranted', sibling.ok, sibling.ok ? sibling.workspace.root : sibling.reason);
      const cross = await resolveInWorkspace(workspaces, guard, demoId, '../demo-sibling/secret.txt');
      check(
        'scope.prefixTrapDenied',
        !cross.ok && cross.reason === 'OUT_OF_SCOPE',
        cross.ok ? `放行了！→ ${cross.absolute}` : cross.reason,
      );
      // 反向 3：反过来从 sibling 走回 demo 也一样要被挡
      if (sibling.ok) {
        const back = await resolveInWorkspace(workspaces, guard, sibling.workspace.id, '../demo/hello.txt');
        check(
          'scope.crossWorkspaceDeniedBothWays',
          !back.ok && back.reason === 'OUT_OF_SCOPE',
          back.ok ? `放行了！→ ${back.absolute}` : back.reason,
        );
        workspaces.revoke(sibling.workspace.id); // 清理，别影响后面
      }
    }

    // 反向 4：深上溯（多级 `..`）
    {
      const deep = await resolveInWorkspace(workspaces, guard, demoId, 'notes/../../../etc/passwd');
      check('scope.deepEscapeDenied', !deep.ok, deep.ok ? `放行了！→ ${deep.absolute}` : deep.reason);
    }
  }

  // ───────────────────────────────────────────────────────────
  // ③-1 内核：普通流式 run
  //     这里用**真实定时器**（不像单测注入假调度器）——
  //     要证明的正是"真实 setInterval 在浏览器里也接得上"。
  // ───────────────────────────────────────────────────────────
  const sessions = new SessionStore();
  const session = sessions.create({ title: 'web-selfcheck' });
  const agentDeps: AgentDeps = {
    now: () => Date.now(),
    every: (ms, fn) => {
      const t = setInterval(fn, ms);
      return () => clearInterval(t);
    },
    newId: (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`,
  };
  const agent = new AgentRuntime({
    deps: agentDeps,
    model: new ScriptedModel({ deps: agentDeps }),
  });

  try {
    const trace = await traceRun(agent, '自检：流式通道是否可用');
    probe.streamTypes = trace.types;
    check('agent.streamStarts', trace.types[0] === 'start', trace.types[0] ?? '(空)');
    check(
      'agent.streamEndsWithDone',
      trace.types[trace.types.length - 1] === 'done',
      trace.types[trace.types.length - 1] ?? '(空)',
    );
    check('agent.hasTokens', trace.tokenCount > 0, trace.tokenCount);

    const terminal = trace.events[trace.events.length - 1];
    if (terminal?.type === 'done') {
      probe.streamUsage = terminal.usage;
      check('agent.usageHasMergedChunks', typeof terminal.usage.mergedChunks === 'number', terminal.usage.mergedChunks);
      check(
        'agent.usageHasTtft',
        typeof terminal.usage.ttftMs === 'number' && terminal.usage.ttftMs > 0,
        terminal.usage.ttftMs,
      );
      check(
        'agent.completionTokensEqualsTextLength',
        terminal.usage.completionTokens === trace.text.length,
        `${terminal.usage.completionTokens} vs ${trace.text.length}`,
      );
    }
    // 终态之后不该再有事件被投递（定时器泄漏会表现为"偶尔多一个 token"）
    await sleep(120);
    check('agent.noEventsAfterTerminal', agent.droppedAfterTerminal === 0, agent.droppedAfterTerminal);
    check('agent.runDeregistered', agent.activeRunCount === 0, agent.activeRunCount);
  } catch (err) {
    check('agent.streamEndsWithDone', false, err instanceof Error ? err.message : String(err));
  }

  // ───────────────────────────────────────────────────────────
  // ③-2 内核：背压 —— 暂停期间必须是**零推送**，不是"少推送"
  // ───────────────────────────────────────────────────────────
  try {
    let tokenCount = 0;
    let countAtPause = -1;
    let countAfterPause = -1;
    let lastType = '';
    let activeRunId: string | null = null;
    const types: string[] = [];

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('背压 run 超时')), RUN_TIMEOUT_MS);

      const off = agent.bus.subscribe((event) => {
        types.push(event.type);
        lastType = event.type;
        if (event.type === 'token') {
          tokenCount += 1;
          if (countAtPause < 0 && activeRunId !== null) {
            // 跑到第一个 token 就暂停 —— 此时 pending 队列里还有大量待推
            countAtPause = tokenCount;
            agent.pause(activeRunId);
          }
        }
        if (event.type === 'done' || event.type === 'error') {
          clearTimeout(timer);
          off();
          resolve();
        }
      });

      activeRunId = agent.startRun({ sessionId: session.id, input: '背压自检' }).runId;

      // 暂停窗口：先记一次，等 400ms 再记一次，两者必须相等
      void (async () => {
        while (countAtPause < 0 && lastType !== 'done' && lastType !== 'error') await sleep(20);
        await sleep(400);
        countAfterPause = tokenCount;
        if (activeRunId !== null) agent.resume(activeRunId);
      })();
    });

    probe.backpressureCountAtPause = countAtPause;
    probe.backpressureCountAfterPause = countAfterPause;
    check('backpressure.pauseFreezesStream', countAtPause >= 0 && countAtPause === countAfterPause, `${countAtPause} → ${countAfterPause}`);
    check('backpressure.resumesAndFinishes', lastType === 'done', lastType || '(空)');
    check('backpressure.tokenCountGrewAfterResume', tokenCount > countAfterPause, `${countAfterPause} → ${tokenCount}`);

    // 反向：对不存在的 run 下发控制指令必须返回 false（"静默成功"会骗 UI）
    check('backpressure.unknownRunRejected', agent.pause('run_does_not_exist') === false);
    check('backpressure.resumeUnknownRejected', agent.resume('run_does_not_exist') === false);
  } catch (err) {
    check('backpressure.pauseFreezesStream', false, err instanceof Error ? err.message : String(err));
  }

  // ───────────────────────────────────────────────────────────
  // ③-3 内核：工具链路走**真通道**（不是单测里直接调 ToolRegistry.invoke）
  // ───────────────────────────────────────────────────────────
  try {
    const trace = await traceRun(agent, `先查一下再答 ${TOOL_SCENARIO_MARKER} web-shell`);
    probe.toolTypes = trace.types;
    const iTool = trace.types.indexOf('tool');
    const iToolEnd = trace.types.indexOf('tool_end');
    check('agent.toolEventOrder', iTool >= 0 && iToolEnd === iTool + 1, trace.types.join(','));
    check('agent.toolBeforeTokens', iToolEnd >= 0 && trace.types.indexOf('token') > iToolEnd, trace.types.join(','));
    const toolEnd = trace.events.find((e) => e.type === 'tool_end');
    check(
      'agent.toolEndOk',
      toolEnd?.type === 'tool_end' && toolEnd.ok === true,
      toolEnd?.type === 'tool_end' ? toolEnd.ok : '(缺 tool_end)',
    );
  } catch (err) {
    check('agent.toolEventOrder', false, err instanceof Error ? err.message : String(err));
  }

  // ───────────────────────────────────────────────────────────
  // ③-4 内核零件：**注入式调度**在浏览器里同样成立
  //     这一组真正回答的是"这套 core 能被确定性测试"是否平台无关。
  //     如果假调度器只在 Node 里跑得通，那"可测性"就是句空话。
  // ───────────────────────────────────────────────────────────
  try {
    // StreamBus：退订必须真的断开（退订泄漏会让同一条流被渲染两遍）
    {
      const bus = new StreamBus();
      let hits = 0;
      let calls = 0;
      const off = bus.subscribe(() => {
        hits += 1;
        calls += 1;
      });
      bus.subscribe(() => {
        calls += 1;
      });
      const delivered = bus.publish({ type: 'start', runId: 'r_probe', at: 0 });
      off();
      bus.publish({ type: 'start', runId: 'r_probe2', at: 1 });
      check('core.streamBusPublishReportsRecipients', delivered === 2, delivered);
      check('core.streamBusUnsubscribeWorks', hits === 1 && calls === 3, `hits=${hits} calls=${calls}`);
      check('core.streamBusListenerCount', bus.listenerCount === 1, bus.listenerCount);
    }

    // ToolRegistry：未知工具是**软失败**（tool_end.ok=false），不是把 run 打挂
    {
      const registry = new ToolRegistry();
      registry.register(echoTool);
      const good = await registry.invoke('echo', { text: 'x' });
      const bad = await registry.invoke('nope', {});
      check('core.toolEchoWorks', good.ok && good.output === 'x', good.output);
      check('core.unknownToolIsSoftFailure', bad.ok === false, bad.output);
      let dupThrew = false;
      try {
        registry.register(echoTool);
      } catch {
        dupThrew = true;
      }
      check('core.duplicateToolRegistrationThrows', dupThrew);
    }

    // BackpressurePump + 假调度器：暂停期间**零推送**
    {
      const s = fakeScheduler();
      const out: string[] = [];
      const pump = new BackpressurePump({ flush: (text) => out.push(text), drained: () => {} }, s.deps);
      pump.start();
      pump.push('abcdefghij');
      s.advance(32); // 两帧
      const before = out.join('');
      check('core.pumpFlushesOnFrames', before.length > 0, before);
      pump.pause();
      s.advance(1000); // 暂停期间几十帧，一个字都不该出去
      check('core.pumpPausedEmitsNothing', out.join('') === before, `${before} → ${out.join('')}`);
      pump.resume();
      s.advance(1000);
      check('core.pumpResumes', out.join('').length > before.length, out.join(''));
      check('core.pumpAcceptedChars', pump.acceptedChars === 10, pump.acceptedChars);
      pump.stop();
    }
  } catch (err) {
    check('core.streamBusUnsubscribeWorks', false, err instanceof Error ? err.message : String(err));
  }

  // ───────────────────────────────────────────────────────────
  // ④ 真实上游链路 —— 同源假 SSE 上游
  //
  // 与 Electron 壳那一版**刻意只验三件事**（分工见开发计划）：
  //   ① 真的连上了   —— 逐帧到达、恰好一个 done、正文逐字一致、凭据确实走 cookie
  //   ② 终态恰好一个 —— 含两条**不同的**断流路径（干净 EOF / socket 销毁）与上游 error 帧
  //   ③ abort 有效   —— 客户端收 ABORTED，且**对端**看见连接真的被关掉
  //
  // 帧解析 / 映射的细粒度断言**只在 `scripts/verify-core-sse.mjs`**。
  // 三端各抄一套的话三套会各自漂移 —— 那比少一套更糟。
  //
  // 场景词表**不在这里硬编码**：页面向 `/__selfcheck/nav-fixture` 取。
  // 词表对不上时页面拿不到 fixture → 自检当场红，漂移不可能静默通过。
  // ⚠️ 所以这一段被**单独开 dev server 跑 `?selfcheck=1`** 时必然失败：
  //    那台服务器没有假上游。自检页与 `scripts/web-selfcheck.mjs` 是一对。
  // ───────────────────────────────────────────────────────────
  try {
    const fixtureRes = await fetch('/__selfcheck/nav-fixture');
    if (!fixtureRes.ok) {
      throw new Error(
        `取不到假上游场景词表（HTTP ${fixtureRes.status}）—— 自检页只能由 ` +
          'packages/shell-web/scripts/web-selfcheck.mjs 提供（它同时挂着同源假上游）',
      );
    }
    const fixture = (await fixtureRes.json()) as {
      scenarios: Record<string, string>;
      normalText: string;
      unknownPrompt: string;
    };
    /** 让运行器知道这一段**真的跑过** —— 报告里少一整块结论不该被默认通过。 */
    probe.navRan = true;
    probe.navFixture = fixture.scenarios;

    const navPrompt = (key: string): string => {
      const p = fixture.scenarios[key];
      if (typeof p !== 'string') {
        throw new Error(`假上游词表里没有场景 "${key}" —— 页面与服务端的场景名对不上了`);
      }
      return p;
    };

    const navDiagnostics: NavigateDiagnostic[] = [];
    const navAgent = new AgentRuntime({
      deps: agentDeps,
      model: new WebNavigateModel({
        deps: agentDeps,
        client: createWebNavigateClient({
          // 同源：留空 → 打**相对路径**，cookie 由浏览器按同源规则自动带上。
          // 拼 location.origin 反而会把"改端口 / 改域名都不用改代码"这件事弄丢。
          baseUrl: '',
          firstFrameTimeoutMs: DEFAULT_FIRST_FRAME_TIMEOUT_MS,
          deps: agentDeps,
          onDiagnostic: (d) => navDiagnostics.push(d),
        }),
      }),
    });

    // 反向 1：**未登录**（没有 cookie）时上游必须 401。
    // 少了这条，"真的连上了"完全可能只是"上游根本没在鉴权"。
    {
      const r = await navRun(navAgent, navPrompt('normal'));
      const msg = r.terminals[0]?.message ?? '';
      check(
        'nav.anonymousIsRejected',
        r.terminals.length === 1 && msg.includes('HTTP 401'),
        msg.length > 0 ? msg : r.types.join(','),
      );
      check('nav.anonymousSawNoText', r.textLength === 0, r.textLength);
    }

    // 登录这一步**不是**壳的代码：Web 壳刻意没有登录流程 —— 凭据是同源 httpOnly cookie，
    // 由 navigate 自己的页面种下。自检在这里把"已经登录过"这个前提做出来。
    {
      const res = await fetch('/api/login/guest', { method: 'POST', credentials: 'same-origin' });
      const body = (await res.json()) as { role?: string };
      check('nav.guestLoginOk', res.ok && body.role === 'guest', `HTTP ${res.status} role=${String(body.role)}`);
    }

    // ── 五个场景 ──
    const navResults: Record<string, NavRunTrace & { error?: string; chunkFrames?: number }> = {};
    const order: Array<[string, { abortAfterMs?: number }]> = [
      ['normal', {}],
      ['silent-close', {}],
      ['killed', {}],
      ['upstream-error', {}],
      // 等它滴几帧再停（服务端 60ms 一滴），否则测的是"还没开始就取消"。
      ['abort', { abortAfterMs: 260 }],
    ];
    for (const [key, opts] of order) {
      const before = navDiagnostics.length;
      try {
        const t: NavRunTrace & { chunkFrames?: number } = await navRun(navAgent, navPrompt(key), opts);
        t.chunkFrames = navDiagnostics.slice(before).filter((d) => d.type === 'chunk').length;
        navResults[key] = t;
      } catch (err) {
        navResults[key] = {
          types: [],
          terminals: [],
          textLength: 0,
          tokenTexts: [],
          usageCompletion: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    probe.navScenarios = Object.fromEntries(
      Object.entries(navResults).map(([k, r]) => {
        const term = r.terminals[r.terminals.length - 1];
        return [
          k,
          {
            events: r.types.join(','),
            terminalCount: r.terminals.length,
            terminal: term?.type ?? null,
            code: term?.code ?? null,
            textLength: r.textLength,
            chunkFrames: r.chunkFrames ?? 0,
            /** 逐帧原样留档：文本总量对不上时，光看"长度不符"是查不出丢在哪一段的。 */
            tokenTexts: r.tokenTexts,
          },
        ];
      }),
    );

    // 三端共用的那张期望表 —— 与 Electron 壳 / verify-core-agent 同一个形状。
    //
    // `messageIncludes` 不是装饰：两条断流路径**必须**能被区分开。
    //   干净 EOF（`res.end()`，没发 done）→ `finishStream()` → "没收到 done 帧"
    //   socket 销毁（`res.destroy()`）    → `reader.read()` 抛错 → "读取上游流失败"
    // 只断言"都是 error / UPSTREAM"的话，把两条路合成一条也照样绿 ——
    // 而合成恰恰会漏掉另一条路径上的失败模式。所以这里锚定各自的措辞。
    const navExpect: Record<
      string,
      { terminal: 'done' | 'error'; code: string | null; minTokens: number; messageIncludes?: string }
    > = {
      normal: { terminal: 'done', code: null, minTokens: 2 },
      'silent-close': {
        terminal: 'error',
        code: 'UPSTREAM',
        minTokens: 1,
        messageIncludes: '没收到 done 帧',
      },
      killed: { terminal: 'error', code: 'UPSTREAM', minTokens: 1, messageIncludes: '读取上游流失败' },
      'upstream-error': { terminal: 'error', code: 'UPSTREAM', minTokens: 1, messageIncludes: '上游报错' },
      abort: { terminal: 'error', code: 'ABORTED', minTokens: 1 },
    };
    for (const [key, want] of Object.entries(navExpect)) {
      const r = navResults[key];
      if (r === undefined) {
        check(`nav.${key}.ran`, false, '场景没跑到');
        continue;
      }
      if (r.error !== undefined) check(`nav.${key}.noThrow`, false, r.error);
      const term = r.terminals[r.terminals.length - 1];
      check(`nav.${key}.exactlyOneTerminal`, r.terminals.length === 1, `${r.terminals.length} 个：${r.types.join(',')}`);
      check(`nav.${key}.terminal`, term?.type === want.terminal, `${String(term?.type)}（期望 ${want.terminal}）`);
      if (want.code !== null) {
        check(`nav.${key}.code`, term?.code === want.code, `${String(term?.code)}（期望 ${want.code}）`);
      }
      if (want.messageIncludes !== undefined) {
        const message = term?.message ?? '';
        check(
          `nav.${key}.message`,
          message.includes(want.messageIncludes),
          `${JSON.stringify(message)} 里没有 ${JSON.stringify(want.messageIncludes)}`,
        );
      }
      check(`nav.${key}.minFrames`, r.tokenTexts.length >= want.minTokens, `${r.tokenTexts.length} < ${want.minTokens}`);
    }

    // ① 的铁证：正文逐字一致 + 分片真的分次到 + completionTokens 与文本长度相等
    const navNormal = navResults['normal'];
    if (navNormal !== undefined) {
      const joined = navNormal.tokenTexts.join('');
      check(
        'nav.normal.textMatchesUpstream',
        joined === fixture.normalText,
        `${JSON.stringify(joined)} ≠ ${JSON.stringify(fixture.normalText)}`,
      );
      check(
        'nav.normal.incrementalArrival',
        (navNormal.chunkFrames ?? 0) >= 2,
        `客户端只看到 ${navNormal.chunkFrames ?? 0} 片 —— 退化成了"攒齐再发"，逐帧断言失去意义`,
      );
      check(
        'nav.normal.usageEqualsTextLength',
        navNormal.usageCompletion === navNormal.textLength,
        `${String(navNormal.usageCompletion)} vs ${navNormal.textLength}`,
      );
    }
    // ⚠️ 错误路径**故意不比正文**：终态走的是 `pump.stop()`，队列尾那块（不足一个
    //    produceChunkSize）本来就丢 —— 那是既定的取舍。拿它当逐字断言会变成偶发红。
    //    所以断流场景只断"终态恰好一个 + 错误码 + 至少收到过帧"。

    // Web 壳的凭据形态：诊断里必须报 cookie。壳的差异就落在这里 ——
    // 若哪天有人给 Web 壳也塞上 `?token=`，这条会红。
    {
      const auths = navDiagnostics.flatMap((d) => (d.type === 'request' ? [d.auth] : []));
      check('nav.authIsCookie', auths.length > 0 && auths.every((a) => a === 'cookie'), auths.join(',') || '(无请求诊断)');
    }

    // 反向 2：不认识的场景必须 400。
    // 它同时证明前面那些场景是**被词表认出来**的，而不是"上游对谁都一样好说话"。
    {
      const r = await navRun(navAgent, fixture.unknownPrompt);
      const msg = r.terminals[0]?.message ?? '';
      check(
        'nav.unknownPromptRejected',
        r.terminals.length === 1 && msg.includes('HTTP 400'),
        msg.length > 0 ? msg : r.types.join(','),
      );
    }

    // ③ 对端观察 —— 「停止真的断了连接」唯一能拿到证据的地方。
    //    客户端自己说"我 abort 了"不算，得看**上游**有没有看见连接被关。
    //    这一步是异步到达的（socket 拆除要绕一圈），给它一个有界窗口，别靠猜。
    {
      let stats: NavUpstreamStats | null = null;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const res = await fetch('/__selfcheck/nav-stats');
        stats = (await res.json()) as NavUpstreamStats;
        if (stats.clientGone.includes('abort')) break;
        await sleep(80);
      }
      probe.navUpstreamStats = stats;
      check(
        'nav.abortSeenByPeer',
        stats !== null && stats.clientGone.includes('abort'),
        stats === null ? '取不到上游统计' : stats.clientGone.join(',') || '(空)—— "停止"只停了渲染，连接还挂着',
      );
      check(
        'nav.noDoneInTruncatedScenarios',
        stats !== null && !stats.doneSent.includes('silent-close') && !stats.doneSent.includes('killed'),
        stats === null ? '取不到上游统计' : `doneSent=[${stats.doneSent.join(',')}] —— 场景造错了，截断判定被绕过`,
      );
      check('nav.upstreamSawLogin', stats !== null && stats.logins >= 1, stats?.logins ?? '(取不到)');
      check(
        'nav.upstreamSawUnknownPrompt',
        stats !== null && stats.unknown.includes(fixture.unknownPrompt),
        stats === null ? '取不到上游统计' : `unknown=[${stats.unknown.join(',')}]`,
      );
    }

    // 全部终态之后不该还有活跃 run（abort 收尾不干净会留在这），也不该有终态之后的事件。
    check('nav.noActiveRunsLeft', navAgent.activeRunCount === 0, navAgent.activeRunCount);
    await sleep(TERMINAL_GRACE_MS);
    check('nav.noEventsAfterTerminal', navAgent.droppedAfterTerminal === 0, navAgent.droppedAfterTerminal);
  } catch (err) {
    // 这一段整块没跑成（最典型：没配套的假上游）—— 记成失败，不静默跳过。
    check('nav.ran', false, err instanceof Error ? err.message : String(err));
  }

  // ───────────────────────────────────────────────────────────
  // ⑤ 驱动一次**真实 UI 点击** —— 让"越界被拒"进入归档截图
  //    算法断言再密，也证明不了"界面上看得见"。
  // ───────────────────────────────────────────────────────────
  try {
    const grantBtn = document.querySelector<HTMLButtonElement>('[data-testid="web-grant"]');
    const escapeBtn = document.querySelector<HTMLButtonElement>('[data-testid="web-escape"]');
    const errBox = document.querySelector<HTMLElement>('[data-testid="web-error"]');
    const treeBox = document.querySelector<HTMLElement>('[data-testid="web-tree"]');

    if (grantBtn === null || escapeBtn === null || errBox === null || treeBox === null) {
      check('ui.probeTargetsPresent', false, '缺少 data-testid 锚点');
    } else {
      check('ui.probeTargetsPresent', true);

      // ① 流式卡片：点一次真「发送」，让事件序列出现在截图里。
      //    自检自己跑的 run 走的是内存里的内核 —— 那证明不了**界面上**接得上。
      const sendBtn = document.querySelector<HTMLButtonElement>('[data-testid="web-send"]');
      const streamMeta = document.querySelector<HTMLElement>('[data-testid="web-stream-meta"]');
      if (sendBtn === null || streamMeta === null) {
        check('ui.probeTargetsPresent', false, '缺少流式卡片的锚点');
      } else {
        sendBtn.click();
        await waitFor(() => (streamMeta.textContent ?? '').includes('事件序列'), 6000);
        const metaText = streamMeta.textContent ?? '';
        probe.uiStreamMeta = metaText;
        check('ui.streamCardRan', metaText.includes('start') && metaText.includes('done'), metaText);
      }

      grantBtn.click();
      const rendered = await waitFor(() => treeBox.querySelectorAll('li').length > 0, 3000);
      const entryCount = treeBox.querySelectorAll('li').length;
      probe.uiEntryCount = entryCount;
      check('ui.treeRendered', rendered && entryCount > 0, entryCount);

      escapeBtn.click();
      const denied = await waitFor(() => (errBox.textContent ?? '').includes('SCOPE_DENIED'), 3000);
      probe.uiEscapeMessage = errBox.textContent;
      check('ui.escapeDenialVisible', denied, errBox.textContent);
    }
  } catch (err) {
    check('ui.treeRendered', false, err instanceof Error ? err.message : String(err));
  }

  return {
    ranAt,
    shell: 'web',
    ok: failures.length === 0,
    platform: shell.ports.env.platform,
    userAgent: navigator.userAgent,
    capabilities,
    // 本文件从 `@crossdeck/core` import 的绑定名。
    // ⚠️ 这是**源码事实**，不是运行时结论：打包压缩会把 `.name` 改成单字母，
    //    所以报告里不能拿 `.name` 当证据。真正的核验交给运行器 ——
    //    它会 import core 的真实产物，逐个确认这些名字确实存在（见 web-selfcheck.mjs）。
    //    名字写错或 core 改名，运行器会直接判失败。
    coreBindingsImported: [
      'AgentRuntime',
      'BackpressurePump',
      'ScriptedModel',
      'SessionStore',
      'StreamBus',
      'TOOL_SCENARIO_MARKER',
      'ToolRegistry',
      'WorkspaceStore',
      'createPathGuard',
      'echoTool',
      'resolveInWorkspace',
    ],
    probe,
    failures,
    warnings,
  };
}
