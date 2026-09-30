#!/usr/bin/env node
/**
 * 构建脚本 —— main / preload / renderer 三个产物一次出。
 *
 * 为什么 main 与 preload 用 esbuild 打包而不是 tsc 直出：
 *
 *   1. **preload 必须是 CJS**。`sandbox: true` 下 Electron 不支持 ESM preload，
 *      而本包 package.json 是 `"type": "module"`，tsc 只会产出 ESM。
 *      用 esbuild 打成单个 .cjs 是唯一干净的解法（tsc 不能让产物改扩展名）。
 *
 *   2. **workspace 依赖指向 TS 源码**（contract / core 的 exports 是 ./src/index.ts）。
 *      打包可以把它们内联进来，Node 运行时就不需要能加载 .ts 了。
 *      否则得给每个内部包加一遍 build 步骤和 dist 路径映射。
 *
 * 全程零子进程：esbuild 的 JS API 与 vite 的 build API 都在进程内。
 */

import { readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const mainOnly = process.argv.includes('--main-only');

/** main 与 preload 共用的编译选项。 */
const NODE_BUNDLE = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  logLevel: 'warning',
  // electron 由运行时提供（打进去会炸）
  // vite 只在 --dev 下被动态 import，绝不能进生产包
  external: ['electron', 'vite'],
};

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} kB`;
}

function report(label, file) {
  const abs = join(PKG_ROOT, file);
  const size = statSync(abs).size;
  console.log(`  ${label.padEnd(10)} ${relative(PKG_ROOT, abs).replace(/\\/g, '/').padEnd(32)} ${kb(size)}`);
}

async function buildMain() {
  await esbuild.build({
    ...NODE_BUNDLE,
    entryPoints: [join(PKG_ROOT, 'src', 'main', 'index.ts')],
    outfile: join(PKG_ROOT, 'dist', 'main', 'index.cjs'),
  });
}

async function buildPreload() {
  await esbuild.build({
    ...NODE_BUNDLE,
    entryPoints: [join(PKG_ROOT, 'src', 'preload', 'bridge.ts')],
    outfile: join(PKG_ROOT, 'dist', 'preload', 'bridge.cjs'),
  });
}

async function buildRenderer() {
  const { build } = await import('vite');

  // 用 configFile 而不是内联配置：dev 与 build 必须走**同一份**配置，
  // 否则最容易出现的 bug 是"dev 正常、build 白屏"。
  await build({
    configFile: join(PKG_ROOT, 'vite.config.ts'),
    root: join(PKG_ROOT, 'src', 'renderer'),
    logLevel: 'warn',
  });
}

console.log('── 构建 crossdeck shell-electron ───────────────');

rmSync(join(PKG_ROOT, 'dist', 'main'), { recursive: true, force: true });
rmSync(join(PKG_ROOT, 'dist', 'preload'), { recursive: true, force: true });

await buildMain();
await buildPreload();

if (!mainOnly) {
  await buildRenderer();
}

console.log('  产物：');
report('main', join('dist', 'main', 'index.cjs'));
report('preload', join('dist', 'preload', 'bridge.cjs'));
if (!mainOnly) {
  // 渲染入口文件名带内容哈希，读一下真实产物名
  const html = readFileSync(join(PKG_ROOT, 'dist', 'renderer', 'index.html'), 'utf8');
  const hit = html.match(/assets\/index-[\w-]+\.js/);
  console.log(`  renderer   dist/renderer/index.html ← ${hit ? hit[0] : '(未找到入口脚本)'}`);
}

console.log(mainOnly ? '✅ main / preload 构建完成（renderer 走 dev server）' : '✅ 全部产物构建完成');
