/**
 * Web 壳自检 —— 「core 真的能在浏览器里跑」的机器可验证据。
 *
 * 它回答的问题与 Electron 壳的自检**不同**。那边问「跨进程链路通不通」，
 * 这边问「同一个 core 换一个运行时还成立吗」。所以断言分三组：
 *
 *   ① 能力**如实降级**   —— 浏览器没有的能力必须报「没有」，不能给假实现
 *   ② scope 算法仍成立   —— 同一个 PathGuard，换了个文件系统后端
 *   ③ 内核仍能跑         —— AgentRuntime 的流式 / 背压 / 工具链路在浏览器里跑通
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
import type { AgentDeps } from '@crossdeck/core';
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
  const agent = new AgentRuntime({
    deps: {
      now: () => Date.now(),
      every: (ms, fn) => {
        const t = setInterval(fn, ms);
        return () => clearInterval(t);
      },
      newId: (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`,
    },
    model: new ScriptedModel(),
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
  // ④ 驱动一次**真实 UI 点击** —— 让"越界被拒"进入归档截图
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
