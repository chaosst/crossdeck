import { app, BrowserWindow } from 'electron';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runtimeConfig } from './runtimeConfig.js';

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

  // 夹具必须**幂等**。少了这一步：上一轮留下的 link-out 会让 symlinkSync 抛 EEXIST，
  // 而 EEXIST 很容易被误读成「平台不支持 symlink」—— 于是这条反向断言从第二轮起
  // 就永远退化成 skipped。**看着是"跳过了"，实际是"从来没验过"**，
  // 而 skipped 又不判失败，所以它会一直安静地烂在那里。
  try {
    rmSync(linkPath, { force: true, recursive: true });
  } catch {
    // 清不掉就交给下面的创建去报错 —— 但那时要把 EEXIST 如实说出来，不能再赖平台
  }

  let symlink: ScopeFixture['symlink'] = { status: 'skipped', name: null, reason: null };
  try {
    // 用相对目标：整个夹具目录可以被搬走而不破坏链接
    symlinkSync(join('..', 'outside', 'secret.txt'), linkPath, 'file');
    symlink = { status: 'ok', name: linkName, reason: null };
  } catch (err) {
    // 区分「平台不允许」和「残留文件冲突」—— 两者的处置完全不同：
    // 前者是已知的降级（core 单测兜住），后者是**夹具自己坏了**，必须能一眼看出来。
    const code = (err as { code?: unknown } | null)?.code;
    const why =
      code === 'EPERM' || code === 'EACCES'
        ? '当前账户无创建符号链接的权限（Windows 需开发者模式 / 管理员）'
        : code === 'EEXIST'
          ? '同名条目已存在且无法清除（夹具状态不干净）'
          : `创建失败（${String(code ?? 'unknown')}）`;
    symlink = {
      status: 'skipped',
      name: null,
      reason: `${why}：${err instanceof Error ? err.message : String(err)}`,
    };
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
  // ── M4：渲染层文件树 + 越界可见化（驱动真实点击，让截图也成为证据）──
  uiEntryCount?: number;
  uiEmptyNotice?: boolean;
  uiEscapeClicked?: boolean;
  uiEscapeShown?: boolean;
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
  const offA = window.bridge.onStream((e) => evA.push(e));
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
  const offB = window.bridge.onStream((e) => evB.push(e));
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
  const offBp = window.bridge.onStream((e) => bpEv.push(e));
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

  const statusEl = document.querySelector('[data-testid="boot-status"]');
  out.domStatus = statusEl ? statusEl.getAttribute('data-state') : null;
  out.domText = document.body.innerText.slice(0, 1500);
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
      failures.push('onStream 退订无效 —— 监听器泄漏（同一条流会被渲染多次）');
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
  } catch (err) {
    failures.push(`探针执行失败：${String(err)}`);
  }

  const criticalConsoleError = consoleErrors.filter((m) => !/Autofill|DevTools/.test(m));
  if (criticalConsoleError.length > 0) {
    failures.push(`渲染层控制台有 ${criticalConsoleError.length} 条错误`);
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
