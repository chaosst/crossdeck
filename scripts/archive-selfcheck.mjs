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
  /** 不判失败、但必须被看见的事项（例如平台不允许建 symlink） */
  warnings: report.warnings ?? [],
  failures: report.failures,
  reportFile: `docs/evidence/${reportName}`,
  screenshotFile: shotName ? `docs/evidence/${shotName}` : null,
};
writeFileSync(join(DEST, 'selfcheck-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

console.log('── 归档自检证据 ────────────────────────────────');
console.log(`  ok=${report.ok}  mode=${report.mode}  ranAt=${report.ranAt}`);
console.log(`  docs/evidence/${reportName}`);
if (shotName) console.log(`  docs/evidence/${shotName}`);
console.log('  docs/evidence/selfcheck-summary.json');
