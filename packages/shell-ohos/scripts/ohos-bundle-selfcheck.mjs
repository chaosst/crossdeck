#!/usr/bin/env node
/**
 * 鸿蒙 bundle 的浏览器自检运行器 —— P3-0 的关键验证件（不需要设备）。
 *
 * 同一份 `rawfile/app` 产物，在真浏览器里配一个 JS 实现的端口桩
 * （`dist-stub/ohos-stub.global.js`，经 CDP `Page.addScriptToEvaluateOnNewDocument`
 * 注入）跑完整条 `probeUi` 链路。这样把两类问题彻底分开：
 *
 *   · 桩上就红        → 打包 / 桥接 / 共享 UI 的问题（不用碰设备）
 *   · 桩绿、设备红    → 一定在 ArkTS 侧或内核侧
 *
 * 骨架（静态服务器 + 假上游 + CDP）与 `web-selfcheck.mjs` 同款 —— 那边已验过
 * 的东西不在这里重新发明，两份的差异只有「注入端口桩」这一步。
 *
 * 用法：
 *   pnpm build:web && pnpm build:stub   # 两个产物
 *   node scripts/ohos-bundle-selfcheck.mjs
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFakeNavigateUpstream } from '../../../scripts/fake-navigate-upstream.mjs';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(PKG_ROOT, '..', '..');
const APP_DIR = join(PKG_ROOT, 'entry', 'src', 'main', 'resources', 'rawfile', 'app');
const STUB_PATH = join(PKG_ROOT, 'dist-stub', 'ohos-stub.global.js');
const EVIDENCE_DIR = join(REPO_ROOT, 'docs', 'evidence');

const BROWSER_CANDIDATES = [
  process.env['CROSSDECK_BROWSER'],
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
].filter((p) => typeof p === 'string' && p.length > 0);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function startStaticServer(fake) {
  return new Promise((resolvePromise, reject) => {
    const server = createServer(async (req, res) => {
      if (await fake.handle(req, res)) return;
      const raw = (req.url ?? '/').split('?')[0];
      const rel = raw === '/' ? 'index.html' : raw.replace(/^\/+/, '');
      const target = normalize(join(APP_DIR, rel));
      if (!target.startsWith(APP_DIR)) {
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
  if (!existsSync(join(APP_DIR, 'index.html'))) {
    console.error('[ohos-bundle] 找不到 rawfile/app/index.html —— 先跑 pnpm build:ohos-web');
    process.exit(2);
  }
  if (!existsSync(STUB_PATH)) {
    console.error('[ohos-bundle] 找不到端口桩 —— 先跑 pnpm --filter @crossdeck/shell-ohos build:stub');
    process.exit(2);
  }
  if (typeof WebSocket !== 'function') {
    console.error('[ohos-bundle] 需要 Node 内建 WebSocket（Node >= 22）');
    process.exit(2);
  }
  const browser = BROWSER_CANDIDATES.find((p) => existsSync(p));
  if (browser === undefined) {
    console.error('[ohos-bundle] 找不到 Chromium 内核浏览器。可用 CROSSDECK_BROWSER 指定路径。');
    process.exit(2);
  }
  const stubSource = readFileSync(STUB_PATH, 'utf8');

  const coreEntry = join(REPO_ROOT, 'packages', 'core', 'dist', 'index.js');
  if (!existsSync(coreEntry)) {
    console.error(`[ohos-bundle] 缺少 ${coreEntry} —— 先跑 pnpm typecheck`);
    process.exit(2);
  }
  const core = await import(pathToFileURL(coreEntry).href);

  const fake = createFakeNavigateUpstream({
    chatPath: core.NAVIGATE_CHAT_PATH,
    doneLiteral: core.NAVIGATE_DONE_LITERAL,
    uploadPath: core.NAVIGATE_UPLOAD_PATH,
    mePath: core.NAVIGATE_ME_PATH,
    logoutPath: core.NAVIGATE_LOGOUT_PATH,
    // 桩的传输形态 = cookie（见桩文件头的「诚实边界」）；token-in-body 的保真度
    // 由设备链路（verify-ohos）验证，这里不重复。
    auth: 'cookie',
  });
  const { server, port } = await startStaticServer(fake);
  const url = `http://127.0.0.1:${port}/?selfcheck=1&upstream=1`;
  console.log(`[ohos-bundle] 产物已起：${url}`);
  console.log(`[ohos-bundle] 端口桩：${STUB_PATH}（${Math.round(stubSource.length / 1024)}KB）`);

  const udd = join(tmpdir(), `crossdeck-ohos-bundle-${Date.now()}`);
  await mkdir(udd, { recursive: true });

  const child = spawn(
    browser,
    [
      '--headless=new',
      '--no-sandbox',
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
    // 端口桩先于页面任何脚本就位：内联脚本注册监听 → 桩投递 port2 → rpc 拿到端口。
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: stubSource });
    await cdp.send('Page.navigate', { url });

    const SENTINEL_BUDGET_MS = 180000;
    const deadline = Date.now() + SENTINEL_BUDGET_MS;
    while (sentinel === null && Date.now() < deadline) await sleep(150);

    const evalResult = await cdp.send('Runtime.evaluate', {
      expression: "window.__selfcheckReportJson ?? ''",
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
      console.error(`[ohos-bundle] ${SENTINEL_BUDGET_MS / 1000}s 内没等到哨兵。控制台输出：`);
      for (const line of consoleLines.slice(-25)) console.error(`  ${line}`);
      throw new Error('自检没有完成（页面可能抛错或卡住）');
    }

    // 硬校验：probeUi 的流式结论必须真的跑过（与 web-selfcheck 的 navRan 同一口径）——
    // 「报告里没有这一项」最容易被当默认通过。
    const streamRan = report?.probe?.uiStream !== undefined;
    if (!streamRan) {
      console.error('[ohos-bundle] 报告里没有流式结论（probe.uiStream 缺失）—— probeUi 链路没跑完');
    }

    await sleep(400);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await mkdir(EVIDENCE_DIR, { recursive: true });
    await writeFile(join(EVIDENCE_DIR, 'ohos-bundle-stub.png'), Buffer.from(shot.data, 'base64'));

    const archived = {
      ...(report ?? { ok: sentinel.ok, failures: ['报告未取到'] }),
      ranAt: report?.ranAt ?? new Date().toISOString(),
      served: 'packages/shell-ohos/entry/src/main/resources/rawfile/app（与设备同一份产物）',
      stub: 'dist-stub/ohos-stub.global.js（浏览器桩，见桩文件头的诚实边界）',
      browser,
      navUpstreamStats: fake.stats,
      screenshot: 'docs/evidence/ohos-bundle-stub.png',
      console: report?.ok === true ? [] : consoleLines.slice(-40),
    };
    await writeFile(join(EVIDENCE_DIR, 'ohos-bundle-selfcheck.json'), `${JSON.stringify(archived, null, 2)}\n`);

    console.log(`[ohos-bundle] 哨兵：${sentinel.raw}`);
    console.log(
      `[ohos-bundle] 假上游：登录 ${fake.stats.logins} 次 · 断连 [${fake.stats.clientGone.join(',')}] · done [${fake.stats.doneSent.join(',')}]`,
    );
    if (report !== null) {
      console.log(`[ohos-bundle] 断言项：${Object.keys(report.probe ?? {}).length}`);
      if ((report.failures ?? []).length > 0) {
        console.log('[ohos-bundle] 失败项：');
        for (const f of report.failures) console.log(`  - ${f}`);
        if (consoleLines.length > 0) {
          console.log('[ohos-bundle] 页内控制台（末 15 行）：');
          for (const line of consoleLines.slice(-15)) console.log(`  ${line}`);
        }
      }
    }
    console.log('[ohos-bundle] 证据：docs/evidence/ohos-bundle-selfcheck.json');
    console.log('[ohos-bundle] 截图：docs/evidence/ohos-bundle-stub.png');

    exitCode = sentinel.code === 0 && streamRan ? 0 : 1;
    cdp.close();
  } catch (err) {
    console.error(`[ohos-bundle] ${err instanceof Error ? err.message : String(err)}`);
    exitCode = 1;
  } finally {
    killTree(child.pid);
    fake.close();
    server.close();
    await rm(udd, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`[ohos-bundle] exit=${exitCode}`);
  process.exit(exitCode);
}

await main();
