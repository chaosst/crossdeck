import { app, BrowserWindow, globalShortcut } from 'electron';
import { join } from 'node:path';
import { parseArgs, setRuntimeConfig } from './runtimeConfig.js';
import {
  denyAllPermissions,
  installDevCsp,
  registerAppScheme,
  serveRenderer,
} from './appProtocol.js';
import { createWindow, setDevServerUrl } from './windows.js';
import { registerHandlers, registeredChannelList } from './handlers.js';
import { stopAllRuns } from './agentRuntime.js';
import { startDevServer } from './devServer.js';
import { runSelfCheck } from './selfcheck.js';

/**
 * main 进程入口 —— 启动顺序在这里，且顺序本身是有讲究的：
 *
 *   1. 解析开关         （后面所有分支都依赖它）
 *   2. registerSchemesAsPrivileged
 *      —— **必须在 app ready 之前**，这是 Electron 的硬要求，
 *         放到 ready 之后只会静默失效（协议变回非特权，fetch/stream 全不通）
 *   3. 单实例锁
 *   4. app.whenReady
 *   5. 安全基线（权限收口）
 *   6. 渲染层来源（dev: 内嵌 Vite / prod: app:// 协议）
 *   7. 注册 IPC handler
 *   8. 开窗
 */

const config = parseArgs(process.argv);
setRuntimeConfig(config);

// 用户数据目录默认取 package.name，会得到 `@crossdeck/shell-electron` 这种带 scope 的怪路径。
// 显式命名一次，缓存/日志/单实例锁的位置都是可预期的（且方便清理）。
app.setName('crossdeck');

// 自检跑在 CI / 无头 / 受限环境里，那里 GPU 进程经常直接崩：
//   GPU process exited unexpectedly → FATAL: GPU process isn't usable. Goodbye.（退出码 3）
// 此时窗口还没画出来，截图与 DOM 断言全都拿不到。
// 自检只需要渲染出 DOM 并截图，软件渲染完全够用，所以彻底关掉 GPU。
// 正常 dev / start 不受影响，保持硬件加速。
if (config.selfcheck) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
}

// 自检模式必须能并发跑（否则上一次没退干净就再也没有下一次），故不加锁。
if (!config.selfcheck && !app.requestSingleInstanceLock()) {
  app.exit(0);
}

registerAppScheme();

// pkgRoot = packages/shell-electron（__dirname 是 dist/main）
const PKG_ROOT = join(__dirname, '..', '..');

const gotLock = !config.selfcheck;

app.whenReady().then(async () => {
  try {
    if (gotLock) {
      app.on('second-instance', () => {
        const [existing] = BrowserWindow.getAllWindows();
        if (existing) {
          if (existing.isMinimized()) existing.restore();
          existing.focus();
        }
      });
    }

    // Windows 任务栏分组/通知需要它，否则通知会显示为 electron.app.Electron
    app.setAppUserModelId('site.crossdeck.app');

    // 安全基线：不需要摄像头/麦克风/定位/通知等任何一项权限
    denyAllPermissions();

    if (config.dev) {
      // --dev：渲染层由内嵌的 Vite dev server 提供（HMR 可用）
      installDevCsp();
      const url = await startDevServer(PKG_ROOT);
      setDevServerUrl(url);
      console.log(`[crossdeck] dev server: ${url}`);
    } else {
      // 生产：app:// 协议 + 严格 CSP
      serveRenderer(join(__dirname, '..', 'renderer'));
    }

    const channelCount = registerHandlers();
    console.log(`[crossdeck] 已注册 IPC 通道 ${channelCount} 个：${registeredChannelList().join(', ')}`);

    const mainWindow = createWindow('main');

    if (config.selfcheck) {
      const code = await runSelfCheck(
        mainWindow,
        join(PKG_ROOT, 'dist', 'selfcheck'),
        channelCount,
        registeredChannelList(),
      );
      app.exit(code);
      return;
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow('main');
    });
  } catch (err) {
    console.error('[crossdeck] 启动失败：', err);
    app.exit(1);
  }
});

app.on('window-all-closed', () => {
  stopAllRuns();
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopAllRuns();
});

// 主进程异常不能静默 —— 没有这个的话进程会直接消失，日志里什么都不留
process.on('uncaughtException', (err) => {
  console.error('[crossdeck] 未捕获异常：', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[crossdeck] 未处理的 Promise 拒绝：', reason);
});
