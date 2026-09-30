#!/usr/bin/env node
/**
 * Core 纯度守卫 —— 把「Core 层不得 import 任何平台 API」这条铁律变成**可执行检查**。
 *
 * 为什么必须有它：
 *   这条铁律是整个项目的立论基础。如果它只写在 README 里，
 *   第一个赶进度的人加一行 `import fs from 'node:fs'`，项目就废了，
 *   而且不会有任何东西报警 —— 「一套 core 多端壳」直接变成无法验证的口号。
 *
 * 检查三件事：
 *   1. core 源码里没有任何 import 指向平台模块（electron / node:* / @ohos.*）
 *   2. core 源码里没有平台全局的直接引用（process / window / document / require）
 *   3. core 的 package.json 依赖面只有 @crossdeck/contract
 *
 * 不用子进程 —— 纯 fs + 正则，跨平台稳定（本机 Node 派生 piped 子进程会被拦）。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE_SRC = join(ROOT, 'packages', 'core', 'src');
const CORE_PKG = join(ROOT, 'packages', 'core', 'package.json');

/** 允许的 import 目标：相对路径 + 唯一共享契约包。 */
const ALLOWED_EXTERNAL = new Set(['@crossdeck/contract']);

/** 平台模块特征（命中即违规，并给出人话原因）。 */
const FORBIDDEN_SPECIFIERS = [
  { test: /^electron($|\/)/, why: 'electron 是壳的东西，core 不认识它' },
  { test: /^node:/, why: 'Node 内置模块 —— Web 壳里根本不存在' },
  { test: /^@ohos(\/|$)/, why: 'HarmonyOS 专有模块' },
  { test: /^fs$|^path$|^os$|^child_process$|^crypto$/, why: 'Node 内置模块的裸名写法' },
];

/** 平台全局变量 —— 类型上也不该出现（core 的 lib 只有 ES2022）。 */
const FORBIDDEN_GLOBALS = [
  { re: /\bprocess\s*\.\s*(platform|env|version|cwd)\b/, why: 'process.* 是宿主信息，应经 EnvPort 注入' },
  { re: /\brequire\s*\(/, why: 'require 是 CommonJS 运行时痕迹' },
  { re: /\bdocument\s*\.\s*/, why: 'document 只在 renderer 存在' },
  { re: /\bwindow\s*\.\s*[a-zA-Z_$]/, why: 'window 只在 renderer 存在' },
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...walk(abs));
    else if (name.endsWith('.ts')) out.push(abs);
  }
  return out;
}

/** 抓出所有静态 import 与动态 import 的模块说明符。 */
function collectSpecifiers(source) {
  const found = [];
  const patterns = [
    /(?:^|\n)\s*import\s+(?:type\s+)?[^'"]*?from\s*['"]([^'"]+)['"]/g, // import x from 'm'
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g, //                          import 'm'
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, //                         import('m')
    /\bexport\s+(?:type\s+)?[^'"]*?from\s*['"]([^'"]+)['"]/g, //         export ... from 'm'
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) {
      if (m[1]) found.push(m[1]);
    }
  }
  return found;
}

const violations = [];
const files = walk(CORE_SRC);

for (const abs of files) {
  const rel = relative(ROOT, abs).split(sep).join('/');
  const source = readFileSync(abs, 'utf8');

  for (const spec of collectSpecifiers(source)) {
    if (spec.startsWith('.')) continue;

    const forbidden = FORBIDDEN_SPECIFIERS.find((f) => f.test.test(spec));
    if (forbidden) {
      violations.push({ rel, what: `import '${spec}'`, why: forbidden.why });
      continue;
    }
    if (spec.startsWith('@crossdeck/')) {
      if (!ALLOWED_EXTERNAL.has(spec)) {
        violations.push({ rel, what: `import '${spec}'`, why: 'core 只允许依赖 contract，不允许依赖别的包' });
      }
      continue;
    }
    violations.push({ rel, what: `import '${spec}'`, why: 'core 不得依赖任何第三方或平台模块' });
  }

  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const fg of FORBIDDEN_GLOBALS) {
    const m = stripped.match(fg.re);
    if (m) {
      violations.push({ rel, what: `代码里出现 ${m[0].trim()}`, why: fg.why });
    }
  }
}

const pkg = JSON.parse(readFileSync(CORE_PKG, 'utf8'));
const declaredDeps = Object.keys(pkg.dependencies ?? {});
for (const dep of declaredDeps) {
  if (!ALLOWED_EXTERNAL.has(dep)) {
    violations.push({
      rel: 'packages/core/package.json',
      what: `dependencies 里有 '${dep}'`,
      why: 'core 的依赖面只允许 @crossdeck/contract',
    });
  }
}

console.log('── Core 纯度检查 ──────────────────────────────');
console.log(`扫描 ${files.length} 个文件（packages/core/src）`);
console.log(`依赖面：${declaredDeps.length ? declaredDeps.join(', ') : '(仅 workspace 内部)'}\n`);

if (violations.length === 0) {
  console.log('✅ Core 层零平台依赖 —— 铁律成立');
  console.log('   （对照：如果哪天这里变红，"一套 core 多端壳"就已经是假的了）');
  process.exit(0);
}

console.error(`❌ 发现 ${violations.length} 处铁律违规：\n`);
for (const v of violations) {
  console.error(`   ${v.rel}`);
  console.error(`     ${v.what}`);
  console.error(`     → ${v.why}\n`);
}
process.exit(1);
