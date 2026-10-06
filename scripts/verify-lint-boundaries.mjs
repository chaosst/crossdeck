#!/usr/bin/env node
/**
 * 跨端边界 lint 规则的负例验收。
 *
 * 为什么必须有这个脚本：**一个从不触发的 lint 配置比没有配置更危险** ——
 * 它让人以为边界被守着，实际上没人守。这次写 `eslint.config.mjs` 时就撞上了
 * 两次（见下面的「实测记录」），两次都不是靠读文档发现的。
 *
 * 所以每条规则都要有一条能把它打红的注入用例，另加几条**必须保持沉默**的
 * 正例 —— 会误报的规则最后一定会被关掉，那和没写是一样的。
 *
 * 做法与 `verify-type-alignment.mjs` 一致：往真实文件末尾追加违规代码，
 * 用 ESLint 的 Node API 在进程内检查，断言命中预期规则，然后还原。
 *
 * ── 实测记录（`no-restricted-imports` 的 pattern 语义）──────────
 * 三个写法各跑 14 个用例才定下来，因为文档看不出来：
 *
 *   写法                        ./fs/posixPath.js   fs/promises   动态 import
 *   paths:[{name:'fs'}]              放行 ✅          放行 ❌       放行 ❌
 *   group:['*','!./**',...]          拦住 ❌          拦住 ✅       放行 ❌
 *   AST 正则选择器                    放行 ✅          拦住 ✅       拦住 ✅
 *
 * 两条要命的：`fs/*` 这类 pattern 会**误伤相对路径** `./fs/xxx`
 * （ESLint 先剥掉前导 `./` 再匹配），而 `['*','!./**']` 里的否定**根本不生效**。
 * 现在配置用的是第三种。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const CORE_INDEX = 'packages/core/src/index.ts';
const CORE_PORTS = 'packages/core/src/ports.ts';
const CONTRACT_INDEX = 'packages/contract/src/index.ts';
const WEB_MAIN = 'packages/shell-web/src/main.ts';

/** 必须被拦住的注入用例。 */
const CASES = [
  {
    id: 'A',
    file: CORE_INDEX,
    what: "core 静态 import 'node:fs'",
    append: `\nimport fs from 'node:fs';\nexport const __a = fs;\n`,
    expectRule: 'no-restricted-syntax',
  },
  {
    id: 'B',
    file: CORE_INDEX,
    what: "core 动态 import('node:os')（最常被用来「绕过检查」的那条路）",
    append: `\nexport async function __b() {\n  return import('node:os');\n}\n`,
    expectRule: 'no-restricted-syntax',
  },
  {
    id: 'C',
    file: CORE_INDEX,
    what: "core `export * from 'node:path'`（export 是另一种入口，容易漏）",
    append: `\nexport * from 'node:path';\n`,
    expectRule: 'no-restricted-syntax',
  },
  {
    id: 'D',
    file: CORE_INDEX,
    what: "core import 'electron'",
    append: `\nimport { app } from 'electron';\nexport const __d = app;\n`,
    expectRule: 'no-restricted-syntax',
  },
  {
    id: 'E',
    file: CORE_INDEX,
    what: "core import '@ohos.app.ability.UIAbility'",
    append: `\nimport UIAbility from '@ohos.app.ability.UIAbility';\nexport const __e = UIAbility;\n`,
    expectRule: 'no-restricted-syntax',
  },
  {
    id: 'F',
    file: CORE_INDEX,
    what: 'core 裸名 import 内置模块（`fs` 而不是 `node:fs`）',
    append: `\nimport { readdirSync } from 'fs';\nexport const __f = readdirSync;\n`,
    expectRule: 'no-restricted-syntax',
  },
  {
    id: 'G',
    file: CORE_INDEX,
    what: 'core 引入第三方包',
    append: `\nimport { z } from 'zod';\nexport const __g = z;\n`,
    expectRule: 'no-restricted-syntax',
  },
  {
    id: 'H',
    file: CORE_INDEX,
    what: 'core 依赖另一个 workspace 包（依赖面只允许 contract）',
    append: `\nimport { x } from '@crossdeck/core';\nexport const __h = x;\n`,
    expectRule: 'no-restricted-syntax',
  },
  {
    id: 'I',
    file: CORE_INDEX,
    what: 'core 读 process.platform（宿主信息必须经 Port 注入）',
    append: `\nexport const __i = process.platform;\n`,
    expectRule: 'no-restricted-globals',
  },
  {
    id: 'J',
    file: CORE_INDEX,
    what: 'core 用 Buffer（Node 专有）',
    append: `\nexport const __j = Buffer.from('x');\n`,
    expectRule: 'no-restricted-globals',
  },
  {
    id: 'K',
    file: CORE_INDEX,
    what: 'core 用 document（DOM 全局）',
    append: `\nexport const __k = document.title;\n`,
    expectRule: 'no-restricted-globals',
  },
  {
    id: 'L',
    file: CONTRACT_INDEX,
    what: '契约层 import 第三方包（它必须是零依赖的）',
    append: `\nimport { z } from 'zod';\nexport const __l = z;\n`,
    expectRule: 'no-restricted-syntax',
  },
  {
    id: 'M',
    file: CONTRACT_INDEX,
    what: '契约层 import node 内置模块',
    append: `\nimport { join } from 'node:path';\nexport const __m = join;\n`,
    expectRule: 'no-restricted-syntax',
  },
  {
    id: 'N',
    file: WEB_MAIN,
    what: 'Web 壳（浏览器侧）import electron',
    append: `\nexport const __n = () => import('electron');\n`,
    expectRule: 'no-restricted-syntax',
  },
  {
    id: 'O',
    file: WEB_MAIN,
    what: 'Web 壳读 process.env（浏览器里没有 process）',
    append: `\nexport const __o = process.env;\n`,
    expectRule: 'no-restricted-globals',
  },
  {
    id: 'P',
    file: CORE_INDEX,
    what: '**关键**：用 eslint-disable 注释关掉规则 —— 这必须无效',
    append: `\n// eslint-disable-next-line no-restricted-syntax\nimport fsx from 'node:fs';\nexport const __p = fsx;\n`,
    expectRule: 'no-restricted-syntax',
  },
  {
    id: 'Q',
    file: CORE_INDEX,
    what: '**关键**：整文件 eslint-disable —— 同样必须无效',
    append: `\n/* eslint-disable no-restricted-syntax */\nimport osx from 'node:os';\nexport const __q = osx;\n`,
    expectRule: 'no-restricted-syntax',
  },
];

/**
 * 必须**保持沉默**的合法写法。
 *
 * 这一组才是这份配置真正的风险所在：`import './fs/posixPath.js'` 长得就像
 * 违规，而 `no-restricted-imports` 的 `fs/*` 正好会在这里误报 ——
 * 误报的规则活不过一周。
 */
const SILENT = [
  {
    id: 'S1',
    file: CORE_INDEX,
    what: "core 相对 import（路径里带 fs 字样，正是会误报的那个形状）",
    append: `\nimport { joinPath } from './fs/posixPath.js';\nexport const __s1 = joinPath;\n`,
  },
  {
    id: 'S2',
    file: CORE_INDEX,
    what: 'core 对契约包做 `import type`',
    append: `\nimport type { Capability } from '@crossdeck/contract';\nexport type __S2 = Capability;\n`,
  },
  {
    id: 'S3',
    file: CORE_INDEX,
    what: 'core 相对 re-export',
    append: `\nexport * from './agent/tools.js';\n`,
  },
  {
    id: 'S4',
    file: CORE_INDEX,
    what: 'core 使用 Uint8Array 这类标准全局（不该被 platform 全局规则误伤）',
    append: `\nexport const __s4 = new Uint8Array(4);\n`,
  },
  {
    id: 'S5',
    file: WEB_MAIN,
    what: 'Web 壳用 navigator（浏览器里合法，core 里不合法 —— 规则必须按目录区分）',
    append: `\nexport const __s5 = navigator.userAgent;\n`,
  },
];

const eslint = new ESLint({ cwd: ROOT });

async function lintAppended(relPath, append) {
  const abs = join(ROOT, relPath);
  const original = readFileSync(abs, 'utf8');
  try {
    writeFileSync(abs, original + append);
    const results = await eslint.lintText(original + append, { filePath: abs });
    return results.flatMap((r) => r.messages.map((m) => ({ ruleId: m.ruleId, message: m.message, line: m.line })));
  } finally {
    writeFileSync(abs, original);
  }
}

async function lintClean() {
  // 正例基线：真实文件必须 0 问题（含被注入过又还原的这几个）
  const results = await eslint.lintFiles([
    'packages/core/src',
    'packages/contract/src',
    'packages/shell-web/src',
    'packages/shell-electron/src/renderer',
  ]);
  const bad = results.filter((r) => r.errorCount > 0);
  return {
    ok: bad.length === 0,
    detail: bad.map((r) => `${r.filePath}\n    ${r.messages.map((m) => `${m.ruleId}: ${m.message}`).join('\n    ')}`).join('\n'),
    files: results.length,
  };
}

console.log('── 正例：真实代码必须 0 问题 ──────────────────────');
const baseline = await lintClean();
if (!baseline.ok) {
  console.error(`❌ 基线不干净，先修好再跑负例：\n${baseline.detail}`);
  process.exit(1);
}
console.log(`✅ ${baseline.files} 个文件、0 个问题\n`);

console.log('── 负例：故意违规，必须被 lint 拦住 ────────────────');
let caught = 0;
for (const c of CASES) {
  const messages = await lintAppended(c.file, c.append);
  const hit = messages.some((m) => m.ruleId === c.expectRule);
  if (hit) caught += 1;
  console.log(
    `${hit ? '✅' : '❌'} [${c.id}] ${hit ? `命中 ${c.expectRule}` : `没拦住！（${messages.length} 条诊断）`}\n     ${c.what}`,
  );
  if (!hit && messages.length > 0) {
    console.log(`     ── 实际诊断 ──\n     ${messages.map((m) => `${m.ruleId}: ${m.message}`).join('\n     ')}`);
  }
}

console.log('\n── 正例 2：这些写法**必须保持沉默**（误报的规则会被关掉）──');
let silent = 0;
for (const s of SILENT) {
  const messages = await lintAppended(s.file, s.append);
  const clean = messages.length === 0;
  if (clean) silent += 1;
  console.log(`${clean ? '✅' : '❌'} [${s.id}] ${clean ? '无告警' : '被误报了！'}\n     ${s.what}`);
  if (!clean) {
    console.log(`     ── 实际诊断 ──\n     ${messages.map((m) => `${m.ruleId}: ${m.message}`).join('\n     ')}`);
  }
}

console.log('\n── 还原校验 ──────────────────────────────────────');
const final = await lintClean();
if (!final.ok) {
  console.error(`❌ 还原后仍有问题，工作区被污染：\n${final.detail}`);
  process.exit(1);
}
console.log('✅ 文件已还原，真实代码重新 0 问题');

const ok = caught === CASES.length && silent === SILENT.length;
console.log(
  `\n结果：拦住 ${caught}/${CASES.length} 个越界 · 保持沉默 ${silent}/${SILENT.length} 个合法写法` +
    (ok ? ' — 跨端边界的编辑器内守卫成立 🎉' : ' — 存在漏网或误报，需检查规则定义'),
);
process.exit(ok ? 0 : 1);
