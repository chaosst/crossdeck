#!/usr/bin/env node
/**
 * 图标索引 —— 当前装的 `lucide-react` 里到底有哪些图标。
 *
 * ── 为什么是脚本，而不是一份 ICONS.md ──────────────────────────
 * 清单会随依赖升级腐烂：此刻 2134 个名字，升级一次可能全变。
 * 而**腐烂的清单比没有清单更危险** —— 你会照着它写出一个已经不存在的图标名，
 * 然后困惑于"为什么 import 报错"。所以这里每次从 node_modules 现算，
 * 结果永远等于实际装的那个版本。
 *
 * ── 数据源 ────────────────────────────────────────────────
 * `lucide-react/dist/esm/icons/*.mjs` 的**文件名**。那就是 lucide 的官方
 * kebab 名，且能直接拼成官网地址：
 *
 *     https://lucide.dev/icons/<kebab-name>
 *
 * ⚠️ 本地元数据只有 `name / size / node / aliases`，**没有分类或关键词**。
 *    所以离线只能按名字搜；要按语义搜（"给我一个表示『同步』的图标"）
 *    必须去官网 —— 那边的搜索是基于关键词的。
 *
 * ── 用法 ──────────────────────────────────────────────────
 *   pnpm icons                看总数与用法（不刷屏）
 *   pnpm icons user           按关键词过滤，同时给出组件名
 *   pnpm icons user check     多个关键词 = AND
 *   pnpm icons --all          打印全部名字（可重定向存盘）
 *   pnpm icons --verify       用**真实装的包**校验本脚本的命名转换
 */

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = join(here, '..', 'node_modules', 'lucide-react', 'dist', 'esm', 'icons');
const SITE = 'https://lucide.dev/icons';

/**
 * kebab 名 → PascalCase 组件名。
 *
 * 这就是 lucide 自己的导出规则（`circle-check` → `CircleCheck`，
 * `arrow-up-0-1` → `ArrowUp01`）。规则看着简单，但数字段的边界值得记一笔：
 * `0-1` 两段各自首字符大写仍是 `0`/`1`，所以结果是 `ArrowUp01` 而不是 `ArrowUp0_1`。
 * 已用 d.ts 里的真实 `declare const` 抽样核对过（含 `AArrowDown` / `BadgeCent`
 * / `ArrowUp01` 三个边界样例）。
 */
function toPascal(kebab) {
  return kebab
    .split('-')
    .map((seg) => (seg ? seg[0].toUpperCase() + seg.slice(1) : seg))
    .join('');
}

function loadIconNames() {
  let entries;
  try {
    entries = readdirSync(ICONS_DIR);
  } catch {
    console.error(`找不到图标目录：\n  ${ICONS_DIR}`);
    console.error('\n依赖大概还没装。先跑：');
    console.error('  pnpm --filter @crossdeck/shell-electron install');
    process.exit(1);
  }
  return entries
    .filter((f) => f.endsWith('.mjs') && !f.endsWith('.map'))
    .map((f) => f.slice(0, -'.mjs'.length))
    .filter((n) => !NON_ICONS.has(n))
    .sort();
}

/**
 * 目录里的非图标文件。
 *
 * `index.mjs` 是包内部的索引，文件名长得和图标一模一样，会被"扫文件名"这个
 * 做法误收进来 —— `pnpm icons --verify` 第一次跑就把它揪出来了
 * （`index` → `Index` 并不存在）。
 *
 * 这只是个必要清单、不是充分保证：真再漏了什么，`--verify` 会兜住。
 * 这也是为什么那个开关必须留着 —— 它替我们盯着这份清单有没有腐烂。
 */
const NON_ICONS = new Set(['index']);

/** ls 风格的多列输出：先定列宽，再**按列优先**填（这样纵向读是连续的字母序）。 */
function printColumns(names) {
  const width = process.stdout.columns || 100;
  const colW = Math.max(...names.map((n) => n.length)) + 2;
  const cols = Math.max(1, Math.floor(width / colW));
  const rows = Math.ceil(names.length / cols);
  const lines = [];
  for (let r = 0; r < rows; r += 1) {
    let line = '';
    for (let c = 0; c < cols; c += 1) {
      const i = c * rows + r;
      if (i < names.length) line += names[i].padEnd(colW);
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

const args = process.argv.slice(2);
const wantAll = args.includes('--all');
const keywords = args.filter((a) => !a.startsWith('-'));
const all = loadIconNames();

// ── --verify：让这把尺子校验自己 ────────────────────────────
// 转换规则一旦写错，这个工具就会给出**不可导入的组件名** —— 那比没有工具更坏，
// 因为你会照着它写 import，然后在报错里困惑。所以这里拿"当前真实装的包"的
// 导出面对一遍，而不是相信规则本身。
//
// 为什么不用 `grep 'declare const X' lucide-react.d.ts` 来校验（我第一版就是
// 这么干的，结果是错的）：d.ts 里**别名走的是 `as` 重命名导出**，形如
//   AlarmClockCheck as AlarmCheck, UserRoundCheck as UserCheck2
// 它们**没有**自己的 `declare const` 行，于是这种校验会把 58 个合法别名里的
// 8 个误判成"不存在"。只有模块的真实导出面才是权威。
if (args.includes('--verify')) {
  const mod = await import('lucide-react');
  const missing = all.filter((n) => !(toPascal(n) in mod));
  console.log(`kebab 名 ${all.length} 个；lucide-react 导出 ${Object.keys(mod).length} 项。`);
  if (missing.length === 0) {
    console.log('✅ 每一个都能转成真实存在的导出名。');
    process.exit(0);
  }
  console.error(`❌ ${missing.length} 个转换后无法导入：`);
  for (const n of missing.slice(0, 20)) console.error(`   ${n} → ${toPascal(n)}`);
  if (missing.length > 20) console.error(`   …另有 ${missing.length - 20} 个`);
  process.exit(1);
}

// ── 无参数：只报总数与用法，不刷屏 ──────────────────────────
if (keywords.length === 0 && !wantAll) {
  console.log(`lucide-react 当前提供 ${all.length} 个可导入的名字（含别名）。\n`);
  console.log('  按名字过滤      pnpm icons <关键词> [更多关键词…]');
  console.log('  只要组件名      pnpm icons user          → User / UserCheck / UserRound …');
  console.log('  全部名字        pnpm icons --all         （可重定向存盘）');
  console.log(`\n  带预览的官网    ${SITE}`);
  console.log('                  ← 按语义搜、调 stroke-width、复制 React/SVG 代码都在这里');
  process.exit(0);
}

// ── --all：愿意刷屏就给全量 ────────────────────────────────
if (keywords.length === 0) {
  console.log(printColumns(all).join('\n'));
  console.log(`\n共 ${all.length} 个。官网：${SITE}`);
  process.exit(0);
}

// ── 关键词过滤（多个词是 AND）──────────────────────────────
const lowered = keywords.map((k) => k.toLowerCase());
const matched = all.filter((n) => lowered.every((k) => n.includes(k)));

if (matched.length === 0) {
  console.error(`没有名字同时包含 ${keywords.map((k) => `"${k}"`).join(' 与 ')}。`);
  console.error(`\n本地只能按**名字**搜。按语义搜请用官网：${SITE}`);
  process.exit(1);
}

const nameW = Math.max(...matched.map((n) => n.length));
for (const n of matched) {
  console.log(`  ${n.padEnd(nameW)}  →  ${toPascal(n)}`);
}

const sample = matched.length <= 8 ? matched : matched.slice(0, 3);
const rest = matched.length > 8 ? ', …' : '';
console.log(`\n${matched.length} 个匹配。`);
console.log(`import { ${sample.map(toPascal).join(', ')}${rest} } from 'lucide-react';`);
console.log(`用法：<${toPascal(matched[0])} className="icon size-3.5" />`);
console.log(`预览：${SITE}/${matched[0]}`);
