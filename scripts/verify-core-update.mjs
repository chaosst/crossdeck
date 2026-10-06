#!/usr/bin/env node
/**
 * Core 更新决策的验收 —— 版本比较与"该不该升级"的判定。
 *
 * 为什么这段逻辑值得单独抽到 core 并单测：
 *
 *   它的失败方式全是**静默**的。版本比较写错不会崩，只会：
 *     · 把 1.10.0 判成比 1.9.0 旧（字符串比较的经典坑）→ 用户永远收不到更新
 *     · 把 1.0.0-beta.1 当成正式版推给已装 1.0.0 的用户 → 反而降级
 *     · 把 1.0.0+20260101 判成比 1.0.0 新 → 每轮检查都提示"有新版本"
 *     · 允许降级 → 被劫持的 feed 可以把用户"更新"回一个含漏洞的旧版
 *   这四种都不会报错，只会表现为「更新功能好像有点怪」。
 *
 * 而它又是纯逻辑：没有网络、没有文件系统、没有 electron —— 所以它可以被
 * 完全确定地验证。平台那半（真正的下载与安装）留在壳里，见 updater.ts。
 *
 * 零依赖、无子进程：直接加载 core 的编译产物（packages/core/dist/index.js）。
 */

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE_DIST = join(ROOT, 'packages', 'core', 'dist', 'index.js');

let core;
try {
  core = await import(pathToFileURL(CORE_DIST).href);
} catch (err) {
  console.error(`❌ 无法加载 core 编译产物：${CORE_DIST}`);
  console.error('   先跑 `pnpm typecheck` 生成 dist/ 再执行本脚本。');
  console.error(`   ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const { parseVersion, compareVersions, decideUpdate } = core;

for (const [name, fn] of Object.entries({ parseVersion, compareVersions, decideUpdate })) {
  if (typeof fn !== 'function') {
    console.error(`❌ core 没有导出 ${name} —— 更新决策逻辑尚未实现。`);
    process.exit(1);
  }
}

let passed = 0;
const failures = [];
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failures.push(`${name}${detail === undefined ? '' : ` （实际：${JSON.stringify(detail)}）`}`);
    console.log(`  ❌ ${name}${detail === undefined ? '' : `\n       实际：${JSON.stringify(detail)}`}`);
  }
}

const gt = (a, b) => compareVersions(parseVersion(a), parseVersion(b)) > 0;

// ─────────────────────────────────────────────────────────────
console.log('── ① 解析 ──────────────────────────────────────────');
{
  const p = parseVersion('1.2.3');
  check('基础三段', p !== null && p.major === 1 && p.minor === 2 && p.patch === 3, p);

  const v = parseVersion('v1.2.3');
  check('容忍 v 前缀（feed 里两种写法都有）', v !== null && v.major === 1, v);

  const pre = parseVersion('1.2.3-beta.2');
  check('保留 prerelease 段', pre !== null && pre.prerelease.join('.') === 'beta.2', pre);

  const build = parseVersion('1.2.3+build.99');
  check('保留 build metadata', build !== null && build.build === 'build.99', build);

  check('空缺段补 0（1.2 → 1.2.0）', parseVersion('1.2')?.patch === 0, parseVersion('1.2'));
  check('空串不合法', parseVersion('') === null);
  check('非版本串不合法', parseVersion('latest') === null);
  check('超长段不合法', parseVersion('1.2.3.4.5') === null);
  check('负数不合法', parseVersion('1.-2.3') === null);
  check('前导零不合法（1.02.3）', parseVersion('1.02.3') === null);
}

// ─────────────────────────────────────────────────────────────
console.log('\n── ② 比较：数值语义（不是字符串语义）───────────────');
{
  // 这一条是整个模块存在的第一理由：字符串比较会得到相反结论
  check('1.10.0 > 1.9.0（数值比较，不是字符串比较）', gt('1.10.0', '1.9.0'), '1.10.0 vs 1.9.0');
  check('1.9.0 不大于 1.10.0', !gt('1.9.0', '1.10.0'));
  check('2.0.0 > 1.99.99', gt('2.0.0', '1.99.99'));
  check('1.0.1 > 1.0.0', gt('1.0.1', '1.0.0'));
  check('相等返回 0', compareVersions(parseVersion('1.2.3'), parseVersion('v1.2.3')) === 0);
}

// ─────────────────────────────────────────────────────────────
console.log('\n── ③ 比较：prerelease 语义（语义化版本最容易写错的一段）──');
{
  check('1.0.0-beta.1 < 1.0.0（预发布低于同号正式版）', gt('1.0.0', '1.0.0-beta.1'), '1.0.0 vs 1.0.0-beta.1');
  check('1.0.0-beta.1 不大于 1.0.0', !gt('1.0.0-beta.1', '1.0.0'));
  check('1.0.0-beta.2 > 1.0.0-beta.1', gt('1.0.0-beta.2', '1.0.0-beta.1'));
  check('1.0.0-alpha < 1.0.0-beta（字母序）', gt('1.0.0-beta', '1.0.0-alpha'));
  check('1.0.0-rc.1 > 1.0.0-beta.999', gt('1.0.0-rc.1', '1.0.0-beta.999'), 'rc 按字母序大于 beta');
  check('数值段按数值比：beta.10 > beta.9', gt('1.0.0-beta.10', '1.0.0-beta.9'));
  check('纯数值标识符按数值比：2 < 10', gt('1.0.0-10', '1.0.0-2'), '字符串比较会得出相反结论');
  // 这一条是变异测试补出来的：把 `xNum ? -1 : 1` 反转后，只有它挂。
  // 原始断言集里没有任何一条覆盖"数字标识符 < 字母标识符"，说明这个方向漏了。
  check('数字标识符 < 字母标识符：1 < alpha', gt('1.0.0-alpha', '1.0.0-1'), 'SemVer §11.4.3');
  check('反过来：alpha 不大于……而是大于 1', !gt('1.0.0-1', '1.0.0-alpha'), 'SemVer §11.4.3');
  check('预发布段多者更大：beta.1 < beta.1.1', gt('1.0.0-beta.1.1', '1.0.0-beta.1'));
  check('1.1.0-beta > 1.0.0（主版本段优先于预发布）', gt('1.1.0-beta', '1.0.0'));
}

// ─────────────────────────────────────────────────────────────
console.log('\n── ④ 比较：build metadata 不参与（SemVer 规定）────');
{
  check(
    '1.0.0+a 与 1.0.0+b 相等（否则每轮检查都提示"有新版本"）',
    compareVersions(parseVersion('1.0.0+a'), parseVersion('1.0.0+b')) === 0,
  );
  check('1.0.0+99 与 1.0.0 相等', compareVersions(parseVersion('1.0.0+99'), parseVersion('1.0.0')) === 0);
}

// ─────────────────────────────────────────────────────────────
console.log('\n── ⑤ 决策：该不该升 ────────────────────────────────');
{
  const up = decideUpdate('1.0.0', '1.1.0');
  check('候选更新 → update', up.kind === 'update' && up.to === '1.1.0', up);

  const same = decideUpdate('1.1.0', '1.1.0');
  check('相同版本 → up-to-date', same.kind === 'up-to-date', same);

  const sameV = decideUpdate('1.1.0', 'v1.1.0');
  check('v 前缀不影响判定', sameV.kind === 'up-to-date', sameV);

  // 降级默认必须拒绝：被劫持的 feed 可以把用户"更新"回含漏洞的旧版
  const down = decideUpdate('2.0.0', '1.9.0');
  check('候选更旧 → downgrade-refused（默认拒绝）', down.kind === 'downgrade-refused', down);

  const forced = decideUpdate('2.0.0', '1.9.0', { allowDowngrade: true });
  check('显式允许时才降级', forced.kind === 'update' && forced.to === '1.9.0', forced);

  const badCurrent = decideUpdate('not-a-version', '1.0.0');
  check('当前版本非法 → invalid(current)', badCurrent.kind === 'invalid' && badCurrent.reason === 'current', badCurrent);

  const badCandidate = decideUpdate('1.0.0', 'latest');
  check('候选版本非法 → invalid(candidate)', badCandidate.kind === 'invalid' && badCandidate.reason === 'candidate', badCandidate);
}

// ─────────────────────────────────────────────────────────────
console.log('\n── ⑥ 决策：预发布策略（默认不该把 beta 推给正式用户）──');
{
  const toBeta = decideUpdate('1.0.0', '1.1.0-beta.1');
  check('默认不把预发布当升级', toBeta.kind === 'up-to-date', toBeta);

  const optIn = decideUpdate('1.0.0', '1.1.0-beta.1', { allowPrerelease: true });
  check('显式开启后才接受预发布', optIn.kind === 'update', optIn);

  // 已经在预发布通道的用户，应当能继续收到预发布
  const betaToBeta = decideUpdate('1.1.0-beta.1', '1.1.0-beta.2', { allowPrerelease: true });
  check('预发布通道内可继续前进', betaToBeta.kind === 'update', betaToBeta);

  // 从预发布"毕业"到正式版：即使用户没开 allowPrerelease 也该收到
  const graduate = decideUpdate('1.1.0-beta.2', '1.1.0');
  check('预发布 → 同号正式版，即使没开开关也要升（"毕业"不能被挡住）', graduate.kind === 'update', graduate);

  const betaDown = decideUpdate('1.1.0-beta.2', '1.1.0-beta.1');
  check('预发布之间降级照样拒绝', betaDown.kind === 'downgrade-refused', betaDown);
}

// ─────────────────────────────────────────────────────────────
console.log('\n── ⑦ 决策：返回值形状必须可判别 ────────────────────');
{
  // 判别联合，而不是 {shouldUpdate: boolean, reason?: string} ——
  // 后者会让调用方忘记处理 downgrade / invalid 这两种情况，
  // 而它们恰恰是"要如实告诉用户"的两种。
  const kinds = new Set(
    ['up-to-date', 'update', 'downgrade-refused', 'invalid'].map((k) => k),
  );
  const observed = new Set(
    [
      decideUpdate('1.0.0', '1.0.0'),
      decideUpdate('1.0.0', '2.0.0'),
      decideUpdate('2.0.0', '1.0.0'),
      decideUpdate('x', 'y'),
    ].map((d) => d.kind),
  );
  check('四种结果都能被区分出来', [...kinds].every((k) => observed.has(k)), [...observed]);

  const up = decideUpdate('1.0.0', '1.1.0');
  check('update 分支带 from / to（日志与 UI 都要用）', up.from === '1.0.0' && up.to === '1.1.0', up);
}

// ─────────────────────────────────────────────────────────────
console.log('\n── ⑧ 进度：规范化掉"说不清哪里不对"的三种回退 ────────');
{
  const { nextProgress, INITIAL_PROGRESS, isProgressComplete } = core;

  if (typeof nextProgress !== 'function' || typeof INITIAL_PROGRESS !== 'object') {
    failures.push('core 没有导出 nextProgress / INITIAL_PROGRESS —— 进度追踪器尚未实现');
  } else {
    // 正常序列：单调上升
    let s = INITIAL_PROGRESS;
    check('起始状态：无版本、0%、0 异常', s.version === null && s.percent === 0 && s.anomalies === 0, s);

    s = nextProgress(s, { version: '1.2.0', percent: 12.7 });
    check('浮点进度取下整（12.7 → 12，UI 不需要自己 floor）', s.percent === 12, s);
    s = nextProgress(s, { version: '1.2.0', percent: 48.2 });
    s = nextProgress(s, { version: '1.2.0', percent: 100 });
    check('正常序列走完后到 100', s.percent === 100 && isProgressComplete(s), s);
    check('正常序列**不**产生异常计数', s.anomalies === 0, s);

    // ① 回退：percent 往回走（chunk 重试）
    let back = nextProgress(INITIAL_PROGRESS, { version: '1.2.0', percent: 80 });
    back = nextProgress(back, { version: '1.2.0', percent: 35 });
    check('进度回退时**保持**已到达的最大值（不跟着往回跳）', back.percent === 80, back);
    check('回退会被记成一次异常（上游不可信的观测信号）', back.anomalies === 1, back);

    // ② 换版本：必须归零重来
    const switched = nextProgress(
      { version: '1.2.0', percent: 87, anomalies: 0 },
      { version: '1.4.0', percent: 3 },
    );
    check('换版本后进度归零重来（否则新版会卡在 99% 不动）', switched.percent === 3, switched);
    check('换版本本身不算异常（那是正常流程）', switched.anomalies === 0, switched);

    // v 前缀不算换版本 —— 归一化后是同一个版本。
    // ⚠️ 这里刻意把百分比**调低**：如果拿"往上涨"的序列来测，
    //    归一化与否的结果都是 45，断言根本分不出对错（这组变异第一次就是
    //    这样存活下来的）。只有"往回走"的输入才能把两条路分开：
    //    归一化 → 保持 90；没归一化 → 误判成换版本，打回 20。
    const prefixed = nextProgress(
      { version: '1.2.0', percent: 90, anomalies: 0 },
      { version: 'v1.2.0', percent: 20 },
    );
    check(
      '`v1.2.0` 与 `1.2.0` 视为同一版本（误判成"换版本"会把进度打回 20）',
      prefixed.percent === 90,
      prefixed,
    );
    check('归一化后走的是"回退"分支，因此记一笔异常', prefixed.anomalies === 1, prefixed);

    // ③ 越界：上游在说谎
    const over = nextProgress(INITIAL_PROGRESS, { version: '1.2.0', percent: 130 });
    check('>100 夹到 100', over.percent === 100, over);
    check('越界记一笔异常', over.anomalies === 1, over);
    const under = nextProgress(INITIAL_PROGRESS, { version: '1.2.0', percent: -5 });
    check('<0 夹到 0（不是负数）', under.percent === 0, under);

    // ④ NaN / Infinity：绝不能进状态
    // 一旦 max(NaN, x) 写进状态，进度条**从此永不更新** —— 这是本函数
    // 唯一一行"防御性"代码存在的原因。
    const nan = nextProgress({ version: '1.2.0', percent: 60, anomalies: 0 }, { version: '1.2.0', percent: Number.NaN });
    check('NaN 不污染状态（保持原值，而不是变成 NaN）', nan.percent === 60, nan);
    check('NaN 记一笔异常', nan.anomalies === 1, nan);
    const inf = nextProgress({ version: '1.2.0', percent: 60, anomalies: 0 }, { version: '1.2.0', percent: Number.POSITIVE_INFINITY });
    check('Infinity 不污染状态', Number.isFinite(inf.percent) && inf.percent === 60, inf);

    // 换版本时若首帧就是 NaN：应当归零，且不把旧版本的百分比带过去
    const switchedNaN = nextProgress({ version: '1.2.0', percent: 90, anomalies: 2 }, { version: '1.4.0', percent: Number.NaN });
    check('换版本 + NaN：归零，且保留历史异常计数', switchedNaN.percent === 0 && switchedNaN.anomalies === 3, switchedNaN);
  }
}

// ─────────────────────────────────────────────────────────────
console.log('\n──────────────────────────────────────────────────────');
if (failures.length > 0) {
  console.log(`❌ ${failures.length} 条断言失败：`);
  for (const f of failures) console.log(`   - ${f}`);
} else {
  console.log(`✅ 全部 ${passed} 条断言通过 — 更新决策是纯逻辑，因此可被完全确定地验证 🎉`);
  console.log('   （不涉及网络 / 文件系统 / electron：那半边在壳里，见 updater.ts）');
}
process.exit(failures.length === 0 ? 0 : 1);
