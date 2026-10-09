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
 *
 * ## 本文件只负责「写盘 + 打印」
 *
 * 「该写什么」的计算在 `syncShared.mjs` 的 `planSync()`，与漂移检测脚本
 * （仓库根 `scripts/verify-shared-fresh.mjs`）**共用同一份** —— 那两处若各算一遍，
 * 检测用的尺子自己就会腐烂。详见 syncShared.mjs 头部。
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { PKG_DIR, planSync } from './syncShared.mjs';

console.log('── 同步 contract/core 进鸿蒙工程 ──────────────');

let plan;
try {
  plan = planSync();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

for (const target of plan) {
  // 产物目录整体重建：既避免删文件后留下孤儿，也顺带清掉手工塞进去的文件。
  rmSync(target.destDir, { recursive: true, force: true });
  mkdirSync(target.destDir, { recursive: true });
  for (const file of target.files) {
    mkdirSync(dirname(file.dest), { recursive: true });
    writeFileSync(file.dest, file.content, 'utf8');
  }
  console.log(
    `  ${target.label.padEnd(9)} ${String(target.files.length).padStart(2)} 个文件 → ${relative(PKG_DIR, target.destDir)}`,
  );
}

console.log(`  裸包名改写：${plan.map((t) => `${t.label} ${t.rewritten} 处`).join('，')}`);
console.log('  提示：产物是只读副本，不要直接改；改 packages/ 下的源再跑一次本脚本。');
