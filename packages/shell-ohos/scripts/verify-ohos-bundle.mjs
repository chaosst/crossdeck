#!/usr/bin/env node
/**
 * verify:ohos-bundle —— 离线校验 `rawfile/app` 产物（纯 Node，不需要设备）。
 *
 * 为什么需要它：`emptyOutDir` 产出一个空壳也算"构建成功"，`$rawfile` 找不到
 * 文件的表现是**白屏而不是构建失败**（P3 文档 §7）。七条断言（P3 文档 §8.1）：
 *
 *   1. 产物存在 index.html + ≥1 个 .js + ≥1 个 .css
 *   2. index.html 引用的资源在产物里真实存在（防 base 写错 → 设备上 404）
 *   3. JS 里必须出现共享 UI 的锚点（证明打进去的是 @crossdeck/ui，不是空壳）
 *   4. JS 里不得出现 node 痕迹（与 verify:type-alignment 的负例呼应）
 *   5. 端口协议字面量出现在产物里（证明通道层被打进去了）
 *   6. 体积双向约束：JS 20~800KB、CSS 15~60KB
 *      —— 只给上限，「样式全丢」会以「页面能跑但没样式」的形式蒙过去；
 *         只给下限，误把 dist 打两次也会通过
 *   7. 反例：拿一个只有 index.html 的空目录跑同一套判定，必须红 ≥3 条
 *      —— 判定自己没有牙的话，前六条只是仪式
 */

import { readdirSync, readFileSync, rmSync, mkdtempSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(HERE, '..', 'entry', 'src', 'main', 'resources', 'rawfile', 'app');

/** 双向体积护栏（P2 基线：JS 391KB / CSS 23.66KB；本壳首测 313KB / 24.7KB）。 */
const JS_RANGE = [20 * 1024, 800 * 1024];
const CSS_RANGE = [15 * 1024, 60 * 1024];

/** 共享 UI 的代表性锚点（§8.1 第 3 条）—— 缺了哪个都说明打进来的不是真 UI。 */
const UI_ANCHORS = ['session-create', 'chat-input', 'login-guest'];

/** 端口协议字面量（§8.1 第 5 条）—— 通道层被打包的证据。 */
const PROTOCOL_LITERALS = ['agent:stream', 'session:list', 'navigate:login-guest', 'document:upload-progress'];

function scan(dir) {
  const files = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(dir);
  return files;
}

/** 判定本体 —— 正例与反例（空目录）共用；失败记进调用方给的桶里。 */
function judge(dir, failures) {
  const check = (name, ok, detail) => {
    console.log(`  ${ok ? '✅' : '❌'} ${name}${detail === undefined ? '' : ` — ${detail}`}`);
    if (!ok) failures.push(name);
  };

  if (!existsSync(dir)) {
    failures.push('bundle.missing');
    return { jsBytes: 0, cssBytes: 0 };
  }

  const files = scan(dir);
  const jsFiles = files.filter((f) => f.endsWith('.js'));
  const cssFiles = files.filter((f) => f.endsWith('.css'));
  const htmlPath = join(dir, 'index.html');

  // 1 入口三件套
  check('bundle.indexHtml', existsSync(htmlPath), htmlPath);
  check('bundle.hasJs', jsFiles.length >= 1, jsFiles.length);
  check('bundle.hasCss', cssFiles.length >= 1, cssFiles.length);

  // 2 index.html 引用的资源真实存在
  let referencedOk = existsSync(htmlPath);
  let refs = [];
  if (referencedOk) {
    const html = readFileSync(htmlPath, 'utf8');
    refs = [...html.matchAll(/(?:src|href)="\.?\/?(assets\/[^"]+)"/g)].map((m) => m[1]);
    referencedOk = refs.length > 0 && refs.every((rel) => existsSync(join(dir, rel)));
  }
  check('bundle.referencedAssetsExist', referencedOk, refs.join(', ') || '(无引用)');

  const jsBytes = jsFiles.reduce((n, f) => n + statSync(f).size, 0);
  const cssBytes = cssFiles.reduce((n, f) => n + statSync(f).size, 0);
  const js = jsFiles.map((f) => readFileSync(f, 'utf8')).join('\n');

  // 3 共享 UI 锚点
  const missingAnchors = UI_ANCHORS.filter((a) => !js.includes(a));
  check('bundle.uiAnchorsPresent', missingAnchors.length === 0, missingAnchors.length === 0 ? UI_ANCHORS.join(',') : `缺 ${missingAnchors.join(',')}`);

  // 4 node 痕迹。`node:` 单查不行 —— lucide 的属性名与压缩后的变量名
  //    （`{node:n,offset:...}`）会误伤；模块说明符必然出现在字符串里（`"node:fs"`）。
  const nodeHits = ['require(', 'process.env', '"node:', "'node:"].filter((t) => js.includes(t));
  check('bundle.noNodeTraces', nodeHits.length === 0, nodeHits.length === 0 ? '无' : nodeHits.join(','));

  // 5 协议字面量
  const missingLiterals = PROTOCOL_LITERALS.filter((t) => !js.includes(t));
  check('bundle.protocolLiteralsPresent', missingLiterals.length === 0, missingLiterals.length === 0 ? PROTOCOL_LITERALS.join(',') : `缺 ${missingLiterals.join(',')}`);

  // 6 体积双向
  check(
    'bundle.jsSizeInRange',
    jsBytes >= JS_RANGE[0] && jsBytes <= JS_RANGE[1],
    `${Math.round(jsBytes / 1024)}KB（${Math.round(JS_RANGE[0] / 1024)}~${Math.round(JS_RANGE[1] / 1024)}KB）`,
  );
  check(
    'bundle.cssSizeInRange',
    cssBytes >= CSS_RANGE[0] && cssBytes <= CSS_RANGE[1],
    `${Math.round(cssBytes / 1024)}KB（${Math.round(CSS_RANGE[0] / 1024)}~${Math.round(CSS_RANGE[1] / 1024)}KB）`,
  );

  return { jsBytes, cssBytes };
}

console.log(`── verify:ohos-bundle ── ${APP_DIR}`);
const mainFailures = [];
const main = judge(APP_DIR, mainFailures);

// 7 反例：空壳目录必须红 ≥3 条（入口/锚点/协议），否则判定本身没牙
{
  const empty = mkdtempSync(join(tmpdir(), 'ohos-bundle-empty-'));
  writeFileSync(join(empty, 'index.html'), '<div id="root"></div>', 'utf8');
  console.log('  ── 反例：只有 index.html 的空壳 ──');
  const emptyFailures = [];
  judge(empty, emptyFailures);
  console.log(`  （空壳红了 ${emptyFailures.length} 条，应为 ≥3）`);
  if (emptyFailures.length < 3) mainFailures.push('bundle.emptyShellDidNotFail');
  rmSync(empty, { recursive: true, force: true });
}

console.log(`\nJS ${Math.round(main.jsBytes / 1024)}KB / CSS ${Math.round(main.cssBytes / 1024)}KB ｜ 失败 ${mainFailures.length} 条`);
if (mainFailures.length > 0) {
  for (const f of mainFailures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('verify:ohos-bundle ✅');
