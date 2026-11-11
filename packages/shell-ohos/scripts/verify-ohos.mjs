#!/usr/bin/env node
/**
 * 鸿蒙壳的端到端验证 —— 编译 → 装 → 起 → 点 → 截图 → 归档 → 判定。
 *
 * ## 为什么需要它（而不是"我手工跑过一次"）
 *
 * 鸿蒙壳的价值主张是「同一份 contract/core 换一个壳」。这句话必须**可复现地**
 * 被证明，否则它就只是一次性的观察。这个脚本把那条链路固化下来：
 * 任何人 clone 下来、装好 DevEco、连着模拟器，跑一条命令就能重放。
 *
 * ## 环境不具备时如实说，不假装成功
 *
 * 四种"跑不了"被严格区分，且**都返回非零**，但报告里的字段不同
 * （`skipped` 而非 `ok`）—— 这与 Electron 壳自检里"未打包形态必须报 error
 * 而不是永远转圈"是同一条原则：
 *   · 工具链缺失（找不到 hvigorw / hdc）→ `skipped: 'toolchain-missing'`
 *   · 派生子进程被拒（受限会话里 `spawnSync` 一律 EBUSY）→ `skipped: 'spawn-blocked'`
 *   · 设备不在线（`hdc list targets` 为空）→ `skipped: 'no-device'`
 *   · core 产物缺失 → `skipped: 'core-dist-missing'`
 *
 * ⚠️ 中间那两条**必须分开**：受限会话里 `hdc list targets` 也会 EBUSY，不区分的话
 *    会把**环境问题**报成**设备问题** —— 正是"测量手段骗了你"那一类。
 *    实测（受限会话）：本脚本在那里停在 ②，exit 2、`skipped: 'spawn-blocked'`。
 *
 * ## 这一趟验什么（四件事，与 Electron / Web 两侧同一口径）
 *
 * ① **真的连上了** —— 宿主侧起假上游（`scripts/fake-navigate-upstream.mjs`），
 *    经 `hdc rport` 映射进模拟器（鸿蒙没有 Android 的 `10.0.2.2`，模拟器里的
 *    `127.0.0.1` 指它自己）；
 * ② **终态恰好一个**（含两条**不同**的断流路径：干净 EOF / socket 被销毁）；
 * ③ **abort 有效** —— 证据在**对端**：客户端自称 abort 不算，得看上游有没有看见连接被关；
 * ④ **端口语义没漂** —— 同一份仓储用例（`checkSessionRepository`，22 条）跑在
 *    relationalStore 上：规格来自 core，后端是鸿蒙的 RDB。
 *
 * 帧解析 / 映射的细粒度断言仍然只在 `scripts/verify-core-sse.mjs`，
 * 这里**不抄第三套**（三套漂移比一套没有更糟）。
 *
 * ## 两条链路（P3 之后默认走新版）
 *
 * | | 主链路（默认） | `--legacy` |
 * |---|---|---|
 * | 界面 | `pages/WebShell`（ArkWeb 承载共享 UI） | `pages/Index`（ArkUI 原生页） |
 * | 点击 | 页面内 `data-testid`（`runUiProbe`） | `dumpLayout` + `uinput` 按坐标点 |
 * | 读结论 | `hdc shell hilog -x`（`[SELFCHECKPAGE]` 分片 + `[SELFCHECK] repo`） | UI 树上的文本行 |
 *
 * 为什么主链路必须换测量手段：ArkWeb 在 UI 树里只是**一个 Web 节点**，
 * 点不到 DOM 子控件（`dumpLayout` 看不到 React 的 DOM）。旧的点击流程对主界面
 * 直接失效，所以自检搬进了页面，设备侧只负责 grep + 判定。
 * 原生页留着是因为它是"没有 WebView 也能自证 core/RDB"的兜底。
 *
 * ## 应用不自己宣布成功
 *
 * 模拟器里的自检只把观察到的**原始数字**打出来（`[SELFCHECK]` 前缀），判定留在这里。
 * 判定逻辑在 `parse-ohos-selfcheck.mjs`（纯函数）—— 抽出去是为了在没有真机的环境里
 * 也能用合成行驱动它，证明那张期望表**有鉴别力**：
 * `pnpm verify:ohos-judge`（13 发变异 + 1 发反向，全部被杀）。
 * 那一层已经抓到过一个真缺陷：解析器把 `text=` / `frames=` 当必需字段，而应用给
 * `unknown` 那行不打它们 → 反向断言恒红（真机上跑对了也会报失败）。
 *
 * ## 「截图要能看到逐字流」这条怎么落地
 *
 * `snapshot_display` 只拍得到一帧，所以：⓪ 自检面板刻意放在**页面最前**（不然流式
 * 卡片滚出屏幕），并新增 `slow` 场景（假上游每片 700ms —— 20ms 那一档整条流 300ms
 * 就结束，只能拍到"还没开始"或"已经结束"）。判定不是"截图文件存在"（那证明不了
 * 逐字），而是 UI 树上出现**终文的真前缀且更短**。
 *
 * ## 为什么点击坐标是**动态取**的
 *
 * 第一版我按截图像素估坐标，结果点了个空 —— 截图里 72580 字节的"没变化"
 * 看起来像"点了但没反应"，实际是根本没点中。改成先用 `uitest dumpLayout`
 * 拿控件的真实 `bounds`，从 UI 树算中心点。UI 改版时它会自己跟上。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// 假上游与 Web 壳自检**共用一份**（见该文件头部：抄两份会长出两套场景词表）。
import {
  NAV_NORMAL_CHUNKS,
  NAV_SCENARIO_PROMPTS,
  createFakeNavigateUpstream,
} from '../../../scripts/fake-navigate-upstream.mjs';
// 判定层抽成纯函数：它能在**没有真机**时被合成行驱动（见该文件头部）。
import { judgeRepo, judgeSelfcheck, judgeUiPage } from './parse-ohos-selfcheck.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const REPO = join(PKG, '..', '..');
const SHOTS = join(REPO, 'docs', 'screenshots');
const EVIDENCE = join(REPO, 'docs', 'evidence');

const DEVECO = process.env.DEVECO_HOME ?? 'D:/software/DevEco Studio';
const SDK_HOME = `${DEVECO}/sdk`;
const HVIGOR = `${DEVECO}/tools/hvigor/bin/hvigorw.bat`;
const NODE_BIN = `${DEVECO}/tools/node`;
const JBR_BIN = `${DEVECO}/jbr/bin`;
const HDC = `${DEVECO}/sdk/default/openharmony/toolchains/hdc.exe`;
const BUNDLE = 'site.crossdeck.app';
const ABILITY = 'EntryAbility';
/** `--legacy` = 旧的 ArkUI 原生页链路（`--ps ui arkui` + `dumpLayout` 点控件）。 */
const LEGACY = process.argv.includes('--legacy');

const evidence = { ranAt: new Date().toISOString(), tool: 'verify-ohos', steps: [], failures: [] };
let failed = false;

function record(name, ok, detail) {
  evidence.steps.push({ name, ok, detail });
  const mark = ok ? '✅' : '❌';
  console.log(`  ${mark} ${name.padEnd(26)} ${detail}`);
  if (!ok) {
    failed = true;
    evidence.failures.push(`${name}: ${detail}`);
  }
}

/**
 * 跑外部命令。
 *
 * `opts.shell` 专给 hvigorw 用 —— 它是个 `.bat`，Windows 上 Node 不能直接 spawn，
 * 必须过 cmd.exe。而过 shell 时**整条命令要被引号包住**：`D:/software/DevEco Studio/...`
 * 里有空格，不包的话命令会从空格处被腰斩，症状是"命令静默地什么都没执行、
 * 退出码非 0、输出为空" —— 第一版就是这么挂的。
 */
function run(cmd, args, opts = {}) {
  const env = {
    ...process.env,
    PATH: `${NODE_BIN};${JBR_BIN};${process.env.PATH}`,
    DEVECO_SDK_HOME: SDK_HOME,
  };
  const cwd = opts.cwd ?? PKG;
  const base = { encoding: 'utf8', cwd, env, maxBuffer: 32 * 1024 * 1024 };
  if (opts.shell === true) {
    return spawnSync(`"${cmd}" ${args.join(' ')}`, { ...base, shell: true });
  }
  return spawnSync(cmd, args, base);
}

/**
 * 等一会儿 —— **必须是异步的**。
 *
 * 曾经用 `Atomics.wait` 同步等，结果它把 Node 事件循环整个堵死：设备侧连接
 * 建立了（rport 在监听、应用也能连上），但同进程的假上游收不到任何回调 ——
 * 请求从未被 accept，应用侧表现为 8s 超时 `2300028`。这就是"测量手段把
 * 被测对象堵死"的现场：假上游和轮询循环在同一个进程里，轮询不许独占线程。
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 把"根本没跑起来"和"跑了但失败"分开。
 *
 * 受限会话里 Node 派生子进程直接 `EBUSY`（`status=null`，`stdout`/`stderr`
 * 全是 `undefined`）。不区分的话：① 后续 `stdout.trim()` 抛 `TypeError`，
 * 报出来像脚本自己写错了；② 被测的 `hdc list targets` 会退化成"没有在线设备"，
 * 把**环境问题**报成**设备问题** —— 正是"测量手段骗了你"那一类。
 */
function spawnFailure(r) {
  return r.error ? `${r.error.code ?? 'spawn'}: ${r.error.message}` : null;
}

function hdc(args, opts = {}) {
  return spawnSync(HDC, args, { encoding: 'utf8', cwd: opts.cwd ?? REPO, maxBuffer: 32 * 1024 * 1024 });
}

console.log('── 鸿蒙壳端到端验证 ────────────────────────────');
mkdirSync(EVIDENCE, { recursive: true });

// ① 工具链
if (!existsSync(HVIGOR) || !existsSync(HDC)) {
  console.error(`❌ 工具链缺失：${HVIGOR} / ${HDC}`);
  console.error('   设置 DEVECO_HOME 指向 DevEco Studio 安装目录后重试。');
  evidence.skipped = 'toolchain-missing';
  writeFileSync(join(EVIDENCE, 'ohos-selfcheck.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  process.exit(2);
}
record('工具链', true, `DevEco @ ${DEVECO}`);

// ② 设备
const probe = hdc(['list', 'targets']);
const probeFail = spawnFailure(probe);
if (probeFail !== null) {
  console.error(`❌ 无法执行 hdc：${probeFail}`);
  console.error('   Node 在本会话派生子进程会 EBUSY —— 换普通终端跑（不要套沙箱），这不是设备的问题。');
  evidence.skipped = 'spawn-blocked';
  writeFileSync(join(EVIDENCE, 'ohos-selfcheck.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  process.exit(2);
}
const targets = probe.stdout.trim();
if (targets.length === 0 || targets.includes('[Empty]')) {
  console.error('❌ 没有在线设备 —— 先启动模拟器：');
  console.error(`   "${DEVECO}/tools/emulator/Emulator.exe" -start "Pura 90 Pro" \\`);
  console.error('     -instancePath "%LOCALAPPDATA%/Huawei/Emulator/deployed" -imageRoot "%LOCALAPPDATA%/Huawei/Sdk"');
  evidence.skipped = 'no-device';
  writeFileSync(join(EVIDENCE, 'ohos-selfcheck.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  process.exit(2);
}
const device = targets.split('\n')[0].trim();
record('设备在线', true, `${device}（${hdc(['shell', 'uname -m']).stdout.trim()}）`);

// ③ 同步 contract/core
const sync = run('node', [join(HERE, 'sync-shared.mjs')]);
if (sync.status !== 0) {
  record('同步 contract/core', false, sync.stderr?.slice(-300) ?? spawnFailure(sync) ?? 'unknown');
  process.exit(1);
}
record('同步 contract/core', true, sync.stdout.trim().split('\n').slice(-1)[0] ?? '');

// ④ 编译
const build = run(HVIGOR, ['assembleHap', '--no-daemon'], { shell: true });
const buildFail = spawnFailure(build);
const buildOk = buildFail === null && build.status === 0 && (build.stdout ?? '').includes('BUILD SUCCESSFUL');
record('hvigorw assembleHap', buildOk, buildOk ? 'BUILD SUCCESSFUL' : (buildFail ?? (build.stdout ?? build.stderr ?? '')).slice(-400));

const hap = join(PKG, 'entry', 'build', 'default', 'outputs', 'default', 'entry-default-unsigned.hap');
if (!buildOk || !existsSync(hap)) {
  record('HAP 产物', false, `未找到 ${hap}`);
  writeFileSync(join(EVIDENCE, 'ohos-selfcheck.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  process.exit(1);
}
record('HAP 产物', true, `${(readFileSync(hap).length / 1024).toFixed(1)} KB`);

// ⑤ 安装（⚠️ 必须 cd 到目录再传相对路径 —— hdc 会把绝对路径拼到自己的 cwd 上）
const hapDir = dirname(hap);
const install = hdc(['install', '-r', 'entry-default-unsigned.hap'], { cwd: hapDir });
const installOk = (install.stdout ?? '').includes('install bundle successfully');
record('hdc install', installOk, installOk ? 'install bundle successfully' : (install.stdout ?? '').slice(-200));

/**
 * 截图 + 拉回仓库。本地文件名写 `.jpg`（内容确实是 JPEG）。
 *
 * ⚠️ 两个坑，都是实测踩出来的，**别改回去**：
 *
 * ① **设备端中转文件必须用 `.jpeg` 后缀。** `snapshot_display` 产出的是 JPEG，
 *    但它只认 `.jpeg` —— 传 `.jpg` 会得到
 *    `error: fileName ... invalid, suffix must be .jpeg`，并且**什么都不生成**。
 *    所以这里有个刻意的不对称：设备端 `.jpeg`、本地 `.jpg`。
 *    这不是笔误，是工具的脾气。
 *
 * ② **成败判定不能只看本地文件在不在。** 第一版写成 `existsSync(local)`，
 *    于是「设备端没生成 → recv 失败 → 但上一次的旧文件还在」这条路径
 *    会**报成功**，detail 里显示的还是上一次的字节数 —— 一个会自我掩盖的假绿。
 *    实测 `hdc file recv` 失败时**退出码依然是 0**，唯一的真信号是 stdout 里
 *    那行 `[Fail]`。所以现在：先删本地文件 → 再 recv → 再查 `[Fail]`，
 *    最后才看文件在不在。三道都要过。
 */
function shot(name) {
  const remote = `/data/local/tmp/${name}.jpeg`;
  const local = join(SHOTS, `${name}.jpg`);
  rmSync(local, { force: true });
  hdc(['shell', `snapshot_display -f ${remote}`]);
  const out = hdc(['file', 'recv', remote, `docs/screenshots/${name}.jpg`], { cwd: REPO });
  const combined = `${out.stdout ?? ''}${out.stderr ?? ''}`;
  if (combined.includes('[Fail]')) {
    return { ok: false, detail: combined.trim().slice(-200) };
  }
  return existsSync(local)
    ? { ok: true, detail: `${(readFileSync(local).length / 1024).toFixed(1)} KB → docs/screenshots/${name}.jpg` }
    : { ok: false, detail: 'recv 没报错但本地也没有文件 —— 拒绝当作成功' };
}

/**
 * 把设备端 UI 树拉到本地并解析成对象。返回 `{ tree }` 或 `{ error }`。
 *
 * 与 `shot()` 同一个道理：**先删本地副本再拉**。否则 `existsSync` 会读到上一次
 * 的 UI 树，然后在**旧界面**上找控件 —— 找到就点到错的位置（比点空更糟，
 * 因为它看起来成功了），找不到就误报"控件不存在"。
 *
 * ⚠️ **必须按 JSON 结构遍历，不要用字符串切片找。**
 * 第一版写成 `raw.indexOf('"text":"X"')` 再往后 slice 找第一个 `"bounds"` ——
 * 看着能用，实则**整体错位一个节点**：attributes 里 `bounds` 排在 `text`
 * **之前**，所以「text 之后第一个 bounds」永远是**下一个节点**的。
 * 后果不是点空，而是**点到隔壁按钮**。实测对照（同一份 UI 树）：
 *
 * | 目标 | 真实中心 | 切片法算出 | 实际落点 |
 * |---|---|---|---|
 * | 「发送」 | (165,1810) | (420,1810) | 「带工具」 |
 * | 「带工具」 | (420,1810) | (674,1810) | 「暂停」 |
 *
 * 这类错位比"点空"危险得多：点空当场能看出来，点错位置会产出
 * **看起来合理、内容却是另一次操作**的截图 —— 两张图字节数完全相同，
 * 直到比对 MD5 才露馅。
 */
function dumpUiTree() {
  const tmp = join(REPO, '.ohos-layout.json');
  rmSync(tmp, { force: true });
  hdc(['shell', 'uitest dumpLayout -p /data/local/tmp/layout.json']);
  const out = hdc(['file', 'recv', '/data/local/tmp/layout.json', '.ohos-layout.json'], { cwd: REPO });
  const combined = `${out.stdout ?? ''}${out.stderr ?? ''}`;
  if (combined.includes('[Fail]')) {
    return { error: `拉不回 UI 树：${combined.trim().slice(-120)}` };
  }
  if (!existsSync(tmp)) return { error: 'hdc recv 没报错但本地也没有 UI 树' };
  try {
    return { tree: JSON.parse(readFileSync(tmp, 'utf8')) };
  } catch (err) {
    return { error: `UI 树不是合法 JSON：${String(err.message).slice(0, 120)}` };
  }
}

/** 深度优先收集 UI 树里所有**非空**的 `attributes.text`（原序）。 */
function collectTexts(node, out = []) {
  const attrs = node.attributes ?? {};
  if (typeof attrs.text === 'string' && attrs.text.length > 0) out.push(attrs.text);
  for (const child of node.children ?? []) collectTexts(child, out);
  return out;
}

/** `dumpUiTree` 的取值包装 —— 返回 `{ texts }` 或 `{ error }`，两种失败可区分。 */
function dumpTexts() {
  const dump = dumpUiTree();
  if (dump.tree === undefined) return { error: dump.error };
  return { texts: collectTexts(dump.tree) };
}

/** 深度优先找第一个 `attributes.text === label` 的节点，返回它自己的 bounds。 */
function findByText(node, label) {
  const attrs = node.attributes ?? {};
  if (attrs.text === label && typeof attrs.bounds === 'string') return attrs.bounds;
  for (const child of node.children ?? []) {
    const hit = findByText(child, label);
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * 从 UI 树里找文本为 `label` 的控件中心点。
 *
 * 返回 `{ center }` 或 `{ error }` —— **两种失败必须可区分**，而且都必须让
 * 调用方报失败，不能悄悄跳过点击：
 *   · 拉不回 UI 树（hdc recv 失败）
 *   · UI 树里有，但没有这个文本的控件
 * 压成同一个 null 会让报告里的原因指向错的那一个。
 */
function centerOf(label) {
  const dump = dumpUiTree();
  if (dump.tree === undefined) return { error: dump.error };
  const boundsStr = findByText(dump.tree, label);
  if (boundsStr === null) return { error: `UI 树里找不到文本为「${label}」的控件` };
  const m = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(boundsStr);
  if (m === null) return { error: `找到了「${label}」但 bounds 解析不出：${boundsStr}` };
  const [, x1, y1, x2, y2] = m.map(Number);
  return { center: { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) } };
}

async function clickAndShot(label, name) {
  const found = centerOf(label);
  if (found.center === undefined) {
    record(`点击「${label}」`, false, `${found.error} —— 拒绝静默跳过`);
    return;
  }
  hdc(['shell', `uinput -T -c ${found.center.x} ${found.center.y}`]);
  await sleep(7000);
  const s = shot(name);
  record(`点击「${label}」→ ${name}.jpg`, s.ok, s.detail);
}

// ⑥ 假上游（宿主侧）+ 端口映射
//
// 与 Web 壳自检**共用同一份实现**（`scripts/fake-navigate-upstream.mjs`）：
// 两个宿主脚本各自抄一套的话，场景词表就会有两个版本 —— 一端改了 prompt、
// 另一端还认旧的，症状是"这个场景不存在（400）"，看起来像客户端的问题。
//
// 为什么要 `rport`：鸿蒙没有 Android 的 `10.0.2.2`，模拟器里的 `127.0.0.1`
// 指的是**它自己**。把宿主端口反向映射进去，应用才连得上。
const coreEntry = join(REPO, 'packages', 'core', 'dist', 'index.js');
if (!existsSync(coreEntry)) {
  console.error(`❌ 缺少 ${coreEntry} —— 先跑 pnpm typecheck`);
  console.error('   （假上游的 chat 路径与 done 字面量取自 core 产物，不在这里另抄一份）');
  evidence.skipped = 'core-dist-missing';
  writeFileSync(join(EVIDENCE, 'ohos-selfcheck.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  process.exit(2);
}
const core = await import(pathToFileURL(coreEntry).href);

const TOKEN = `ohos-selfcheck-${Date.now()}`;
const upstream = createFakeNavigateUpstream({
  chatPath: core.NAVIGATE_CHAT_PATH,
  doneLiteral: core.NAVIGATE_DONE_LITERAL,
  auth: 'token',
  fixedToken: TOKEN,
});
// ⚠️ 必须绑 `::`（IPv6 双栈），不能绑 `127.0.0.1`。
// hdc 的 rport 在宿主侧是往 `localhost` 转发的，而它解析到 `::1`：
// 只监听 IPv4 时，设备侧 TCP 能连上（rport 在设备上 listen），但转发立刻断掉 ——
// 应用侧表现为 8s 超时 `2300028 Operation timeout`，看起来像"上游没起"。
// 实测：同一个 server 换成 `listen(0, '::')` 后，`/__selfcheck/nav-fixture` 立刻到达。
/**
 * 设备侧该端口是否已经在监听。
 *
 * 为什么要查：`hdc rport` 遇到设备端口被占（上一轮残留的映射）时会输出
 * `[Fail]TCP Port listen failed at <port>`，**但退出码仍然是 0**。只看关键字
 * 会漏，只看退出码更会漏 —— 应用侧最终表现为 8s 超时，看起来像"上游没起"。
 */
function devicePortInUse(port) {
  const r = hdc(['shell', `netstat -tunl 2>/dev/null | grep -c ':${port} '`]);
  return Number((r.stdout ?? '0').trim()) > 0;
}

/**
 * 在**固定端口段**里挑一个"宿主空闲 + 设备未占用"的端口监听。
 *
 * ⚠️ 不要用 `listen(0)` 让系统随机分配：动态段（49152–65535）上的端口，
 * `hdc rport` 会在设备侧 LISTEN、应用也能连上，但请求一条都到不了宿主。
 * 固定段没有这个问题（实测 64001/64002/64004/38000 均通）。
 *
 * ⚠️ 也**不能只挑宿主空闲的**：设备侧可能还留着上一轮的映射（hdc 的
 * `fport rm` 对陈旧条目常常报"不存在"却仍列在表里），此时 rport 会失败，
 * 而失败信号只是一个 `[Fail]` 字符串。所以这里两侧都查。
 */
async function listenOnFixedPort(server, from = 64000, to = 64999) {
  for (let port = from; port <= to; port += 1) {
    if (devicePortInUse(port)) continue;
    try {
      await new Promise((resolve, reject) => {
        const onError = (err) => {
          server.removeListener('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '::');
      });
      return port;
    } catch {
      // 端口被占：试下一个。server 在 EADDRINUSE 之后仍可再次 listen。
    }
  }
  throw new Error(`端口段 ${from}-${to} 里没有空闲端口`);
}

const upstreamServer = createServer(async (req, res) => {
  if (process.env.OHOS_DEBUG_UPSTREAM === '1') console.error(`[upstream] ${req.method} ${req.url}`);
  if (await upstream.handle(req, res)) return;
  res.writeHead(404).end('not found');
});
const upstreamPort = await listenOnFixedPort(upstreamServer);
const deviceBase = `http://127.0.0.1:${upstreamPort}`;
record('假上游已起', true, `${deviceBase}（token 鉴权）`);

const rport = hdc(['rport', `tcp:${upstreamPort}`, `tcp:${upstreamPort}`]);
const rportOut = `${rport.stdout ?? ''}${rport.stderr ?? ''}`.trim();
const rportCmdOk = spawnFailure(rport) === null && rportOut.length > 0 && !rportOut.includes('[Fail]');
// 第二道：设备侧真的在监听。只信命令回显会被「退出码 0 + [Fail]」骗过去 ——
// 那正是这条链路曾经连续几轮失败的原因：脚本自报 rport OK，应用却一直超时。
const listening = devicePortInUse(upstreamPort);
const rportOk = rportCmdOk && listening;
record(
  'hdc rport',
  rportOk,
  rportOk
    ? `tcp:${upstreamPort} → 宿主（设备侧已监听）`
    : `命令=${rportOut.slice(-140) || '（无输出）'}｜设备侧监听=${listening}`,
);
if (!rportOk) {
  console.error('❌ 端口映射没建立 —— 后面的 navigate 判定只会得到 8s 超时，先修这里');
  evidence.skipped = 'rport-failed';
  writeFileSync(join(EVIDENCE, 'ohos-selfcheck.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  upstreamServer.close();
  process.exit(1);
}

mkdirSync(SHOTS, { recursive: true });

const EXPECT_TEXT = NAV_NORMAL_CHUNKS.join('');
let midText = '';

if (LEGACY) {
  // ─────────────────────────────────────────────────────────────
  // ⑦L 第一趟：**不带配置**启动 —— 与历史证据完全同一条路（脚本上游）。
  //
  // 为什么仍要跑这一趟：自检面板只在配了上游时出现，而它会把 ③ 节挤到屏幕外，
  // 「带工具」那一步就点不到了。这一趟保证**工具链路的截图没有因为 T14 而丢**。
  // ─────────────────────────────────────────────────────────────
  hdc(['shell', `aa force-stop ${BUNDLE}`]);
  const startDemo = hdc(['shell', `aa start -a ${ABILITY} -b ${BUNDLE} --ps ui arkui`]);
const demoOk = (startDemo.stdout ?? '').includes('start ability successfully');
record('aa start（演示形态，脚本上游）', demoOk, demoOk ? 'start ability successfully' : (startDemo.stdout ?? '').slice(-200));
await sleep(6000);

const overview = shot('ohos-shell');
record('截图 · 首屏', overview.ok, overview.detail);

await clickAndShot('发送', 'ohos-shell-stream');
await clickAndShot('带工具', 'ohos-shell-tool');

// ─────────────────────────────────────────────────────────────
// ⑧ 第二趟：**带配置**启动 —— 地址与 token 走命令行参数
//    （`--ps` → EntryAbility → AppStorage → 页面的 @StorageLink）。
//
// ⚠️ token 由命令行注入：鸿蒙侧还没有 guest 登录那条链路，而"登录"不属于这张卡的
//    三条判定。聊天路径本身仍然**真的**带 token、并被上游校验（401 那条反向断言在 Web 侧）。
// ─────────────────────────────────────────────────────────────
hdc(['shell', `aa force-stop ${BUNDLE}`]);
const startNav = hdc([
  'shell',
  `aa start -a ${ABILITY} -b ${BUNDLE} --ps ui arkui --ps upstreamUrl ${deviceBase} --ps ohosToken ${TOKEN}`,
]);
const navStartOk = (startNav.stdout ?? '').includes('start ability successfully');
record('aa start（--ps 配置通道）', navStartOk, navStartOk ? deviceBase : (startNav.stdout ?? '').slice(-200));
await sleep(6000);

const panel = shot('ohos-shell-selfcheck-boot');
record('截图 · 自检面板（首屏）', panel.ok, panel.detail);

// ─────────────────────────────────────────────────────────────
// ⑨ 慢流中间帧 —— 「截图要能看到逐字流」这条判据就落在这里
//
// 为什么不能用 normal 场景拍：20ms 一片，整条流 300ms 就结束了，
// 截图只能拍到"还没开始"或"已经结束"。slow 场景 700ms 一片，能稳定拍到半截。
//
// 判定不是"截图文件存在"（那证明不了逐字），而是：
// UI 树上出现了**最终文本的一个真前缀**且更短 —— 那才是"逐字流"的定义。
// ─────────────────────────────────────────────────────────────
  {
    const found = centerOf('自检·慢流');
  if (found.center === undefined) {
    record('点击「自检·慢流」', false, `${found.error} —— 拒绝静默跳过`);
  } else {
    hdc(['shell', `uinput -T -c ${found.center.x} ${found.center.y}`]);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await sleep(500);
      const dump = dumpTexts();
      if (dump.texts === undefined) continue;
      const partial = dump.texts.find(
        (t) => t.length > 0 && t.length < EXPECT_TEXT.length && EXPECT_TEXT.startsWith(t),
      );
      if (partial !== undefined) {
        midText = partial;
        break;
      }
    }
    const s = shot('ohos-shell-selfcheck-midstream');
    record(
      '截图 · 慢流中间帧（逐字流）',
      s.ok && midText.length > 0,
      midText.length > 0
        ? `${JSON.stringify(midText)} = ${midText.length}/${EXPECT_TEXT.length} 字符（终文的真前缀）`
        : '始终没抓到"半截"文本 —— 那张截图只能证明结果，证明不了逐字',
    );
  }
}

// 等慢流自己收尾，再拍终帧 —— 中间帧与终帧并排看，就是"逐字"最直接的证据
await sleep(6000);
{
  const s = shot('ohos-shell-selfcheck-done');
  const dump = dumpTexts();
  const texts = dump.texts ?? [];
  const full = texts.includes(EXPECT_TEXT);
  record('慢流收尾（全文出现在界面上）', full, full ? EXPECT_TEXT : `界面上没有 ${EXPECT_TEXT}`);
  record('截图 · 慢流终帧', s.ok, s.detail);
}

// ─────────────────────────────────────────────────────────────
// ⑩ 三判断：真的连上了 / 终态恰好一个（含两条断流）/ abort 有效
//
// ⚠️ 应用**不自己宣布成功**（那不算证据）：它只把观察到的原始数字打出来，
//    判定留在这里 —— 与 T12 / T13 同一口径。帧解析的细粒度断言仍然只在
//    `scripts/verify-core-sse.mjs`，这里不抄第三套。
//
// 判定逻辑本身在 `parse-ohos-selfcheck.mjs`（纯函数）：抽出去是为了让它在
// **没有真机**的时候也能被合成行驱动 —— 否则「期望表有没有鉴别力」无从证明。
// ─────────────────────────────────────────────────────────────

{
  const found = centerOf('自检·跑判定');
  if (found.center === undefined) {
    record('点击「自检·跑判定」', false, `${found.error} —— 拒绝静默跳过`);
  } else {
    hdc(['shell', `uinput -T -c ${found.center.x} ${found.center.y}`]);

    // 有界等待：等 `DONE` 那一行出现，别靠"睡够久应该就好了"
    let lines = [];
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      await sleep(2000);
      const dump = dumpTexts();
      if (dump.texts === undefined) continue;
      lines = dump.texts.filter((t) => t.startsWith('[SELFCHECK]'));
      if (lines.some((l) => l.includes('DONE runs='))) break;
    }
    evidence.selfcheckLines = lines;

    const verdictShot = shot('ohos-shell-selfcheck-verdict');
    record('截图 · 判定结果行', verdictShot.ok, verdictShot.detail);

    // 判定层是纯函数（`parse-ohos-selfcheck.mjs`）：这里只负责把行喂进去、
    // 把判定结果 record 出来。`自检跑完` 那一条也由它给（没有 DONE 行就是失败）。
    const judged = judgeSelfcheck(lines, EXPECT_TEXT);
    for (const v of judged.verdicts) record(v.name, v.ok, v.detail);
    evidence.peer = judged.peer;
    evidence.verdicts = judged.verdicts;
  }
}

// ⑪ 会话仓储一致性 —— 同一份 core 用例（22 条）跑在 relationalStore 上
//
// 这一趟证明的是"端口语义在三端一致"里最硬的一条：用例是**同一份代码**，
// 只是后端换了。判定层仍是纯函数（`judgeRepo`），这里只负责点击、抓行、record。
// `minCases` 从 core 的 `CONFORMANCE_CASE_COUNT` 取 —— 用例数只有一个真源。
// ─────────────────────────────────────────────────────────────
{
  const found = centerOf('自检·仓储');
  if (found.center === undefined) {
    record('点击「自检·仓储」', false, `${found.error} —— 拒绝静默跳过`);
  } else {
    hdc(['shell', `uinput -T -c ${found.center.x} ${found.center.y}`]);

    let lines = [];
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      await sleep(1500);
      const dump = dumpTexts();
      if (dump.texts === undefined) continue;
      lines = dump.texts.filter((t) => t.startsWith('[SELFCHECK] repo'));
      if (lines.some((l) => l.includes('repo total='))) break;
    }
    evidence.repoLines = lines;

    const repoShot = shot('ohos-shell-selfcheck-repo');
    record('截图 · 仓储一致性', repoShot.ok, repoShot.detail);

    const judged = judgeRepo(lines, core.CONFORMANCE_CASE_COUNT);
    evidence.repoVerdicts = judged.verdicts;
    for (const v of judged.verdicts) record(v.name, v.ok, v.detail);
  }
}
} else {
  // ─────────────────────────────────────────────────────────────
  // ⑦ 主链路：**共享 UI 装进 ArkWeb**（P3 之后这是产品形态）
  //
  // 与旧链路的根本差别：界面在 WebView 里，`dumpLayout` 只能看到一个 `Web` 节点 ——
  // 点不到 DOM 子控件。所以**点击与断言都搬进页面**（`@crossdeck/ui` 的 `runUiProbe`），
  // 设备侧只做三件事：起（`--ps selfcheck 1`）→ 读 hilog → 判定。
  //
  // 只起一趟：自检自己会走完"登录 → 建会话 → 删会话 → 聊天 → 切页签 →
  // 授权目录 → 越界 → 上传被拒"，整条业务链一次覆盖。
  // ─────────────────────────────────────────────────────────────
  const bundleIndex = join(PKG, 'entry', 'src', 'main', 'resources', 'rawfile', 'app', 'index.html');
  if (!existsSync(bundleIndex)) {
    console.error(`❌ 缺少 ${bundleIndex} —— 先跑 \`pnpm build:ohos-web\``);
    console.error('   产物不入库（gitignore）；少了它应用会**白屏而不是构建失败**。');
    evidence.skipped = 'ohos-bundle-missing';
    writeFileSync(join(EVIDENCE, 'ohos-selfcheck.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    process.exit(2);
  }
  record('共享 UI 产物', true, `${(readFileSync(bundleIndex).length / 1024).toFixed(1)} KB index.html`);

  /**
   * 读设备侧 hilog。
   *
   * 先 `hilog -r` 清缓冲再起应用 —— 不清的话"上一轮的 DONE 行"会被当成本轮的结论，
   * 而症状是**看起来每次都通过**。
   */
  const readHilog = () => (hdc(['shell', 'hilog -x']).stdout ?? '').split('\n');

  /** 有界等待：等某类行出现，别靠"睡够久应该就好了"。 */
  const waitHilog = async (needle, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    let out = readHilog();
    while (Date.now() < deadline) {
      if (out.some((l) => l.includes(needle))) return out;
      await sleep(3000);
      out = readHilog();
    }
    return out;
  };

  hdc(['shell', `aa force-stop ${BUNDLE}`]);
  hdc(['shell', 'hilog -r']);
  const startWeb = hdc([
    'shell',
    `aa start -a ${ABILITY} -b ${BUNDLE} --ps ui web --ps upstreamUrl ${deviceBase} --ps selfcheck 1`,
  ]);
  const webStartOk = (startWeb.stdout ?? '').includes('start ability successfully');
  record('aa start（WebView + 自检）', webStartOk, webStartOk ? deviceBase : (startWeb.stdout ?? '').slice(-200));

  // 页面自检跑完整条业务链（最慢的一步是 20s 的流式收尾）。
  // 「端口已投递」必须**先等**：等完 DONE 再回头查，那行早被 hilog 缓冲轮转冲掉了。
  const portLines = await waitHilog('端口已投递', 60000);
  const portDelivered = portLines.some((l) => l.includes('端口已投递'));
  record(
    '桥接 · 端口投递到页面',
    portDelivered,
    portDelivered ? 'WebMessagePort 已交付' : 'hilog 里没有「端口已投递」—— 多半是白屏',
  );

  let lines = await waitHilog('[selfcheck] DONE', 180000);

  const pageShot = shot('ohos-shell-web');
  record('截图 · 共享 UI', pageShot.ok, pageShot.detail);

  // 仓储一致性由端口在投递后自己跑（22 条用例、独立库），与页面自检并行。
  lines = await waitHilog('repo total=', 90000);
  evidence.hilogLines = lines.filter((l) => l.includes('[SELFCHECK'));

  // hdc 输出行尾是 \r\n：不剥掉，\r 会混进拼接文本（JSON 报 control character）
  // 和 `$` 锚定的正则（repo 汇总行永远解析失败）。判定只吃 `[SELFCHECK…]` 之后的净内容。
  // 哨兵行是小写 `[selfcheck]`，整行保留（parsePageSentinel 自己按正则捞）。
  const appLines = lines
    .filter((l) => l.includes('[SELFCHECK') || l.includes('[selfcheck] DONE'))
    .map((l) => l.replace(/\r$/, ''));
  const uiJudged = judgeUiPage(appLines, EXPECT_TEXT.length);
  evidence.uiVerdicts = uiJudged.verdicts;
  evidence.pageReport = uiJudged.report;
  for (const v of uiJudged.verdicts) record(v.name, v.ok, v.detail);

  const repoJudged = judgeRepo(
    lines
      .filter((l) => l.includes('[SELFCHECK] '))
      .map((l) => l.slice(l.indexOf('[SELFCHECK] ')).replace(/\r$/, '')),
    core.CONFORMANCE_CASE_COUNT,
  );
  evidence.repoVerdicts = repoJudged.verdicts;
  for (const v of repoJudged.verdicts) record(v.name, v.ok, v.detail);

  writeFileSync(join(EVIDENCE, 'ohos-hilog.txt'), `${lines.join('\n')}\n`, 'utf8');
}

// ─────────────────────────────────────────────────────────────
// ⑫ 收尾 + 归档
try {
  // ⚠️ 删除用的是 `hdc fport rm <taskstring>`，不是 `hdc rport rm` ——
  // 后者不是合法命令（第一次写错时它静默失败），残留的反向规则会让后续的映射行为异常。
  hdc(['fport', 'rm', `tcp:${upstreamPort} tcp:${upstreamPort}`]);
} catch {
  /* 尽力而为：rport 没摘干净只是留个映射，不影响判定 */
}
upstream.close();
upstreamServer.closeAllConnections();
upstreamServer.close();

mkdirSync(EVIDENCE, { recursive: true });
evidence.ok = !failed;
evidence.device = device;
evidence.bundle = BUNDLE;
evidence.upstream = {
  base: deviceBase,
  auth: 'token',
  scenarios: Object.keys(NAV_SCENARIO_PROMPTS),
  expectedText: EXPECT_TEXT,
  midStreamText: midText,
};
evidence.chain = LEGACY ? 'legacy-arkui' : 'arkweb-webview';
evidence.screenshots = LEGACY
  ? [
      'ohos-shell.jpg',
      'ohos-shell-stream.jpg',
      'ohos-shell-tool.jpg',
      'ohos-shell-selfcheck-boot.jpg',
      'ohos-shell-selfcheck-midstream.jpg',
      'ohos-shell-selfcheck-done.jpg',
      'ohos-shell-selfcheck-verdict.jpg',
      'ohos-shell-selfcheck-repo.jpg',
    ]
  : ['ohos-shell-web.jpg'];
if (!LEGACY) delete evidence.upstream.midStreamText;
writeFileSync(join(EVIDENCE, 'ohos-selfcheck.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

console.log('────────────────────────────────────────────────');
console.log(failed ? `❌ 失败 ${evidence.failures.length} 项` : '✅ 全部通过');
for (const f of evidence.failures) console.log(`   - ${f}`);
console.log('   证据：docs/evidence/ohos-selfcheck.json');
console.log(`[ohos-selfcheck] DONE ok=${!failed} code=${failed ? 1 : 0}`);
process.exit(failed ? 1 : 0);
