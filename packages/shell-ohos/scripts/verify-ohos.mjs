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
 * 三种"跑不了"被严格区分，且**都返回非零**，但报告里的字段不同
 * （`skipped` 而非 `ok`）—— 这与 Electron 壳自检里"未打包形态必须报 error
 * 而不是永远转圈"是同一条原则：
 *   · 工具链缺失（找不到 hvigorw / hdc）
 *   · 设备不在线（`hdc list targets` 为空）
 *   · 编译或安装失败
 *
 * ## 为什么点击坐标是**动态取**的
 *
 * 第一版我按截图像素估坐标，结果点了个空 —— 截图里 72580 字节的"没变化"
 * 看起来像"点了但没反应"，实际是根本没点中。改成先用 `uitest dumpLayout`
 * 拿控件的真实 `bounds`，从 UI 树算中心点。UI 改版时它会自己跟上。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * 同步等一会儿。刻意用 `Atomics.wait` 而不是 `spawnSync(node -e setTimeout)` ——
 * 后者每次要多起一个 Node 进程，而且失败时只留下一句看不懂的 die 信息。
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function hdc(args, opts = {}) {
  return spawnSync(HDC, args, { encoding: 'utf8', cwd: opts.cwd ?? REPO, maxBuffer: 32 * 1024 * 1024 });
}

console.log('── 鸿蒙壳端到端验证 ────────────────────────────');

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
const targets = hdc(['list', 'targets']).stdout.trim();
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
  record('同步 contract/core', false, sync.stderr?.slice(-300) ?? 'unknown');
  process.exit(1);
}
record('同步 contract/core', true, sync.stdout.trim().split('\n').slice(-1)[0] ?? '');

// ④ 编译
const build = run(HVIGOR, ['assembleHap', '--no-daemon'], { shell: true });
const buildOk = build.status === 0 && (build.stdout ?? '').includes('BUILD SUCCESSFUL');
record('hvigorw assembleHap', buildOk, buildOk ? 'BUILD SUCCESSFUL' : (build.stdout ?? build.stderr ?? '').slice(-400));

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

// ⑥ 启动
hdc(['shell', `aa force-stop ${BUNDLE}`]);
const start = hdc(['shell', `aa start -a ${ABILITY} -b ${BUNDLE}`]);
const startOk = (start.stdout ?? '').includes('start ability successfully');
record('aa start', startOk, startOk ? 'start ability successfully' : (start.stdout ?? '').slice(-200));
sleepSync(6000);

mkdirSync(SHOTS, { recursive: true });

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

const overview = shot('ohos-shell');
record('截图 · 首屏', overview.ok, overview.detail);

/**
 * 从 UI 树里找文本为 `label` 的控件中心点。
 *
 * 返回 `{ center }` 或 `{ error }` —— **两种失败必须可区分**，而且都必须让
 * 调用方报失败，不能悄悄跳过点击：
 *   · 拉不回 UI 树（hdc recv 失败）
 *   · UI 树里有，但没有这个文本的控件
 * 压成同一个 null 会让报告里的原因指向错的那一个。
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
function centerOf(label) {
  const tmp = join(REPO, '.ohos-layout.json');
  rmSync(tmp, { force: true });
  hdc(['shell', 'uitest dumpLayout -p /data/local/tmp/layout.json']);
  const out = hdc(['file', 'recv', '/data/local/tmp/layout.json', '.ohos-layout.json'], { cwd: REPO });
  const combined = `${out.stdout ?? ''}${out.stderr ?? ''}`;
  if (combined.includes('[Fail]')) {
    return { error: `拉不回 UI 树：${combined.trim().slice(-120)}` };
  }
  if (!existsSync(tmp)) return { error: 'hdc recv 没报错但本地也没有 UI 树' };

  let tree;
  try {
    tree = JSON.parse(readFileSync(tmp, 'utf8'));
  } catch (err) {
    return { error: `UI 树不是合法 JSON：${String(err.message).slice(0, 120)}` };
  }

  const boundsStr = findByText(tree, label);
  if (boundsStr === null) return { error: `UI 树里找不到文本为「${label}」的控件` };
  const m = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(boundsStr);
  if (m === null) return { error: `找到了「${label}」但 bounds 解析不出：${boundsStr}` };
  const [, x1, y1, x2, y2] = m.map(Number);
  return { center: { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) } };
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

function clickAndShot(label, name) {
  const found = centerOf(label);
  if (found.center === undefined) {
    record(`点击「${label}」`, false, `${found.error} —— 拒绝静默跳过`);
    return;
  }
  hdc(['shell', `uinput -T -c ${found.center.x} ${found.center.y}`]);
  sleepSync(7000);
  const s = shot(name);
  record(`点击「${label}」→ ${name}.jpg`, s.ok, s.detail);
}

clickAndShot('发送', 'ohos-shell-stream');
clickAndShot('带工具', 'ohos-shell-tool');

// ⑦ 归档
mkdirSync(EVIDENCE, { recursive: true });
evidence.ok = !failed;
evidence.device = device;
evidence.bundle = BUNDLE;
evidence.screenshots = ['ohos-shell.jpg', 'ohos-shell-stream.jpg', 'ohos-shell-tool.jpg'];
writeFileSync(join(EVIDENCE, 'ohos-selfcheck.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

console.log('────────────────────────────────────────────────');
console.log(failed ? `❌ 失败 ${evidence.failures.length} 项` : '✅ 全部通过');
for (const f of evidence.failures) console.log(`   - ${f}`);
console.log('   证据：docs/evidence/ohos-selfcheck.json');
console.log(`[ohos-selfcheck] DONE ok=${!failed} code=${failed ? 1 : 0}`);
process.exit(failed ? 1 : 0);
