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
  checkSessionRepository,
  createPathGuard,
  echoTool,
  resolveInWorkspace,
} from '@crossdeck/core';
import type {
  AgentDeps,
  NavigateDiagnostic,
  SessionRepositoryHarness,
  UploadProgress,
} from '@crossdeck/core';
import { createWebNavigateClient } from './navigate/client.js';
import { uploadDocumentViaXhr } from './navigate/upload.js';
import { IdbSessionRepository, deleteSessionDatabase } from './session/idbRepository.js';
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
  // ③b 上传（XHR）—— 浏览器独有的那一段
  //
  //    **必须在登录之前跑**：401 那条反向要求"此刻没有凭据"，
  //    而 httpOnly cookie 从 JS 里清不掉（这正是 httpOnly 的意义）。
  //    所以顺序是：本地拦截 → 未登录 401 → 主动登录 → 403。
  //
  //    这里不演成功：假上游只回 401/403（与真上游 requireAdminApi 一致），
  //    200 的解码在 core，由 `scripts/verify-upload-client.mjs` 用真 HTTP 覆盖。
  //    演一个假的 200 会让人以为成功路径也被验过了。
  // ───────────────────────────────────────────────────────────
  try {
    const uploadStats = async (): Promise<{
      uploads: string[];
    }> => {
      const res = await fetch('/__selfcheck/nav-stats');
      return (await res.json()) as { uploads: string[] };
    };

    const before = await uploadStats();

    // ① 后缀不合规：本地就拦，**一个字节都不发**
    const rejectedExt = await uploadDocumentViaXhr({
      file: new File([new Uint8Array(16)], 'payload.exe', { type: 'application/octet-stream' }),
    }).promise;
    check(
      'upload.localRejectsBadExtension',
      rejectedExt.ok === false && rejectedExt.stage === 'rejected-local' && rejectedExt.message.includes('只接受'),
      rejectedExt,
    );

    // ② 超限：同样本地拦
    const rejectedSize = await uploadDocumentViaXhr({
      file: new File([new Uint8Array(21 * 1024 * 1024)], 'big.txt', { type: 'text/plain' }),
    }).promise;
    check(
      'upload.localRejectsOversize',
      rejectedSize.ok === false && rejectedSize.stage === 'rejected-local' && rejectedSize.message.includes('超过上限'),
      rejectedSize,
    );

    // ③ 上面两次都没发请求 —— 这条才是"体检在壳里做"的证据。
    //    少了它，①②只是在验一个正则，发没发出去没人知道。
    const afterLocal = await uploadStats();
    check(
      'upload.noRequestWhenRejectedLocally',
      afterLocal.uploads.length === before.uploads.length,
      `上游看到了 ${afterLocal.uploads.length - before.uploads.length} 次请求（应为 0）`,
    );

    // ④ 未登录：401 要翻译成"登录已失效"，不是"上传失败"
    const unauthorized = await uploadDocumentViaXhr({
      file: new File([new Uint8Array(16)], 'note.txt', { type: 'text/plain' }),
    }).promise;
    check(
      'upload.unauthorizedWithoutCookie',
      unauthorized.ok === false && unauthorized.stage === 'http' && unauthorized.message.includes('登录已失效'),
      unauthorized,
    );
  } catch (err) {
    check('upload.anonymousRan', false, err instanceof Error ? err.message : String(err));
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
  // ⑥ 仓储端口：**同一份**用例，换一个后端再跑一遍
  //
  //    这不是"再测一遍 IndexedDB 好不好用"。用例本体住在 core 里
  //    （`checkSessionRepository`），Electron 壳在 Node 里拿它跑真 SQLite，
  //    这里拿它跑真 IndexedDB —— 两边通过的集合一致，"同一套语义"才成立。
  //    如果哪天两个实现漂了，只有一边会红，而且是**同一条用例名**，
  //    不用去比两套各自的断言。
  // ───────────────────────────────────────────────────────────
  try {
    let clock = 1_700_000_000_000;
    let idSeq = 0;
    let caseSeq = 0;
    const created: IdbSessionRepository[] = [];

    const newRepo = (accountKey: string): IdbSessionRepository =>
      new IdbSessionRepository({
        accountKey,
        now: () => clock,
        // id 前缀与两个 SQL 实现同构：s_ / m_ / ev_
        newId: (prefix) => `${prefix}_${(idSeq += 1)}`,
      });

    const harness: SessionRepositoryHarness = {
      label: 'indexeddb',
      async create() {
        caseSeq += 1;
        const repo = newRepo(`selfcheck-case-${caseSeq}`);
        // 上一轮自检可能留下同名库（进程被强杀时 destroy 跑不到）——
        // 先删一次，保证"空库"这个前提是真的
        await repo.destroy();
        created.push(repo);
        return repo;
      },
      advance(ms) {
        clock += ms;
      },
      async reopen() {
        const repo = newRepo(`selfcheck-case-${caseSeq}`);
        created.push(repo);
        return repo;
      },
      async dispose() {
        // 同一个库可能有两条连接：先全部关掉，再删一次，否则删不掉
        const names = new Set<string>();
        for (const repo of created) {
          names.add(await repo.databaseName());
          await repo.close();
        }
        for (const name of names) {
          try {
            await deleteSessionDatabase(name);
          } catch {
            // 删不掉不该改变判定：浏览器下次打开会碰到旧数据，
            // 但用例已经跑完了，而 create() 里还有一次 destroy 兜底
          }
        }
        created.length = 0;
      },
    };

    const result = await checkSessionRepository(harness);
    probe.sessionRepo = {
      total: result.total,
      passed: result.passed,
      skipped: result.skipped,
      failures: result.failures,
    };
    check('sessionRepo.allCasesPassed', result.failures.length === 0, `${result.passed}/${result.total}`);
    // 用例被删空也会"全绿" —— 这条钉住规格本身还在
    check('sessionRepo.specIsNotEmpty', result.total >= 15, result.total);
    // 持久化那条只有 harness 提供 reopen 才会跑；跳过等于少验一整块
    check('sessionRepo.persistenceCaseRan', result.skipped.length === 0, result.skipped.join(',') || '无跳过');
    for (const f of result.failures) failures.push(`仓储用例未通过：${f}`);
  } catch (err) {
    check('sessionRepo.allCasesPassed', false, err instanceof Error ? err.message : String(err));
  }

  // ───────────────────────────────────────────────────────────
  // ③c 上传（登录态）—— 403 与进度
  //
  //    与 ③b 拆开的原因很实在：nav 那一段要做"未登录必须被拒"的反向断言，
  //    而 cookie 一旦写进去就清不掉（httpOnly 的意义）。所以"没登录"只能排在
  //    任何登录之前，"登录了"只能排在之后 —— 一个块拆两半，顺序就是约束本身。
  // ───────────────────────────────────────────────────────────
  try {
    // 自己登一次，不依赖 nav 那段留下的状态（少一条隐式耦合）
    await fetch('/api/login/guest', { method: 'POST', credentials: 'same-origin' });

    const progressFrames: UploadProgress[] = [];
    const payload = new Uint8Array(1024 * 1024); // 1MB：太小可能一帧不下就结束了
    const forbidden = await uploadDocumentViaXhr({
      file: new File([payload], 'hello.txt', { type: 'text/plain' }),
      onProgress: (p) => progressFrames.push(p),
    }).promise;
    check(
      'upload.forbiddenForGuest',
      forbidden.ok === false && forbidden.stage === 'http' && forbidden.message.includes('没有上传权限'),
      forbidden,
    );

    // 进度：至少一帧、单调不减、末帧走满（`max(上次,本次)` 夹紧在 core，这里验它真被调用了）
    const monotonic = progressFrames.every(
      (p, i) => i === 0 || p.sentBytes >= (progressFrames[i - 1]?.sentBytes ?? 0),
    );
    const last = progressFrames[progressFrames.length - 1];
    check(
      'upload.progressArrived',
      progressFrames.length >= 1 && monotonic && last !== undefined && last.sentBytes === payload.byteLength,
      { frames: progressFrames.length, monotonic, last },
    );

    // 对端看见了哪个文件 —— 证明 multipart 字段名与 filename 都对
    const stats = (await (await fetch('/__selfcheck/nav-stats')).json()) as { uploads: string[] };
    check('upload.filenameReachedUpstream', stats.uploads.includes('hello.txt'), stats.uploads);
  } catch (err) {
    check('upload.authenticatedRan', false, err instanceof Error ? err.message : String(err));
  }

  // ───────────────────────────────────────────────────────────
  // ⑤ 驱动一次**真实界面** —— 同一份 `@crossdeck/ui` 在浏览器里跑起来
  //
  //    算法断言再密，也证明不了"界面上接得上"。这一段的每一跳都过 bridge：
  //    登录闸门 → 建会话 → 发一问（流式落到 DOM）→ 流式中切页签 → 授权目录
  //    → 越界被拒 → 上传被拒。
  //
  //    界面本体在 `packages/ui`（三端共用），所以这里验的其实是**三端那同一条链路**：
  //    换成 Electron 壳，点击顺序与断言名一个字都不用改。
  // ───────────────────────────────────────────────────────────
  const ui = {
    find<T extends Element>(testId: string): T | null {
      return document.querySelector<T>(`[data-testid="${testId}"]`);
    },
    /**
     * 点一个锚点。`click()` 只有 `HTMLElement` 有 —— 图标按钮的锚点常挂在 SVG 上
     * （lucide 会把 `data-*` 透传给 `<svg>`），所以非 HTML 元素走派发冒泡事件，
     * React 收到的是同一条合成事件路径，行为一致。
     */
    click(testId: string): boolean {
      const el = ui.find<Element>(testId);
      if (el === null) return false;
      if (el instanceof HTMLElement) {
        el.click();
        return true;
      }
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return true;
    },
    attr(testId: string, name: string): string | null {
      return ui.find(testId)?.getAttribute(name) ?? null;
    },
    text(testId: string): string {
      return ui.find(testId)?.textContent ?? '';
    },
    /**
     * 切页签到 `anchor` 出现为止。
     *
     * `el.click()` 返回时 React 还没把新分支刷进 DOM（同步 lane 走的是微任务），
     * 所以点完立刻 `querySelector` 会看到旧页签 —— 必须等锚点，不能等一个固定时长：
     * 页面本体在 `packages/ui`，渲染时机归它，自检没有立场猜它多久画完。
     */
    async switchTab(tabTestId: string, anchor: string): Promise<boolean> {
      if (!ui.click(tabTestId)) return false;
      return waitFor(() => ui.find(anchor) !== null, 8000);
    },
  };

  try {
    // ① 登录闸门：未登录时停在 #/login，点「获取体验账号」才进主界面。
    //    这条同时验了三件事：navigate:status 的探测、登录通道、以及 cookie 真的被种下。
    const gate = await waitFor(() => ui.find('login-guest') !== null, 10000);
    probe.uiLoginGate = gate;
    check('ui.loginGateShown', gate, location.hash);

    check('ui.guestLoginClicked', ui.click('login-guest'));
    const booted = await waitFor(() => ui.attr('boot-status', 'data-state') === 'ready', 15000);
    probe.uiBootState = ui.attr('boot-status', 'data-state');
    check('ui.bootReadyAfterGuestLogin', booted, probe.uiBootState);

    // 登录真的落到了 cookie 上：再问一次 /api/me，上游得认。
    // 少了这条，"登录成功"只说明响应体是 200 —— 而浏览器侧的身份全在那个 cookie 里。
    const me = await fetch('/api/me', { credentials: 'same-origin' });
    probe.uiMeStatus = me.status;
    check('ui.loginCookiePersisted', me.ok, me.status);

    // ② 会话：真点一次「新建会话」，列表里要多出一行。
    //    「新建会话」在「应用能力」页签里，所以先切页签并等它出现 —— 见 `switchTab`。
    const onAbility = await ui.switchTab('tab-ability', 'session-create');
    const itemCount = (): number => document.querySelectorAll('[data-testid="session-item"]').length;
    const sessionsBefore = itemCount();
    check('ui.sessionCreateClicked', onAbility && ui.click('session-create'), onAbility);
    const created = await waitFor(() => itemCount() === sessionsBefore + 1, 8000);
    probe.uiSessionCount = { before: sessionsBefore, after: itemCount() };
    check('ui.sessionCreatedThroughUi', created, probe.uiSessionCount);

    /**
     * ②b 「列表多一行」只证明界面收下了回执 —— `handleCreate` 拿到 meta 就本地
     * append 了，库里有没有那一行它并不知道。
     *
     * 真伪用**删除**来证：删一个库里不存在的 id，仓储返回 false、壳抛 NOT_FOUND、
     * 行留在原地并弹出错误卡片。所以"删掉了 + 没有任何错误"才是这一行真落过库的
     * 证据。删完再建一个，供后面聊天用 —— 顺带说明这条链能在同一个会话表上反复走。
     */
    const deleteRow = async (): Promise<{ gone: boolean; error: string }> => {
      ui.click('session-delete');
      const gone = await waitFor(() => itemCount() === sessionsBefore, 8000);
      return { gone, error: ui.text('action-error') };
    };
    const deleted = created ? await deleteRow() : { gone: false, error: '未执行：会话没建成' };
    probe.uiSessionDelete = deleted;
    check('ui.sessionDeletedThroughUi', deleted.gone && deleted.error === '', deleted);

    // 聊天要在有会话的前提下点发送，所以这里补建一个 —— 建不起来后面会明确判红
    if (created) ui.click('session-create');
    const recreated = await waitFor(() => itemCount() === sessionsBefore + 1, 8000);
    probe.uiSessionRecreated = recreated;

    // ③ 聊天：真打一行字、真点发送 —— 流式正文必须出现在 DOM 里
    //
    //    场景词表**从这里取**（`/__selfcheck/nav-fixture`），不硬编码：
    //    硬编码的话假上游一改词表，自检就变成"发了个 400 然后判 error 是正常的"。
    const fixtureRes = await fetch('/__selfcheck/nav-fixture');
    check('ui.navFixtureReachable', fixtureRes.ok, fixtureRes.status);
    const fixture = (await fixtureRes.json()) as { scenarios: Record<string, string>; normalText: string };
    const promptNormal = fixture.scenarios['normal'] ?? '';
    /** 慢流**必须用会收尾的那一档** —— `slow` 永不 done，断言终态会永远等不到。 */
    const promptSlow = fixture.scenarios['slow-done'] ?? '';
    /** 上游对所有正常收尾的场景吐同一份文本，切片是它自己的事 —— 所以长度可以精确比。 */
    const expectedLen = fixture.normalText.length;

    const onChat = await ui.switchTab('tab-chat', 'chat-input');
    const input = ui.find<HTMLTextAreaElement>('chat-input');
    if (input === null) {
      check('ui.chatInputPresent', false, {
        onChat,
        hash: location.hash,
        anchors: [...document.querySelectorAll('[data-testid]')].map((n) => n.getAttribute('data-testid')),
      });
    } else if (!recreated) {
      /**
       * 会话没建成 → 后面每一次发送都会走到 `[NOT_FOUND] 会话不存在`。
       *
       * 这里**明确判红而不是跳过**：跳过的断言和通过的那条在报告里长得一模一样，
       * 于是"链条断在前一步"会被读成"聊天功能正常"。同时也不真发消息 ——
       * 发出去只会把每个 `waitFor` 都等满超时，一轮下来能把哨兵预算烧光，
       * 报告落不了地，一条诊断都剩不下。
       */
      check('ui.streamReachedDone', false, '未执行：会话没建成（见 ui.sessionRecreated）');
      check('ui.tokensSurviveTabSwitch', false, '未执行：会话没建成（见 ui.sessionRecreated）');
    } else {
      check('ui.chatInputPresent', true);
      const typeInto = (text: string): void => {
        // React 的受控/非受控都靠原生 setter + input 事件这条正路，别去改 value 了事
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setter?.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };

      typeInto(promptNormal);
      check('ui.sendClicked', ui.click('chat-send'));

      const streaming = await waitFor(() => ui.attr('stream-stage', 'data-stage') === 'streaming', 8000);
      const done = await waitFor(() => ui.attr('stream-stage', 'data-stage') === 'done', 20000);
      const textLength = Number(ui.attr('stream-text', 'data-len') ?? '0');
      probe.uiStream = { streaming, stage: ui.attr('stream-stage', 'data-stage'), textLength, expectedLen };
      // 比**长度相等**而不是 >0：少一片也算通的话，这条断言就测不出"漏帧"
      check('ui.streamReachedDone', streaming && done && textLength === expectedLen, probe.uiStream);

      // ④ 流式中切页签：订阅挂在窗口入口（`streamBinding`），不随页面卸载而摘掉 ——
      //    所以切走期间到达的帧必须仍然进 store，切回来后的正文只会更长。
      //    素材用 `slow-done`（5 片、每片 700ms，走完正常 done）：20ms 那一档在切页签
      //    之前就结束了，测不到东西；基线也要等第一片落地再取 —— 刚点发送时正文还是空的，
      //    拿 0 当基线等于没有基线。
      typeInto(promptSlow);
      check('ui.slowSendClicked', ui.click('chat-send'));
      const restarted = await waitFor(() => ui.attr('stream-stage', 'data-stage') === 'streaming', 8000);
      const firstChunk = await waitFor(() => Number(ui.attr('stream-text', 'data-len') ?? '0') > 0, 8000);
      const lengthBeforeSwitch = Number(ui.attr('stream-text', 'data-len') ?? '0');
      ui.click('tab-ability');
      await sleep(1500);
      const backOnChat = await ui.switchTab('tab-chat', 'stream-stage');
      const lengthAfterSwitch = Number(ui.attr('stream-text', 'data-len') ?? '0');
      const finished = await waitFor(() => ui.attr('stream-stage', 'data-stage') === 'done', 20000);
      const finalLen = Number(ui.attr('stream-text', 'data-len') ?? '0');
      probe.uiTabSwitch = {
        restarted,
        firstChunk,
        backOnChat,
        lengthBeforeSwitch,
        lengthAfterSwitch,
        finalLen,
        expectedLen,
        finished,
        stage: ui.attr('stream-stage', 'data-stage'),
      };
      // 三件事一起判，缺一条就退化：
      //   ① 切走那一刻正文**没写完**（否则这条断言在"流早就结束"的情况下空转通过）；
      //   ② 切回来时比切走时更长（期间确实有帧进来）；
      //   ③ 最终长度**等于完整答案** —— 只判"更长"的话，
      //      "页签卸载时退订、重新挂载时再订阅"也能通过（丢的那几片之后再补不上就对不上长度）。
      check(
        'ui.tokensSurviveTabSwitch',
        finished &&
          lengthBeforeSwitch > 0 &&
          lengthBeforeSwitch < expectedLen &&
          lengthAfterSwitch > lengthBeforeSwitch &&
          finalLen === expectedLen,
        probe.uiTabSwitch,
      );
    }

    // ⑤ 工作区：授权 OPFS 演示目录 → 列目录 → 试读 `../` 必须被拒
    await ui.switchTab('tab-ability', 'ws-grant');
    check('ui.grantClicked', ui.click('ws-grant'));
    const treeRendered = await waitFor(() => document.querySelectorAll('[data-testid="ws-entry"]').length > 0, 8000);
    probe.uiEntryCount = document.querySelectorAll('[data-testid="ws-entry"]').length;
    check('ui.treeRendered', treeRendered, probe.uiEntryCount);

    check('ui.escapeClicked', ui.click('ws-probe-escape'));
    const denied = await waitFor(() => ui.text('fs-error').includes('SCOPE_DENIED'), 8000);
    probe.uiEscapeMessage = ui.text('fs-error');
    check('ui.escapeDenialVisible', denied, probe.uiEscapeMessage);

    // ⑥ 上传：点开一个真文件 → 点上传 → 游客必须被上游 403 拒掉，且界面如实显示原因
    const fileEntry = document.querySelector<HTMLElement>('[data-testid="ws-entry"][data-kind="file"]');
    if (fileEntry === null) {
      check('ui.fileEntryPresent', false, '工作区里没有可点的文件');
    } else {
      check('ui.fileEntryPresent', true);
      fileEntry.click();
      const panel = await waitFor(() => ui.find('upload-panel') !== null, 8000);
      check('ui.uploadClicked', ui.click('upload-button'));
      const failed = await waitFor(() => ui.attr('upload-stage', 'data-stage') === 'error', 20000);
      probe.uiUpload = {
        panel,
        stage: ui.attr('upload-stage', 'data-stage'),
        ratio: ui.attr('upload-stage', 'data-ratio'),
        error: ui.text('upload-error'),
      };
      check(
        'ui.uploadDeniedForGuest',
        panel && failed && ui.text('upload-error').includes('没有上传权限'),
        probe.uiUpload,
      );
    }
  } catch (err) {
    check('ui.driverThrew', false, err instanceof Error ? err.message : String(err));
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
      'checkSessionRepository',
      'createPathGuard',
      'echoTool',
      'resolveInWorkspace',
    ],
    probe,
    failures,
    warnings,
  };
}
