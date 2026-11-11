#!/usr/bin/env node
/**
 * 鸿蒙自检**判定层**的鉴别力测试 —— 不需要真机，也不派生子进程。
 *
 * ## 为什么要有它
 *
 * `packages/shell-ohos/scripts/verify-ohos.mjs` 的第 ⑩ 步（三判断）是本卡的核心，
 * 但它要连模拟器。在**没有设备**的环境里，那条路一行都跑不到 —— 判定表写得好不好，
 * 就只能靠肉眼。这个脚本把那层判定拿出来，用**合成行**（格式逐字抄自 `Index.ets`
 * 的 `runSelfCheck`）驱动，把客户端行为逐条改坏，看它是否每条都挂。
 *
 * ## 它已经抓到过的真缺陷（如实记）
 *
 * **M0 基线就挂。** 第一版解析器把 `text=` / `frames=` 写成必需字段，而应用给
 * `unknown` 那行**不打**这两个字段 —— 于是 `unknown` 永远解析不出来，反向断言
 * 变成**恒红**：真机上"跑对了"也会报失败。改真机之前抓到的，因为真机那时够不着。
 *
 * ## 这条"挂死"不是坏事，但判定要看退出码
 *
 * 变异测试有两种失败形态，我们**只**认第一种：
 *   · 判定挂了（打 ❌）—— 期望之内
 *   · 脚本自己崩了（退出码非 0，却一条 ❌ 都没有）—— 那是我们写错了，不是变异被杀
 * 所以最终判定同时看 `code=` 与计数：`DONE code=1` 且"异常 0 例"才算过。
 *
 * ## 13 发变异 + 1 发反向（全部被杀）
 *
 * | 变异 | 改坏的是什么 | 被哪一条杀掉 |
 * |---|---|---|
 * | M0 | 不动（基线） | —— 应当 0 条 |
 * | M1 | normal 终态数 1→2 | `场景 normal · 恰好一个终态` |
 * | M2 | 两条断流合成一条（killed 说成"没收到 done 帧"） | `场景 killed · 措辞` |
 * | M3 | 断流当成功（silent-close → done） | `场景 silent-close · 终态与错误码` |
 * | M4 | abort 没被认出来（ABORTED → UPSTREAM） | `场景 abort · 终态与错误码` |
 * | M5 | normal 少收几片（逐帧不够） | `场景 normal · 逐帧` |
 * | M6 | normal 正文长度差 1（跳字 / 重复） | `场景 normal · 正文长度` |
 * | M7 | 报告里没有 unknown 那行 | `反向 · 不认识场景被拒` |
 * | M8 | 不认识场景没被拒（HTTP 200） | `反向 · 不认识场景被拒` |
 * | M9 | 上游给截断场景也发了 done | `对端 · 截断场景没发 done` |
 * | M10 | 停止没真断连（对端没看见 abort） | `对端 · 看见了 abort 断连` |
 * | M11 | 应用自报异常（超时兜底） | `场景 normal · 无异常` |
 * | M12 | 没有 DONE 行 | `自检跑完` |
 * | R1 | **反向**：判定表里 killed 的 `msgHas` 拿掉 | —— M2 那条**不再挂**（证明是它承重） |
 *
 * 每发只挂**一条**（M0/R1 挂 0 条），说明判定不是靠"一挂一大片"蒙对的。
 * R1 是必须的：只证明"改坏输入会挂"还不够 —— 得证明"挂"确实靠那条断言，
 * 否则可能只是别的断言恰好也不同意，那就等于我们并不知道自己在测什么。
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NAV_NORMAL_CHUNKS } from '../../../scripts/fake-navigate-upstream.mjs';
import { judgeRepo, judgeSelfcheck, judgeUiPage } from './parse-ohos-selfcheck.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = join(HERE, 'parse-ohos-selfcheck.mjs');
const EXPECT_TEXT = NAV_NORMAL_CHUNKS.join('');

// 用例数只有一个真源：core 的 CONFORMANCE_CASE_COUNT。在这里写死一个数字，
// 以后加用例它不会跟着长 —— 而"规格被删空还全绿"正是要防的那件事。
const CORE_DIST = join(HERE, '..', '..', '..', 'packages', 'core', 'dist', 'index.js');
let core;
try {
  core = await import(pathToFileURL(CORE_DIST).href);
} catch (err) {
  console.error(`❌ 无法加载 core 编译产物：${CORE_DIST}`);
  console.error('   先跑 `pnpm typecheck`。');
  console.error(`   ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const MIN_CASES = core.CONFORMANCE_CASE_COUNT;
if (!Number.isInteger(MIN_CASES) || MIN_CASES < 1) {
  console.error(`❌ core 没有导出 CONFORMANCE_CASE_COUNT（拿到 ${String(MIN_CASES)}）—— 判定没法对账`);
  process.exit(1);
}

// 格式逐字抄自 Index.ets 的 runSelfCheck：
//   `run <key> terminal=… count=… code=… text=… frames=…[ error=…][ msg=…]`
// ⚠️ `unknown` 那行应用**不打** text=/frames= —— 这正是当初让基线挂掉的地方，
//    所以它必须**留在**这份合成报告里（免得以后有人"顺手补齐"把那个坑盖回去）。
const GOOD = [
  '[SELFCHECK] upstream=http://127.0.0.1:41000',
  '[SELFCHECK] fixture scenarios=5',
  '[SELFCHECK] run normal terminal=done count=1 code=- text=23 frames=5',
  '[SELFCHECK] run silent-close terminal=error count=1 code=UPSTREAM text=22 frames=5 msg=上游提前关闭连接：没收到 done 帧',
  '[SELFCHECK] run killed terminal=error count=1 code=UPSTREAM text=22 frames=5 msg=上游请求失败（HTTP 0）：Transferred a partial file（code=2300018）',
  '[SELFCHECK] run upstream-error terminal=error count=1 code=UPSTREAM text=22 frames=5 msg=上游报错：SELFCHECK：上游故意报错',
  '[SELFCHECK] run abort terminal=error count=1 code=ABORTED text=3 frames=3 msg=用户取消了这次提问',
  '[SELFCHECK] run unknown terminal=error count=1 code=- msg=HTTP 400：自检假上游不认识这个场景',
  '[SELFCHECK] peer clientGone=abort doneSent=normal logins=0',
  '[SELFCHECK] DONE runs=6',
];

const sub = (from, to) => (lines) => lines.map((l) => (l.includes(from) ? l.replace(from, to) : l));
const drop = (needle) => (lines) => lines.filter((l) => !l.includes(needle));

const cases = [
  { name: 'M0 基线：判定应全过', mutate: (l) => l, mustFail: [] },
  {
    name: 'M1 终态数=2（收尾窗口没起作用 → 会漏掉第二个终态）',
    mutate: sub('run normal terminal=done count=1', 'run normal terminal=done count=2'),
    mustFail: ['场景 normal · 恰好一个终态'],
  },
  {
    name: 'M2 两条断流被合成一条（killed 说成"没收到 done 帧"）',
    mutate: sub('msg=上游请求失败（HTTP 0）：Transferred a partial file（code=2300018）', 'msg=上游提前关闭连接：没收到 done 帧'),
    mustFail: ['场景 killed · 措辞'],
  },
  {
    name: 'M3 断流没报错、反而当成功（silent-close → done）',
    mutate: sub('run silent-close terminal=error count=1 code=UPSTREAM', 'run silent-close terminal=done count=1 code=-'),
    mustFail: ['场景 silent-close · 终态与错误码'],
  },
  {
    name: 'M4 abort 没被认出来（ABORTED → UPSTREAM）',
    mutate: sub('run abort terminal=error count=1 code=ABORTED', 'run abort terminal=error count=1 code=UPSTREAM'),
    mustFail: ['场景 abort · 终态与错误码'],
  },
  {
    name: 'M5 normal 少收了几片（逐帧不够）',
    mutate: sub('count=1 code=- text=23 frames=5', 'count=1 code=- text=23 frames=1'),
    mustFail: ['场景 normal · 逐帧'],
  },
  {
    name: 'M6 normal 正文长度不对（跳字 / 重复）',
    mutate: sub('count=1 code=- text=23 frames=5', 'count=1 code=- text=22 frames=5'),
    mustFail: ['场景 normal · 正文长度'],
  },
  {
    name: 'M7 反向丢了：unknown 那行不在报告里',
    mutate: drop('run unknown '),
    mustFail: ['反向 · 不认识场景被拒（HTTP 400）'],
    note: '顺带盯住"解析器要求 text=/frames= 才认"这个坑 —— 应用给 unknown 那行不打这两个字段',
  },
  {
    name: 'M8 不认识场景没被拒（上游把它当正常回答，HTTP 200）',
    mutate: sub('msg=HTTP 400：自检假上游不认识这个场景', 'msg=正文：这是一个正常回答'),
    mustFail: ['反向 · 不认识场景被拒（HTTP 400）'],
  },
  {
    name: 'M9 上游把截断场景也发了 done',
    mutate: sub('peer clientGone=abort doneSent=normal', 'peer clientGone=abort doneSent=normal,killed'),
    mustFail: ['对端 · 截断场景没发 done'],
  },
  {
    name: 'M10 停止没真的断连（对端没看见 abort）',
    mutate: sub('peer clientGone=abort', 'peer clientGone='),
    mustFail: ['对端 · 看见了 abort 断连'],
  },
  {
    name: 'M11 应用自报异常（超时兜底）',
    mutate: sub('count=1 code=- text=23 frames=5', 'count=1 code=- text=23 frames=5 error=12s 内没有终态'),
    mustFail: ['场景 normal · 无异常'],
  },
  {
    name: 'M12 自检根本没跑完（没有 DONE 行）',
    mutate: drop('DONE runs='),
    mustFail: ['自检跑完'],
  },
];

let bad = 0;

for (const c of cases) {
  const lines = c.mutate([...GOOD]);
  const { verdicts } = judgeSelfcheck(lines, EXPECT_TEXT);
  const failed = verdicts.filter((v) => !v.ok).map((v) => v.name).sort();
  const ok = JSON.stringify(failed) === JSON.stringify([...c.mustFail].sort());
  if (!ok) bad += 1;
  console.log(`${ok ? '✅' : '❌'} ${c.name}`);
  console.log(`     挂了 ${failed.length} 条：${failed.length === 0 ? '（无）' : failed.join(' | ')}`);
  if (!ok) console.log(`     期望挂：${c.mustFail.length === 0 ? '（无）' : c.mustFail.join(' | ')}`);
  if (c.note !== undefined) console.log(`     ⚠️ ${c.note}`);
}

// ─────────────────────────────────────────────────────────────
// R1 · 反向：判定表里承重的那条删掉，坏输入必须**存活**。
//
// 只有这一步能证明"挂"是靠 `msgHas` 挂的 —— 否则可能只是恰好别的断言
// 也不同意（那就等于我们并不知道自己在测什么）。
// 变异体写到系统临时目录，不往仓库里丢文件。
// ─────────────────────────────────────────────────────────────
const src = readFileSync(MODULE, 'utf8');
const weakened = src.replace("msgHas: '上游请求失败'", 'msgHas: null');
if (weakened === src) {
  console.log('❌ R1 无法在判定表里删掉 killed 的 msgHas —— 锚点失配，变异没生效（别当成通过）');
  bad += 1;
} else {
  const mutPath = join(tmpdir(), `crossdeck-ohos-judge-mutant-${process.pid}.mjs`);
  writeFileSync(mutPath, weakened, 'utf8');
  try {
    const mutant = await import(pathToFileURL(mutPath).href);
    const { verdicts } = mutant.judgeSelfcheck(cases[2].mutate([...GOOD]), EXPECT_TEXT);
    const failed = verdicts.filter((v) => !v.ok).map((v) => v.name);
    const survived = !failed.includes('场景 killed · 措辞');
    console.log(`${survived ? '✅' : '❌'} R1 反向：拿掉 killed 的 msgHas 后，M2 那条措辞断言必须不再挂`);
    console.log(`     挂了 ${failed.length} 条：${failed.length === 0 ? '（无）' : failed.join(' | ')}`);
    if (!survived) {
      console.log('     说明它被别的断言顺带覆盖了 —— 要重新想它到底测什么');
      bad += 1;
    }
  } finally {
    rmSync(mutPath, { force: true });
  }
}

// ─────────────────────────────────────────────────────────────
// 仓储一致性判定（7 发变异 + 1 发反向）
//
// 报告格式逐字抄自 Index.ets 的 `runRepoCheck`。`MIN_CASES` 来自 core，
// total 比它多 1 —— 多出来的是"持久化"那条（harness 提供 reopen 才会被加入）。
// ─────────────────────────────────────────────────────────────
const REPO_OK = [`[SELFCHECK] repo total=${MIN_CASES + 1} passed=${MIN_CASES + 1} failed=0 skipped=0`];

const repoCases = [
  { name: 'Q0 基线：仓储判定应全过', mutate: (l) => l, mustFail: [] },
  {
    name: 'Q1 没有 repo 汇总行（用例没跑起来）',
    mutate: () => [],
    mustFail: ['仓储 · 报告存在'],
  },
  {
    name: 'Q2 用例集被删空（total=1 也算"全过"）',
    mutate: () => ['[SELFCHECK] repo total=1 passed=1 failed=0 skipped=0'],
    mustFail: ['仓储 · 用例数没被删空'],
  },
  {
    name: 'Q3 自报"全过"但少了一条（passed < total）',
    mutate: () => [`[SELFCHECK] repo total=${MIN_CASES + 1} passed=${MIN_CASES} failed=0 skipped=0`],
    mustFail: ['仓储 · 全过'],
  },
  {
    name: 'Q4 有一条失败，且明细列出来了',
    mutate: () => [
      `[SELFCHECK] repo total=${MIN_CASES + 1} passed=${MIN_CASES} failed=1 skipped=0`,
      '[SELFCHECK] repoFail [ohos-rdb] flushMessage：覆盖写 —— 期望 3，实际 2',
    ],
    mustFail: ['仓储 · 全过'],
  },
  {
    name: 'Q5 有失败但明细被隐瞒（failed=1，一行 repoFail 都没有）',
    mutate: () => [`[SELFCHECK] repo total=${MIN_CASES + 1} passed=${MIN_CASES} failed=1 skipped=0`],
    mustFail: ['仓储 · 全过', '仓储 · 失败行如实列出'],
    note: '这条挂两条是设计使然：failures 非空同时说明"没全过"和"明细没列"',
  },
  {
    name: 'Q6 跳过了持久化那条（harness 没提供 reopen）',
    mutate: () => [`[SELFCHECK] repo total=${MIN_CASES} passed=${MIN_CASES} failed=0 skipped=1`],
    mustFail: ['仓储 · 没有跳过的用例'],
  },
  {
    name: 'Q7 整体抛异常（建库就崩了）',
    mutate: () => [
      `[SELFCHECK] repo total=${MIN_CASES + 1} passed=${MIN_CASES + 1} failed=0 skipped=0`,
      '[SELFCHECK] repoError 打开会话库失败：code=14800000',
    ],
    mustFail: ['仓储 · 无异常'],
  },
];

for (const c of repoCases) {
  const lines = c.mutate([...REPO_OK]);
  const { verdicts } = judgeRepo(lines, MIN_CASES);
  const failed = verdicts.filter((v) => !v.ok).map((v) => v.name).sort();
  const ok = JSON.stringify(failed) === JSON.stringify([...c.mustFail].sort());
  if (!ok) bad += 1;
  console.log(`${ok ? '✅' : '❌'} ${c.name}`);
  console.log(`     挂了 ${failed.length} 条：${failed.length === 0 ? '（无）' : failed.join(' | ')}`);
  if (!ok) console.log(`     期望挂：${c.mustFail.length === 0 ? '（无）' : c.mustFail.join(' | ')}`);
  if (c.note !== undefined) console.log(`     ⚠️ ${c.note}`);
}

// 反向：把"用例数没被删空"那条断言删掉，Q2 必须**存活**。
// 只有这一步能证明 Q2 是被它杀掉的，而不是恰好别处也不同意。
{
  const anchor = /^\s*push\('仓储 · 用例数没被删空'.*$/m;
  const weakened = src.replace(anchor, '');
  if (weakened === src) {
    console.log('❌ Q8 无法在判定层删掉"用例数没被删空" —— 锚点失配，变异没生效（别当成通过）');
    bad += 1;
  } else {
    const mutPath = join(tmpdir(), `crossdeck-ohos-judge-repo-${process.pid}.mjs`);
    writeFileSync(mutPath, weakened, 'utf8');
    try {
      const mutant = await import(pathToFileURL(mutPath).href);
      const { verdicts } = mutant.judgeRepo(repoCases[2].mutate([...REPO_OK]), MIN_CASES);
      const failed = verdicts.filter((v) => !v.ok).map((v) => v.name);
      const survived = !failed.includes('仓储 · 用例数没被删空');
      console.log(`${survived ? '✅' : '❌'} Q8 反向：拿掉"用例数没被删空"后，Q2 必须不再挂`);
      console.log(`     挂了 ${failed.length} 条：${failed.length === 0 ? '（无）' : failed.join(' | ')}`);
      if (!survived) {
        console.log('     说明它被别的断言顺带覆盖了 —— 要重新想它到底测什么');
        bad += 1;
      }
    } finally {
      rmSync(mutPath, { force: true });
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 页面自检报告判定（P3：界面搬进 ArkWeb 之后的主判定）
//
// 报告格式逐字抄自 `src/selfcheck.ts` 的 `report(...)` + `AppHost.report()` 的分片方式：
//   `[SELFCHECKPAGE] <i>/<n> <chunk>`，chunk 拼起来就是那份 JSON。
// 这里故意把**hilog 前缀**也拼进去 —— 解析器要在整行里找 `[SELFCHECKPAGE]`，
// 只喂裸分片就等于没测到真实输入形状。
// ─────────────────────────────────────────────────────────────
const pageReport = () => ({
  shell: 'ohos-web',
  ok: true,
  failures: [],
  probe: {
    'bridge.systemInfoReachable': { platform: 'ohos', capabilities: ['fs.scope'] },
    uiLoginGate: true,
    uiGuestLoginClicked: true,
    uiBootState: 'ready',
    uiLoginPersisted: true,
    uiSessionCount: { before: 0, after: 1 },
    uiSessionCreateClicked: true,
    uiSessionCreatedThroughUi: true,
    uiSessionDelete: { gone: true, error: '' },
    uiSessionRecreated: true,
    uiNavFixtureReachable: 6,
    uiChatInputPresent: true,
    uiSendClicked: true,
    uiStream: { streaming: true, stage: 'done', textLength: EXPECT_TEXT.length, expectedLen: EXPECT_TEXT.length },
    uiSlowSendClicked: true,
    uiTabSwitch: {
      restarted: true,
      firstChunk: true,
      backOnChat: true,
      lengthBeforeSwitch: 3,
      lengthAfterSwitch: 13,
      finalLen: EXPECT_TEXT.length,
      expectedLen: EXPECT_TEXT.length,
      finished: true,
      stage: 'done',
    },
    uiGrantClicked: true,
    uiEntryCount: 3,
    uiTreeRendered: true,
    uiEscapeClicked: true,
    uiEscapeMessage: '[SCOPE_DENIED:ESCAPE] 路径不在任何已授权工作区之内',
    uiFileEntryPresent: true,
    uiUploadClicked: true,
    uiUpload: { panel: true, stage: 'error', ratio: '1', error: '[FORBIDDEN] 当前身份没有上传权限（游客不能上传文档）' },
    uiUploadDeniedForGuest: true,
  },
});

const SENTINEL_LINE = '11-09 12:00:00.000  4321  4321 I A03200/WebShell: console: [selfcheck] DONE ok=true code=0';

/** 与 `AppHost.report()` 同一分片规则（700 字符），行首带 hilog 前缀。 */
function pageLines(report, { dropChunk = 0, dropSentinel = false } = {}) {
  const json = JSON.stringify(report);
  const CHUNK = 700;
  const total = Math.max(1, Math.ceil(json.length / CHUNK));
  const lines = [];
  for (let i = 0; i < total; i += 1) {
    if (i + 1 === dropChunk) continue;
    const body = json.slice(i * CHUNK, (i + 1) * CHUNK);
    lines.push(`11-09 12:00:0${i}.000  4321  4321 I A03200/HostBridge: [SELFCHECKPAGE] ${i + 1}/${total} ${body}`);
  }
  if (!dropSentinel) lines.push(SENTINEL_LINE);
  return lines;
}

const mutReport = (fn) => (r) => {
  const copy = JSON.parse(JSON.stringify(r));
  fn(copy);
  return copy;
};

const uiCases = [
  { name: 'U0 基线：页面报告判定应全过', report: (r) => r, lines: {}, mustFail: [] },
  {
    name: 'U1 正文少一个字符（漏帧 / 跳字）',
    report: mutReport((r) => {
      r.probe.uiStream.textLength -= 1;
    }),
    lines: {},
    mustFail: ['界面 · 聊天逐字到终态（长度相等）'],
  },
  {
    name: 'U2 切页签时丢了最后几片（终长不等于全文）',
    report: mutReport((r) => {
      r.probe.uiTabSwitch.finalLen -= 5;
    }),
    lines: {},
    mustFail: ['界面 · 切页签不丢帧'],
  },
  {
    name: 'U3 哨兵行没出现（页面崩了 / 自检没跑完）',
    report: (r) => r,
    lines: { dropSentinel: true },
    mustFail: ['界面 · 哨兵行'],
  },
  {
    name: 'U4 报告缺一片（hilog 截断 / 分片丢）',
    report: (r) => r,
    lines: { dropChunk: 2 },
    mustFail: ['界面 · 报告完整'],
    note: '只看"能 parse"是不够的：缺中间一片时 JSON 必定 parse 失败，这条要挂在更早一步',
  },
  {
    name: 'U5 有一条断言失败（应用如实上报）',
    report: mutReport((r) => {
      r.ok = false;
      r.failures = ['ui.treeRendered'];
    }),
    lines: {},
    mustFail: ['界面 · 断言无失败项', '界面 · 应用自评通过'],
    note: '两条同时挂是设计使然：failures 非空也意味着 ok 该是 false',
  },
  {
    name: 'U6 应用自评 false 但 failures 空（自相矛盾）',
    report: mutReport((r) => {
      r.ok = false;
    }),
    lines: {},
    mustFail: ['界面 · 应用自评通过'],
  },
  {
    name: 'U7 报告不是鸿蒙 WebView 壳报的（串了壳）',
    report: mutReport((r) => {
      r.shell = 'web';
    }),
    lines: {},
    mustFail: ['界面 · 是鸿蒙 WebView 壳报的'],
  },
  {
    name: 'U8 上传被拒的文案没到界面（403 没落到 UI）',
    report: mutReport((r) => {
      r.probe.uiUpload.error = '[UPSTREAM] 上传失败：HTTP 500';
    }),
    lines: {},
    mustFail: ['界面 · 游客上传被上游 403 拒'],
  },
  {
    name: 'U9 越界没被拒（fs-error 里没有 SCOPE_DENIED）',
    report: mutReport((r) => {
      r.probe.uiEscapeMessage = '';
    }),
    lines: {},
    mustFail: ['界面 · 越界被拒（SCOPE_DENIED 可见）'],
  },
  {
    name: 'U10 工作区树是空的（列目录没通）',
    report: mutReport((r) => {
      r.probe.uiEntryCount = 0;
    }),
    lines: {},
    mustFail: ['界面 · 工作区树渲染出来了'],
  },
  {
    name: 'U11 登录没落到凭据通道（只说明响应 200）',
    report: mutReport((r) => {
      r.probe.uiLoginPersisted = false;
    }),
    lines: {},
    mustFail: ['界面 · 凭据真的进了端口'],
  },
  {
    name: 'U12 删会话时弹出错误卡片（说明那行不在库里）',
    report: mutReport((r) => {
      r.probe.uiSessionDelete = { gone: true, error: '[NOT_FOUND] 会话不存在：s_1' };
    }),
    lines: {},
    mustFail: ['界面 · 删除证明会话真落库'],
  },
  {
    name: 'U13 probe 被删空（只剩一个空壳报告）',
    report: mutReport((r) => {
      r.probe = {};
    }),
    lines: {},
    mustFail: [
      '界面 · 断言项没被删空',
      '界面 · 登录闸门出现过',
      '界面 · 体验账号登录后到 ready',
      '界面 · 凭据真的进了端口',
      '界面 · 删除证明会话真落库',
      '界面 · 聊天逐字到终态（长度相等）',
      '界面 · 切页签不丢帧',
      '界面 · 工作区树渲染出来了',
      '界面 · 越界被拒（SCOPE_DENIED 可见）',
      '界面 · 游客上传被上游 403 拒',
    ],
    note: '这条是"只看 ok 字段"最典型的假绿：报告形制完整但一张证据都没有 —— 挂一片是设计使然',
  },
];

for (const c of uiCases) {
  const lines = pageLines(c.report(pageReport()), c.lines);
  const { verdicts } = judgeUiPage(lines, EXPECT_TEXT.length);
  const failed = verdicts.filter((v) => !v.ok).map((v) => v.name).sort();
  const ok = JSON.stringify(failed) === JSON.stringify([...c.mustFail].sort());
  if (!ok) bad += 1;
  console.log(`${ok ? '✅' : '❌'} ${c.name}`);
  console.log(`     挂了 ${failed.length} 条：${failed.length === 0 ? '（无）' : failed.join(' | ')}`);
  if (!ok) console.log(`     期望挂：${c.mustFail.length === 0 ? '（无）' : c.mustFail.join(' | ')}`);
  if (c.note !== undefined) console.log(`     ⚠️ ${c.note}`);
}

// 反向：把"断言项没被删空"那条删掉，U13 必须**不再挂它**。
// 只有这一步能证明 U13 里那一条是靠它杀掉的，而不是恰好别处也不同意。
{
  const anchor = /^\s*push\('界面 · 断言项没被删空'.*$/m;
  const weakened = src.replace(anchor, '');
  if (weakened === src) {
    console.log('❌ U14 无法在判定层删掉"断言项没被删空" —— 锚点失配，变异没生效（别当成通过）');
    bad += 1;
  } else {
    const mutPath = join(tmpdir(), `crossdeck-ohos-judge-ui-${process.pid}.mjs`);
    writeFileSync(mutPath, weakened, 'utf8');
    try {
      const mutant = await import(pathToFileURL(mutPath).href);
      const lines = pageLines(uiCases[13].report(pageReport()), uiCases[13].lines);
      const { verdicts } = mutant.judgeUiPage(lines, EXPECT_TEXT.length);
      const failed = verdicts.filter((v) => !v.ok).map((v) => v.name);
      const survived = !failed.includes('界面 · 断言项没被删空');
      console.log(`${survived ? '✅' : '❌'} U14 反向：拿掉"断言项没被删空"后，U13 必须不再挂它`);
      console.log(`     挂了 ${failed.length} 条：${failed.length === 0 ? '（无）' : failed.join(' | ')}`);
      if (!survived) {
        console.log('     说明它被别的断言顺带覆盖了 —— 要重新想它到底测什么');
        bad += 1;
      }
    } finally {
      rmSync(mutPath, { force: true });
    }
  }
}

console.log('────────────────────────────────────────────────');
console.log(`[ohos-judge] 共 ${cases.length + repoCases.length + uiCases.length + 3} 例，异常 ${bad} 例`);
console.log(`[ohos-judge] DONE code=${bad === 0 ? 0 : 1}`);
process.exit(bad === 0 ? 0 : 1);
