#!/usr/bin/env node
/**
 * 显式拉取 Electron 二进制。
 *
 * 为什么需要这一步：
 *   electron 44 起**取消了 postinstall**（`package.json` 里没有 scripts 字段），
 *   二进制不再在 `pnpm install` 时自动下载，只留了一个 bin：`install-electron`。
 *   结果就是：装完依赖能 import、能通过类型检查，
 *   但 `pnpm dev` 会在启动瞬间报 "Electron failed to install correctly"。
 *
 * 这一步只有做与不做，没有中间态 —— 与其在 README 里写一句"记得手动跑"，不如给个脚本。
 * install.js 自带 isInstalled() 判断，重复执行是幂等的。
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON_DIR = join(PKG_ROOT, 'node_modules', 'electron');

// 国内镜像：Electron 的 release 资源在默认源上很慢甚至超时。
// 已经显式设置过就不覆盖（允许用户换源）。
process.env.ELECTRON_MIRROR ||= 'https://npmmirror.com/mirrors/electron/';

if (!existsSync(join(ELECTRON_DIR, 'install.js'))) {
  console.error('❌ 找不到 node_modules/electron —— 先跑 pnpm install');
  process.exit(1);
}

const versionFile = join(ELECTRON_DIR, 'dist', 'version');
const pathFile = join(ELECTRON_DIR, 'path.txt');
const alreadyInstalled = existsSync(versionFile) && existsSync(pathFile);

if (alreadyInstalled) {
  console.log(`✅ Electron 二进制已存在（${readFileSync(versionFile, 'utf8').trim()}）—— 跳过下载`);
  process.exit(0);
}

const version = JSON.parse(readFileSync(join(ELECTRON_DIR, 'package.json'), 'utf8')).version;
console.log(`⏳ 开始下载 Electron ${version} 二进制`);
console.log(`   镜像：${process.env.ELECTRON_MIRROR}`);
console.log('   体积约 240MB，首次会比较慢。\n');

// install.js 是 CJS 且会自行处理 isInstalled / 解压 / 写 path.txt
require(join(ELECTRON_DIR, 'install.js'));
