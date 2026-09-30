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

  hardenWebContents(win);
  loadRenderer(win, kind);

  // show: false → ready-to-show → show，避免白屏闪烁
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });

  return win;
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
