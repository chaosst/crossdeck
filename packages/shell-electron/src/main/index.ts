import { app, BrowserWindow, globalShortcut } from 'electron';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs, setRuntimeConfig } from './runtimeConfig.js';
import {
  denyAllPermissions,
  installDevCsp,
  registerAppScheme,
  serveRenderer,
} from './appProtocol.js';
import { createWindow, setDevServerUrl } from './windows.js';
import { registerHandlers, registeredChannelList, grantWorkspaceForSelfCheck } from './handlers.js';
import { activeUpstream, flushAllRuns, stopAllRuns } from './agentRuntime.js';
import { startDevServer } from './devServer.js';
import { prepareScopeFixture, runSelfCheck } from './selfcheck.js';
import { closeSessionRepo, configureSessionDb, ensureSessionRepo } from './sessionDb/index.js';
import { currentAccountKey, overrideBaseUrl } from './navigate/session.js';
import { runUpdateFeedProbe } from './updateProbe.js';
import { scheduleStartupUpdateCheck } from './updater.js';

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

/** 本地 id 生成器：前缀 + 时间 + 随机，够本地唯一。 */
const makeId = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;

const config = parseArgs(process.argv);
setRuntimeConfig(config);

// 自检环境里既没有 navigate 服务器也没有凭据：先把上游置成脚本上游，
// 让不依赖凭据的探针跑得起来；登录与假 SSE 场景由自检自己切。
if (config.selfcheck) overrideBaseUrl(null);

// 用户数据目录默认取 package.name，会得到 `@crossdeck/shell-electron` 这种带 scope 的怪路径。
// 显式命名一次，缓存/日志/单实例锁的位置都是可预期的（且方便清理）。
app.setName('crossdeck');

// 自检的凭据、设置、会话库一律关进 dist/selfcheck —— 否则会写到开发机**真实**的
// userData 里：① 留下一份体验账号凭据；② 下一轮自检读到上一轮留下的 token，
// 于是"有没有登录"这件事每跑一次都不一样。
// 每轮先清空：不清的话上一轮那次登录会被下一轮当成"用户已经登录"，
// 登录闸门这条断言从此永远走不到。
// 必须在 app ready 之前设置：handler 与 tokenStore 都在 ready 之后才解析路径。
if (config.selfcheck) {
  const selfcheckUserData = join(__dirname, '..', '..', 'dist', 'selfcheck', 'userData');
  try {
    rmSync(selfcheckUserData, { recursive: true, force: true });
  } catch (err) {
    console.warn('[crossdeck] 自检 userData 没清干净：', err);
  }
  app.setPath('userData', selfcheckUserData);
}

// 自检 / 更新探针跑在 CI / 无头 / 受限环境里，那里 GPU 进程经常直接崩：
//   GPU process exited unexpectedly → FATAL: GPU process isn't usable. Goodbye.（退出码 3）
// 此时窗口还没画出来，截图与 DOM 断言全都拿不到。
// 这两条路径只需要渲染出 DOM 并截图，软件渲染完全够用，所以彻底关掉 GPU。
// 正常 dev / start 不受影响，保持硬件加速。
if (config.selfcheck || config.updateProbe) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
}

// 自检 / 探针模式必须能并发跑（否则上一次没退干净就再也没有下一次），故不加锁。
if (!config.selfcheck && !config.updateProbe && !app.requestSingleInstanceLock()) {
  app.exit(0);
}

registerAppScheme();

// pkgRoot = packages/shell-electron（__dirname 是 dist/main）
const PKG_ROOT = join(__dirname, '..', '..');

const gotLock = !config.selfcheck && !config.updateProbe;

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

    // 会话库要在注册 handler **之前**打开：迁移失败就不该起窗口，
    // 否则用户点开第一个会话才会看到「库版本不兼容」。
    // 自检用独立目录 —— 写进用户真实 userData 会让假会话永久留在列表里；
    // 每轮再清一次，否则会话数会一轮轮涨上去，报告里的数字失去可比性。
    const sessionDir = join(PKG_ROOT, 'dist', 'selfcheck', 'sessions');
    if (config.selfcheck) {
      try {
        rmSync(sessionDir, { recursive: true, force: true });
      } catch (err) {
        console.warn('[crossdeck] 自检会话库没清干净：', err);
      }
    }
    configureSessionDb({
      dir: config.selfcheck ? sessionDir : join(app.getPath('userData'), 'sessions'),
      deps: { now: () => Date.now(), newId: makeId },
    });
    const repo = ensureSessionRepo(currentAccountKey());
    console.log(`[crossdeck] 会话库：${currentAccountKey()}（${repo.listSessions().length} 个会话）`);

    const channelCount = registerHandlers();
    console.log(`[crossdeck] 已注册 IPC 通道 ${channelCount} 个：${registeredChannelList().join(', ')}`);

    // 上游现在存在配置里（随用户改），所以这条日志只能在 ready 之后打 ——
    // 模块加载时读它就得碰 userData 路径，那时 app 还没 ready。
    const upstream = activeUpstream();
    console.log(
      upstream.kind === 'navigate'
        ? `[crossdeck] 上游：navigate @ ${upstream.baseUrl}`
        : '[crossdeck] 上游：脚本上游（离线可跑；UI 需如实标注，别当成真上游）',
    );

    const selfcheckOutDir = join(PKG_ROOT, 'dist', 'selfcheck');

    // 自检要验证 scope 边界，而无头环境弹不出系统授权对话框 ——
    // 所以预先造一个夹具目录并**走与用户点击完全相同的 grant 路径**授权它。
    // 抄近路（直接往表里塞一条）会让自检验证一条用户永远走不到的分支。
    const fixture = config.selfcheck ? prepareScopeFixture(selfcheckOutDir) : null;
    if (fixture !== null) {
      const ws = grantWorkspaceForSelfCheck(fixture.root);
      console.log(`[crossdeck] 自检夹具工作区：${ws.id} → ${ws.root}（symlink: ${fixture.symlink.status}）`);
    }

    const mainWindow = createWindow('main');

    if (config.updateProbe) {
      // 更新 feed 探针：跑完「检查 → 发现新版本 → 下载 → 就绪」再退出。
      // 这里同样不 await 后续流程 —— 探针的收尾由 scripts/verify-update-feed.mjs
      // 依哨兵强杀进程树完成（受限会话里 app.exit 未必能结束进程，同 selfcheck）。
      const code = await runUpdateFeedProbe(mainWindow, config.expectVersion);
      app.exit(code);
      return;
    }

    if (config.selfcheck) {
      if (fixture === null) {
        // 走到这里说明自检开关与夹具准备脱节了。直接失败而不是继续跑 ——
        // 没有夹具的"自检通过"是假的：scope 与背压断言全都会被跳过。
        console.error('[crossdeck] 自检模式缺少 scope 夹具，无法验证越界断言 —— 直接判失败');
        app.exit(1);
        return;
      }
      const code = await runSelfCheck(
        mainWindow,
        selfcheckOutDir,
        channelCount,
        registeredChannelList(),
        fixture,
      );
      // 快路径：正常环境下 app.exit 立即结束进程。
      // 受限会话里它可能卡在残留的 GPU/viz 子进程上 —— 那种情况由
      // launch.mjs 收到 `[selfcheck] DONE` 哨兵后强杀进程树收尾。
      app.exit(code);
      return;
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow('main');
    });

    // 启动后自己查一次更新。**自检与探针模式必须跳过** —— 自检断言"推送恰好 1 条
    // update:status"，多一次启动检查会把计数打乱，而那种失败看起来会像
    // 推送通道坏了，排查方向完全错；探针模式下它会变成轨迹里第二条 checking。
    scheduleStartupUpdateCheck();
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
  // 关库前先把没落盘的草稿写完，顺序反了会丢最后一个节流窗口。
  flushAllRuns();
  closeSessionRepo();
});

// 主进程异常不能静默 —— 没有这个的话进程会直接消失，日志里什么都不留
process.on('uncaughtException', (err) => {
  console.error('[crossdeck] 未捕获异常：', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[crossdeck] 未处理的 Promise 拒绝：', reason);
});
