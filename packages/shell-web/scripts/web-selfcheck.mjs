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
 * 判定来源：**以应用打印的哨兵为准**（`[selfcheck] DONE ok=… code=…`），
 * 不挂"进程能不能退出" —— Edge 后台进程在本机受限会话里同样可能收不干净，但结论已经拿到了。
 *
 * ⚠️ 但哨兵**不是唯一**的判据，另外两件事也会把退出码拉红：
 *   ① core 导出核验失败 —— 报告里那张绑定表就成了没人核对的字符串
 *   ② 报告里没有上游链路结论（`probe.navRan !== true`）—— 这次自检少了一整块结论
 *   它们的失败形态恰恰是"❌ 一条都没有、退出码却是 1"。**只看 ❌ 行会把它判成"存活"**
 *   （变异 M7 就是这个形状），所以判定必须同时看退出码。
 *
 * ── 假上游（T13）──
 * 静态服务器**同一个端口**上挂了一个假 navigate 上游：同源是唯一被支持的部署形态
 * （凭据是同源 httpOnly cookie，跨源带不上也过不了 CORS）。它下发场景词表，
 * 自检页据此跑「真的连上了 / 终态恰好一个（含断流）/ abort 有效」三条。
 * 帧解析的细粒度断言**只在 `scripts/verify-core-sse.mjs`** —— 不在这里再抄一套。
 *
 * ── 变异测试（2026-10-09，7 发 7 杀，存活 0 条）──
 * | id | 变异                                              | 被谁杀掉                                        |
 * |----|-------------------------------------------------|----------------------------------------------|
 * | M1 | Web 壳 abort 只 `stream.cancel()`，不 `ac.abort()` | `nav.abortSeenByPeer`（对端没看见连接被关）           |
 * | M2 | core：干净 EOF 当**正常收尾**（截断被吞掉）              | `nav.silent-close.{terminal,code,message}` ×3   |
 * | M3 | core：终态**多投递一次**                             | 5×`exactlyOneTerminal` + 2 条反向断言            |
 * | M4 | 假上游：killed 改成干净 EOF（两条断流路径合成一条）        | `nav.killed.message`（**只有它**）                |
 * | M5 | 假上游：去掉 cookie 闸门（对谁都放行）                    | `nav.anonymous{IsRejected,SawNoText}` ×2        |
 * | M6 | Web 壳诊断把凭据形态报成 `token` 而不是 `cookie`        | `nav.authIsCookie`                              |
 * | M7 | 自检页不再上报 `probe.navRan`                        | ❌ 一条都没有，**退出码 1** ← 只看 ❌ 会漏判            |
 *
 * M4 是先做变异、才发现缺断言的：两条断流路径只断言"都是 error / UPSTREAM"时，
 * 把它们合成一条照样绿 —— 而合成恰恰会漏掉另一条路径上的失败模式。
 * 补上 `messageIncludes`（"没收到 done 帧" / "读取上游流失败"）之后才杀得掉。
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
// ① 假 navigate 上游 —— 与静态站点**同一个服务器**
//
// 为什么必须同源：Web 壳的凭据是**同源 httpOnly cookie**，而同源是唯一被支持的
// 部署形态（跨源既被 CORS 挡、又带不上 cookie）。换一个端口就是跨源 ——
// 那测出来的不是这个壳真实会走的那条路，而是"一个更方便的上游"。
//
// 场景词表由 `GET /__selfcheck/nav-fixture` **下发给页面**：页面不硬编码任何一个
// 字符串。词表漂移时页面根本拿不到 fixture，自检当场红 —— 不可能静默通过。
//
// 场景名与 Electron 壳那份（`shell-electron/src/main/fakeNavigateUpstream.ts`）
// 保持一致：两端的假上游说同一套话，将来换成同一个真上游时口径不用二次对齐。
//
// ⚠️ 只在 `?selfcheck=1` 这条路径上被用到，不属于任何用户路径。
// ─────────────────────────────────────────────────────────────
const NAV_SCENARIO_PROMPTS = {
  normal: 'selfcheck:navigate-normal',
  'silent-close': 'selfcheck:navigate-close',
  killed: 'selfcheck:navigate-killed',
  'upstream-error': 'selfcheck:navigate-error',
  abort: 'selfcheck:navigate-abort',
};
const NAV_NORMAL_CHUNKS = ['SELF', 'CHECK-', 'NAV', 'IGATE-', 'OK!!'];

/**
 * `chatPath` / `doneLiteral` 由调用方从 **core 的真实产物** 注入（而不是在这里
 * 再抄一遍 `'/api/resume/chat'`）—— 抄一份就等于给"协议漂移"留了一条静默通道。
 */
function createFakeNavigate({ chatPath, doneLiteral }) {
  const liveTokens = new Set();
  const timers = new Set();
  let seq = 0;
  const stats = { logins: 0, frames: {}, ended: [], doneSent: [], clientGone: [], unknown: [] };

  const json = (res, status, payload) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(payload));
  };

  const cookieToken = (req) => {
    for (const part of String(req.headers.cookie ?? '').split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() === 'navigate_session') return part.slice(eq + 1).trim();
    }
    return null;
  };

  const readBody = async (req) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8');
  };

  const openSse = (res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('connection', 'keep-alive');
    // `flushHeaders()` 不能省：不 flush 的话浏览器要等服务端攒够一定字节才收到首字节，
    // 于是"逐帧到达"会退化成"一次性到齐"，首帧超时也会假触发。
    res.flushHeaders();
  };

  const scenarioFor = (question) => {
    for (const [name, prompt] of Object.entries(NAV_SCENARIO_PROMPTS)) {
      if (prompt === question) return name;
    }
    return null;
  };

  const streamScenario = (scenario, res) => {
    openSse(res);
    stats.frames[scenario] = 0;

    let stopped = false;
    let timer = null;
    /**
     * 服务端**自己**掐断（killed 场景）时要置位。
     *
     * 不然 `close` 那一判会把"我把它杀了"也算成"客户端跑了" ——
     * 于是 `clientGone` 里混进一个假条目，而它正是 abort 那条断言**唯一**的证据来源。
     * 测量本身不干净，结论就没法信。
     */
    let killedByUs = false;

    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (timer !== null) {
        clearInterval(timer);
        timers.delete(timer);
      }
    };

    // 「客户端断开了吗」的判据是 `close` 且**没写过 end** 且**不是我们自己杀的** ——
    // 正常写完也会 close，单看 close 会把每个正常请求都算成断开。
    res.on('close', () => {
      if (!res.writableEnded && !killedByUs && !stats.clientGone.includes(scenario)) {
        stats.clientGone.push(scenario);
      }
      stop();
    });

    const frame = (event, data) => {
      res.write(`event: ${event}\ndata: ${data}\n\n`);
      if (event === 'token') stats.frames[scenario] = (stats.frames[scenario] ?? 0) + 1;
      if (event === 'done') stats.doneSent.push(scenario);
    };

    if (scenario === 'abort') {
      // 慢慢滴：给客户端留出"中途点停止"的时间窗。停不下来（= 没断连）时本定时器会一直跑，
      // 由收尾的 `close()` 兜住 —— 所以下面每一拍都先自查 `stopped`。
      timer = setInterval(() => {
        if (stopped || res.writableEnded || res.destroyed) return stop();
        frame('token', JSON.stringify('滴'));
      }, 60);
      timers.add(timer);
      return;
    }

    let i = 0;
    timer = setInterval(() => {
      if (stopped || res.writableEnded || res.destroyed) return stop();

      if (i < NAV_NORMAL_CHUNKS.length) {
        frame('token', JSON.stringify(NAV_NORMAL_CHUNKS[i]));
        i += 1;
        return;
      }

      stop();
      switch (scenario) {
        case 'normal':
          frame('done', doneLiteral);
          stats.ended.push(scenario);
          res.end();
          return;
        case 'upstream-error':
          frame('error', JSON.stringify('SELFCHECK：上游故意报错'));
          stats.ended.push(scenario);
          res.end();
          return;
        case 'silent-close':
          // 干净 EOF，**不发 done** —— 客户端应据此判"被截断"。
          stats.ended.push(scenario);
          res.end();
          return;
        case 'killed':
          // 粗暴断开：客户端读到的是**流错误**，不是 EOF。两条路必须都覆盖。
          // 置位再 destroy —— 这是**我们**杀的，不是客户端跑的（见 killedByUs 的说明）。
          killedByUs = true;
          res.destroy();
          return;
        default:
          return;
      }
    }, 20);
    timers.add(timer);
  };

  const fixture = {
    chatPath,
    scenarios: NAV_SCENARIO_PROMPTS,
    normalChunks: NAV_NORMAL_CHUNKS,
    normalText: NAV_NORMAL_CHUNKS.join(''),
    /** 一个必然不被认识的场景名 —— 页面拿它做反例（证明前面的场景是"被认出来"的）。 */
    unknownPrompt: 'selfcheck:navigate-not-a-scenario',
  };

  const handle = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');

    if (req.method === 'GET' && url.pathname === '/__selfcheck/nav-fixture') {
      json(res, 200, fixture);
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/__selfcheck/nav-stats') {
      json(res, 200, stats);
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/login/guest') {
      seq += 1;
      const token = `selfcheck-cookie-${seq}`;
      liveTokens.add(token);
      stats.logins += 1;
      // 真上游的凭据是 httpOnly cookie，同时响应体里也回一份 token（照抄真形状）。
      res.setHeader('set-cookie', `navigate_session=${token}; Path=/; HttpOnly; SameSite=Lax`);
      json(res, 200, { token, role: 'guest', expiresIn: 1800, next: '/' });
      return true;
    }
    if (req.method === 'POST' && url.pathname === chatPath) {
      const token = cookieToken(req);
      // 与真上游同一条闸门：没有有效 cookie 就是 401。
      // 页面靠它验证"未登录 / 已登录"这条反向路径确实被上游鉴权挡住。
      if (token === null || !liveTokens.has(token)) {
        json(res, 401, { error: 'unauthorized' });
        return true;
      }

      let question = '';
      try {
        const parsed = JSON.parse(await readBody(req));
        if (parsed !== null && typeof parsed === 'object' && 'question' in parsed) {
          question = String(parsed.question);
        }
      } catch {
        // body 不是 JSON 就当空 question —— 下面按"不认识的场景"回 400。
      }

      const scenario = scenarioFor(question);
      if (scenario === null) {
        if (!stats.unknown.includes(question)) stats.unknown.push(question);
        json(res, 400, { error: `自检假上游不认识这个场景：${question}` });
        return true;
      }
      streamScenario(scenario, res);
      return true;
    }
    return false;
  };

  return {
    stats,
    handle,
    close: () => {
      for (const t of timers) clearInterval(t);
      timers.clear();
    },
  };
}

// ─────────────────────────────────────────────────────────────
// ② 静态服务器（127.0.0.1 是"潜在可信来源"，OPFS 需要安全上下文）
// ─────────────────────────────────────────────────────────────
function startStaticServer(fake) {
  return new Promise((resolvePromise, reject) => {
    const server = createServer(async (req, res) => {
      // 假上游先过一道：它是**同源**的 API 路由，和静态文件共用一个 server。
      if (await fake.handle(req, res)) return;

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

  // core 的真实产物**提前**加载：它同时给下面两处用 ——
  //   ① 假上游要照抄 core 里的路径 / 终态字面量（不许在这里再抄一遍）
  //   ② 报告里的 core 绑定名核验（这一条本来就在，只是挪到前面）
  // core 的 `exports` 指向 `src/index.ts`（Vite 能编译 TS，裸 Node 不能），
  // 所以这里加载的是 `tsc -b` 的产物 —— 与 `verify-core-scope.mjs` 同一条路。
  const coreEntry = join(REPO_ROOT, 'packages', 'core', 'dist', 'index.js');
  if (!existsSync(coreEntry)) {
    console.error(`[web-selfcheck] 缺少 ${coreEntry} —— 先跑 pnpm typecheck`);
    process.exit(2);
  }
  const core = await import(pathToFileURL(coreEntry).href);

  const fake = createFakeNavigate({
    chatPath: core.NAVIGATE_CHAT_PATH,
    doneLiteral: core.NAVIGATE_DONE_LITERAL,
  });
  const { server, port } = await startStaticServer(fake);
  const url = `http://127.0.0.1:${port}/?selfcheck=1`;
  console.log(`[web-selfcheck] 静态站点已起：${url}`);
  console.log(`[web-selfcheck] 同源假上游已挂上：${core.NAVIGATE_CHAT_PATH}`);
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
    // core 产物已经在 `main()` 开头加载过了（假上游的路径 / 终态字面量也来自它），
    // 这里直接复用 —— 少一次 import，也少一处"两份产物"的可能。
    // 没有这一步，报告里的绑定名就只是一张没人核对的字符串表。
    let coreVerification;
    try {
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

    // 页面必须**真的跑过**上游链路那一段（`probe.navRan` 由 selfcheck.ts 置位）。
    // 少了它，报告里就没有"连上了 / 终态恰好一个 / abort 有效"这三条证据 ——
    // 而"报告里没有这一项"最容易被当默认通过，所以这里把它变成一次硬的失败。
    const navRan = report?.probe?.navRan === true;
    if (!navRan) {
      console.error('[web-selfcheck] 报告里没有上游链路结论（probe.navRan !== true）—— 自检页与假上游没配套');
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
      /** 假上游那一侧的观察 —— "abort 真断了连接"唯一的证据在**对端**，不在客户端自己的说辞里。 */
      navUpstreamStats: fake.stats,
      screenshot: 'docs/evidence/web-shell.png',
    };
    const reportPath = join(EVIDENCE_DIR, 'web-selfcheck.json');
    await writeFile(reportPath, `${JSON.stringify(archived, null, 2)}\n`);

    console.log(`[web-selfcheck] 哨兵：${sentinel.raw}`);
    console.log(
      `[web-selfcheck] 假上游：登录 ${fake.stats.logins} 次 · 观察到断连 [${fake.stats.clientGone.join(',')}] · ` +
        `发过 done [${fake.stats.doneSent.join(',')}]`,
    );
    if (report !== null) {
      console.log(`[web-selfcheck] 断言项：${Object.keys(report.probe ?? {}).length}`);
      if ((report.failures ?? []).length > 0) {
        console.log('[web-selfcheck] 失败项：');
        for (const f of report.failures) console.log(`  - ${f}`);
      }
    }
    console.log(`[web-selfcheck] 证据：docs/evidence/web-selfcheck.json`);
    console.log(`[web-selfcheck] 截图：docs/evidence/web-shell.png`);

    // 判定以哨兵为准，但另外两件事也会把退出码拉红：
    //   · core 导出核验 —— 它失败意味着报告里那条证据是假的
    //   · 上游链路没跑 —— 意味着这次自检少了一整块结论
    const coreOk = coreVerification.checked && coreVerification.missing.length === 0;
    exitCode = sentinel.code === 0 && coreOk && navRan ? 0 : 1;
    cdp.close();
  } catch (err) {
    console.error(`[web-selfcheck] ${err instanceof Error ? err.message : String(err)}`);
    exitCode = 1;
  } finally {
    if (!keepOpen) killTree(child.pid);
    fake.close(); // 假上游的定时器（abort 场景那个）必须停，否则事件循环不放行
    server.close();
    await rm(udd, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`[web-selfcheck] exit=${exitCode}`);
  process.exit(exitCode);
}

await main();
