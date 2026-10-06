#!/usr/bin/env node
/**
 * 把自检产物归档到 docs/evidence/ —— 让"跑起来了"这件事在仓库里有据可查。
 *
 * 为什么不让自检直接写到 docs/：
 *   自检产物是**生成的**，生成物应该待在 dist/（已 gitignore）。
 *   只有"需要有据可查"的那一份才进版本库，且要能一眼看出是哪次跑出来的
 *   （报告里带 ranAt / mode / 版本矩阵）。
 *
 * 为什么不提交 dist/ 里的产物：
 *   每次跑都会变（时间戳、哈希文件名），提交进去只会得到一堆无意义的 diff。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'packages', 'shell-electron', 'dist', 'selfcheck');
const DEST = join(ROOT, 'docs', 'evidence');

const REPORT = join(SRC, 'report.json');
const SHOT = join(SRC, 'window.png');
/** 更新链路端到端验证的产物（由 verify:update-feed 生成，可能不存在） */
const UPDATE_FEED = join(SRC, 'update-feed.json');

if (!existsSync(REPORT)) {
  console.error(`❌ 找不到自检报告：${REPORT}\n   先跑 pnpm selfcheck`);
  process.exit(1);
}

const report = JSON.parse(readFileSync(REPORT, 'utf8'));
mkdirSync(DEST, { recursive: true });

const suffix = report.mode === 'dev' ? 'dev' : 'prod';
const reportName = `selfcheck-${suffix}.json`;
copyFileSync(REPORT, join(DEST, reportName));

let shotName = null;
if (existsSync(SHOT)) {
  shotName = `window-${suffix}.png`;
  copyFileSync(SHOT, join(DEST, shotName));
}

// README 里引用的"最近一次自检结论"，自动跟着更新，避免文档与事实脱节
const summary = {
  updatedAt: report.ranAt,
  mode: report.mode,
  ok: report.ok,
  electron: report.versions.electron,
  chrome: report.versions.chrome,
  node: report.versions.node,
  registeredChannelCount: report.registeredChannelCount,
  assertionSummary: {
    bridgeMounted: report.probe?.hasBridge ?? null,
    systemInfoOk: report.probe?.systemInfoOk ?? null,
    errorCodePreservedAs: report.probe?.errorDecodedCode ?? null,
    streamEvents: (report.probe?.streamTokenCount ?? 0) + 2,
    streamEndedWithDone: report.probe?.streamLastEvent === 'done',
    streamUnsubscribeWorks: report.probe?.streamUnsubscribeWorks ?? null,
    unknownChannelRejected: report.probe?.unknownChannelThrew ?? null,
    consoleErrors: (report.consoleErrors ?? []).length,
  },
  // ── M4：工作区 scope + 背压 + 渲染层可见化 ──
  m4: {
    workspaceGranted: (report.probe?.workspaceCount ?? 0) >= 1,
    listDirEntries: report.probe?.scopeReadEntries ?? null,
    escapeDeniedAs: report.probe?.scopeEscapeCode
      ? `${report.probe.scopeEscapeCode}:${report.probe.scopeEscapeDetail}`
      : null,
    /** passed = 逃逸被拦；failed = 竟然读到了；skipped = 夹具没建出来（**不算通过**） */
    symlinkEscape: report.probe?.scopeSymlinkCase ?? null,
    symlinkFixture: report.scopeFixture?.symlink?.status ?? null,
    fileTreeRenderedEntries: report.probe?.uiEntryCount ?? null,
    escapeVisibleInUi: report.probe?.uiEscapeShown ?? null,
    tokensWhilePaused: report.probe?.pausedTokenCount ?? null,
    tokensWhilePausedLater: report.probe?.pausedTokenCountLater ?? null,
    pausedReallyStoppedPush:
      report.probe?.pausedTokenCount !== undefined &&
      report.probe?.pausedTokenCount === report.probe?.pausedTokenCountLater,
    tokensAfterResume: report.probe?.resumeTokenCount ?? null,
    unknownRunRejectedAs: report.probe?.controlUnknownCode ?? null,
  },
  // ── M5：自动更新 ──
  // 自检跑的是**未打包**形态，所以这一节记录的不是"更新能下载"（那要真打包才能验），
  // 而是更重要的那条：**不具备条件时会不会如实说**。
  m5: {
    updateCardRendered: report.probe?.updateButtonClicked ?? null,
    /** 界面停在哪个阶段 —— 出现 'checking' 就是「永远转圈」复现，M5-3 未达成 */
    stageShownInUi: report.probe?.updateDomStage ?? null,
    retryableFlagInUi: report.probe?.updateDomRetryable ?? null,
    pushedStatuses: report.probe?.updateEventCount ?? null,
    firstPushedStage: report.probe?.updateFirstStage ?? null,
    pushedErrorMessage: report.probe?.updateFirstMessage ?? null,
    sawCheckingStage: report.probe?.updateSawChecking ?? null,
    unpackagedRejectedAs: report.probe?.updateCheckCode
      ? `${report.probe.updateCheckCode}:${report.probe.updateCheckDetail}`
      : null,
    downloadWithoutVersionThrew: report.probe?.updateDownloadThrew ?? null,
    installWithoutReadyThrew: report.probe?.updateInstallThrew ?? null,
    /** 退订前 / 退订后的事件数 —— 相等才说明推送监听真的摘掉了 */
    eventsBeforeUnsub: report.probe?.updateEventsBeforeUnsub ?? null,
    eventsAfterUnsub: report.probe?.updateEventsAfterUnsub ?? null,
    unsubscribeWorks:
      report.probe?.updateEventsBeforeUnsub !== undefined &&
      report.probe?.updateEventsBeforeUnsub === report.probe?.updateEventsAfterUnsub,
  },
  /**
   * ── M5 的另一半：打包产物 + 真实 feed 的端到端 ──
   *
   * 上面那节（m5）只覆盖了「不具备条件时如实报错」。这一节覆盖反过来的那条：
   * 真的有新版本时，检查 → 发现 → 下载 → 就绪 是不是通的。
   * 两节都绿，"自动更新"才算被证明过 —— 只验一半的话，
   * 未打包报错正确 ≠ 打包后能升级。
   *
   * 没跑过 `pnpm verify:update-feed` 时这里是 null，也就是"未验证"，
   * 而不是"通过" —— 这两者在文档里必须长得不一样。
   */
  m5Feed: readUpdateFeedEvidence(),
  /** 不判失败、但必须被看见的事项（例如平台不允许建 symlink） */
  warnings: report.warnings ?? [],
  failures: report.failures,
  reportFile: `docs/evidence/${reportName}`,
  screenshotFile: shotName ? `docs/evidence/${shotName}` : null,
};
writeFileSync(join(DEST, 'selfcheck-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

/**
 * 读取更新链路端到端验证的证据。
 *
 * 该证据由 `pnpm verify:update-feed` 生成（它要先有打包产物，所以不能并进自检里跑）。
 * 归档时把两份产物拼成一个可读摘要：阶段轨迹 + HTTP 请求清单 +
 * "界面渲染出来的阶段 / 主进程终态"三处一致性。
 */
function readUpdateFeedEvidence() {
  if (!existsSync(UPDATE_FEED)) return null;
  let payload;
  try {
    payload = JSON.parse(readFileSync(UPDATE_FEED, 'utf8'));
  } catch {
    return null;
  }
  const probe = payload.report ?? null;
  if (probe === null) return null;

  copyFileSync(UPDATE_FEED, join(DEST, 'update-feed.json'));
  return {
    verifiedAt: payload.ranAt,
    appVersion: probe.appVersion,
    packaged: probe.packaged,
    feedUrl: probe.feedUrl,
    expectedVersion: probe.expectedVersion,
    /** 渲染层收到的全部推送，按到达顺序 —— 这是界面真正看到的东西 */
    stageTrace: (probe.frames ?? []).map(formatStageFrame),
    rendererFinalStageAttr: probe.rendererFinalStageAttr,
    mainFinalStage: probe.mainFinalStage,
    rendererHasUpdateCard: probe.rendererHasUpdateCard,
    httpRequests: payload.requests ?? [],
    failures: probe.failures ?? [],
    ok: probe.ok,
    reportFile: 'docs/evidence/update-feed.json',
  };
}

function formatStageFrame(f) {
  if (f.stage === 'downloading') return `downloading(${String(f.percent)}%)`;
  if (f.version !== null && f.version !== undefined) return `${f.stage}(${f.version})`;
  return f.stage;
}

console.log('── 归档自检证据 ────────────────────────────────');
console.log(`  ok=${report.ok}  mode=${report.mode}  ranAt=${report.ranAt}`);
console.log(`  docs/evidence/${reportName}`);
if (shotName) console.log(`  docs/evidence/${shotName}`);
if (summary.m5Feed === null) {
  console.log('  更新链路端到端：未验证（跑 pnpm verify:update-feed 可补上打包产物 + 真实 feed 那一半）');
} else {
  console.log(`  更新链路端到端：ok=${summary.m5Feed.ok} 轨迹 ${summary.m5Feed.stageTrace.join(' → ')}`);
  console.log('  docs/evidence/update-feed.json');
}
console.log('  docs/evidence/selfcheck-summary.json');
