import { app, BrowserWindow } from 'electron';
import { isTerminalStage } from '@crossdeck/contract';
import type { UpdateStage } from '@crossdeck/contract';
import { checkForUpdates, currentUpdateStatus, downloadUpdate } from './updater.js';

/**
 * 更新链路探针 —— 对着一个**真实可访问的 HTTP 更新源**跑完整条路。
 *
 * 为什么需要它（而不是只靠 selfcheck）：
 *   selfcheck 跑的是未打包形态，那条路径**必然**落在 UNSUPPORTED 分支 ——
 *   它能证明「条件不具备时会如实报错」，却完全碰不到
 *   「真的有新版本」这一半：feed 怎么解析、版本怎么比、下载进度怎么来、
 *   下载完成是个什么状态。而那一半才是自动更新真正会走的路。
 *
 * 为什么只能在打包产物里跑：
 *   `isUpdateSupported()` 判的是 `app.isPackaged`。未打包形态下探针会在第一步
 *   就拿到 UNSUPPORTED —— 那不是"链路通了"，是"链路根本没进去"。
 *   所以这里把 packaged 当成一条断言，而不是一个前提。
 *
 * 为什么由脚本（scripts/verify-update-feed.mjs）起进程、而不是 pnpm script 直接跑：
 *   它需要一个本地 HTTP 服务端、一份 latest.yml、一个假的安装包，
 *   以及"应用不退出就强杀进程树"的兜底 —— 这些都不该塞进应用里。
 *
 * ⚠️ 探针**不会**走到 install：那一步会 `quitAndInstall`，把假安装包真的执行起来。
 *    链路验到 `ready` 为止 —— `ready` 已经是「文件下载完且校验通过」的终态。
 *
 * ── 关于"在哪儿收集状态"这件事，第一版踩过的坑 ──────────────────
 * 第一版在主进程里 `setInterval(50ms)` 轮询 `currentUpdateStatus()`。结果是
 * **假阴性**：本机回环上整个 check 只花了几毫秒，`checking` 与 `available`
 * 两帧完整地落在同一个采样间隔里，一帧都没被采到，于是断言报"没有出现
 * checking"—— 而主进程日志里那两行写得清清楚楚，链路其实完全正常。
 *
 * 采样永远会漏。所以现在改成正路：在**渲染层**订阅推送通道收集全量事件。
 * 这不但不漏帧，还顺带证明了另一件事 —— 推送真的走到了渲染层
 * （主进程自己的状态对不对，和界面收没收到，是两回事）。
 */

/** 等终态时的轮询间隔。只用于判"到没到终态"，不用于采样事件，所以粗一点没关系。 */
const POLL_MS = 50;

const CHECK_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** 一帧状态快照。判的是"界面能拿到的东西"，所以只留契约里真实存在的字段。 */
interface StageFrame {
  stage: UpdateStage;
  /** 该阶段对应的版本号（idle / checking / error 没有） */
  version: string | null;
  /** 该阶段对应的百分比（只有 downloading 有） */
  percent: number | null;
  retryable: boolean | null;
  message: string | null;
}

export interface UpdateFeedProbeReport {
  ok: boolean;
  packaged: boolean;
  appVersion: string;
  feedUrl: string | null;
  expectedVersion: string | null;
  bootState: string | null;
  rendererHasUpdateCard: boolean;
  /** 最后渲染出来的卡片阶段（DOM 上的 data-stage）—— 界面到底显示了什么 */
  rendererFinalStageAttr: string | null;
  /** 主进程眼里的终态 —— 与上面的 data-stage 应当一致 */
  mainFinalStage: UpdateStage;
  checkReturnedVersion: string | null;
  checkError: string | null;
  downloadError: string | null;
  /** 渲染层收到的全部推送，按到达顺序 */
  frames: StageFrame[];
  failures: string[];
}

/**
 * 把任意一个推过来的状态规范化。
 *
 * 刻意不信任入参形状：这份数据是穿过 IPC 到达渲染层、又被 executeJavaScript
 * 取回来的，中途任何一步出问题都会得到"看着像但不是"的对象。
 * 规范化不了就返回 null，由调用方记一条失败 —— 而不是让下面的断言
 * 在一个畸形对象上做出结论。
 */
function normalizeFrame(raw: unknown): StageFrame | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as { stage?: unknown; info?: unknown; percent?: unknown; retryable?: unknown; message?: unknown };
  const stages: UpdateStage[] = ['idle', 'checking', 'available', 'downloading', 'ready', 'error'];
  if (typeof r.stage !== 'string' || !stages.includes(r.stage as UpdateStage)) return null;

  const info = typeof r.info === 'object' && r.info !== null ? (r.info as { version?: unknown }) : null;
  return {
    stage: r.stage as UpdateStage,
    version: info !== null && typeof info.version === 'string' ? info.version : null,
    percent: typeof r.percent === 'number' ? r.percent : null,
    retryable: typeof r.retryable === 'boolean' ? r.retryable : null,
    message: typeof r.message === 'string' ? r.message : null,
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 带超时的等待。
 *
 * 刻意不用 `Promise.race([p, sleep(n).then(() => throw)])` 那种一行写法：
 * 竞速结束后，那个"晚到的 reject"没人接 —— 会变成一条 unhandledRejection，
 * 混在输出里看起来像更新链路出了问题，实际只是超时守卫的尾巴。
 * 所以定时器必须在 finally 里清掉。
 */
async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 在 ${ms}ms 内没有返回`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 等渲染层自报就绪。
 *
 * 复用 selfcheck 认的那个信号（`[data-testid="boot-status"]` 的 `data-state`），
 * 而不是改用 `did-finish-load`：后者只说明 HTML 到了，
 * 白屏（脚本报错）时它照样会触发 —— 那正是这个断言要抓的东西。
 */
async function waitForBoot(win: BrowserWindow, timeoutMs: number): Promise<string | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (win.isDestroyed()) return null;
    try {
      const state = (await win.webContents.executeJavaScript(
        `(() => { const el = document.querySelector('[data-testid="boot-status"]'); return el ? el.getAttribute('data-state') : null; })()`,
      )) as string | null;
      if (state === 'ready' || state === 'error') return state;
    } catch {
      // 页面还没就绪时 executeJavaScript 会抛 —— 预期内，继续轮询
    }
    await sleep(250);
  }
  return null;
}

/** 等一个终态。返回 false 表示超时（也就是"卡住不动"——最该被抓住的失败）。 */
async function waitForTerminal(timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (isTerminalStage(currentUpdateStatus().stage)) return true;
    await sleep(POLL_MS);
  }
  return false;
}

/** 探针在渲染层留下的收集器名字。带前缀是为了在 DevTools 里一眼看出是谁放的。 */
const COLLECTOR = '__crossdeckUpdateFeedProbe';

export async function runUpdateFeedProbe(win: BrowserWindow, expectedVersion: string | null): Promise<number> {
  const failures: string[] = [];

  const bootState = await waitForBoot(win, 20_000);
  if (bootState !== 'ready') {
    failures.push(`渲染层未就绪（boot-status=${String(bootState)}）—— 打包产物的渲染层没起来`);
  }

  let rendererHasUpdateCard = false;
  try {
    const dom = (await win.webContents.executeJavaScript(
      `(() => {
         const card = document.querySelector('[data-testid="update-status"]');
         return { has: card !== null, stage: card ? card.getAttribute('data-stage') : null };
       })()`,
    )) as { has: boolean; stage: string | null };
    rendererHasUpdateCard = dom.has;
    if (dom.stage !== 'never') {
      // "never" 是卡片还没收到任何状态时的初值。这里要求它——否则说明
      // 在我们开始之前就已经有东西推过状态了，那轨迹的起点就不干净。
      failures.push(`探针开始前更新卡片已有阶段 ${String(dom.stage)}，轨迹起点不干净`);
    }
  } catch (err) {
    failures.push(`读取渲染层更新卡片失败：${String(err)}`);
  }
  if (!rendererHasUpdateCard) {
    failures.push('渲染层没有更新卡片 —— 说明打包产物里 update.auto 能力探测或卡片渲染失效');
  }

  if (!app.isPackaged) {
    // 探针被用错地方了。这条必须显式失败：未打包形态下下面的 check 会拿到
    // UNSUPPORTED，那看起来"有错误输出"，很容易被当成链路问题去排查。
    failures.push('探针跑在未打包形态下（app.isPackaged=false）—— 请在 dist/pack/win-unpacked 里跑');
  }

  // 装收集器。走的是渲染层真实消费的那条通道（preload 暴露的 on），
  // 而不是给 updater 加一个"只有探针用"的订阅 API —— 后者是在为测试改造被测对象。
  try {
    await win.webContents.executeJavaScript(
      `(() => {
         const w = window;
         w.${COLLECTOR} = [];
         w.bridge.on('update:status', (s) => { w.${COLLECTOR}.push(s); });
         return true;
       })()`,
    );
  } catch (err) {
    failures.push(`在渲染层安装状态收集器失败：${String(err)}`);
  }

  let checkReturnedVersion: string | null = null;
  let checkError: string | null = null;
  let downloadError: string | null = null;

  try {
    const info = await withTimeout(checkForUpdates(), CHECK_TIMEOUT_MS, '检查更新');
    checkReturnedVersion = info === null ? null : info.version;
  } catch (err) {
    checkError = err instanceof Error ? err.message : String(err);
  }

  if (checkError === null && checkReturnedVersion === null) {
    failures.push('检查更新没有拿到任何版本（feed 里的版本没被接受）——「发现新版本」这一半没验到');
  }

  if (checkReturnedVersion !== null) {
    try {
      await withTimeout(downloadUpdate(), DOWNLOAD_TIMEOUT_MS, '发起下载');
      const settled = await waitForTerminal(DOWNLOAD_TIMEOUT_MS);
      if (!settled) {
        failures.push(`下载在 ${DOWNLOAD_TIMEOUT_MS}ms 内没有到达终态 —— 正是"永远转圈"那种失败`);
      }
    } catch (err) {
      downloadError = err instanceof Error ? err.message : String(err);
    }
  }

  const mainFinal = currentUpdateStatus();

  // ── 取回渲染层看到的东西 ────────────────────────────────────
  const frames: StageFrame[] = [];
  let rendererFinalStageAttr: string | null = null;
  let collectError: string | null = null;
  try {
    const raw = (await win.webContents.executeJavaScript(
      `(() => {
         const card = document.querySelector('[data-testid="update-status"]');
         return {
           frames: window.${COLLECTOR} ?? null,
           stage: card ? card.getAttribute('data-stage') : null,
           percent: card ? card.getAttribute('data-percent') : null,
         };
       })()`,
    )) as { frames: unknown[] | null; stage: string | null; percent: string | null };
    rendererFinalStageAttr = raw.stage;
    if (raw.frames === null) {
      collectError = '渲染层里没有找到收集器（executeJavaScript 可能没生效）';
    } else {
      for (const item of raw.frames) {
        const frame = normalizeFrame(item);
        if (frame === null) {
          collectError = `渲染层收到的状态形状不合法：${JSON.stringify(item).slice(0, 120)}`;
          break;
        }
        frames.push(frame);
      }
    }
  } catch (err) {
    collectError = `取回渲染层状态轨迹失败：${String(err)}`;
  }
  if (collectError !== null) failures.push(collectError);

  // ── 断言 ────────────────────────────────────────────────────
  if (checkError !== null) failures.push(`检查更新抛错：${checkError}`);
  if (downloadError !== null) failures.push(`下载抛错：${downloadError}`);

  if (expectedVersion !== null && checkReturnedVersion !== null && checkReturnedVersion !== expectedVersion) {
    failures.push(`检查更新返回 ${checkReturnedVersion}，feed 里写的是 ${expectedVersion}`);
  }

  const stages = frames.map((f) => f.stage);
  const firstChecking = stages.indexOf('checking');
  const firstAvailable = stages.indexOf('available');
  if (frames.length === 0) {
    failures.push('渲染层一条 update:status 都没收到 —— 推送通道没通到界面');
  }
  if (firstChecking === -1) {
    failures.push('轨迹里没有出现 checking —— 检查更新的状态没被推出来');
  }
  if (firstAvailable === -1) {
    failures.push('轨迹里没有出现 available —— 「发现新版本」没有被如实上报');
  }
  if (firstChecking !== -1 && firstAvailable !== -1 && firstAvailable < firstChecking) {
    failures.push('available 出现在 checking 之前 —— 状态顺序不对');
  }

  const availableFrame = frames.find((f) => f.stage === 'available');
  if (availableFrame !== undefined && expectedVersion !== null && availableFrame.version !== expectedVersion) {
    failures.push(`available 阶段带的版本是 ${String(availableFrame.version)}，期望 ${expectedVersion}`);
  }

  // 进度必须单调且落在 [0,100]。这一条同时在验 core 的 nextProgress 接线 ——
  // 上游每秒几十次浮点百分比，原样透出去就是一个会往回跳的进度条。
  const percents = frames.filter((f) => f.stage === 'downloading').map((f) => f.percent ?? Number.NaN);
  if (percents.length === 0) {
    failures.push('没有收到任何 downloading 帧 —— 下载进度没有推给界面');
  }
  let previous = 0;
  for (const p of percents) {
    if (!Number.isFinite(p) || p < 0 || p > 100) {
      failures.push(`进度出现越界值：${String(p)}`);
      break;
    }
    if (p < previous) {
      failures.push(`进度回退：${previous} → ${p}（进度条会倒着走）`);
      break;
    }
    previous = p;
  }

  const lastFrame = frames[frames.length - 1];
  if (lastFrame === undefined || lastFrame.stage !== 'ready') {
    const reason = lastFrame !== undefined && lastFrame.message !== null ? `（原因：${lastFrame.message}）` : '';
    failures.push(
      `渲染层收到的终态是 ${lastFrame === undefined ? '(没有)' : lastFrame.stage}，期望 ready${reason}`,
    );
  }
  if (mainFinal.stage !== 'ready') {
    failures.push(`主进程终态是 ${mainFinal.stage}，期望 ready`);
  }

  // 三处必须一致：主进程状态机、渲染层收到的最后一帧、界面上真的渲染出来的阶段。
  // 只对其中两处，就会出现"状态对了但界面没刷新"这种没人看得见的故障。
  const mainFrame = normalizeFrame(mainFinal);
  if (mainFrame !== null && lastFrame !== undefined && mainFrame.stage !== lastFrame.stage) {
    failures.push(`主进程终态(${mainFrame.stage}) 与渲染层最后一帧(${lastFrame.stage}) 不一致`);
  }
  if (rendererFinalStageAttr !== (lastFrame === undefined ? null : lastFrame.stage)) {
    failures.push(
      `界面渲染出来的阶段(${String(rendererFinalStageAttr)}) 与收到的最后一帧` +
        `(${lastFrame === undefined ? '无' : lastFrame.stage}) 不一致 —— 状态到了但没渲染`,
    );
  }

  const report: UpdateFeedProbeReport = {
    ok: failures.length === 0,
    packaged: app.isPackaged,
    appVersion: app.getVersion(),
    feedUrl: process.env['CROSSDECK_UPDATE_URL'] ?? null,
    expectedVersion,
    bootState,
    rendererHasUpdateCard,
    rendererFinalStageAttr,
    mainFinalStage: mainFinal.stage,
    checkReturnedVersion,
    checkError,
    downloadError,
    frames,
    failures,
  };

  console.log(`[updatefeed] 渲染层收到的阶段轨迹：${frames.map(describeFrame).join(' → ')}`);
  for (const f of failures) console.log(`[updatefeed] 失败：${f}`);

  // 结构化数据与判定分开打：脚本靠 DATA 做报告、靠 DONE 定成败，
  // 混在一行会让"报告写成了但判定读错"这种事故有机会发生。
  console.log(`[updatefeed] DATA ${JSON.stringify(report)}`);
  const code = report.ok ? 0 : 1;
  console.log(`[updatefeed] DONE ok=${report.ok} code=${code}`);
  return code;
}

function describeFrame(f: StageFrame): string {
  if (f.stage === 'downloading') return `downloading(${String(f.percent)}%)`;
  if (f.version !== null) return `${f.stage}(${f.version})`;
  return f.stage;
}
