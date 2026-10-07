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

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'packages', 'shell-electron', 'dist', 'selfcheck');
const DEST = join(ROOT, 'docs', 'evidence');

const REPORT = join(SRC, 'report.json');
const SHOT = join(SRC, 'window.png');
/** 更新链路端到端验证的产物（由 verify:update-feed 生成，可能不存在） */
const UPDATE_FEED = join(SRC, 'update-feed.json');
/** 鸿蒙壳端到端验证的产物（由 verify:ohos 生成，可能不存在） */
const OHOS_EVIDENCE = join(DEST, 'ohos-selfcheck.json');

if (!existsSync(REPORT)) {
  console.error(`❌ 找不到自检报告：${REPORT}\n   先跑 pnpm selfcheck`);
  process.exit(1);
}

const report = JSON.parse(readFileSync(REPORT, 'utf8'));
mkdirSync(DEST, { recursive: true });

// 判定口径从 contract 的**编译产物**现读（见 loadPerfContract 的注释）。
const perfMod = await loadPerfContract();

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
  /**
   * ── M6-1：性能量化 ──
   *
   * 六项指标里五项来自自检报告，安装包体积来自文件系统实测 ——
   * 后者的理由是它在**报告之外**（打包产物由 `pnpm pack:win` 生成，
   * 自检跑的是未打包形态，看不见它）。两者拼在一节里，才是一张完整的表。
   *
   * `verdicts` 里的 `not-measured` 与 `fail` 必须分开：前者是"这次没测到"
   * （例如没跑流式就没有帧率），后者是"测到了但不达标"。
   * 把两者压成一个 false，会让"漏测"看起来像"性能差"。
   */
  m6: buildPerfSummary(report, perfMod),
  /** ── M6-2：鸿蒙壳端到端（同一个 core，换一个壳） ── */
  m6Ohos: readOhosEvidence(),
  /** 不判失败、但必须被看见的事项（例如平台不允许建 symlink） */
  warnings: report.warnings ?? [],
  failures: report.failures,
  reportFile: `docs/evidence/${reportName}`,
  screenshotFile: shotName ? `docs/evidence/${shotName}` : null,
};
writeFileSync(join(DEST, 'selfcheck-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

/**
 * contract 的性能口径 —— 从**编译产物**现读，而不是在这一行抄一份。
 *
 * 判定标准（哪几项"越大越好"、目标值各是多少）必须只有一个事实源：
 * 如果这里硬编码一份副本，那么改了 `contract/src/perf.ts` 的 `PERF_TARGETS`
 * 之后，归档仍会按旧值报"达标"，两份产物静默地互相矛盾 ——
 * 这种错最难发现，因为它不报错。
 *
 * 拿不到（没构建过 contract，`tsc -b` 没跑）就返回 null：
 * 报告里体现为"未判定"，而不是"判定通过"。
 */
async function loadPerfContract() {
  const mod = join(ROOT, 'packages', 'contract', 'dist', 'perf.js');
  if (!existsSync(mod)) return null;
  try {
    return await import(pathToFileURL(mod).href);
  } catch {
    return null;
  }
}

/**
 * 把自检报告 + 安装包实测拼成 M6-1 的指标表。
 *
 * @param {object} report 自检报告
 * @param {object|null} perfMod contract 的编译产物（含 PERF_TARGETS / meetsTarget）
 */
function buildPerfSummary(report, perfMod) {
  const p = report.perf ?? null;
  const ttftMs = report.probe?.streamUsage?.ttftMs ?? null;
  const installer = measureInstaller();
  const targets = perfMod?.PERF_TARGETS ?? null;
  const meets = perfMod?.meetsTarget ?? null;

  /**
   * 三态判定：`pass` / `fail` / `not-measured`（外加 `null` = 根本没判定口径）。
   *
   * `0` 在契约里是"没测到"的哨兵值（见 `contract/src/perf.ts` 对 `streamFps`
   * 的注释），所以它必须先于比较被拦下 —— 否则 `0 >= 55` 会得到一个
   * 看起来很正常的 `fail`，把一次漏测记成一次性能问题。
   */
  const judge = (metric, actual) => {
    if (meets === null || targets === null) return null;
    if (actual === null || actual === undefined) return 'not-measured';
    if (actual === 0) return 'not-measured';
    return meets(metric, actual) ? 'pass' : 'fail';
  };

  return {
    measuredAt: report.ranAt,
    coldStartMs: p?.coldStartMs ?? null,
    mainRssBytes: p?.mainRssBytes ?? null,
    rendererRssBytes: p?.rendererRssBytes ?? null,
    streamFps: p?.streamFps ?? null,
    streamTtftMs: ttftMs,
    installerBytes: installer?.bytes ?? null,
    targets,
    verdicts: targets === null
      ? null
      : {
          coldStartMs: judge('coldStartMs', p?.coldStartMs ?? null),
          mainRssBytes: judge('mainRssBytes', p?.mainRssBytes ?? null),
          rendererRssBytes: judge('rendererRssBytes', p?.rendererRssBytes ?? null),
          streamFps: judge('streamFps', p?.streamFps ?? null),
          streamTtftMs: judge('streamTtftMs', ttftMs),
          installerBytes: judge('installerBytes', installer?.bytes ?? null),
        },
    /** 每个数字是哪来的 —— "这个值哪来的"不应该只能靠猜 */
    sources: {
      coldStartMs: `docs/evidence/${reportName} · perf.coldStartMs`,
      mainRssBytes: `docs/evidence/${reportName} · perf.mainRssBytes`,
      rendererRssBytes: `docs/evidence/${reportName} · perf.rendererRssBytes`,
      streamFps: `docs/evidence/${reportName} · perf.streamFps`,
      streamTtftMs: `docs/evidence/${reportName} · probe.streamUsage.ttftMs`,
      installerBytes: installer?.file ?? '（无打包产物，未测）',
    },
    doc: 'docs/perf.md',
  };
}

/**
 * 安装包体积（文件系统实测）。
 *
 * 按通配找而不是拼死版本号：`crossdeck-Setup-<version>.exe` 里的 version
 * 跟着 package.json 走，写死它会在下次升版本时静默变成 null（"未测"）。
 * 找不到就返回 null —— 打包产物本来就可能不存在（要先 `pnpm pack:win`）。
 */
function measureInstaller() {
  const dir = join(ROOT, 'packages', 'shell-electron', 'dist', 'pack');
  if (!existsSync(dir)) return null;
  const name = readdirSync(dir).find((n) => /^crossdeck-Setup-.*\.exe$/.test(n));
  if (name === undefined) return null;
  return {
    file: `packages/shell-electron/dist/pack/${name}`,
    bytes: statSync(join(dir, name)).size,
  };
}

/**
 * 读取鸿蒙壳的端到端验证证据（由 `pnpm verify:ohos` 生成）。
 *
 * 与 `m5Feed` 同一原则：**没跑过就是 null（"未验证"）**，既不是 false 也不是
 * true。两条链路（Electron 自检 / 鸿蒙 verify）各有自己的入口命令，
 * 归档只负责呈现，不代替它们跑 —— 否则归档会变成"假装验证过"的源头。
 */
function readOhosEvidence() {
  if (!existsSync(OHOS_EVIDENCE)) return null;
  let payload;
  try {
    payload = JSON.parse(readFileSync(OHOS_EVIDENCE, 'utf8'));
  } catch {
    return null;
  }
  const steps = payload.steps ?? [];
  return {
    verifiedAt: payload.ranAt,
    ok: payload.ok ?? null,
    device: payload.device ?? null,
    bundle: payload.bundle ?? null,
    /** 五个关键里程碑各取一份 —— 其余步骤保留在 steps 里供追溯 */
    toolchain: findStep(steps, '工具链'),
    deviceOnline: findStep(steps, '设备在线'),
    syncShared: findStep(steps, '同步 contract/core'),
    buildHap: findStep(steps, 'hvigorw assembleHap'),
    hapSize: findStep(steps, 'HAP 产物'),
    install: findStep(steps, 'hdc install'),
    start: findStep(steps, 'aa start'),
    screenshots: payload.screenshots ?? [],
    steps,
    failures: payload.failures ?? [],
    reportFile: 'docs/evidence/ohos-selfcheck.json',
  };
}

/** 从步骤列表里取某一步的 {ok, detail}；找不到返回 null（步骤改名时不留假数据）。 */
function findStep(steps, name) {
  const hit = steps.find((s) => s.name === name);
  return hit === undefined ? null : { ok: hit.ok, detail: hit.detail };
}

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
// ── M6-1 性能量化：六项指标一行一档，图标一眼分得出"没测到"与"不达标" ──
const m6 = summary.m6;
if (m6.verdicts === null) {
  console.log('  M6-1 性能：未判定（找不到 contract 编译产物，先跑 pnpm typecheck）');
} else {
  const icon = (s) => (s === 'pass' ? '✅' : s === 'fail' ? '❌' : '·');
  const mb = (b) => (b === null ? 'n/a' : `${(b / 1048576).toFixed(1)}MB`);
  const v = m6.verdicts;
  console.log(`  M6-1 性能：${icon('pass')} 达标   ${icon('fail')} 未达标   · 未测到`);
  console.log(
    `    冷启动 ${String(m6.coldStartMs)}ms ${icon(v.coldStartMs)}` +
      `    main ${mb(m6.mainRssBytes)} ${icon(v.mainRssBytes)}` +
      `    renderer ${mb(m6.rendererRssBytes)} ${icon(v.rendererRssBytes)}`,
  );
  console.log(
    `    首token ${String(m6.streamTtftMs)}ms ${icon(v.streamTtftMs)}` +
      `    帧率 ${String(m6.streamFps)}fps ${icon(v.streamFps)}` +
      `    安装包 ${mb(m6.installerBytes)} ${icon(v.installerBytes)}`,
  );
  console.log('    → docs/perf.md');
}

// ── M6-2 鸿蒙壳：没跑过就说没跑过，不留"看起来像通过"的空壳 ──
if (summary.m6Ohos === null) {
  console.log('  M6-2 鸿蒙壳：未验证（跑 pnpm verify:ohos；需 DevEco 工具链 + 模拟器在线）');
} else {
  const o = summary.m6Ohos;
  console.log(`  M6-2 鸿蒙壳：ok=${String(o.ok)}  设备 ${String(o.device)}  bundle ${String(o.bundle)}`);
  console.log(`    HAP ${String(o.hapSize?.detail ?? '—')}  截图 ${o.screenshots.length} 张 → docs/screenshots/`);
}

console.log('  docs/evidence/selfcheck-summary.json');
