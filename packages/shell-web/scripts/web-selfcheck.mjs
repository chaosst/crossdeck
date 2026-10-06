#!/usr/bin/env node
/**
 * Web 壳端到端自检运行器。
 *
 * 它要回答的问题是「core 在浏览器里真的跑起来了吗」——所以必须**真开一个浏览器**。
 * 编译通过只证明静态层面没有 node 依赖，证明不了运行时。
 *
 * 零依赖：静态服务器用 node:http 手写，CDP 用 Node 内建的 WebSocket。
 * 引 puppeteer/playwright 当然更省事，但那样"证明 core 无平台假设"的脚本
 * 自己先拖进来两百兆 —— 说服力会打折。
 *
 * 判定来源与 Electron 壳一致：**以应用打印的哨兵为准**，不挂进程退出码。
 * Edge 后台进程在本机受限会话里同样可能收不干净，但结论已经拿到了。
 *
 * 用法：
 *   node packages/shell-web/scripts/web-selfcheck.mjs
 *   node packages/shell-web/scripts/web-selfcheck.mjs --keep-open   # 不关浏览器，便于人肉看
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(PKG_ROOT, '..', '..');
const SITE_DIR = join(PKG_ROOT, 'dist', 'site');
const EVIDENCE_DIR = join(REPO_ROOT, 'docs', 'evidence');

const keepOpen = process.argv.includes('--keep-open');

// ─────────────────────────────────────────────────────────────
// 浏览器发现：只用系统既有的 Chromium 内核浏览器，不下载任何东西
// ─────────────────────────────────────────────────────────────
const BROWSER_CANDIDATES = [
  process.env['CROSSDECK_BROWSER'],
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter((p) => typeof p === 'string' && p.length > 0);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ─────────────────────────────────────────────────────────────
// ① 静态服务器（127.0.0.1 是"潜在可信来源"，OPFS 需要安全上下文）
// ─────────────────────────────────────────────────────────────
function startStaticServer() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer(async (req, res) => {
      const raw = (req.url ?? '/').split('?')[0];
      const rel = raw === '/' ? 'index.html' : raw.replace(/^\/+/, '');
      // 目录穿越防护：normalize 之后必须仍在 SITE_DIR 内
      const target = normalize(join(SITE_DIR, rel));
      if (!target.startsWith(SITE_DIR)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      try {
        const body = await readFile(target);
        res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' });
        res.end(body);
      } catch {
        res.writeHead(404).end('not found');
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolvePromise({ server, port: addr.port });
    });
  });
}

// ─────────────────────────────────────────────────────────────
// ② CDP 客户端（Node 内建 WebSocket）
// ─────────────────────────────────────────────────────────────
class Cdp {
  #ws;
  #id = 0;
  #pending = new Map();
  #listeners = [];

  static async connect(wsUrl) {
    const cdp = new Cdp();
    cdp.#ws = new WebSocket(wsUrl);
    await new Promise((resolvePromise, reject) => {
      cdp.#ws.addEventListener('open', resolvePromise, { once: true });
      cdp.#ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
    });
    cdp.#ws.addEventListener('message', (ev) => cdp.#onMessage(ev.data));
    return cdp;
  }

  #onMessage(data) {
    const msg = JSON.parse(typeof data === 'string' ? data : String(data));
    if (msg.id !== undefined) {
      const pending = this.#pending.get(msg.id);
      if (pending === undefined) return;
      this.#pending.delete(msg.id);
      if (msg.error !== undefined) pending.reject(new Error(JSON.stringify(msg.error)));
      else pending.resolve(msg.result);
      return;
    }
    for (const fn of this.#listeners) fn(msg);
  }

  on(fn) {
    this.#listeners.push(fn);
  }

  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((resolvePromise, reject) => {
      this.#pending.set(id, { resolve: resolvePromise, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.#ws.close();
    } catch {
      /* 已经断了就算了 */
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await sleep(100);
  }
  return false;
}

async function httpJson(url) {
  const res = await fetch(url);
  return res.json();
}

function killTree(pid) {
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      // Windows 上 child.kill() 只杀直接子进程，Chromium 的子孙会留下来
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    /* 已经没了 */
  }
}

// ─────────────────────────────────────────────────────────────
async function main() {
  if (!existsSync(join(SITE_DIR, 'index.html'))) {
    console.error(`[web-selfcheck] 找不到 ${SITE_DIR}/index.html —— 先跑 pnpm --filter @crossdeck/shell-web build`);
    process.exit(2);
  }
  if (typeof WebSocket !== 'function') {
    console.error('[web-selfcheck] 需要 Node 内建 WebSocket（Node >= 22）');
    process.exit(2);
  }
  const browser = BROWSER_CANDIDATES.find((p) => existsSync(p));
  if (browser === undefined) {
    console.error('[web-selfcheck] 找不到 Chromium 内核浏览器。可用 CROSSDECK_BROWSER 指定路径。');
    process.exit(2);
  }

  const { server, port } = await startStaticServer();
  const url = `http://127.0.0.1:${port}/?selfcheck=1`;
  console.log(`[web-selfcheck] 静态站点已起：${url}`);
  console.log(`[web-selfcheck] 浏览器：${browser}`);

  const udd = join(tmpdir(), `crossdeck-web-selfcheck-${Date.now()}`);
  await mkdir(udd, { recursive: true });

  const child = spawn(
    browser,
    [
      '--headless=new',
      '--no-sandbox', // 本机受限会话里 Chromium 自己的沙箱起不来（见 README 排查表）
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--window-size=1000,900',
      '--remote-debugging-port=0',
      `--user-data-dir=${udd}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const portFile = join(udd, 'DevToolsActivePort');
  let exitCode = 1;
  let report = null;
  let sentinel = null;
  const consoleLines = [];

  try {
    if (!(await waitForFile(portFile, 20000))) {
      throw new Error('浏览器没有写出 DevToolsActivePort —— 启动失败');
    }
    const [devtoolsPort] = (await readFile(portFile, 'utf8')).split('\n');
    const targets = await httpJson(`http://127.0.0.1:${devtoolsPort.trim()}/json/list`);
    const page = targets.find((t) => t.type === 'page');
    if (page === undefined) throw new Error('没有可用的 page target');

    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    cdp.on((msg) => {
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = msg.params.args
          .map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? '')))
          .join(' ');
        consoleLines.push(`[${msg.params.type}] ${text}`);
        if (text.includes('[selfcheck] DONE')) {
          const m = /ok=(\w+)\s+code=(\d+)/.exec(text);
          if (m !== null) sentinel = { ok: m[1] === 'true', code: Number(m[2]), raw: text };
        }
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        consoleLines.push(`[exception] ${msg.params.exceptionDetails?.exception?.description ?? ''}`);
      }
    });

    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url });

    // 等哨兵 —— 判定以它为准，不靠固定等待
    const deadline = Date.now() + 60000;
    while (sentinel === null && Date.now() < deadline) await sleep(150);

    const evalResult = await cdp.send('Runtime.evaluate', {
      expression: "document.getElementById('selfcheck-report')?.textContent ?? ''",
      returnByValue: true,
    });
    const reportText = evalResult.result?.value ?? '';
    if (reportText.length > 0) {
      try {
        report = JSON.parse(reportText);
      } catch {
        report = null;
      }
    }

    if (sentinel === null) {
      console.error('[web-selfcheck] 60s 内没等到哨兵。控制台输出：');
      for (const line of consoleLines.slice(-25)) console.error(`  ${line}`);
      throw new Error('自检没有完成（页面可能抛错或卡住）');
    }

    // 核验页面上报的 core 绑定名确实是 @crossdeck/core 的导出。
    // 页面里拿不到可靠的名字（压缩器会把类名改写成单字母），所以这一步只能在这里做。
    //
    // 加载的是 `packages/core/dist`（`tsc -b` 的产物），而不是 `@crossdeck/core`：
    // core 的 `exports` 指向 `src/index.ts`（Vite 能编译 TS，裸 Node 不能）。
    // dist 与 src 是同一份代码的编译前后 —— verify-core-scope.mjs 也走的这条路。
    // 没有这一步，报告里的绑定名就只是一张没人核对的字符串表。
    let coreVerification;
    try {
      const coreEntry = join(REPO_ROOT, 'packages', 'core', 'dist', 'index.js');
      if (!existsSync(coreEntry)) {
        throw new Error(`缺少 ${coreEntry} —— 先跑 pnpm typecheck`);
      }
      const core = await import(pathToFileURL(coreEntry).href);
      const names = report?.coreBindingsImported ?? [];
      const missing = names.filter((n) => !(n in core));
      coreVerification = {
        checked: true,
        source: 'packages/core/dist/index.js',
        reportedBindings: names.length,
        packageExportCount: Object.keys(core).length,
        missing,
      };
      console.log(
        `[web-selfcheck] core 导出核验：${names.length} 个绑定全部存在（dist 共 ${coreVerification.packageExportCount} 个导出）`,
      );
      if (missing.length > 0) {
        console.error(`[web-selfcheck] 这些绑定在 core 里不存在：${missing.join(', ')}`);
      }
    } catch (err) {
      coreVerification = { checked: false, error: err instanceof Error ? err.message : String(err) };
      console.error(`[web-selfcheck] core 导出核验失败：${coreVerification.error}`);
    }

    // 截图：先让浏览器把最后一帧画完
    await sleep(400);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await mkdir(EVIDENCE_DIR, { recursive: true });
    const shotPath = join(EVIDENCE_DIR, 'web-shell.png');
    await writeFile(shotPath, Buffer.from(shot.data, 'base64'));

    const archived = {
      ...(report ?? { ok: sentinel.ok, failures: ['报告未取到'] }),
      ranAt: report?.ranAt ?? new Date().toISOString(),
      served: 'packages/shell-web/dist/site（构建产物，不是 dev server）',
      browser,
      coreVerification,
      screenshot: 'docs/evidence/web-shell.png',
    };
    const reportPath = join(EVIDENCE_DIR, 'web-selfcheck.json');
    await writeFile(reportPath, `${JSON.stringify(archived, null, 2)}\n`);

    console.log(`[web-selfcheck] 哨兵：${sentinel.raw}`);
    if (report !== null) {
      console.log(`[web-selfcheck] 断言项：${Object.keys(report.probe ?? {}).length}`);
      if ((report.failures ?? []).length > 0) {
        console.log('[web-selfcheck] 失败项：');
        for (const f of report.failures) console.log(`  - ${f}`);
      }
    }
    console.log(`[web-selfcheck] 证据：docs/evidence/web-selfcheck.json`);
    console.log(`[web-selfcheck] 截图：docs/evidence/web-shell.png`);

    // 判定以哨兵为准，但"core 导出核验"也会把退出码拉红 ——
    // 它失败意味着报告里那条证据是假的，不能算通过。
    const coreOk = coreVerification.checked && coreVerification.missing.length === 0;
    exitCode = sentinel.code === 0 && coreOk ? 0 : 1;
    cdp.close();
  } catch (err) {
    console.error(`[web-selfcheck] ${err instanceof Error ? err.message : String(err)}`);
    exitCode = 1;
  } finally {
    if (!keepOpen) killTree(child.pid);
    server.close();
    await rm(udd, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`[web-selfcheck] exit=${exitCode}`);
  process.exit(exitCode);
}

await main();
