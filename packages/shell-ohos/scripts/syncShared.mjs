/**
 * `sync-shared` 的**纯计算**部分 —— 被两个调用方共用：
 *
 *   1. `packages/shell-ohos/scripts/sync-shared.mjs`  —— 把计划**写进** shared/（真正的同步）
 *   2. `scripts/verify-shared-fresh.mjs`（仓库根）    —— 把计划与磁盘现状**比对**（漂移检测）
 *
 * ⚠️ 检测脚本**必须**复用这里的 `planSync()`。
 *    若两边各算一份「期望内容」，检测脚本自己就会漂移 ——
 *    那等于拿一把会腐烂的尺子去量另一把会不会腐烂。
 *
 * `planSync()` 返回的 `content` 已经是**最终落盘内容**（含裸包名改写），
 * 调用方拿去写盘或比对即可，不需要再加工。
 *
 * 背景（为什么是「复制」而不是「依赖」）见 sync-shared.mjs 头部。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const REPO = join(PKG, '..', '..');

/** 鸿蒙工程包的根（打印相对路径用）。 */
export const PKG_DIR = PKG;

/** 生成产物的落点，也是漂移检测的比对基准。 */
export const SHARED_DIR = join(PKG, 'entry', 'src', 'main', 'ets', 'shared');

/** 单一事实源。 */
export const SOURCE_DIRS = {
  contract: join(REPO, 'packages', 'contract', 'src'),
  core: join(REPO, 'packages', 'core', 'src'),
};

/** 递归收集所有 .ts 文件（core 有子目录）。 */
function collectTs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...collectTs(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * 把裸包名改写成相对路径。
 *
 * `from '@crossdeck/contract'` 出现在 core 的每个文件里（且一律是 `import type`，
 * 与 core「对 contract 零运行时依赖」的约定一致）。
 * 目标深度按当前文件在 shared/ 下的层级算：
 *   shared/core/index.ts         → ../contract/index
 *   shared/core/agent/runtime.ts → ../../contract/index
 *
 * 显式补 `/index`：ArkTS 的模块解析不认目录（不会自动找 index）。
 */
function rewriteSpecifiers(source, relDepth) {
  const specifier = `${'../'.repeat(relDepth)}contract/index`;
  return source.replace(/(from\s+')(@crossdeck\/contract)(')/g, `$1${specifier}$3`);
}

/** 算一个目标目录的同步计划（**不落盘**）。 */
function planTarget(label, srcDir, destDir) {
  let stat;
  try {
    stat = statSync(srcDir);
  } catch {
    throw new Error(`找不到源目录：${srcDir}`);
  }
  if (!stat.isDirectory()) throw new Error(`源不是目录：${srcDir}`);

  let rewritten = 0;
  const files = [];
  for (const file of collectTs(srcDir)) {
    // 统一成 POSIX 分隔符：既便于打印，也让期望值与磁盘遍历结果可比对。
    const rel = relative(srcDir, file).split(sep).join('/');
    const dest = join(destDir, rel);
    // 从 destDir 出发，回到 shared/ 需要几层
    const depthFromShared = relative(SHARED_DIR, dirname(dest)).split(sep).length;
    const original = readFileSync(file, 'utf8');
    const content = rewriteSpecifiers(original, depthFromShared);
    if (content !== original) rewritten += 1;
    files.push({ rel, dest, content });
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : 1));
  return { label, srcDir, destDir, files, rewritten };
}

/** 两个目标（contract / core）的完整同步计划。 */
export function planSync() {
  return [
    planTarget('contract', SOURCE_DIRS.contract, join(SHARED_DIR, 'contract')),
    planTarget('core', SOURCE_DIRS.core, join(SHARED_DIR, 'core')),
  ];
}
