/**
 * 游客登录跳转的端到端探针。
 *
 * 跑法（必须在 shell-electron 目录下，先构建产物）：
 *   node scripts/build.mjs
 *   "$(node -p "require('electron')")" scripts/verify-login-redirect.cjs --no-sandbox --disable-gpu
 *
 * 它加载的是**生产产物**（dist/renderer + dist/preload/bridge.cjs），
 * 只把 main 侧 IPC 换成桩 —— 而"登录后跳转"整件事都发生在渲染层，
 * main 不参与。所以这里验的是**产物里的路由行为**，不是"我写的等价代码"。
 *
 * 两个场景：
 *   A 登录失败 → 不许跳转，且失败原文必须可见（否则按钮看起来像"点了没反应"）
 *   B 登录成功 → hash 退掉 #/login，界面切到 App
 *
 * 鉴别力（实测）：把 main.tsx 的 hashchange 监听拿掉（= 修复前的行为）后重新构建再跑，
 * 11 条里挂 2 条 —— B1「App 已挂载」、B3「登录页已卸载」。
 * ⚠️ 同一次跑里 B2「hash 不再是 #/login」**保持绿**：改 hash 这步本来就生效，
 *    失效的是"没有任何人据此重渲染"。这正是用户看到的那副样子。
 *    只盯着"hash 变了没有"会得到一句"已修复"的假结论 —— 承重断言是 B1/B3。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const { createServer } = require('node:http');
const { readFileSync, existsSync } = require('node:fs');
const { join, extname } = require('node:path');

const PKG = join(__dirname, '..');
const RENDERER = join(PKG, 'dist', 'renderer');
const PRELOAD = join(PKG, 'dist', 'preload', 'bridge.cjs');

/** 'ok' = 登录成功；'fail' = 上游拒绝（真实最常见的那条：没配上游地址）。 */
let loginMode = 'fail';
let loginCalls = 0;
let upstreamStatusCalls = 0;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};

const statusEnvelope = () => ({
  ok: true,
  value: {
    upstream: { kind: 'navigate', baseUrl: 'http://127.0.0.1:3001' },
    login: {
      hasToken: false,
      role: null,
      expiresAt: null,
      encrypted: true,
      persisted: false,
      note: '',
    },
  },
});

ipcMain.handle('navigate:status', () => {
  upstreamStatusCalls += 1;
  return statusEnvelope();
});

ipcMain.handle('navigate:login-guest', () => {
  loginCalls += 1;
  if (loginMode === 'fail') {
    return {
      ok: false,
      error: {
        __crossdeckError: true,
        code: 'BAD_REQUEST',
        message: '还没有配置上游地址 —— 先填一个（形如 http://127.0.0.1:3001），再点登录',
      },
    };
  }
  return { ok: true, value: { role: 'guest', expiresInSec: 600, expiresAt: 1893456000000 } };
});

// App 启动会读这几条 —— 给空值，免得启动失败干扰断言。
ipcMain.handle('session:list', () => ({ ok: true, value: [] }));
ipcMain.handle('workspace:list', () => ({ ok: true, value: [] }));
ipcMain.handle('system:info', () => ({
  ok: true,
  value: {
    platform: 'win32',
    appVersion: '0.0.0-probe',
    locale: 'zh-CN',
    osVersion: 'probe',
    capabilities: [],
  },
}));

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  ok  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const step = (msg) => console.log(`[probe] ${msg}`);

async function main() {
  step('main() 进入');
  // 产物是 <script type="module">，file:// 会被 CORS 拦（见 appProtocol.ts）——
  // 探针用一次性 http 服务器喂它，效果等同生产里的 app:// 协议。
  const server = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = join(RENDERER, rel);
    if (!file.startsWith(RENDERER) || !existsSync(file)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  step(`静态服务器就绪 127.0.0.1:${port}`);
  step(`preload 存在=${existsSync(PRELOAD)} 产物存在=${existsSync(join(RENDERER, 'index.html'))}`);

  const win = new BrowserWindow({
    width: 1120,
    height: 760,
    show: false,
    webPreferences: {
      preload: PRELOAD,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 渲染层的 console / 加载失败全部转到主进程 —— 白屏时最需要看到的就是这两样。
  win.webContents.on('console-message', (event) => {
    const msg = typeof event === 'object' && event !== null && 'message' in event ? event.message : '';
    console.log(`[renderer] ${msg}`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.log(`[probe] did-fail-load ${code} ${desc} ${url}`);
  });

  const js = (expr) => win.webContents.executeJavaScript(expr, true);

  /**
   * 等到条件成立，返回成立与否 —— **不抛**。
   *
   * 抛出去会把后面几条承重断言一起吞掉，于是变异体只留下一句"探针崩溃"，
   * 看起来像"没跑"而不是"断言被杀掉了"。每条断言必须独立出结论。
   */
  const settleWhen = async (expr, timeoutMs = 8000) => {
    const started = Date.now();
    for (;;) {
      if (await js(expr)) return true;
      if (Date.now() - started > timeoutMs) return false;
      await new Promise((r) => setTimeout(r, 80));
    }
  };

  const ON_LOGIN = `!!document.querySelector('#login-account')`;
  const ON_APP = `!!document.querySelector('[data-testid="boot-status"]')`;
  const HASH = `window.location.hash`;
  const CLICK_GUEST = `(() => {
    const b = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === '获取体验账号');
    if (!b) throw new Error('没找到「获取体验账号」按钮');
    b.click();
    return true;
  })()`;

  // ═══ 场景 A：登录失败 —— 不许跳转，且必须把原因说出来 ═══
  loginMode = 'fail';
  await win.loadURL(`http://127.0.0.1:${port}/index.html`);
  const bootedLogin = await settleWhen(ON_LOGIN);
  record('A1 无凭据时渲染的是登录页', bootedLogin);

  const bootHash = await js(HASH);
  record('A2 无凭据时落在 #/login', bootHash === '#/login', `hash=${bootHash}`);

  await js(CLICK_GUEST);
  const errShown = await settleWhen(`!!document.querySelector('[data-testid="login-error"]')`);
  record('A3 登录失败的原因已呈现给用户', errShown);

  const failHash = await js(HASH);
  record('A4 登录失败后 hash 不动', failHash === '#/login', `hash=${failHash}`);
  record('A5 登录失败后仍停在登录页', await js(ON_LOGIN));
  record('A6 登录失败后没有误挂 App', (await js(ON_APP)) === false);
  record('A7 失败确实来自真通道', loginCalls === 1, `login-guest 调用 ${loginCalls} 次`);

  // ═══ 场景 B：登录成功 —— hash 退掉 #/login，界面切到 App ═══
  loginMode = 'ok';
  await win.loadURL(`http://127.0.0.1:${port}/index.html`);
  await settleWhen(ON_LOGIN);

  await js(CLICK_GUEST);
  const switched = await settleWhen(ON_APP);
  record('B1 登录成功后 App 已挂载', switched);

  const okHash = await js(HASH);
  record('B2 登录成功后 hash 不再是 #/login', okHash !== '#/login', `hash="${okHash}"`);
  record('B3 登录成功后登录页已卸载', (await js(ON_LOGIN)) === false);
  record('B4 跳转发生在真实状态读数之后', upstreamStatusCalls >= 2, `navigate:status ${upstreamStatusCalls} 次`);

  server.close();
  win.destroy();
}

// 挂死比失败更糟（分不清"过了"和"没跑"）—— 兜底硬停。
setTimeout(() => {
  console.log('[probe] 看门狗触发 —— 探针挂死，强制结束');
  app.exit(9);
}, 45000).unref();

app.whenReady().then(async () => {
  console.log('[probe] app ready');
  try {
    await main();
  } catch (err) {
    record('探针自身崩溃', false, err instanceof Error ? err.message : String(err));
  }
  const failed = results.filter((r) => !r.pass);
  console.log(
    `\n[login-redirect-probe] 共 ${results.length} 条，失败 ${failed.length} 条`,
  );
  app.exit(failed.length === 0 ? 0 : 1);
});
