#!/usr/bin/env node
/**
 * 渲染层颜色收敛的验收 —— 色值必须只剩 `styles.css` 一份真源。
 *
 * 与 verify-core-scope 同风格：零依赖、**不派生任何子进程**，
 * 直接读源码文本跑断言（所以受限会话里也跑得动）。
 *
 * 检定力的来源是反向断言：
 *   证明"现在扫不到 hex"说明不了任何事 —— 扫描器可能压根没在工作
 *   （正则写错、目录走错、文件没读进来，全都是"扫不到"）。
 *   所以每条正向断言都配一发**合成坏输入**，要求检出器必须报错。
 *   反向用例的锚点失配时报失败而不是跳过 —— 跳过等于悄悄失去鉴别力。
 *
 * 实测鉴别力（2026-10-14，每条变异各跑一次，基线还原后 exit=0）：
 *   恢复 1 处 hex（App.tsx）              → 挂 1 条（①）
 *   渲染层改回裸 hex（TUI 代码正文）      → 挂 1 条（①）
 *   去掉 @theme 的 static                → 挂 1 条（②）
 *   tokens.ts 注入 var(--color-nope)      → 挂 1 条（③）
 *   引回已删的 var(--color-tui-notice)    → 挂 1 条（③）
 *   重新引入第二套 TUI 色板变量           → 挂 1 条（③）
 *   删掉 --color-muted 定义（并重建）     → 挂 2 条（③ + ⑤）
 *   删掉 --color-hint 定义（并重建）      → 挂 2 条（③ + ⑤）
 *
 * ★ ⑤ 起初把 token 名只取自 `@theme` 定义 —— 定义被删时源码里的类名就提取不出来，
 *   这条网跟着一起安静。改成「定义 ∪ 源码里的 var() 引用」之后它才独立成网。
 *
 * ⚠️ 两条被实测推翻的设计（诚实记录，别改回去）：
 *   1. ③ 的反向断言原先把**真实 refs** 混进合成输入 → 仓库里只要存在一个悬空 var
 *      它就跟着变红，此时的"挂了"只说明真缺陷存在、证明不了检出器还在工作。
 *      已改成纯合成输入 + 独立的"扫描面非空"断言，与 ① 同构（锚点不依赖仓库状态）。
 *   2. 「删掉某 token 定义」型变异**杀不到 ④**：④ 判的是"定义 ⊆ 产物"，定义都没了
 *      自然不违例。真正咬住它的是 ⑤（产物里找不到对应工具类）。早期头部记的"③ + ④"是错的。
 *
 * ⚠️ 与预期不符的一条（诚实记录）：把 `@theme static` 改回 `@theme` 并**重新构建**后，
 *   全部变量**仍然**出现在产物 CSS 里 —— Tailwind 4.3.3 默认并不摇掉未使用的
 *   theme 变量。所以④不是"证明没被摇掉"的活证据，而是"上游改了行为就会被发现"的哨兵；
 *   ② 同理，它盯的是我方那条显式声明还在不在，而不是"变量真的会消失"。
 *
 * ⚠️ ④ 依赖产物，**改完 styles.css 必须 `pnpm build` 再跑** —— 否则它在拿旧产物判"子集成立"，
 *   删掉的 token 也能通过（2026-10-14 实测踩过）。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER = join(ROOT, 'packages', 'shell-electron', 'src', 'renderer');
const STYLES = join(RENDERER, 'styles.css');
const BUILT_CSS_DIR = join(ROOT, 'packages', 'shell-electron', 'dist', 'renderer', 'assets');

// ─────────────────────────────────────────────────────────────
// 纯函数层 —— 判定逻辑与 IO 分开，好让反向断言喂合成数据进来
// ─────────────────────────────────────────────────────────────

/** 源文本 → hex 颜色字面量（3 / 6 / 8 位）。`#root` 这类选择器不会被误伤。 */
function findHexLiterals(text) {
  return text.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
}

/** 一组源文件 → hex 命中总数。 */
function countHex(files) {
  let n = 0;
  for (const f of files) n += findHexLiterals(f.text).length;
  return n;
}

/** 源文本 → 引用的 `var(--color-*)` 名。 */
function referencedColorVars(text) {
  return [...text.matchAll(/var\((--color-[a-z0-9-]+)\)/g)].map((m) => m[1]);
}

/** CSS 文本 → `@theme` 块里定义的 `--color-*` 名；没有 @theme 块时返回 null。 */
function definedColorVars(css) {
  const block = css.match(/@theme[^{]*\{([\s\S]*?)\n\}/);
  if (block === null) return null;
  return [...block[1].matchAll(/(--color-[a-z0-9-]+)\s*:/g)].map((m) => m[1]);
}

/** 引用了但没定义的变量（悬空引用）。 */
function danglingVars(refs, defined) {
  return [...refs].filter((v) => !defined.has(v));
}

/** 源码里用到的 token 工具类（text-muted / bg-canvas / border-line-subtle …）。 */
function usedTokenUtilities(files, tokenNames) {
  const alt = [...tokenNames].sort((a, b) => b.length - a.length).join('|');
  const re = new RegExp(
    `(?:text|bg|border|divide|ring|fill|stroke|outline|shadow)-(?:${alt})(?![-a-z])`,
    'g',
  );
  const set = new Set();
  for (const f of files) for (const m of f.text.matchAll(re)) set.add(m[0]);
  return set;
}

/**
 * 产物 CSS 里是否真的定义了这个类。
 * 尾随负向断言是必需的：否则 `text-ink` 会被 `text-ink-body{...}` 误判为"已定义"。
 */
function cssDefinesUtility(css, cls) {
  return new RegExp(`${cls}(?![-a-z0-9])`).test(css);
}

/** 递归收集 `.ts` / `.tsx`。 */
function collectSources(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

// ─────────────────────────────────────────────────────────────
// 极简断言器
// ─────────────────────────────────────────────────────────────
let passed = 0;
const failures = [];
const skipped = [];

function check(what, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ✅ ${what}`);
  } else {
    failures.push(what);
    console.log(`  ❌ ${what}${detail === undefined || detail === '' ? '' : `\n       ${detail}`}`);
  }
}

// ─────────────────────────────────────────────────────────────
// IO：读真实源码
// ─────────────────────────────────────────────────────────────
const srcPaths = collectSources(RENDERER);
const sources = srcPaths.map((p) => ({
  path: relative(ROOT, p).split(sep).join('/'),
  text: readFileSync(p, 'utf8'),
}));
const cssText = readFileSync(STYLES, 'utf8');

console.log(`\n渲染层源文件：${srcPaths.length} 个（packages/shell-electron/src/renderer）\n`);

// ─────────────────────────────────────────────────────────────
// ① hex 零残留
// ─────────────────────────────────────────────────────────────
console.log('── ① 色值已收敛到唯一真源 ─────────────────────────────');
{
  const hits = [];
  for (const f of sources) for (const h of findHexLiterals(f.text)) hits.push(`${f.path}: ${h}`);

  // 扫描面非空 —— 防"目录走错 → 0 个文件 → 断言假绿"。
  check(`扫描面非空（${sources.length} 个 ts/tsx）`, sources.length > 0);

  check(
    `渲染层 ${sources.length} 个 ts/tsx 里无 hex 颜色字面量`,
    hits.length === 0,
    hits.length === 0
      ? ''
      : `${hits.length} 处残留：\n       ${hits.slice(0, 12).join('\n       ')}`,
  );

  // 反向：**纯合成输入**，不与真实文件集混 —— 否则这条断言会随仓库状态
  // 时红时绿（收敛前必红、收敛后恒绿），两边都不在证明"扫描器有效"。
  const probeFiles = [{ path: '<probe>', text: 'const x = <div className="text-[#deadbe]" />;' }];
  check(
    '[反向] 1 条合成 hex → 必须检出恰好 1 处',
    countHex(probeFiles) === 1,
    `实际检出 ${countHex(probeFiles)} 处`,
  );
}

// ─────────────────────────────────────────────────────────────
// ② @theme 的变量定义面
// ─────────────────────────────────────────────────────────────
console.log('\n── ② token 定义面完整 ────────────────────────────────');
const defined = definedColorVars(cssText);
{
  check('styles.css 里存在 @theme 块', defined !== null);
  check('@theme 块非空', defined !== null && defined.length > 0, `定义 ${defined?.length ?? 0} 个`);

  // 这盯的是**我方声明**还在不在，不是"变量真的会消失"——见文件头那条实测记录。
  check(
    '@theme 声明为 static 变体（所有 token 都进产物的显式约定）',
    /@theme\s+static\s*\{/.test(cssText),
  );
}

// ─────────────────────────────────────────────────────────────
// ③ tokens.ts 的引用闭合（无悬空 var）
// ─────────────────────────────────────────────────────────────
console.log('\n── ③ tokens.ts 引用闭合 ──────────────────────────────');
{
  if (defined === null) {
    check('引用闭合（前置：@theme 必须存在）', false, '@theme 缺失，无法判定');
  } else {
    const definedSet = new Set(defined);
    const refs = new Set();
    for (const f of sources) for (const v of referencedColorVars(f.text)) refs.add(v);

    const dangling = danglingVars(refs, definedSet);
    // 扫描面非空 —— 防"源码里一个 var 都没有 → 断言假绿"。
    check(`源里确实引用了 var(--color-*)（${refs.size} 个）`, refs.size > 0);

    check(
      `源里引用的 ${refs.size} 个 var(--color-*) 全部有定义`,
      dangling.length === 0,
      dangling.length === 0 ? '' : `悬空：${dangling.join(', ')}`,
    );

    // 反向：**纯合成输入**，不掺真实 refs。
    // 掺进去的话，仓库里只要有一个悬空 var，这条就跟着变红 —— 那时的"挂了"只说明
    // 真缺陷存在，证明不了"检出器还在工作"（2026-10-14 变异 F/H 实测踩到）。
    const probeBad = danglingVars(new Set(['--color-a', '--color-nope']), new Set(['--color-a']));
    check(
      '[反向] 合成 1 已定义 + 1 悬空 → 必须只检出悬空那个',
      probeBad.length === 1 && probeBad[0] === '--color-nope',
      `实际：${probeBad.length === 0 ? '一个都没检出（检出器失效）' : probeBad.join(', ')}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────
// ④ 产物层：变量真的没被摇掉（需要已构建）
// ─────────────────────────────────────────────────────────────
console.log('\n── ④ 产物 CSS（构建后才有意义）───────────────────────');
{
  const built =
    existsSync(BUILT_CSS_DIR) && defined !== null
      ? readdirSync(BUILT_CSS_DIR)
          .filter((f) => f.endsWith('.css'))
          .map((f) => readFileSync(join(BUILT_CSS_DIR, f), 'utf8'))
          .join('\n')
      : null;

  if (built === null) {
    skipped.push('产物 CSS 缺失（未构建）—— tree-shake 断言跳过；跑 `pnpm build` 后再验证');
    console.log('  ⏭️  跳过：dist/renderer/assets/*.css 不存在（未构建）');
  } else {
    const missing = defined.filter((v) => !built.includes(`${v}:`));
    check(
      `${defined.length} 个 token 全部进了产物 CSS（未被 tree-shake）`,
      missing.length === 0,
      missing.length === 0 ? '' : `产物里找不到：${missing.join(', ')}`,
    );

    // 变量在 ≠ 工具类在。少了这一条，就会漏掉"类名写错/没被扫到 → 静默失色"
    // 这个本模块最想防的坑（编译通过、界面失色）。
    // token 名取自「@theme 定义」∪「源码里 var(--color-*) 的引用」。
    // 只看 defined 会留一个盲区：定义被误删时源码里的类名就提取不出来，
    // 这条断言会跟着一起安静下来 —— 而它本该是独立于 ③ 的另一层网（实测抓过）。
    const tokenNames = new Set(
      [...defined, ...new Set(sources.flatMap((f) => referencedColorVars(f.text)))].map((v) =>
        v.replace('--color-', ''),
      ),
    );
    const used = usedTokenUtilities(sources, tokenNames);
    const notEmitted = [...used].filter((c) => !cssDefinesUtility(built, c));
    check(
      `源码用到的 ${used.size} 个 token 工具类都在产物里有定义`,
      used.size > 0 && notEmitted.length === 0,
      notEmitted.length === 0 ? '' : `产物里没有：${notEmitted.join(', ')}`,
    );
  }

  // 纯函数反向：不依赖产物，任何情况下都跑。
  check(
    '[反向] 合成类名判定：text-muted 算有、text-nonexistent 算没有',
    cssDefinesUtility('.text-muted{color:var(--color-muted)}', 'text-muted') === true &&
      cssDefinesUtility('.text-muted{color:var(--color-muted)}', 'text-nonexistent') === false,
  );
}

// ─────────────────────────────────────────────────────────────
// 汇总
// ─────────────────────────────────────────────────────────────
console.log('\n──────────────────────────────────────────────────────');
for (const s of skipped) console.log(`⏭️  ${s}`);
if (failures.length > 0) {
  console.log(`❌ ${failures.length} 条断言失败：`);
  for (const f of failures) console.log(`   - ${f}`);
} else {
  console.log(`✅ 全部 ${passed} 条断言通过 — 色值只有一份真源 🎉`);
}
process.exit(failures.length === 0 ? 0 : 1);
