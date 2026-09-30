import { join } from 'node:path';

/**
 * 开发模式的 Vite dev server —— **内嵌进主进程**，而不是另起一个进程。
 *
 * 这是个刻意的取舍：
 *
 *   常见做法是起两个进程（vite 一个、electron 一个），用 concurrently 之类编排，
 *   再由主进程 loadURL('http://localhost:5173')。代价是：
 *     · 多一个需要维护的编排脚本，且要处理跨平台 spawn 差异
 *     · 两个进程的生命周期互相不知道 —— vite 挂了 electron 只会白屏
 *     · 端口占用 / 退出清理要靠人肉约定
 *
 *   内嵌做法的收益：`pnpm dev` 就是一条 `electron . --dev`，
 *   没有编排层、没有孤儿进程、dev server 生命周期与主进程绑定。
 *   代价：vite 成了主进程的运行时依赖（仅 dev，动态 import，不进生产包）。
 *
 * ⚠️ 路径一律用 `join(pkgRoot, ...)` 拼，不要用 `new URL(..., import.meta.url).pathname`：
 *    ① 本文件会被打成 CJS，CJS 里没有 import.meta；
 *    ② Windows 上 URL.pathname 会得到 `/D:/...` 这种非法的盘符形式。
 *
 * 生产模式完全不碰这个文件 —— 它只被 `--dev` 分支动态导入。
 */

export async function startDevServer(pkgRoot: string): Promise<string> {
  // 动态 import：生产路径下这个模块根本不会被加载。
  const { createServer } = await import('vite');

  const server = await createServer({
    configFile: join(pkgRoot, 'vite.config.ts'),
    root: join(pkgRoot, 'src', 'renderer'),
    mode: 'development',
    server: { open: false },
    // 主进程里跑，日志不要清屏（否则会被自己的输出盖掉）
    clearScreen: false,
  });

  await server.listen();

  const local = server.resolvedUrls?.local?.[0];
  if (!local) {
    throw new Error(`Vite dev server 启动后未返回本地 URL（pkgRoot=${pkgRoot}）`);
  }
  // 去掉尾部斜杠，后面拼 hash 时才不会出现 `http://host//#/settings`
  return local.replace(/\/+$/, '');
}
