#!/usr/bin/env node
/**
 * Electron 启动器 —— 存在的唯一理由是清掉一个非常隐蔽的环境变量。
 *
 * `ELECTRON_RUN_AS_NODE=1` 会让 electron.exe **退化成普通 Node 进程**：
 * 它不再起 GUI，而是把你的 main 脚本当 Node 脚本执行。
 * 表现是 `require('electron')` 返回一个字符串路径、`app` 为 undefined，
 * 报错信息与真实原因完全对不上（通常是 "Cannot read properties of undefined"）。
 *
 * 这个变量常被宿主工具（IDE / 集成终端 / 打包好的 Electron 应用）注入到子进程环境里，
 * 所以"我这里能跑、你那里白屏"很可能就是它。
 *
 * 与其在 README 里写一句注意事项，不如在启动处直接删掉 —— 它在本项目里永远是错的。
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// electron 包导出的是可执行文件路径（见其 index.js）
const electronPath = require('electron');

const env = { ...process.env };
delete env['ELECTRON_RUN_AS_NODE'];

const forwarded = process.argv.slice(2);
console.log(`[launch] ${electronPath} . ${forwarded.join(' ')}`);

const child = spawn(electronPath, ['.', ...forwarded], {
  cwd: PKG_ROOT,
  stdio: 'inherit',
  env,
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[launch] electron 被信号终止：${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});

child.on('error', (err) => {
  console.error('[launch] 启动 electron 失败：', err);
  process.exit(1);
});
