import { app, BrowserWindow } from 'electron';
import { lstatSync, mkdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { IPC } from '@crossdeck/contract';
import type { PerfSnapshot } from '@crossdeck/contract';
import { droppedAfterTerminal, undeliveredTerminalCount } from './agentRuntime.js';
import { resetPerfForSelfCheck } from './perf.js';
import { runtimeConfig } from './runtimeConfig.js';
import { currentUpdateStatus, resetUpdateStateForSelfCheck } from './updater.js';

/**
 * 自检模式 —— 把「跑起来了」变成**可归档的证据**，而不是一句主观判断。
 *
 * 它做四件事，任何一件失败都算出错：
 *   1. 等渲染层通过 preload → main → core 走完整条链并把状态置为 ready
 *   2. 在**渲染进程真实上下文里**直接调 window.bridge 做正向与反向探针
 *      （正向：合法通道返回正确形状；反向：错误路径必须真的抛错）
 *   3. 截图存 PNG —— 布局崩了、白屏、样式没加载，都能一眼看出来
 *   4. 写 JSON 报告：版本矩阵 / 已注册通道 / DOM 文本 / 探针结果 / 控制台错误
 *
 * 为什么反向探针必须有：
 *   一个"永远返回成功"的实现同样能通过正向探针。
 *   只有证明"该失败的时候真的失败了"，这条链路才算被验证过。
 *
 * M4 起新增的三条反向断言（scope 越界 / symlink 逃逸 / 暂停期间零推送）
 * 都属于第二类：它们验证的是**约束真的存在**，而不是功能能跑。
 */

/**
 * 自检夹具 —— 一条**真实**的授权工作区。
 *
 * 为什么要建它：M4 的核心断言是"越界必须被拒"，而 `workspace:grant` 会弹系统
 * 对话框 —— 无头环境根本弹不出来。所以夹具由 main 侧预先造好，
 * 再走与用户点击**完全相同**的 `WorkspaceStore.grant` 授权。
 * 抄近路（比如直接往表里塞一条）会让自检验证一条用户永远走不到的分支。
 */
export interface ScopeFixture {
  /** 授权根（绝对路径） */
  root: string;
  /** 指向 root 之外的目标，用于验证 symlink 逃逸被拦 */
  symlink: {
    /** ok = 已创建、可断言；skipped = 平台不允许（Windows 未开开发者模式） */
    status: 'ok' | 'skipped';
    name: string | null;
    reason: string | null;
  };
  /** root 之外的文件（symlink 的指向） */
  outsideFile: string;
  /** 探针据以做正向断言的固定文件名 */
  probeFile: string;
}

export function prepareScopeFixture(outDir: string): ScopeFixture {
  const root = join(outDir, 'ws');
  const outsideDir = join(outDir, 'outside');
  mkdirSync(join(root, 'notes'), { recursive: true });
  mkdirSync(outsideDir, { recursive: true });

  writeFileSync(join(root, 'hello.txt'), 'crossdeck scope fixture\n', 'utf8');
  writeFileSync(join(root, 'notes', 'readme.md'), '# 夹具目录\n\n用于验证 workspace scope 授权。\n', 'utf8');

  const outsideFile = join(outsideDir, 'secret.txt');
  writeFileSync(outsideFile, '这个文件在授权工作区之外 —— 读它必须被拒绝\n', 'utf8');

  const linkName = 'link-out';
  const linkPath = join(root, linkName);
  // 用相对目标：整个夹具目录可以被搬走而不破坏链接
  const linkTarget = join('..', 'outside', 'secret.txt');

  /**
   * 幂等靠**复用**，不靠"先删再建"。
   *
   * 走过的弯路记在这里，免得再踩：
   *   第一版用 `rmSync(linkPath, {recursive:true})` 清残留。本机环境下
   *   NODE_OPTIONS 里的 safe-delete shim 会被 Electron 主进程继承，而那个守卫是
   *   **按工具调用累计配额**的（阈值 50 个文件）—— 应用内的删除会花掉同一次调用
   *   剩下的额度。额度耗尽后这一步静默变成空操作 → 接着 `symlinkSync` 抛 EEXIST →
   *   symlink 逃逸这条**安全断言**从第二轮起永远退化成 skipped，
   *   而 skipped 不判失败，于是它会一直安静地烂在那里。
   *   最坑的是症状看起来像"平台不给建符号链接"，与真实原因完全对不上。
   *
   * 改成"残留正好是我们要的东西就直接用"之后：不依赖任何删除能力、
   * 不依赖任何环境变量，而且省掉一次建链。删除被拦、被沙箱改写都不再影响这条断言。
   */
  let symlink: ScopeFixture['symlink'] = { status: 'skipped', name: null, reason: null };
  let needCreate = true;

  try {
    const existing = lstatSync(linkPath);
    if (existing.isSymbolicLink() && readlinkSync(linkPath) === linkTarget) {
      symlink = { status: 'ok', name: linkName, reason: null };
      needCreate = false;
    }
  } catch {
    // 不存在是最常见的情况 —— 继续往下建
  }

  if (needCreate) {
    try {
      symlinkSync(linkTarget, linkPath, 'file');
      symlink = { status: 'ok', name: linkName, reason: null };
    } catch (err) {
      // 区分「平台不允许」和「残留条目冲突」—— 两者的处置完全不同：
      // 前者是已知的降级（core 单测兜住），后者是**夹具自己坏了**，必须能一眼看出来。
      const code = (err as { code?: unknown } | null)?.code;
      const why =
        code === 'EPERM' || code === 'EACCES'
          ? '当前账户无创建符号链接的权限（Windows 需开发者模式 / 管理员）'
          : code === 'EEXIST'
            ? '同名条目已存在、但不是指向预期目标的符号链接（夹具状态不干净）'
            : `创建失败（${String(code ?? 'unknown')}）`;
      symlink = {
        status: 'skipped',
        name: null,
        reason: `${why}：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return { root, symlink, outsideFile, probeFile: 'hello.txt' };
}

export interface SelfCheckProbe {
  hasBridge: boolean;
  bridgeMethods: string[];
  systemInfo?: unknown;
  systemInfoOk: boolean;
  sessionListOk: boolean;
  errorPathThrew: boolean;
  errorMessage?: string;
  /** 错误码是否跨 preload → renderer 边界存活（走 message 前缀编码） */
  errorCodePreserved: boolean;
  errorDecodedCode?: string | null;
  errorDecodedMessage?: string | null;
  /** 用于记录"自定义属性被 contextBridge 丢弃"这一事实 */
  errorRawPropCode?: unknown;
  errorOwnProps?: string[];
  unknownChannelThrew: boolean;
  unknownChannelMessage?: string;
  // ── 单向推送通道（agent:stream）──
  streamRunId?: string;
  streamEnded?: boolean;
  streamEventTypes?: string[];
  streamFirstEvent?: string | null;
  streamLastEvent?: string | null;
  streamTokenCount?: number;
  streamTextLength?: number;
  streamUsage?: { ttftMs?: number; totalMs: number; completionTokens: number } | null;
  streamError?: string;
  streamSecondEnded?: boolean;
  streamSecondError?: string;
  /** 退订是否真的生效（A 退订后不应再收到 B 的事件） */
  streamUnsubscribeWorks?: boolean;
  // ── M4：工作区授权 + 文件系统 scope ──
  workspaceCount?: number;
  scopeReadOk?: boolean;
  scopeReadEntries?: string[];
  scopeReadError?: string;
  scopeEscapeThrew?: boolean;
  scopeEscapeCode?: string | null;
  scopeEscapeDetail?: string | null;
  /** passed = 逃逸被拦；failed = 竟然读到了；skipped = 夹具没建出来 */
  scopeSymlinkCase?: 'passed' | 'failed' | 'skipped';
  scopeSymlinkDetail?: string | null;
  // ── M4：背压 ──
  pausedTokenCount?: number;
  pausedTokenCountLater?: number;
  resumeTokenCount?: number;
  backpressureEnded?: boolean;
  backpressureTextLength?: number;
  backpressureMerged?: number | null;
  backpressureError?: string;
  controlUnknownThrew?: boolean;
  controlUnknownCode?: string | null;
  // ── M4.5：core Agent 内核的工具链路（先干活再回答）──
  toolRunEnded?: boolean;
  toolEventCount?: number;
  toolEndOk?: boolean | null;
  toolBeforeToken?: boolean;
  toolRunLastEvent?: string | null;
  toolRunError?: string;
  // ── M4：渲染层文件树 + 越界可见化（驱动真实点击，让截图也成为证据）──
  uiEntryCount?: number;
  uiEmptyNotice?: boolean;
  uiEscapeClicked?: boolean;
  uiEscapeShown?: boolean;
  // ── M5：自动更新 —— 未打包形态下"必须如实说不" ──
  updateButtonClicked?: boolean;
  /** 点完按钮后界面上呈现的阶段 —— M5-3 的关键：**不允许**是 checking */
  updateDomStage?: string | null;
  updateDomRetryable?: string | null;
  /** 推送到达的事件数 —— 应当恰好 1（不多不少：不重复推、也不漏推） */
  updateEventCount?: number;
  updateFirstStage?: string | null;
  updateFirstRetryable?: boolean | null;
  updateFirstMessage?: string | null;
  updateSawChecking?: boolean;
  updateLastStage?: string | null;
  updateCheckThrew?: boolean;
  updateCheckCode?: string | null;
  updateCheckDetail?: string | null;
  updateDownloadThrew?: boolean;
  updateDownloadCode?: string | null;
  updateInstallThrew?: boolean;
  updateInstallCode?: string | null;
  /** 退订之后再触发一次，事件数应当**不变** —— 不变才说明真的退订了 */
  updateEventsBeforeUnsub?: number;
  updateEventsAfterUnsub?: number;
  domStatus: string | null;
  domText: string;
}

export interface SelfCheckReport {
  ok: boolean;
  ranAt: string;
  /** 'dev' = 渲染层来自内嵌 Vite dev server；'prod' = 来自 app:// 协议 + 严格 CSP */
  mode: 'dev' | 'prod';
  versions: {
    electron: string;
    chrome: string;
    node: string;
    app: string;
    v8: string;
  };
  registeredChannelCount: number;
  registeredChannels: string[];
  scopeFixture: {
    root: string;
    symlink: ScopeFixture['symlink'];
    outsideFile: string;
  };
  probe: SelfCheckProbe;
  /**
   * Agent 内核的自查计数 —— 两个都应当恒为 0。
   *
   * 这两条断言的形状是"不变量"而不是"功能"：
   * 它们不验证任何功能能跑，只验证**不该发生的事没发生**。
   * 之所以必须有，是因为它们对应的 bug 都不崩、不报错，
   * 只表现为"UI 停在最后一帧"或"偶尔多一个 token"，从日志里完全看不出来。
   */
  agentRuntime: {
    droppedAfterTerminal: number;
    undeliveredTerminal: number;
  };
  /**
   * 性能快照（M6-1）。**不达标不算失败** —— 把"未达标"混进 `failures`
   * 会让自检变成一场"为了变绿而调参"的游戏，指标就失去度量意义。
   * 不达标写进 `docs/perf.md` 的改进项；`null` = 整块没采到（会进 warnings）。
   */
  perf: PerfSnapshot | null;
  /** 不判失败、但必须被看见的事项（例如平台不允许建 symlink） */
  warnings: string[];
  consoleErrors: string[];
  screenshot: string | null;
  failures: string[];
}

/**
 * 渲染进程里跑的探针脚本 —— 字符串形式，因为它执行在另一个上下文。
 *
 * ⚠️ 这一段是要被 `executeJavaScript` evaluate 的**源码**，不是普通字符串：
 *   ① 模板字符串会再吃一层反斜杠 —— 正则里的 `\[` 必须写成 `\\[`，
 *      否则到渲染进程就变成裸的 `[`（非法正则）；
 *   ② 注释里不能出现反引号，会把模板字符串提前终止。
 *   两个坑都踩过（表现只有一句 "Script failed to execute"）。
 */
function buildProbeScript(fixture: ScopeFixture): string {
  const injected = JSON.stringify({
    probeFile: fixture.probeFile,
    symlinkName: fixture.symlink.name,
  });

  return `(async () => {
  const out = {};
  const fixture = ${injected};
  const parseErr = (e) => {
    const message = String((e && e.message) || e);
    const m = /^\\[([A-Z_]+)(?::([A-Z_]+))?\\]\\s?([\\s\\S]*)$/.exec(message);
    return m ? { code: m[1], detail: m[2] || null, message: m[3] } : { code: null, detail: null, message: message };
  };

  out.hasBridge = typeof window.bridge === 'object' && window.bridge !== null;
  out.bridgeMethods = out.hasBridge ? Object.keys(window.bridge).sort() : [];

  try {
    const info = await window.bridge.invoke('system:info');
    out.systemInfo = info;
    out.systemInfoOk = !!info && info.platform === 'electron' && Array.isArray(info.capabilities);
  } catch (e) { out.systemInfoOk = false; out.systemInfoErr = String((e && e.message) || e); }

  try {
    const list = await window.bridge.invoke('session:list');
    out.sessionListOk = Array.isArray(list);
  } catch (e) { out.sessionListOk = false; out.sessionListErr = String((e && e.message) || e); }

  // 反向：删一个不存在的会话，必须抛错（AppError NOT_FOUND）
  try {
    await window.bridge.invoke('session:delete', { sessionId: 'definitely-not-here' });
    out.errorPathThrew = false;
  } catch (e) {
    out.errorPathThrew = true;
    out.errorMessage = String((e && e.message) || e);
    // contextBridge 跨上下文只搬运 message，自定义属性会被丢掉 ——
    // 所以错误码必须编码进 message 前缀，这里验证它真的活下来了。
    const parsed = parseErr(e);
    out.errorCodePreserved = parsed.code !== null;
    out.errorDecodedCode = parsed.code;
    out.errorDecodedMessage = parsed.message;
    // 顺带把"自定义属性确实丢了"这件事记录下来，作为编码方式的依据
    out.errorRawPropCode = e ? e.code : undefined;
    out.errorOwnProps = e ? Object.keys(e) : [];
  }

  // 反向：未注册的通道，必须失败（不能静默返回 undefined）
  try {
    await window.bridge.invoke('no:such:channel');
    out.unknownChannelThrew = false;
  } catch (e) {
    out.unknownChannelThrew = true;
    out.unknownChannelMessage = String((e && e.message) || e).slice(0, 200);
  }

  // ── 单向推送通道（agent:stream）：这条不走 invoke，失败模式完全不同 ──
  const runOnce = async (title) => {
    const created = await window.bridge.invoke('session:create', { title });
    return window.bridge.invoke('agent:run', { sessionId: created.id, input: 'ping' });
  };
  const waitEnd = async (evts, ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (evts.some((x) => x.type === 'done' || x.type === 'error')) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };

  // A：订阅 → 跑 → 收全 → 退订
  const evA = [];
  const offA = window.bridge.on('agent:stream', (e) => evA.push(e));
  let runA = null;
  try {
    runA = await runOnce('selfcheck-A');
    out.streamRunId = runA.runId;
    out.streamEnded = await waitEnd(evA, 12000);
    out.streamEventTypes = evA.map((e) => e.type);
    out.streamFirstEvent = evA.length ? evA[0].type : null;
    out.streamLastEvent = evA.length ? evA[evA.length - 1].type : null;
    out.streamTokenCount = evA.filter((e) => e.type === 'token').length;
    out.streamTextLength = evA
      .filter((e) => e.type === 'token')
      .map((e) => e.text)
      .join('').length;
    const doneEv = evA.find((e) => e.type === 'done');
    out.streamUsage = doneEv ? doneEv.usage : null;
  } catch (e) {
    out.streamError = String((e && e.message) || e);
  }
  const countAOnUnsub = evA.length;
  offA();

  // B：A 退订后再跑一次 —— 若退订无效，evA 会继续增长（监听器泄漏）
  const evB = [];
  const offB = window.bridge.on('agent:stream', (e) => evB.push(e));
  try {
    await runOnce('selfcheck-B');
    out.streamSecondEnded = await waitEnd(evB, 12000);
  } catch (e) {
    out.streamSecondError = String((e && e.message) || e);
  }
  offB();
  out.streamUnsubscribeWorks = evA.length === countAOnUnsub;

  // ─────────────────────────────────────────────────────────────
  // M4 ①：工作区授权 + 文件系统 scope（正向 + 两条反向）
  // ─────────────────────────────────────────────────────────────
  let wsId = null;
  try {
    const wsList = await window.bridge.invoke('workspace:list');
    out.workspaceCount = wsList.length;
    wsId = wsList.length ? wsList[0].id : null;
  } catch (e) {
    out.workspaceCount = -1;
    out.scopeReadError = String((e && e.message) || e);
  }

  if (wsId) {
    // 正向：授权目录内的文件必须列得出来
    try {
      const entries = await window.bridge.invoke('fs:list-dir', { workspaceId: wsId, path: '.' });
      out.scopeReadEntries = entries.map((x) => x.name).sort();
      out.scopeReadOk = out.scopeReadEntries.indexOf(fixture.probeFile) >= 0;
    } catch (e) {
      out.scopeReadOk = false;
      out.scopeReadError = parseErr(e).message;
    }

    // 反向 A：\`..\` 越界必须被拒，且要能解出**具体** detail（只断言有前缀是不够的）
    try {
      await window.bridge.invoke('fs:list-dir', { workspaceId: wsId, path: '..' });
      out.scopeEscapeThrew = false;
    } catch (e) {
      const p = parseErr(e);
      out.scopeEscapeThrew = true;
      out.scopeEscapeCode = p.code;
      out.scopeEscapeDetail = p.detail;
    }

    // 反向 B：symlink 逃逸。夹具没建出来就如实记 skipped，**不当通过**
    if (fixture.symlinkName) {
      try {
        const leaked = await window.bridge.invoke('fs:read-file', { workspaceId: wsId, path: fixture.symlinkName });
        out.scopeSymlinkCase = 'failed';
        out.scopeSymlinkDetail = '读到了 scope 外的内容：' + String(leaked && leaked.text).slice(0, 32);
      } catch (e) {
        const p = parseErr(e);
        out.scopeSymlinkCase = p.detail === 'ESCAPE_ATTEMPT' ? 'passed' : 'failed';
        out.scopeSymlinkDetail = p.code + (p.detail ? ':' + p.detail : '');
      }
    } else {
      out.scopeSymlinkCase = 'skipped';
      out.scopeSymlinkDetail = '夹具未创建 symlink';
    }
  }

  // ─────────────────────────────────────────────────────────────
  // M4 ②：背压 —— 暂停期间**一个 token 都不能送出来**
  // ─────────────────────────────────────────────────────────────
  const bpEv = [];
  const offBp = window.bridge.on('agent:stream', (e) => bpEv.push(e));
  try {
    const created = await window.bridge.invoke('session:create', { title: 'selfcheck-backpressure' });
    const started = await window.bridge.invoke('agent:run', { sessionId: created.id, input: 'backpressure-probe' });
    await window.bridge.invoke('agent:control', { runId: started.runId, type: 'pause' });
    await new Promise((r) => setTimeout(r, 400));
    out.pausedTokenCount = bpEv.filter((e) => e.type === 'token').length;
    // 再等同样长的时间：真的暂停了就**一个都不涨**
    // （没暂停的话 400ms × 250 字符/秒 会多出十几个 token，不可能撞上）
    await new Promise((r) => setTimeout(r, 400));
    out.pausedTokenCountLater = bpEv.filter((e) => e.type === 'token').length;

    await window.bridge.invoke('agent:control', { runId: started.runId, type: 'resume' });
    out.backpressureEnded = await waitEnd(bpEv, 12000);
    out.resumeTokenCount = bpEv.filter((e) => e.type === 'token').length;
    out.backpressureTextLength = bpEv
      .filter((e) => e.type === 'token')
      .map((e) => e.text)
      .join('').length;
    const bpDone = bpEv.find((e) => e.type === 'done');
    out.backpressureMerged = bpDone && bpDone.usage ? bpDone.usage.mergedChunks : null;
  } catch (e) {
    out.backpressureError = parseErr(e).message;
  }
  offBp();

  // 反向 C：agent:control 对不存在的 runId 必须抛 NOT_FOUND
  try {
    await window.bridge.invoke('agent:control', { runId: 'run_definitely_not_here', type: 'pause' });
    out.controlUnknownThrew = false;
  } catch (e) {
    const p = parseErr(e);
    out.controlUnknownThrew = true;
    out.controlUnknownCode = p.code;
  }

  // ─────────────────────────────────────────────────────────────
  // M4.5：core Agent 内核的工具链路 —— 事件序列应当是
  //   start → tool → tool_end → token* → done
  // 这一条走的是**真通道**：脚本模型按输入里的标记决定先调工具。
  // 没有它，工具链路直到第一次接真模型之前都只是纸面设计。
  // ─────────────────────────────────────────────────────────────
  const toolEv = [];
  const offTool = window.bridge.on('agent:stream', (e) => toolEv.push(e));
  try {
    const created = await window.bridge.invoke('session:create', { title: 'selfcheck-tool' });
    await window.bridge.invoke('agent:run', {
      sessionId: created.id,
      input: '请回声 [[tool:echo]] 你好',
    });
    out.toolRunEnded = await waitEnd(toolEv, 12000);
    out.toolEventCount = toolEv.filter((e) => e.type === 'tool').length;
    const te = toolEv.find((e) => e.type === 'tool_end');
    out.toolEndOk = te ? te.ok : null;
    const iTool = toolEv.findIndex((e) => e.type === 'tool');
    const iToken = toolEv.findIndex((e) => e.type === 'token');
    out.toolBeforeToken = iTool >= 0 && iToken >= 0 && iTool < iToken;
    out.toolRunLastEvent = toolEv.length ? toolEv[toolEv.length - 1].type : null;
  } catch (e) {
    out.toolRunError = parseErr(e).message;
  }
  offTool();

  // ─────────────────────────────────────────────────────────────
  // M4 ③：驱动一次**真实 UI 点击**，让"越界被拒"进入归档截图。
  // 断言能证明逻辑对，但截图是人一眼能核验的东西 —— 两者都要。
  // ─────────────────────────────────────────────────────────────
  // 等文件树加载出来（browse 是挂载后异步发的，不一定已经回来）
  for (let i = 0; i < 30; i++) {
    if (document.querySelector('[data-testid="ws-entry"]')) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  out.uiEntryCount = document.querySelectorAll('[data-testid="ws-entry"]').length;
  out.uiEmptyNotice = (document.body.innerText || '').indexOf('（空目录）') >= 0;
  const escapeBtn = document.querySelector('[data-testid="ws-probe-escape"]');
  if (escapeBtn) {
    escapeBtn.click();
    await new Promise((r) => setTimeout(r, 500));
    out.uiEscapeClicked = true;
    out.uiEscapeShown = (document.body.innerText || '').indexOf('SCOPE_DENIED') >= 0;
  } else {
    out.uiEscapeClicked = false;
  }

  // ─────────────────────────────────────────────────────────────
  // M5：自动更新 —— 在**未打包**形态下必须如实说"不支持"
  //
  // 这是 M5-3 的验收（无签名 / 未打包环境不允许停在「检查中…」）。
  // 刻意走真实点击：断言能证明链路，截图能让人一眼核验。
  // ─────────────────────────────────────────────────────────────
  const upEvents = [];
  window.__upEvents = upEvents;
  const offUp = window.bridge.on('update:status', (s) => upEvents.push(s));
  const upBtn = document.querySelector('[data-testid="update-check"]');
  if (upBtn) {
    upBtn.click();
    out.updateButtonClicked = true;
    // 等 React 把推送过来的状态画到 DOM 上（invoke 是异步的）
    await new Promise((r) => setTimeout(r, 700));
    const el = document.querySelector('[data-testid="update-status"]');
    out.updateDomStage = el ? el.getAttribute('data-stage') : null;
    out.updateDomRetryable = el ? el.getAttribute('data-retryable') : null;
  } else {
    out.updateButtonClicked = false;
  }

  out.updateEventCount = upEvents.length;
  out.updateFirstStage = upEvents.length ? upEvents[0].stage : null;
  out.updateFirstRetryable = upEvents.length ? upEvents[0].retryable : null;
  out.updateFirstMessage = upEvents.length ? upEvents[0].message : null;
  out.updateSawChecking = upEvents.some((s) => s.stage === 'checking');
  out.updateLastStage = upEvents.length ? upEvents[upEvents.length - 1].stage : null;

  // 直接调 invoke 也要能拿到结构化错误码（按钮那条路把它收进了状态里）
  try {
    await window.bridge.invoke('update:check');
    out.updateCheckThrew = false;
  } catch (e) {
    const p = parseErr(e);
    out.updateCheckThrew = true;
    out.updateCheckCode = p.code;
    out.updateCheckDetail = p.detail;
  }

  // 另外两条通道在没有可用版本时也必须**抛错**，不能静默成功 ——
  // 静默成功会让 UI 以为"已经开始下载了"，然后一直等一个永远不会来的进度。
  try {
    await window.bridge.invoke('update:download');
    out.updateDownloadThrew = false;
  } catch (e) {
    out.updateDownloadThrew = true;
    out.updateDownloadCode = parseErr(e).code;
  }
  try {
    await window.bridge.invoke('update:install');
    out.updateInstallThrew = false;
  } catch (e) {
    out.updateInstallThrew = true;
    out.updateInstallCode = parseErr(e).code;
  }

  // 退订。第二次触发由 main 侧在复位状态之后发起（否则会被去重掉，
  // 「退订失效」也能通过 —— 这条断言第一版就是这么被骗过去的）。
  out.updateEventsBeforeUnsub = upEvents.length;
  offUp();

  const statusEl = document.querySelector('[data-testid="boot-status"]');
  out.domStatus = statusEl ? statusEl.getAttribute('data-state') : null;
  out.domText = document.body.innerText.slice(0, 1500);
  return out;
})()`;
}

/**
 * 第二阶段探针：main 侧已把更新状态复位，这里再触发一次检查。
 *
 * 目的只有一个 —— 验证第一条推送通道的**退订真的生效**：
 * 上一个探针已经 offUp()，若事件数仍然不变，说明监听器确实摘掉了。
 * 这条断言对 agent 流已经有过（evA 不再增长），但那是另一条通道；
 * 推送通道的退订逻辑在 preload 里是同一段代码，可**用到**它的地方是两条 ——
 * 只测一条就等于没测另一条。
 */
function buildUpdateResumeProbeScript(): string {
  return `(async () => {
  const out = {};
  try {
    await window.bridge.invoke('update:check');
    out.resumeThrew = false;
  } catch (e) {
    out.resumeThrew = true;
  }
  await new Promise((r) => setTimeout(r, 200));
  out.eventsWhileUnsubscribed = (window.__upEvents || []).length;
  return out;
})()`;
}

function collectConsole(bucket: string[]) {
  return (...args: unknown[]): void => {
    const first = args[0] as Record<string, unknown> | undefined;
    // Electron 36+ 把 console-message 的参数合并成了一个 details 对象，
    // 这里同时兼容新老签名 —— 否则会静默漏掉所有错误。
    const isDetails =
      typeof first === 'object' && first !== null && 'message' in first && 'level' in first;

    const level = isDetails ? first.level : args[1];
    const message = isDetails ? first.message : args[2];
    const isError = level === 'error' || level === 3;

    if (isError) bucket.push(String(message));
  };
}

async function waitForReady(win: BrowserWindow, timeoutMs: number): Promise<string | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (win.isDestroyed()) return null;
    try {
      const state = (await win.webContents.executeJavaScript(
        `(() => { const el = document.querySelector('[data-testid="boot-status"]'); return el ? el.getAttribute('data-state') : null; })()`,
      )) as string | null;
      if (state === 'ready' || state === 'error') return state;
    } catch {
      // 页面还没就绪时 executeJavaScript 会抛，属于预期内，继续轮询
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

export async function runSelfCheck(
  win: BrowserWindow,
  outDir: string,
  channelCount: number,
  channelList: string[],
  fixture: ScopeFixture,
): Promise<number> {
  const consoleErrors: string[] = [];
  win.webContents.on('console-message', collectConsole(consoleErrors));

  // 两个"只记第一次"的采样点必须复位（见 perf.ts）：否则在同一个进程里跑第二遍
  // 会复用上一遍的首帧时刻，给出一个莫名其妙的小数字 —— 而且它不会报错。
  resetPerfForSelfCheck();

  const failures: string[] = [];
  const warnings: string[] = [];
  let domStatus: string | null = null;

  try {
    await new Promise<void>((resolve) => {
      if (!win.webContents.isLoading()) return resolve();
      win.webContents.once('did-finish-load', () => resolve());
    });

    domStatus = await waitForReady(win, 20_000);
    if (domStatus !== 'ready') {
      failures.push(domStatus === null ? '渲染层 20s 内未就绪（可能白屏 / 脚本报错）' : `渲染层状态为 ${domStatus}`);
    }
  } catch (err) {
    failures.push(`加载阶段异常：${String(err)}`);
  }

  let probe: SelfCheckProbe | null = null;
  try {
    probe = (await win.webContents.executeJavaScript(
      buildProbeScript(fixture),
    )) as SelfCheckProbe;

    if (!probe.hasBridge) failures.push('window.bridge 未挂载 —— preload 没生效或 sandbox 下 ESM/CJS 格式不对');
    if (!probe.systemInfoOk) failures.push('system:info 正向探针失败');
    if (!probe.sessionListOk) failures.push('session:list 正向探针失败');
    if (!probe.errorPathThrew) failures.push('session:delete 删除不存在的会话竟未抛错 —— 错误路径失效');
    if (!probe.errorCodePreserved) {
      failures.push(
        '错误码未跨 preload → renderer 边界保留：contextBridge 只搬运 message，' +
          'code 必须编码进 message 前缀（见 contract 的 encodeBridgeError）',
      );
    }
    // 只断言"有前缀"是不够的：把业务码一路压成 INTERNAL 同样能通过前缀检查。
    // 必须断言具体是哪个码，否则「错误信封」退化成一句装饰。
    if (probe.errorDecodedCode !== 'NOT_FOUND') {
      failures.push(
        `错误码应为 NOT_FOUND，实际 ${String(probe.errorDecodedCode)} —— ` +
          '序列化链路可能把业务码吞成了 INTERNAL',
      );
    }
    if (!probe.unknownChannelThrew) failures.push('未注册通道竟然没有失败 —— 通道表约束失效');

    // ── 单向推送通道 ──
    if (probe.streamError) failures.push(`agent:run 抛错：${probe.streamError}`);
    if (probe.streamEnded !== true) failures.push('流式运行未在 12s 内结束（没收到 done / error）');
    if (probe.streamFirstEvent !== 'start') failures.push(`流首个事件应为 start，实际 ${String(probe.streamFirstEvent)}`);
    if (probe.streamLastEvent !== 'done') failures.push(`流末个事件应为 done，实际 ${String(probe.streamLastEvent)}`);
    if ((probe.streamTokenCount ?? 0) < 5) failures.push(`token 事件过少（${String(probe.streamTokenCount)}），流式通道可能没真正推送`);
    if ((probe.streamTextLength ?? 0) === 0) failures.push('流式文本为空 —— 事件到了但载荷是空的');
    if (!probe.streamUsage) failures.push('done 事件缺少 usage 统计');
    if (probe.streamSecondEnded !== true) failures.push('第二次流式运行未结束');
    if (probe.streamUnsubscribeWorks !== true) {
      failures.push("bridge.on('agent:stream') 退订无效 —— 监听器泄漏（同一条流会被渲染多次）");
    }

    // ── M4 ①：scope 授权（正向 + 两条反向）──
    if ((probe.workspaceCount ?? 0) < 1) {
      failures.push('自检夹具工作区未授权 —— scope 断言无法成立（检查 grantWorkspaceForSelfCheck）');
    }
    if (probe.scopeReadOk !== true) {
      failures.push(
        `fs:list-dir 正向探针失败：未在授权目录里列出 ${fixture.probeFile}` +
          (probe.scopeReadError ? `（${probe.scopeReadError}）` : ''),
      );
    }
    if (!probe.scopeEscapeThrew) failures.push('fs:list-dir 读 `..` 竟然成功 —— workspace scope 边界失效！');
    if (probe.scopeEscapeCode !== 'SCOPE_DENIED') {
      failures.push(`越界错误码应为 SCOPE_DENIED，实际 ${String(probe.scopeEscapeCode)}（压成 FORBIDDEN 会让 UI 无法分流）`);
    }
    if (probe.scopeEscapeDetail !== 'OUT_OF_SCOPE') {
      failures.push(`越界 detail 应为 OUT_OF_SCOPE，实际 ${String(probe.scopeEscapeDetail)}`);
    }
    if (probe.scopeSymlinkCase === 'failed') {
      failures.push(`symlink 逃逸未被拦住：${String(probe.scopeSymlinkDetail)}`);
    } else if (probe.scopeSymlinkCase === 'skipped') {
      // 不算失败，但**必须被看见** —— 静默跳过 = 假装验证过了
      warnings.push(`symlink 逃逸断言未执行：${String(fixture.symlink.reason)}（core 单测覆盖此路径）`);
    }

    // ── M4 ②：背压 ──
    if (probe.backpressureError !== undefined) failures.push(`背压探针失败：${probe.backpressureError}`);
    if ((probe.pausedTokenCount ?? -1) < 0) {
      failures.push('pause 探针未取到 token 计数');
    } else if ((probe.pausedTokenCount ?? 0) > 1) {
      failures.push(`pause 之前就送出了 ${String(probe.pausedTokenCount)} 个 token，无法判定暂停是否生效`);
    }
    if (probe.pausedTokenCountLater !== probe.pausedTokenCount) {
      failures.push(
        `pause 期间仍在推送 token（${String(probe.pausedTokenCount)} → ${String(
          probe.pausedTokenCountLater,
        )}）—— 背压失效`,
      );
    }
    if (probe.backpressureEnded !== true) failures.push('resume 之后流式未在 12s 内结束');
    if ((probe.resumeTokenCount ?? 0) <= (probe.pausedTokenCount ?? 0)) {
      failures.push('resume 之后没有新的 token —— 暂停把流卡死了');
    }
    if (!probe.controlUnknownThrew) failures.push('agent:control 对不存在的 runId 竟然没有失败');
    if (probe.controlUnknownCode !== 'NOT_FOUND') {
      failures.push(`agent:control 未知 runId 应解出 NOT_FOUND，实际 ${String(probe.controlUnknownCode)}`);
    }

    // ── M4.5：工具链路 ──
    if (probe.toolRunError !== undefined) failures.push(`工具链路探针失败：${probe.toolRunError}`);
    if (probe.toolRunEnded !== true) failures.push('带工具的 run 未在 12s 内结束');
    if ((probe.toolEventCount ?? 0) < 1) {
      failures.push('没有收到 tool 事件 —— Agent 内核的工具链路未接通（还是纯吐字的脚本？）');
    }
    if (probe.toolEndOk !== true) failures.push(`tool_end 未报告成功：${String(probe.toolEndOk)}`);
    if (probe.toolBeforeToken !== true) {
      failures.push('tool 事件没有出现在 token 之前 —— "先干活再回答"的顺序被破坏');
    }
    if (probe.toolRunLastEvent !== 'done') {
      failures.push(`带工具的 run 末个事件应为 done，实际 ${String(probe.toolRunLastEvent)}`);
    }

    // ── M4 ③：渲染层文件树 + 越界可见化 ──
    // 这条断言抓的是一类很隐蔽的 UI 谎言：目录读出来了，但渲染层因为
    // "只选中、没请求"而把结果画成「（空目录）」—— 看着像空文件夹，
    // 实际是根本没读。截图里出现过，所以固化成断言。
    if ((probe.uiEntryCount ?? 0) < 1) {
      failures.push(
        `授权工作区的文件树没有渲染出任何条目（uiEntryCount=${String(probe.uiEntryCount)}）——` +
          '渲染层可能只设置了 activeWsId 却没请求目录内容',
      );
    }
    if (probe.uiEmptyNotice === true) {
      failures.push('界面显示了「（空目录）」，但夹具里明明有文件 —— 把"没加载"画成了"空"');
    }
    if (probe.uiEscapeClicked !== true) failures.push('UI 越界探针按钮未点击成功');
    if (probe.uiEscapeShown !== true) {
      failures.push('点击「试读 ../」后界面上没有出现 SCOPE_DENIED —— 越界拒绝没有对用户可见');
    }

    // ── M5：自动更新（M5-3 验收：未打包 / 无签名环境必须报 error，不允许转圈）──
    if (probe.updateButtonClicked !== true) {
      failures.push('界面里没有找到「检查更新」按钮 —— update.auto 能力探测或卡片渲染失效');
    }
    // 这条是 M5-3 的核心断言：**不是** checking。
    // 界面停在 checking = 用户面对一个转圈到天荒地老的按钮，
    // 而 electron-updater 在这种情况下恰恰不会抛错（它只打一行日志）。
    if (probe.updateDomStage === 'checking') {
      failures.push('未打包环境下界面停在了 checking —— 「永远转圈」复现（M5-3 未达成）');
    }
    if (probe.updateDomStage !== 'error') {
      failures.push(
        `未打包环境下界面阶段应为 error，实际 ${String(probe.updateDomStage)} —— ` +
          '更新功能在不可用时要如实显示，不能装作没事',
      );
    }
    if (probe.updateDomRetryable !== 'false') {
      failures.push(
        `未打包/无签名这类失败必须标成不可重试，实际 retryable=${String(probe.updateDomRetryable)} —— ` +
          '给了重试按钮等于把唯一的路指错方向',
      );
    }
    // 恰好 1 条：既不能是 0（通道没接上），也不能重复推（渲染层会被同一条状态刷屏）
    if (probe.updateEventCount !== 1) {
      failures.push(
        `点击检查更新应恰好收到 1 条 update:status，实际 ${String(probe.updateEventCount)}`,
      );
    }
    if (probe.updateFirstStage !== 'error') failures.push(`首条 update:status 应为 error，实际 ${String(probe.updateFirstStage)}`);
    if (probe.updateFirstRetryable !== false) failures.push('首条 update:status 的 retryable 应为 false');
    if (typeof probe.updateFirstMessage !== 'string' || probe.updateFirstMessage.length === 0) {
      failures.push('error 阶段没带 message —— 用户只会看到一个红点，不知道发生了什么');
    }
    if (probe.updateSawChecking === true) {
      failures.push('推送里出现了 checking 阶段 —— 自我否决的路径不该先宣称"正在检查"');
    }
    // 反向：不支持的环境里，另外两条通道也必须抛错，不能静默成功
    if (probe.updateCheckThrew !== true) failures.push('未打包环境下 update:check 竟然没有失败');
    if (probe.updateCheckCode !== 'UNSUPPORTED') {
      failures.push(
        `update:check 应解出 UNSUPPORTED，实际 ${String(probe.updateCheckCode)} —— ` +
          '压成 INTERNAL 会让 UI 提示"请上报 bug"，而正确动作是隐藏入口',
      );
    }
    if (probe.updateCheckDetail !== 'NOT_PACKAGED') {
      failures.push(`update:check 的 detail 应为 NOT_PACKAGED，实际 ${String(probe.updateCheckDetail)}`);
    }
    if (probe.updateDownloadThrew !== true) {
      failures.push('没有可用版本时 update:download 静默成功了 —— UI 会一直等一个永远不来的进度');
    }
    if (probe.updateInstallThrew !== true) failures.push('未就绪时 update:install 静默成功了');
  } catch (err) {
    failures.push(`探针执行失败：${String(err)}`);
  }

  // ─────────────────────────────────────────────────────────────
  // M5 第二段：推送通道的退订是否真的生效。
  //
  // 必须先复位状态：不复位的话第二次推的是同一条 error（消息完全相同），
  // 会被 main 的「重复状态不推」去重 —— 于是"退订失效"也能通过。
  // 第一版就是这么写的，被去重骗过去了，所以这条复位是断言的一部分，不是清理。
  // ─────────────────────────────────────────────────────────────
  resetUpdateStateForSelfCheck();
  if (probe !== null) {
    try {
      const resume = (await win.webContents.executeJavaScript(
        buildUpdateResumeProbeScript(),
      )) as { resumeThrew?: boolean; eventsWhileUnsubscribed?: number };

      if (resume.resumeThrew !== true) {
        failures.push('复位后再检查更新竟然没有抛错 —— 确认状态机没有被意外放行');
      }
      // exactOptionalPropertyTypes 下不能把 undefined 赋给可选属性 —— 显式判一下，
      // 顺便把"探针没返回计数"变成一条可见的失败，而不是静默跳过断言。
      if (typeof resume.eventsWhileUnsubscribed === 'number') {
        probe.updateEventsAfterUnsub = resume.eventsWhileUnsubscribed;
      } else {
        failures.push('退订探针没有返回事件计数 —— 无法判定监听器是否泄漏');
      }
      if (probe.updateEventsAfterUnsub !== probe.updateEventsBeforeUnsub) {
        failures.push(
          "bridge.on('update:status') 退订无效 —— " +
            `退订前 ${String(probe.updateEventsBeforeUnsub)} 条，退订后又涨到 ` +
            `${String(probe.updateEventsAfterUnsub)} 条（监听器泄漏）`,
        );
      }
      // 跨进程一致性：main 认为的状态与推给渲染层的最后一个阶段必须一致。
      // 不一致意味着有状态变化没被推出去 —— 用户看到的界面会永远落后一步。
      const mainStage = currentUpdateStatus().stage;
      if (mainStage !== probe.updateLastStage) {
        failures.push(
          `main 侧状态(${mainStage}) 与推给渲染层的最后阶段(${String(probe.updateLastStage)}) 不一致 —— 有状态变化没推送`,
        );
      }
    } catch (err) {
      failures.push(`更新退订探针执行失败：${String(err)}`);
    }
  }

  const criticalConsoleError = consoleErrors.filter((m) => !/Autofill|DevTools/.test(m));
  if (criticalConsoleError.length > 0) {
    failures.push(`渲染层控制台有 ${criticalConsoleError.length} 条错误`);
  }

  // ── Agent 内核不变量（不是功能断言，是"不该发生的事"）──
  const dropped = droppedAfterTerminal();
  const undelivered = undeliveredTerminalCount();
  if (dropped !== 0) {
    failures.push(`终态之后仍投递了 ${dropped} 个事件 —— 有调度没摘干净（定时器泄漏）`);
  }
  if (undelivered !== 0) {
    failures.push(
      `有 ${undelivered} 个终态事件找不到窗口被丢弃 —— 事件路由坏了：` +
        '渲染层会收齐 token 却永远等不到 done（先删窗口映射再查就会这样）',
    );
  }

  // ── M6-1 性能快照 ─────────────────────────────────────────
  //
  // 走**渲染层的 bridge** 调 —— 与用户路径完全相同的通道，不是从 main 内部抄近路。
  // 首帧与帧率只有渲染层测得到（它才看得见 rAF），这里是取回汇聚结果。
  let perf: PerfSnapshot | null = null;
  try {
    perf = (await win.webContents.executeJavaScript(
      `window.bridge.invoke(${JSON.stringify(IPC.perfSample)}, {})`,
    )) as PerfSnapshot;
  } catch (err) {
    warnings.push(`性能采样失败：${String(err)}`);
  }
  if (perf !== null) {
    // 「没测到」要单独说，不能与「数值很小」混同 ——
    // 0ms 冷启动读起来像性能奇迹，实际是根本没测。这类静默失败最值得显式化。
    if (perf.coldStartMs === 0) warnings.push('冷启动未测到（渲染层没有上报首帧）');
    if (perf.streamFps === 0) warnings.push('流式帧率未测到（本次自检没跑流式）');
    if (perf.rendererRssBytes === 0) warnings.push('渲染进程内存未测到（拿不到该窗口的 pid 指标）');
    console.log(
      `[selfcheck] 性能：冷启动 ${perf.coldStartMs}ms / main ${(perf.mainRssBytes / 1048576).toFixed(1)}MB` +
        ` / renderer ${(perf.rendererRssBytes / 1048576).toFixed(1)}MB / ${perf.streamFps}fps`,
    );
  }

  let screenshot: string | null = null;
  try {
    mkdirSync(outDir, { recursive: true });
    const image = await win.webContents.capturePage();
    screenshot = join(outDir, 'window.png');
    writeFileSync(screenshot, image.toPNG());
  } catch (err) {
    failures.push(`截图失败：${String(err)}`);
  }

  const report: SelfCheckReport = {
    ok: failures.length === 0,
    ranAt: new Date().toISOString(),
    mode: runtimeConfig().dev ? 'dev' : 'prod',
    versions: {
      electron: process.versions.electron ?? '?',
      chrome: process.versions.chrome ?? '?',
      node: process.versions.node ?? '?',
      app: app.getVersion(),
      v8: process.versions.v8 ?? '?',
    },
    registeredChannelCount: channelCount,
    registeredChannels: channelList,
    scopeFixture: {
      root: fixture.root,
      symlink: fixture.symlink,
      outsideFile: fixture.outsideFile,
    },
    probe: probe ?? ({} as SelfCheckProbe),
    agentRuntime: {
      droppedAfterTerminal: dropped,
      undeliveredTerminal: undelivered,
    },
    perf,
    warnings,
    consoleErrors: criticalConsoleError,
    screenshot,
    failures,
  };

  mkdirSync(outDir, { recursive: true });
  const reportPath = join(outDir, 'report.json');
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  // 控制台输出留一份精简版 —— 跑 CI / 脚本时不用再开文件
  console.log(`\n[selfcheck] ok=${report.ok}  mode=${report.mode}`);
  console.log(`[selfcheck] electron ${report.versions.electron} / chrome ${report.versions.chrome} / node ${report.versions.node}`);
  console.log(`[selfcheck] 已注册通道 ${channelCount} 个`);
  console.log(`[selfcheck] 夹具工作区：${fixture.root}（symlink ${fixture.symlink.status}）`);
  console.log(`[selfcheck] 报告：${reportPath}`);
  console.log(`[selfcheck] 截图：${screenshot ?? '(失败)'}`);
  if (failures.length > 0) {
    console.log('[selfcheck] 失败项：');
    for (const f of failures) console.log(`  - ${f}`);
  }
  if (warnings.length > 0) {
    console.log('[selfcheck] 未执行 / 需注意：');
    for (const w of warnings) console.log(`  - ${w}`);
  }
  if (criticalConsoleError.length > 0) {
    console.log('[selfcheck] 控制台错误：');
    for (const e of criticalConsoleError) console.log(`  - ${e}`);
  }

  // ── 完成哨兵 ──────────────────────────────────────────────
  //
  // 为什么需要它：在受限会话（无桌面 / 沙箱起不来 viz）里，Chromium 可能
  // **无法干净退出** —— `app.exit()` 会卡在残留的 GPU/viz 子进程上，
  // 于是 `pnpm selfcheck` 永远不返回。校验链挂在"进程能不能退出"上，
  // 而不是挂在"断言过没过"上，这本身就是错的。
  //
  // 所以这里明确广播"报告已落盘"，由 launch.mjs（监督进程）据此收尾：
  // 它才是唯一有能力强杀进程树的一层。应用内部的定时器救不了自己 ——
  // 事件循环已经停摆，兜底 setTimeout 根本不会触发（实测）。
  const code = report.ok ? 0 : 1;
  console.log(`[selfcheck] DONE ok=${report.ok} code=${code}`);

  return code;
}
