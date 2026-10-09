#!/usr/bin/env node
/**
 * 漂移检测：`shared/{contract,core}` 还是不是 `packages/{contract,core}/src` 的影子？
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要它（两条**无声**的失败路径）
 * ══════════════════════════════════════════════════════════════════
 *
 * 鸿蒙工程消费 core 的方式是「构建期复制源码」（见 shell-ohos/scripts/sync-shared.mjs）：
 * `shared/{contract,core}` 是**生成产物、已 gitignore**。于是有两条静默失败：
 *
 *   1. `pnpm verify`（主链）不含 ohos → 改了 core，**没有任何人管副本**；
 *   2. hvigor / DevEco 构建**不触发** sync —— `hvigorfile.ts` 里只有
 *      `appTasks` / `hapTasks`，没有 preBuild hook → 在 DevEco 里点运行，
 *      跑的是**旧副本**。
 *
 * 两种情况 `git status` 都是干净的（副本被 ignore），所以漂移完全无声：
 * 界面上的表现只是「行为不对」，排查会先怀疑 core 而不是副本。
 *
 * 本脚本把「无声」变成「当场红」：把 planSync() 算出的期望与磁盘现状逐字节比。
 *
 * ══════════════════════════════════════════════════════════════════
 * 与 sync-shared.mjs 的关系：**只共用一份计算**
 * ══════════════════════════════════════════════════════════════════
 *
 * 两边都调 `syncShared.mjs` 的 `planSync()`。检测脚本**绝不**自己再算一遍
 * 「期望内容」—— 否则两把尺子会各自腐烂，而其中一把是拿来量腐烂的。
 *
 * ══════════════════════════════════════════════════════════════════
 * skip 语义（重要，别改成「不存在就报错」）
 * ══════════════════════════════════════════════════════════════════
 *
 * `shared/{contract,core}` **都不存在** → 跳过，退出码 **0**。
 *   理由：没同步过就没有副本，也就没有「漂移」这回事（此时工程直接 import
 *   失败，比静默更响亮）。而主链 `pnpm verify` 不该强求每个人都装 DevEco。
 * 任一存在 → **严格比对**：少一个文件、多一个文件、内容差一个字节都算不一致。
 *   （半同步是最坏的状态 —— 工程能 import 一部分，看着像好的。）
 *
 * ══════════════════════════════════════════════════════════════════
 * 零依赖、无子进程
 * ══════════════════════════════════════════════════════════════════
 *
 * 只用 node:fs / node:path —— 本机沙箱下用 pipe 派生子进程必 EBUSY（见计划 §2），
 * 所以不动 `spawnSync(node sync-shared.mjs --out tmp)` 那种写法，直接 import 计算。
 *
 * ══════════════════════════════════════════════════════════════════
 * 变异测试记录（确认这些断言有鉴别力）
 * ══════════════════════════════════════════════════════════════════
 *
 * 本脚本的「被测量物」是 `shared/` 与源的一致性，所以变异打在**被检测的对象**上
 * （副本 / 源 / 共享的改写逻辑），而不是打在本文件里 —— 打在本文件里只能证明
 * 「分支能跑到」，证明不了「差异能被发现」。每次跑前先 `pnpm sync:ohos` 回到基线。
 *
 * | 变异                                                     | 预期   | 实测                        |
 * |--------------------------------------------------------|------|---------------------------|
 * | V0 基线（一致）                                             | 绿    | exit=0，0 差异               |
 * | V1 副本改一行（`shared/core/index.ts` 追加 `// MUT`）           | 红    | exit=1，内容不同 1（index.ts）  |
 * | V2 副本删一个（`shared/core/errorMessage.ts`）               | 红    | exit=1，缺失 1               |
 * | V3 副本多一个（塞 `__stray__.ts`）                            | 红    | exit=1，多余 1               |
 * | V4 **源**改一行、没同步（真实漂移场景）                           | 红    | exit=1，内容不同 1（index.ts）  |
 * | V5 共享计算被改坏（`planTarget` 里深度写死 0）                   | 红    | exit=1，内容不同 **7**（改写过的全部）|
 * | V6 半同步（只移走 `contract/`）→ 最坏的状态                     | 红    | exit=1，缺失 12              |
 * | V7 全未同步（两个都移走）                                      | skip | exit=0，打印「跳过」           |
 *
 * V3 与 V5 是两条最值钱的：
 *   · V3 证明「只检查计划里的文件是否都在」**不够** —— 那样会漏掉被手工塞进来的文件；
 *   · V5 证明检测**确实在走同一份 planSync()** —— 若它自己另算一份「期望」，
 *     改坏共享计算时它就跟不上，V5 会漏报。
 *
 * 另有一条等价性证明（不属于变异，但每次重写 sync-shared.mjs 都该重做）：
 *   制造落后态 → 分别用**旧版**与**新版** sync 收敛 → 产物快照逐字节比对。
 *   实测 33 个文件全部一致 ⇒ 「把计算抽成 syncShared.mjs」是纯重构、行为不变。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { SHARED_DIR, planSync } from '../packages/shell-ohos/scripts/syncShared.mjs';

const TARGET_NAMES = ['contract', 'core'];

/** 递归列出目录下所有文件，返回 POSIX 相对路径（与 plan 的 `rel` 同构）。 */
function listFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/** 差异摘要：多于 6 项时只列前 6 项，避免刷屏。 */
function brief(list) {
  return list.length <= 6 ? list.join('、') : `${list.slice(0, 6).join('、')} …`;
}

console.log('── shared/ 漂移检测 ────────────────────────────');

const present = TARGET_NAMES.filter((name) => existsSync(join(SHARED_DIR, name)));

if (present.length === 0) {
  console.log('  ⏭  shared/{contract,core} 都不存在 → 跳过');
  console.log('     没同步过就没有副本可漂移（此时工程 import 会直接失败，比静默更响亮）。');
  console.log('     要用鸿蒙壳：先 `pnpm sync:ohos`。');
  console.log('──────────────────────────────────────────────────────');
  console.log('✅ verify-shared-fresh：跳过（尚未同步过鸿蒙副本）');
  process.exit(0);
}

let plan;
try {
  plan = planSync();
} catch (err) {
  console.error(`❌ 无法计算期望内容：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

/** 每一类差异一行，供收尾汇总。 */
const problems = [];

for (const target of plan) {
  const expected = new Map(target.files.map((file) => [file.rel, file.content]));
  const actualRels = existsSync(target.destDir) ? listFiles(target.destDir) : [];
  const actual = new Map(
    actualRels.map((rel) => [rel, readFileSync(join(target.destDir, rel), 'utf8')]),
  );

  const missing = [];
  const stale = [];
  for (const [rel, content] of expected) {
    if (!actual.has(rel)) missing.push(rel);
    else if (actual.get(rel) !== content) stale.push(rel);
  }
  const extra = actualRels.filter((rel) => !expected.has(rel));

  if (missing.length === 0 && stale.length === 0 && extra.length === 0) {
    console.log(`  ${target.label.padEnd(9)} ${String(expected.size).padStart(2)} 个文件 → 一致`);
    continue;
  }

  console.log(
    `  ${target.label.padEnd(9)} ${String(expected.size).padStart(2)} 个文件 → ❌ 不一致` +
      `（缺失 ${missing.length} / 内容不同 ${stale.length} / 多余 ${extra.length}）`,
  );
  const at = `shared/${target.label}`;
  if (missing.length > 0) problems.push(`${at} 缺失 ${missing.length} 个：${brief(missing)}`);
  if (stale.length > 0) problems.push(`${at} 内容不同 ${stale.length} 个：${brief(stale)}`);
  if (extra.length > 0) problems.push(`${at} 多余 ${extra.length} 个：${brief(extra)}`);
}

console.log('──────────────────────────────────────────────────────');

if (problems.length > 0) {
  console.log(`❌ verify-shared-fresh：shared/ 已与 packages/{contract,core}/src 漂移`);
  for (const line of problems) console.log(`   - ${line}`);
  console.log('');
  console.log('   跑 `pnpm sync:ohos` 重新生成。');
  console.log('   ⚠️ shared/{contract,core} 是**只读副本**：直接改它们会被下次同步覆盖；');
  console.log('      要改就改 packages/{contract,core}/src，再同步。');
  process.exit(1);
}

const total = plan.reduce((sum, target) => sum + target.files.length, 0);
console.log(`✅ verify-shared-fresh：shared/ 与源一致（${total} 个文件）🎉`);
process.exit(0);
