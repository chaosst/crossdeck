import { BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import type { WindowKind } from '@crossdeck/contract';
import { APP_ORIGIN } from './appProtocol.js';
import { runtimeConfig } from './runtimeConfig.js';

/**
 * 窗口工厂 —— 安全基线集中在这一处。
 *
 * Electron 的安全问题几乎全部来自 `webPreferences` 配错，
 * 所以这里不提供"可选的宽松模式"：所有窗口都走同一套最严配置，
 * 需要放宽的场景（比如真的要 <webview>）再单独评审，而不是留个开关。
 */

/** preload 必须是 CJS：sandbox: true 下 Electron 不支持 ESM preload。 */
export const PRELOAD_PATH = join(__dirname, '..', 'preload', 'bridge.cjs');

/** 各窗口种类在渲染层的落点。Web 壳会把同样的 kind 映射成 window.open。 */
const HASH_BY_KIND: Record<WindowKind, string> = {
  main: '',
  session: '#/session',
  settings: '#/settings',
  inspector: '#/inspector',
  login: '#/login'
};

const BASE_WEB_PREFERENCES = {
  preload: PRELOAD_PATH,
  // ── 三件套：缺一不可 ─────────────────────────────
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  // ── 其余攻击面收口 ───────────────────────────────
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webviewTag: false,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  spellcheck: false,
} as const;

export function createWindow(kind: WindowKind): BrowserWindow {
  const isMain = kind === 'main';

  const win = new BrowserWindow({
    width: isMain ? 1120 : 760,
    height: isMain ? 760 : 540,
    minWidth: 560,
    minHeight: 400,
    show: false,
    backgroundColor: '#f6f5f2',
    autoHideMenuBar: true,
    title: isMain ? 'crossdeck' : `crossdeck · ${kind}`,
    webPreferences: { ...BASE_WEB_PREFERENCES },
  });

  if (devToolsAllowed()) {
    attachDevTools(win);
    // 开在 loadURL **之前**：模块求值、首次 render 之前抛出来的错才收得到。
    // 挂到 did-finish-load 上会漏掉整个启动阶段 —— 而那恰恰是最需要看的一段。
    //
    // activate: false —— 自动弹出来的调试器不该把焦点从应用窗口抢走；
    // 手动按快捷键的那条路径才把它带到前台（见 attachDevTools）。
    win.webContents.openDevTools({ mode: 'detach', activate: false });
  }

  hardenWebContents(win);
  loadRenderer(win, kind);

  // show: false → ready-to-show → show，避免白屏闪烁
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });

  return win;
}

/**
 * 这个窗口是否允许开 DevTools。
 *
 * 三个"不"的理由：
 *   · 发布形态（既没 `--dev` 也没 `--devtools`）不开 —— DevTools 是渲染进程里
 *     一个能跑任意脚本、能直接调 preload 那座桥的控制台。webPreferences 收得再严，
 *     留着它就从另一扇门把收益还回去一半。
 *   · selfcheck / updateProbe 不开 —— 那两条路是要出**证据**的（截图 + DOM 断言），
 *     多一个窗口既是干扰源，在禁用 GPU 的受限环境里也是最容易把进程拖崩的东西。
 *   · 其余情况开（开发中，或用户显式要求）。
 */
function devToolsAllowed(): boolean {
  const { dev, devtools, selfcheck, updateProbe } = runtimeConfig();
  if (selfcheck || updateProbe) return false;
  return dev || devtools;
}

/**
 * DevTools 接线的两条边：打开策略 + 键盘开关。
 *
 * **为什么开成 detach 而不是默认的贴边停靠**：停靠会压缩页面视口宽度，
 * 于是"我看到的布局"和"用户看到的布局"就不是同一个了 —— 这个项目的
 * 自检截图与布局调试都按真实视口宽度做判断，让调试器改变它太容易自欺。
 * （实测 detach 下 `window.innerWidth` = 1104，与 1120 窗口宽一致，视口没被吃掉。）
 *
 * **为什么自己接键盘，不靠 Electron 的默认菜单**：默认菜单里确实有
 * Toggle Developer Tools（Ctrl+Shift+I），但菜单一旦被 `setApplicationMenu`
 * 换掉就没了，而且 `autoHideMenuBar` 下得按 Alt 才摸得到。挂在
 * `before-input-event` 上，行为与菜单是否存在无关。
 *
 * **为什么不用 globalShortcut**：那是系统级快捷键，会从别的应用手里抢键。
 * 调试开关不该有这种权力。
 *
 * 🔴 **已知限制（实测，别照着社区答案改回去）**：快捷键只在**应用窗口**聚焦时
 * 生效。有人会告诉你"再给 `webContents.devToolsWebContents` 挂一份就行"——
 * 在本项目实测（Electron 44.4.5）**不成立**：
 *   · DevTools 窗口不在 `BrowserWindow.getAllWindows()` 里，拿不到 BrowserWindow；
 *   · `devToolsWebContents.getOwnerBrowserWindow()` 返回的是**被检查的主窗口**；
 *   · `devToolsWebContents`（`getType() === 'remote'`）**从不发 `before-input-event`**
 *     —— 挂上去的监听器一次都不会被调用。
 * 所以那段监听器已被删除而不是留在代码里假装能用。当前可用的关闭方式：
 * 应用窗口聚焦时按 F12 / Ctrl+Shift+I，或直接点 DevTools 窗口自己的关闭按钮。
 * （自动打开时用了 `activate: false`，焦点默认留在应用窗口，正常路径下 F12 立刻可用。）
 */
function attachDevTools(win: BrowserWindow): void {
  const { webContents } = win;

  webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    // F12 是肌肉记忆；Ctrl+Shift+I 沿用 Chromium 原生那套组合，不自创。
    const isF12 = input.key === 'F12';
    const isStdCombo = input.control && input.shift && input.key.toLowerCase() === 'i';
    if (!isF12 && !isStdCombo) return;

    event.preventDefault();
    if (webContents.isDevToolsOpened()) {
      webContents.closeDevTools();
    } else {
      // 手动按的 —— 用户刚表达了"我要看它"，这一路才带到前台
      webContents.openDevTools({ mode: 'detach', activate: true });
    }
  });
}

function loadRenderer(win: BrowserWindow, kind: WindowKind): void {
  const hash = HASH_BY_KIND[kind];
  const { dev } = runtimeConfig();
  // dev 一律走内嵌 Vite（含 --dev --selfcheck，这样开发链路也能被真实验证）；
  // 只有不带 --dev 时才加载生产产物 —— 那才是"发布前要验的东西"。
  const devUrl = dev ? devServerUrl() : null;

  if (devUrl) {
    void win.loadURL(`${devUrl}${hash}`);
  } else {
    void win.loadURL(`${APP_ORIGIN}/index.html${hash}`);
  }
}

let resolvedDevUrl: string | null = null;

export function setDevServerUrl(url: string): void {
  resolvedDevUrl = url;
}

function devServerUrl(): string | null {
  return resolvedDevUrl;
}

/**
 * 渲染进程硬约束：
 *   - 不允许开新窗口（需要新窗口时走 window:open 通道，由 main 显式创建）
 *   - 不允许导航到外部地址：外链一律交给系统浏览器
 *   - 不允许挂 <webview>
 */
function hardenWebContents(win: BrowserWindow): void {
  const { webContents } = win;

  webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:$/.test(new URL(url).protocol)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  webContents.on('will-navigate', (event, url) => {
    const isDev = url.startsWith('http://localhost:');
    const isApp = url.startsWith(`${APP_ORIGIN}/`);
    // 开发模式下 Vite HMR 会触发同源导航，必须放行
    if (isDev || isApp) return;

    event.preventDefault();
    if (/^https?:$/.test(new URL(url).protocol)) {
      void shell.openExternal(url);
    }
  });

  webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}
