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

import { spawn, spawnSync } from 'node:child_process';
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
const isSelfCheck = forwarded.includes('--selfcheck');
console.log(`[launch] ${electronPath} . ${forwarded.join(' ')}`);

/**
 * 强杀整棵进程树。
 *
 * Windows 上 `child.kill()` 只杀直接子进程，Chromium 的 GPU / renderer / utility
 * 进程会全部变成孤儿继续占着内存与文件锁 —— 所以必须用 `taskkill /T`。
 */
function killTree(pid) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 已经退了 */
    }
  }
}

/**
 * 自检收尾 —— 监督进程的职责，不是被监督进程的。
 *
 * 背景（实测）：受限会话里 Chromium 可能**无法干净退出** —— `app.exit()` 会卡在
 * 残留的 GPU / viz 子进程上。此时主进程的事件循环已经停摆，连兜底的
 * `setTimeout(() => process.exit())` 都不会触发（实测确认）。
 * 结果是 `pnpm selfcheck` 永远不返回，校验链挂在"能不能退出"而不是"断言过没过"。
 *
 * 做法：应用在报告落盘后打印 `[selfcheck] DONE ok=<bool> code=<n>`，
 * 这里收到哨兵 → 宽限一小段 → 强杀进程树 → 以**哨兵里的判定**为退出码。
 * 另设一个硬上限兜底：连哨兵都没等到（比如页面白屏导致探针挂死）就判失败。
 */
const SELFCHECK_HARD_LIMIT_MS = 180_000;
const SELFCHECK_GRACE_MS = 800;
const DONE_RE = /\[selfcheck\] DONE ok=(true|false) code=(\d+)/;

let child;

if (isSelfCheck) {
  // 自检要读 stdout 才能看到哨兵，所以这一路改成 pipe 并原样转发（dev / start 不受影响）
  child = spawn(electronPath, ['.', ...forwarded], {
    cwd: PKG_ROOT,
    stdio: ['inherit', 'pipe', 'inherit'],
    env,
  });

  let settled = false;
  const settle = (code, why) => {
    if (settled) return;
    settled = true;
    if (why) console.error(`[launch] ${why}`);
    killTree(child.pid);
    process.exit(code);
  };

  const hardLimit = setTimeout(
    () => settle(1, `自检 ${SELFCHECK_HARD_LIMIT_MS / 1000}s 内未收到完成哨兵 —— 判失败并强制结束`),
    SELFCHECK_HARD_LIMIT_MS,
  );
  hardLimit.unref();

  let buffered = '';
  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    buffered += chunk.toString('utf8');
    const m = DONE_RE.exec(buffered);
    if (m === null) return;
    clearTimeout(hardLimit);
    const code = Number(m[2]);
    const ok = m[1] === 'true';
    // 报告已经落盘，判定也已经出来了 —— 剩下的只是"进程能不能退"，
    // 而那件事不该影响成败。宽限一小段给正常退出机会，然后强杀收尾。
    setTimeout(() => {
      if (settled) return;
      settled = true;
      console.error(
        `[launch] 报告已落盘且判定为 ${ok ? 'ok' : 'fail'}，但主进程未自行退出（受限会话常见）—— 强制结束进程树`,
      );
      killTree(child.pid);
      process.exit(code);
    }, SELFCHECK_GRACE_MS).unref();
  });

  child.on('exit', (code, signal) => {
    clearTimeout(hardLimit);
    if (settled) return;
    settled = true;
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
} else {
  child = spawn(electronPath, ['.', ...forwarded], {
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
}
