#!/usr/bin/env node
/**
 * 把 `packages/contract` 与 `packages/core` 的源码同步进鸿蒙工程。
 *
 * ## 为什么需要这一步（这是 M6-0 spike 的直接结论）
 *
 * 鸿蒙工程**能**消费 contract/core，但只有一个前提：**必须以 `.ts` 形态**。
 * 同一份 `types.ts` 内容改成 `.ets` 后，ArkTS 立刻拒绝：
 *
 *   arkts-no-conditional-types  Conditional types are not supported
 *   arkts-no-aliases-by-index   Indexed access types are not supported
 *
 * 而 ArkTS 工程对 `.ts` 文件走的是 TypeScript 规则（宽松），所以类型体操能活。
 * 反例留档在 `spike/ets-rejects-conditional-types.ets.txt`。
 *
 * ## 为什么是「复制」而不是「依赖」
 *
 * ArkTS 工程（hvigor）不吃 pnpm workspace 的裸包名 `@crossdeck/contract`，
 * 它的模块解析器只认相对路径与 ohpm 依赖。所以这里做一次**构建期复制 + 路径改写**：
 *
 *   - 单一事实源仍在 `packages/contract`、`packages/core` —— 这个脚本不产出内容，只搬运
 *   - `@crossdeck/contract` → 按文件深度算出的相对路径
 *   - 产物目录整体重建，避免删文件后留下孤儿
 *
 * 换句话说：这个脚本是「一套 core 多端壳」在鸿蒙端的**接缝**，
 * 接缝必须是显式的、可复现的 —— 而不是手工复制出一份会悄悄腐烂的副本。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const REPO = join(PKG, '..', '..');
const SHARED = join(PKG, 'entry', 'src', 'main', 'ets', 'shared');

const CONTRACT_SRC = join(REPO, 'packages', 'contract', 'src');
const CORE_SRC = join(REPO, 'packages', 'core', 'src');

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
 * 与 core 「对 contract 零运行时依赖」的约定一致）。
 * 目标深度按当前文件在 shared/ 下的层级算：
 *   shared/core/index.ts        → ../contract/index
 *   shared/core/agent/runtime.ts → ../../contract/index
 *
 * 显式补 `/index`：ArkTS 的模块解析不认目录（不会自动找 index）。
 */
function rewriteSpecifiers(source, relDepth) {
  const specifier = `${'../'.repeat(relDepth)}contract/index`;
  return source.replace(/(from\s+')(@crossdeck\/contract)(')/g, `$1${specifier}$3`);
}

function syncDir(srcDir, destDir, label) {
  const files = collectTs(srcDir);
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });

  let rewritten = 0;
  for (const file of files) {
    const rel = relative(srcDir, file);
    const dest = join(destDir, rel);
    mkdirSync(dirname(dest), { recursive: true });

    const original = readFileSync(file, 'utf8');
    // 从 destDir 出发，回到 shared/ 需要几层
    const depthFromShared = relative(SHARED, dirname(dest)).split(sep).length;
    const next = rewriteSpecifiers(original, depthFromShared);
    if (next !== original) rewritten += 1;
    writeFileSync(dest, next, 'utf8');
  }
  console.log(`  ${label.padEnd(9)} ${String(files.length).padStart(2)} 个文件 → ${relative(PKG, destDir)}`);
  return { files: files.length, rewritten };
}

console.log('── 同步 contract/core 进鸿蒙工程 ──────────────');
if (!existsSync(CONTRACT_SRC) || !existsSync(CORE_SRC)) {
  console.error(`找不到源目录：${CONTRACT_SRC} / ${CORE_SRC}`);
  process.exit(1);
}

const c = syncDir(CONTRACT_SRC, join(SHARED, 'contract'), 'contract');
const k = syncDir(CORE_SRC, join(SHARED, 'core'), 'core');

console.log(`  裸包名改写：contract ${c.rewritten} 处，core ${k.rewritten} 处`);
console.log('  提示：产物是只读副本，不要直接改；改 packages/ 下的源再跑一次本脚本。');
