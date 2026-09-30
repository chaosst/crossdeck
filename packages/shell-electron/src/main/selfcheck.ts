import { app, BrowserWindow } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
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
 */

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
  probe: SelfCheckProbe;
  consoleErrors: string[];
  screenshot: string | null;
  failures: string[];
}

/** 渲染进程里跑的探针脚本 —— 字符串形式，因为它执行在另一个上下文。 */
const PROBE_SCRIPT = `(async () => {
  const out = {};
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
    // 注意：这一段是要被 evaluate 的字符串源码，反斜杠会被模板字符串再吃一层。
    // 正则里的方括号转义必须写成双反斜杠，否则到渲染进程就变成裸的 [ （非法正则）。
    const m = /^\\[([A-Z_]+)\\]\\s?([\\s\\S]*)$/.exec(out.errorMessage);
    out.errorCodePreserved = !!m;
    out.errorDecodedCode = m ? m[1] : null;
    out.errorDecodedMessage = m ? m[2] : null;
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

  const statusEl = document.querySelector('[data-testid="boot-status"]');
  out.domStatus = statusEl ? statusEl.getAttribute('data-state') : null;
  out.domText = document.body.innerText.slice(0, 1500);
  return out;
})()`;

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
): Promise<number> {
  const consoleErrors: string[] = [];
  win.webContents.on('console-message', collectConsole(consoleErrors));

  const failures: string[] = [];
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
    probe = (await win.webContents.executeJavaScript(PROBE_SCRIPT)) as SelfCheckProbe;

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
    probe: probe ?? ({} as SelfCheckProbe),
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
  console.log(`[selfcheck] 报告：${reportPath}`);
  console.log(`[selfcheck] 截图：${screenshot ?? '(失败)'}`);
  if (failures.length > 0) {
    console.log('[selfcheck] 失败项：');
    for (const f of failures) console.log(`  - ${f}`);
  }
  if (criticalConsoleError.length > 0) {
    console.log('[selfcheck] 控制台错误：');
    for (const e of criticalConsoleError) console.log(`  - ${e}`);
  }

  return report.ok ? 0 : 1;
}
