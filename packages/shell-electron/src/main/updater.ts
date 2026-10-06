import { app, BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import { AppError, IPC } from '@crossdeck/contract';
import type { UpdateInfo, UpdateStatus } from '@crossdeck/contract';
import {
  INITIAL_PROGRESS,
  nextProgress,
  normalizeVersionLabel,
  parseVersion,
  selectUpgrade,
} from '@crossdeck/core';
import type { ProgressState } from '@crossdeck/core';

/**
 * 自动更新的 Electron 侧实现 —— 本项目里唯一"进程会自己消失"的模块。
 *
 * 分工（与 agentRuntime 同一套原则）：
 *   · 「该不该升」「进度合不合理」「链路上每个数字是不是合法」→ core（纯逻辑，可断言）
 *   · electron-updater 的接线、feed 的真实形状、平台支不支持 → 这里
 *
 * ⚠️ 本模块的核心命题是**如实**：
 *   无签名 / 未打包 / feed 不可达这三种环境里，electron-updater 的行为是
 *   「静默降级 + 打个日志」而不是抛错 —— 如果照抄它的返回值，
 *   UI 会永远停在「检查中…」，用户面对一个转圈到天荒地老的按钮。
 *   所以这里的每个出口都必须落到一个**终态**：idle / ready / error。
 *   计划里的 M5-3 就是这条：「无签名环境必须报 error 而非永远转圈」。
 */

/**
 * 唯一的推送出口。
 *
 * 更新是应用级状态，不属于某个窗口 —— 所以广播给所有窗口，
 * 而不是像 agent 流那样回到"发起它的那个窗口"。
 */
function broadcast(status: UpdateStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(IPC.updateStatus, status);
  }
}

let status: UpdateStatus = { stage: 'idle' };
let progress: ProgressState = INITIAL_PROGRESS;
let wired = false;

/** 当前状态（自检与日志用）。 */
export function currentUpdateStatus(): UpdateStatus {
  return status;
}

/**
 * 两条完全相同的状态不必重复推送。
 *
 * electron-updater 的 download-progress 每秒能来几十次，而 core 的追踪器
 * 会把它们压成 0–100 的整数 —— 于是会有大量"百分比没变"的事件。
 * 原样转发等于把 IPC 通道当进度条用的同时白白打满渲染层。
 */
function sameStatus(a: UpdateStatus, b: UpdateStatus): boolean {
  return a.stage === b.stage && JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 此刻所处的阶段。
 *
 * 刻意走函数读取，而不是直接写 `status.stage`：
 *   electron-updater 的事件回调会在 `await checkForUpdates()` 期间改动 status，
 *   而 TS 会把 await 之前那次 `status.stage` 的判断窄化一直带下来，
 *   给出一个**过期**的结论（编译器甚至会因为"不可能相等"而报 TS2367）。
 *   这里的语义本来就是"现在是什么"，所以必须重新读一次。
 */
function currentStage(): UpdateStatus['stage'] {
  return status.stage;
}

function publish(next: UpdateStatus): void {
  if (sameStatus(status, next)) return;
  status = next;
  console.log(`[crossdeck] update → ${describe(next)}`);
  broadcast(next);
}

function describe(s: UpdateStatus): string {
  switch (s.stage) {
    case 'idle':
      return 'idle';
    case 'checking':
      return 'checking';
    case 'available':
      return `available ${s.info.version}`;
    case 'downloading':
      return `downloading ${s.info.version} ${s.percent}%`;
    case 'ready':
      return `ready ${s.info.version}`;
    case 'error':
      return `error ${s.message}`;
  }
}

/**
 * 这个安装形态支不支持自动更新。
 *
 * 为什么必须显式判断，而不是"试一下看它抛不抛"：
 *   electron-updater 在未打包时**不抛错** —— 它打印一句
 *   "Skip checkForUpdates because application is not packed" 然后返回 null。
 *   照抄它的返回值就是那个经典 bug：用户点检查更新，界面永远在转圈。
 *   所以这里主动把它变成一个明确的 UNSUPPORTED，让 UI 有东西可显示。
 *
 * 开发期确实有 `dev-app-update.yml` + `forceDevUpdateConfig` 这条路，
 * 但那需要一份指向真实 feed 的配置；自检环境里我们恰恰要验证
 * 「不具备条件时会不会如实说」这条反向路径，所以默认不开。
 */
export function isUpdateSupported(): boolean {
  return app.isPackaged;
}

/**
 * 「这个安装形态做不了」——**同时**推一条 error 状态，再抛 UNSUPPORTED。
 *
 * 为什么要推：一是 UI 不该只靠 invoke 的抛错来表达"更新功能当前不可用"，
 * 状态机里就有一个 `error` 终态正是给这种情况准备的；二是——更实际的理由——
 * 自检跑的就是未打包形态，这是**唯一**能在自检里真正跑通的推送路径。
 * 不推的话，这条新推送通道在开发期完全是"看一眼觉得对"就出厂了。
 *
 * retryable 恒为 false：换个时间点、换台网络都不会变，重试没有意义。
 */
function refuseUnsupported(action: string): AppError {
  const message = `${action}不可用：当前是未打包的开发形态，没有 app-update.yml 也就没有可比的版本`;
  publish({ stage: 'error', message, retryable: false });
  return new AppError('UNSUPPORTED', message, 'NOT_PACKAGED');
}

/**
 * electron-updater 的错误分类。
 *
 * 存在的理由：`retryable` 决定 UI 给不给「重试」按钮，而这个判断**不能**由
 * 用户来做 —— 无签名证书的失败重试一万次还是同一个结果，网络抖动则不然。
 *
 * 兜底选择 retryable = true 是刻意的非对称取舍：
 * 把一个"其实不可重试"的失败误判成可重试，代价是用户多点一次、再看到同一个错误；
 * 反过来误判成不可重试，会把唯一的出路藏起来。前者可以接受，后者不可以。
 */
function classifyFailure(raw: unknown): { message: string; retryable: boolean; detail: string } {
  const text = raw instanceof Error ? raw.message : String(raw ?? '');
  const at = /(ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|socket hang up|net::|getaddrinfo|502|503|504)/i;
  const feed = /(app-update\.yml|No published versions|Cannot find.*(yml|release)|latest\.yml|404)/i;
  const integrity = /(signature|signed|gpg|sha512|checksum|integrity|code sign)/i;
  const disk = /(ENOSPC|EACCES|EPERM|EBUSY|read-only)/i;

  if (at.test(text)) return { message: `连接更新服务失败：${text}`, retryable: true, detail: 'NETWORK' };
  if (feed.test(text)) return { message: `更新源不可用（缺少发布描述或版本不存在）：${text}`, retryable: false, detail: 'FEED' };
  if (integrity.test(text)) {
    return {
      message: `更新包的签名/校验未通过，已拒绝安装：${text}`,
      retryable: false,
      detail: 'INTEGRITY',
    };
  }
  if (disk.test(text)) return { message: `写入更新文件失败：${text}`, retryable: false, detail: 'DISK' };
  return { message: `更新失败：${text}`, retryable: true, detail: 'UNKNOWN' };
}

/**
 * 把 electron-updater 的 info 折成契约类型。
 *
 * 两处刻意保留的差异：
 *   1. 版本号走 core 归一化 —— feed 里是 `v1.2.3` 还是 `1.2.3` 不该泄漏到 UI，
 *      更不能影响比较（core 已经算过 1.10.0 > 1.9.0）。
 *   2. releaseNotes 可能是字符串，也可能是 `[{version, note}]` 数组（GitHub provider）。
 *      统一折成一段纯文本并截断 —— UI 要显示的是一句话，不是一份 changelog。
 *      没给 notes 时**省略**这个键（exactOptionalPropertyTypes）。
 */
const NOTES_LIMIT = 600;

function toInfo(raw: unknown): UpdateInfo | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as { version?: unknown; releaseNotes?: unknown; releaseDate?: unknown };
  if (typeof r.version !== 'string' || r.version.trim().length === 0) return null;

  const version = normalizeVersionLabel(r.version);
  if (parseVersion(version) === null) return null;

  const notes = extractNotes(r.releaseNotes);
  const releasedAt =
    typeof r.releaseDate === 'string' && !Number.isNaN(Date.parse(r.releaseDate))
      ? Date.parse(r.releaseDate)
      : undefined;

  const base: UpdateInfo = { version };
  if (notes !== undefined) base.notes = notes;
  if (releasedAt !== undefined) base.releasedAt = releasedAt;
  return base;
}

function extractNotes(raw: unknown): string | undefined {
  let text: string | undefined;
  if (typeof raw === 'string') text = raw;
  else if (Array.isArray(raw)) {
    const parts = raw
      .map((item) =>
        typeof item === 'object' && item !== null && typeof (item as { note?: unknown }).note === 'string'
          ? (item as { note: string }).note
          : '',
      )
      .filter((s) => s.length > 0);
    if (parts.length > 0) text = parts.join('\n');
  }

  if (text === undefined) return undefined;
  // 去掉 HTML 标签（GitHub 的 notes 通常是 HTML 片段），折掉空行。
  // 不做完整 markdown 渲染：渲染层只把这段当作纯文本放进 <p>。
  const plain = text
    .replace(/<[^>]*>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (plain.length === 0) return undefined;
  return plain.length > NOTES_LIMIT ? `${plain.slice(0, NOTES_LIMIT)}…` : plain;
}

/** 只有 available / downloading / ready 三种状态带 info。 */
function pendingInfo(): UpdateInfo | null {
  return 'info' in status ? status.info : null;
}

function toErrorStatus(err: unknown): UpdateStatus {
  const { message, retryable } = classifyFailure(err);
  return { stage: 'error', message, retryable };
}

/**
 * 事件接线 —— 只做一次。
 *
 * ⚠️ 必须无条件挂 `error` 监听：autoUpdater 是 EventEmitter，
 *    没有 error 监听时它 emit('error') 会**直接把主进程抛崩**。
 *    也就是说"忘了接线"的代价不是更新失效，而是应用闪退。
 */
function ensureWired(): void {
  if (wired) return;
  wired = true;

  // 下载必须由用户点。自动下载意味着用户一开应用就在不知情的情况下
  // 拉几十兆 —— 流量可能走的是手机热点，而这属于用户的钱。
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = console;

  autoUpdater.on('checking-for-update', () => publish({ stage: 'checking' }));

  autoUpdater.on('update-available', (raw: unknown) => {
    const info = toInfo(raw);
    if (info === null) {
      // feed 给了个连版本号都读不出来的东西 —— 如实报，不要装作"已是最新"。
      publish({ stage: 'error', message: '更新源返回了无法解析的版本信息', retryable: false });
      return;
    }
    progress = INITIAL_PROGRESS;
    publish({ stage: 'available', info });
  });

  autoUpdater.on('update-not-available', () => {
    progress = INITIAL_PROGRESS;
    publish({ stage: 'idle' });
  });

  autoUpdater.on('download-progress', (raw: unknown) => {
    const info = pendingInfo();
    // 进度先于 available 到达是不可能的（available 才触发下载），
    // 但没有 info 就无法构造合法的 downloading 状态 —— 丢掉这一帧比编造一个版本号好。
    if (info === null) return;
    const percentRaw = (raw as { percent?: unknown })?.percent;
    progress = nextProgress(progress, {
      version: info.version,
      percent: typeof percentRaw === 'number' ? percentRaw : Number.NaN,
    });
    publish({ stage: 'downloading', info, percent: progress.percent });
  });

  autoUpdater.on('update-downloaded', (raw: unknown) => {
    const info = toInfo(raw) ?? pendingInfo();
    if (info === null) {
      publish({ stage: 'error', message: '下载完成但无法解析版本信息', retryable: false });
      return;
    }
    publish({ stage: 'ready', info });
  });

  // 这个监听还有一个副作用：没有它，emit('error') 会把主进程抛崩。
  autoUpdater.on('error', (err: unknown) => {
    console.error('[crossdeck] updater error:', err);
    publish(toErrorStatus(err));
  });
}

/**
 * 检查更新 —— 计划里的 M5-2。
 *
 * 返回 null 的语义是「查过了，没有可装的新版本」；
 * 失败一律抛错（并同时推一个 error 状态），**不**把失败伪装成 null ——
 * 否则 UI 会把"网络断了"显示成"已是最新"，这是最坏的一种假话。
 */
export async function checkForUpdates(): Promise<UpdateInfo | null> {
  ensureWired();
  if (!isUpdateSupported()) throw refuseUnsupported('检查更新');

  if (currentStage() === 'checking') {
    throw new AppError('BAD_REQUEST', '正在检查更新，请稍等这次检查结束');
  }
  if (status.stage === 'downloading') {
    throw new AppError('BAD_REQUEST', '正在下载更新，请等下载完成或重启后再检查');
  }

  publish({ stage: 'checking' });

  let result: unknown;
  try {
    result = await autoUpdater.checkForUpdates();
  } catch (err) {
    publish(toErrorStatus(err));
    throw new AppError('UPSTREAM', classifyFailure(err).message, classifyFailure(err).detail);
  }

  const info = toInfo((result as { updateInfo?: unknown } | null)?.updateInfo);
  if (info === null) {
    // 走到这里有两种可能：真的没有新版（dev 下常见），或 feed 形状不认得。
    // electron-updater 用"没有 update-available 事件"表达前者 —— 我们无法从这里
    // 区分，所以以事件为准：事件到达时状态已被 publish 成 available / error。
    // 若事件的判定是"没有新版"，把状态收回到 idle，绝不留一个转圈的 checking。
    if (currentStage() === 'checking') publish({ stage: 'idle' });
    return null;
  }

  // ── 决定"该装哪个"的是 core，不是 electron-updater ──────────────
  // electron-updater 只负责"feed 上最新的是什么"，它不关心降级/预发布策略，
  // 也不保证 feed 里只有一个候选。这一段是计划里"模拟新版本可检出"的落点。
  const current = app.getVersion();
  const selection = selectUpgrade(current, [info]);

  if (selection.picked === null) {
    // 拒绝的原因要留痕：被静默丢掉的 downgrade / 畸形版本，排查时完全看不出来。
    console.log(
      `[crossdeck] update check: current=${current} feed=${info.version} ` +
        `→ 不接受（${selection.rejected.map((r) => `${r.version}:${r.reason}`).join(', ') || '无候选'}）`,
    );
    if (currentStage() === 'checking') publish({ stage: 'idle' });
    return null;
  }

  const picked = selection.picked;
  const accepted: UpdateInfo = { version: normalizeVersionLabel(picked.version) };
  if (picked.notes !== undefined) accepted.notes = picked.notes;
  if (picked.releasedAt !== undefined) accepted.releasedAt = picked.releasedAt;

  // 事件可能已经把状态推成 available 了（并且 info 与这里一致）；
  // 若事件没到（上游实现差异），这里补一次，保证调用方拿到非 null 就一定
  // 有一个 available 状态与之对应。
  if (currentStage() === 'checking') {
    progress = INITIAL_PROGRESS;
    publish({ stage: 'available', info: accepted });
  }
  return accepted;
}

/** 开始下载。进度走 updateStatus 推送，这里只回"已受理"。 */
export async function downloadUpdate(): Promise<void> {
  ensureWired();
  if (!isUpdateSupported()) throw refuseUnsupported('下载更新');

  const info = pendingInfo();
  if (info === null) {
    throw new AppError('BAD_REQUEST', '还没有可下载的版本，请先检查更新');
  }
  if (currentStage() === 'downloading') {
    throw new AppError('BAD_REQUEST', '已经在下载了');
  }

  // 立刻推一帧 0%，否则用户点下去到第一个进度事件之间（可能几秒）
  // 界面毫无变化 —— 又是一个"点了没反应"。
  progress = { version: info.version, percent: 0, anomalies: progress.anomalies };
  publish({ stage: 'downloading', info, percent: progress.percent });

  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    publish(toErrorStatus(err));
    throw new AppError('UPSTREAM', classifyFailure(err).message, classifyFailure(err).detail);
  }
}

/**
 * 重启并安装。
 *
 * ⚠️ 调用方**不要** await 它之后再做事：quitAndInstall 会让进程消失，
 * 后面的代码不会执行。所以真正的调用放在 setImmediate —— 先把 IPC 响应
 * 送回渲染层，再关自己。
 */
export async function installUpdate(): Promise<void> {
  ensureWired();
  if (!isUpdateSupported()) throw refuseUnsupported('安装更新');

  if (currentStage() !== 'ready') {
    throw new AppError('BAD_REQUEST', `更新尚未下载完成（当前阶段：${status.stage}）`);
  }
  const info = pendingInfo();

  console.log(`[crossdeck] 重启安装更新 ${info?.version ?? '(未知版本)'}`);
  setImmediate(() => {
    try {
      autoUpdater.quitAndInstall(false, true);
    } catch (err) {
      // 走到这里说明安装器起不来（无签名 / 策略拦截）。如实推一个 error，
      // 而不是让应用在"看起来什么都没发生"里继续跑。
      publish(toErrorStatus(err));
    }
  });
}

/**
 * 自检用：把状态机复位到 idle。
 *
 * ⚠️ 不是为了"清理"，是为了让**退订断言**有鉴别力：
 *    publish 会丢弃与上一次完全相同的状态（上游每秒几十次进度事件里
 *    绝大多数是重复的）。而自检的退订验证是"再触发一次，看事件数涨不涨" ——
 *    若第二次触发推的还是同一条 error 状态，它会被去重掉，
 *    于是"退订失效"也能通过。复位一下，第二次推送就是一次真实的新事件。
 */
export function resetUpdateStateForSelfCheck(): void {
  status = { stage: 'idle' };
  progress = INITIAL_PROGRESS;
}
