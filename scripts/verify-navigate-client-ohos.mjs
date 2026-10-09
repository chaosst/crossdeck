#!/usr/bin/env node
/**
 * 鸿蒙壳 navigate IO 验收（`shell-ohos/entry/src/main/ets/navigate/*`）。
 *
 * 为什么不能只靠 `pnpm verify:ohos`：
 *
 *   ① 它需要**在线模拟器**，而本机不一定有；没有时它按设计 `skipped + exit 2`，
 *      等于这条链路平时**根本没有回归能力**。
 *   ② 它测的是"端到端能跑通"，测不出壳侧那几条**规则**（首帧超时、静默关闭、
 *      cancel 真断连、非 2xx 要报得出状态码）。
 *
 * 所以这里把鸿蒙壳的 `.ets` 直接喂给 Node：用 esbuild 的进程内 JS API 打包，
 * 把 `@kit.NetworkKit` / `@kit.ArkTS` / `@kit.BasicServicesKit` 三个平台模块
 * **换成进程内的假实现**（真的打到本机的一个 node:http 假 SSE 上游），
 * 于是"鸿蒙壳的 IO 逻辑"可以在 0 依赖、无子进程、无模拟器的情况下被断言。
 *
 *   ⚠️ 它证明的是**我们写的接线逻辑**；`@ohos.net.http` 自身的真实行为
 *      （尤其"非 2xx 时到底发不发 dataEnd"）只有真机能定，见文件末尾「待真机确认」。
 *
 * 与 `verify-navigate-client.mjs`（Electron / Web 两端）是**同一个思路的第三端**：
 * 同一个假上游 helpers、同一个手动时钟、同一套"恰好一个终态"的收尾断言。
 *
 * 零依赖（除仓库自己的 esbuild devDependency）、**无子进程**。
 *
 * `../shared/core/index` 是 `pnpm sync:ohos` 复制出来的 **gitignore 生成产物**，fresh clone
 * 上不存在 —— 本脚本用 esbuild `onResolve` 把它指回 `packages/core/dist`，于是不依赖生成物
 * （副本新鲜度由 `verify:shared-fresh` 单独保证），也因此**可以进 `pnpm verify` 链**。
 * ⚠️ **不能用 `alias`**：esbuild 的 alias 只接受**非相对**的键，写 `'../shared/core/index'`
 *    会报 `Invalid alias name` 并让整条链挂掉（实测撞过）。
 * 鉴别力记录：把 `shared/core` 整个挪走 → **带插件仍 49/49 通过**、**去掉插件立刻 ❌**
 *    （证明②真走了插件，不是"副本还在所以看着绿"）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 变异测试记录（确认这些断言有鉴别力）
 * ══════════════════════════════════════════════════════════════════
 * 做法：把 `NavigateClient.ets` / `NavigateModel.ets` 改坏一个点 → 重跑本脚本 → 数挂了几条。
 * 脚本**现场从 src 打包**，改完 src 直接重跑即可（不需要重编译）。
 * ⚠️ 两个 `.ets` 必须是 **LF**。它们原本是 CRLF（编辑器默认），多行锚点会静默失配
 *    （表现为一片 `PATCH-MISS`）—— 第一次跑变异就撞上了。
 *
 * | 变异                                          | 挂掉断言数 |
 * |----------------------------------------------|--------|
 * | O1  删 `dataReceive` 的 `markFirstByte()`       | 2 |
 * | O2  删 `dataReceive` 的终态守卫（野帧会进 sink）     | 1 |
 * | O3  `complete` 里不报状态码                       | 2 |
 * | O4  失败消息吞掉状态码与根因                        | 2 |
 * | O5  `abortUpstream` 变 no-op                    | 1 |
 * | O6  删 `dataEnd` 的 `finishStream()`             | 1 |
 * | O7  `dataEnd` 把截断当正常收尾                      | 2 |
 * | O8  没 token 也照发请求                            | 2 |
 * | O9  `decodeToString` 不用 `{ stream: true }`     | 1 |
 * | O10 body 里不带 token                            | 1 |
 * | O11 `cancel()` 里不断连                           | 2 |
 * | O12 `OhosNavigateModel` 不转发 prompt             | 1 |
 *
 * 结论：**12/12 全部杀死**。
 *
 * 两条值得记的经过：
 *   · **O4 第一次存活 0 条**（那时⑪只断言"消息里有个前缀"）—— 变异逼出了两条更强的
 *     断言：必须带状态码位、必须带底层原因。"有个前缀"这种断言抓不住"把根因吞掉"。
 *   · **O6 只挂 1 条**，因为 `complete` 回调兜住了底：静默关闭仍会报错，只是消息退化成
 *     "上游返回 HTTP 200"（少了"没收到 done"这个关键信息）。属于纵深防御 ——
 *     测试没错，是"两个地方都能报错"。
 */

import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHELL_EL = join(ROOT, 'packages', 'shell-electron');
const OHOS_NAV = join(ROOT, 'packages', 'shell-ohos', 'entry', 'src', 'main', 'ets', 'navigate');

// ─────────────────────────────────────────────────────────────
// 极简断言器（与其余 verify-*.mjs 同款）
// ─────────────────────────────────────────────────────────────
let passed = 0;
const failures = [];

function check(what, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ✅ ${what}`);
  } else {
    failures.push(`${what}${detail === undefined ? '' : ` —— ${detail}`}`);
    console.log(`  ❌ ${what}${detail === undefined ? '' : `\n       ${detail}`}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 有界等待终态。
 *
 * ⚠️ 刻意**不**用 `await h.terminalArrived` —— 若实现的 bug 恰好是"永远不交终态"，
 *    无界等待会让整个脚本挂死，表现为"退出码非 0 但一条 ❌ 都不打"，
 *    看起来像测试没鉴别力，其实是它根本没跑到断言。有界等待把这种情况变成一条
 *    干净的 ❌（见 ⑤/⑩ 的负例）。
 */
const waitTerminal = (h) => Promise.race([h.terminalArrived, sleep(400)]);

setTimeout(() => {
  console.error('\n❌ verify-navigate-client-ohos: 超过 60s 仍未结束，判定失败（有场景挂死了）');
  process.exit(1);
}, 60_000).unref();

// ─────────────────────────────────────────────────────────────
// 假平台模块（写进临时目录，供 esbuild alias）
// ─────────────────────────────────────────────────────────────
const OUT_DIR = mkdtempSync(join(tmpdir(), 'crossdeck-ohos-nav-'));
process.on('exit', () => rmSync(OUT_DIR, { recursive: true, force: true }));
const FAKE = join(OUT_DIR, 'fakes');
mkdirSync(FAKE, { recursive: true });

const STATE_KEY = '__ohosHttpState';

writeFileSync(
  join(FAKE, 'networkkit.mjs'),
  `const state = (globalThis[${JSON.stringify(STATE_KEY)}] ??= {
  requests: [], destroyCalls: 0, chunkSize: 4096, dataEndCount: 0,
});
export const __state = state;

const RequestMethod = {
  OPTIONS: 'OPTIONS', GET: 'GET', HEAD: 'HEAD', POST: 'POST',
  PUT: 'PUT', DELETE: 'DELETE', TRACE: 'TRACE', CONNECT: 'CONNECT',
};

class FakeHttpRequest {
  constructor() { this.handlers = new Map(); this.destroyed = false; this.ac = null; }
  on(type, cb) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(cb);
  }
  emit(type, arg) { for (const cb of this.handlers.get(type) ?? []) cb(arg); }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    state.destroyCalls += 1;
    if (this.ac !== null) this.ac.abort();
  }
  requestInStream(url, options, callback) {
    state.requests.push({ url, options: { ...options, extraData: options.extraData } });
    const ac = new AbortController();
    this.ac = ac;
    (async () => {
      let status = 0;
      try {
        const res = await fetch(url, {
          method: options.method ?? 'GET',
          headers: options.header ?? {},
          body: options.extraData === undefined ? undefined : JSON.stringify(options.extraData),
          signal: ac.signal,
        });
        status = res.status;
        if (!res.ok) {
          // 按导航上游实测口径：非 2xx 走**异常路径** —— 不发 dataReceive / dataEnd，
          // 只有 complete 回调（带状态码、err 为 undefined）能告诉壳"没成"。
          callback(undefined, status);
          return;
        }
        const reader = res.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value === undefined || value.byteLength === 0) continue;
          for (let off = 0; off < value.byteLength; off += state.chunkSize) {
            const part = value.slice(off, off + state.chunkSize);
            this.emit('dataReceive', part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength));
          }
        }
        state.dataEndCount += 1;
        this.emit('dataEnd');
        callback(undefined, status);
      } catch (err) {
        // 真机上这里是 BusinessError（继承 Error）；必须也是 Error 实例，
        // 否则 core 的 errorMessage() 会退化成 String(err) = "[object Object]"。
        const message = err !== null && typeof err === 'object' && 'message' in err ? err.message : String(err);
        const e = new Error(message);
        callback(e, 0);
      }
    })();
  }
}

export const http = {
  RequestMethod,
  createHttp: () => new FakeHttpRequest(),
};
export default { http, RequestMethod };
`,
  'utf8',
);

writeFileSync(
  join(FAKE, 'arkts.mjs'),
  `export const util = {
  TextDecoder: {
    create(encoding = 'utf-8', options = {}) {
      const inner = new globalThis.TextDecoder(encoding, {
        fatal: options.fatal ?? false,
        ignoreBOM: options.ignoreBOM ?? false,
      });
      return {
        decodeToString(input, opts) {
          return inner.decode(input, { stream: (opts && opts.stream) ?? false });
        },
      };
    },
  },
};
export default { util };
`,
  'utf8',
);

writeFileSync(
  join(FAKE, 'basic.mjs'),
  `export class BusinessError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export default { BusinessError };
`,
  'utf8',
);

// ─────────────────────────────────────────────────────────────
// esbuild 打包（alias 三个平台模块 + `.ets` 当 TS 解析）
// ─────────────────────────────────────────────────────────────
const require = createRequire(import.meta.url);
let esbuild;
try {
  esbuild = await import(pathToFileURL(require.resolve('esbuild', { paths: [SHELL_EL] })).href);
} catch (err) {
  console.error('❌ 找不到 esbuild（shell-electron 的 devDependency）。先跑 `pnpm install`。');
  console.error(`   ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
if (esbuild.build === undefined) esbuild = esbuild.default;

/**
 * 鸿蒙源码 import 的 `../shared/core/index` 是 `pnpm sync:ohos` 复制出来的副本 ——
 * 那是 **gitignore 的生成产物**，fresh clone 上不存在。指回 core 的 dist，
 * 于是本脚本不依赖生成物（副本新鲜度由 `verify:shared-fresh` 单独保证）。
 *
 * ⚠️ **不能用 `alias`**：esbuild 的 `alias` 只接受非相对的键，写 `'../shared/core/index'`
 * 会直接报 `Invalid alias name` 并让整条链挂掉（已实测踩过）。必须走 `onResolve`。
 */
const ohosCorePlugin = {
  name: 'ohos-shared-core',
  setup(build) {
    build.onResolve({ filter: /^\.\.\/shared\/core\/index$/ }, () => ({
      path: join(ROOT, 'packages', 'core', 'dist', 'index.js'),
    }));
  },
};

try {
  await esbuild.build({
    entryPoints: [join(OHOS_NAV, 'NavigateClient.ets'), join(OHOS_NAV, 'NavigateModel.ets')],
    outdir: join(OUT_DIR, 'ohos'),
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'warning',
    loader: { '.ets': 'ts' },
    alias: {
      '@kit.NetworkKit': join(FAKE, 'networkkit.mjs'),
      '@kit.ArkTS': join(FAKE, 'arkts.mjs'),
      '@kit.BasicServicesKit': join(FAKE, 'basic.mjs'),
    },
    plugins: [ohosCorePlugin],
  });
} catch (err) {
  console.error('❌ 打包鸿蒙 navigate 源码失败：');
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const load = (file) => import(pathToFileURL(join(OUT_DIR, 'ohos', file)).href);
const { createOhosNavigateClient } = await load('NavigateClient.mjs');
const { OhosNavigateModel } = await load('NavigateModel.mjs');
const { __state } = await import(pathToFileURL(join(FAKE, 'networkkit.mjs')).href);

if (typeof createOhosNavigateClient !== 'function') {
  console.error('❌ NavigateClient.ets 没有导出 createOhosNavigateClient');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────
// 假上游（进程内 node:http）
// ─────────────────────────────────────────────────────────────
let handler = (_req, res) => {
  res.statusCode = 500;
  res.end('no handler');
};
const requests = [];
let closedByPeer = 0;

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const entry = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    };
    requests.push(entry);
    res.on('close', () => {
      if (!res.writableEnded) closedByPeer += 1;
    });
    handler(req, res, entry);
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE_URL = `http://127.0.0.1:${server.address().port}`;

const sse = (res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  return {
    frame(event, data) {
      res.write(`event: ${event}\ndata: ${data}\n\n`);
    },
    token(text) {
      this.frame('token', JSON.stringify(text));
    },
    done() {
      this.frame('done', '__DONE__');
    },
    raw(buf) {
      res.write(buf);
    },
    end() {
      res.end();
    },
  };
};

// ─────────────────────────────────────────────────────────────
// 手动时钟（"15s 首帧超时"在 0ms 内验完）
// ─────────────────────────────────────────────────────────────
function fakeDeps() {
  let t = 1_000_000;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    every: (ms, fn) => {
      const id = ++seq;
      timers.set(id, { ms, fn });
      return () => timers.delete(id);
    },
    newId: (prefix) => `${prefix}_${++seq}`,
    fireAll() {
      for (const [id, tm] of [...timers.entries()]) {
        timers.delete(id);
        tm.fn();
      }
    },
    pending() {
      return timers.size;
    },
  };
}

function collect() {
  const chunks = [];
  const terminals = [];
  let resolveTerminal = () => {};
  const terminalArrived = new Promise((r) => {
    resolveTerminal = r;
  });
  return {
    chunks,
    terminals,
    terminalArrived,
    sink: {
      onChunk: (text) => chunks.push(text),
      onEnd: () => {
        terminals.push('end');
        resolveTerminal('end');
      },
      onError: (message) => {
        terminals.push(`error:${message}`);
        resolveTerminal(`error:${message}`);
      },
    },
    text: () => chunks.join(''),
    errors: () => terminals.filter((t) => t.startsWith('error:')),
  };
}

async function settleAndCheck(label, h, deps) {
  await sleep(40);
  check(`${label} · 恰好一个终态（不是两个）`, h.terminals.length === 1, JSON.stringify(h.terminals));
  check(`${label} · 没有残留定时器`, deps.pending() === 0, `还挂着 ${deps.pending()} 个`);
}

const reset = () => {
  __state.requests.length = 0;
  __state.destroyCalls = 0;
  __state.dataEndCount = 0;
  __state.chunkSize = 4096;
  requests.length = 0;
  closedByPeer = 0;
};

const withClient = (deps, opts = {}) =>
  createOhosNavigateClient({
    baseUrl: BASE_URL,
    getToken: () => 'TOKEN-abc',
    firstFrameTimeoutMs: 15_000,
    deps,
    ...opts,
  });

// ═════════════════════════════════════════════════════════════
console.log('\n── ① 请求形状与认证（navigate 的 getToken：?token= → body.token → cookie）──');
// ═════════════════════════════════════════════════════════════
{
  reset();
  handler = (_req, res) => {
    const w = sse(res);
    w.token('你');
    w.done();
    w.end();
  };

  const deps = fakeDeps();
  const diag = [];
  const h = collect();
  const client = withClient(deps, { onDiagnostic: (d) => diag.push(d) });
  client.streamChat({ sessionId: 's1', prompt: '你好' }, h.sink);
  await waitTerminal(h);
  await settleAndCheck('①', h, deps);

  const req = __state.requests[0];
  check('① 打到 NAVIGATE_CHAT_PATH', req?.url === `${BASE_URL}/api/resume/chat`, req?.url);
  check('① 方法 POST', req?.options?.method === 'POST', String(req?.options?.method));
  check('① body 里是 { token, question }', req?.options?.extraData?.question === '你好'
    && req?.options?.extraData?.token === 'TOKEN-abc',
    JSON.stringify(req?.options?.extraData));
  check('① 凭据不进 URL（无 ?token=）', req !== undefined && !req.url.includes('token'), req?.url);
  check('① 诊断里请求事件不带凭据',
    diag.some((d) => d.type === 'request' && !JSON.stringify(d).includes('TOKEN-abc')),
    JSON.stringify(diag.filter((d) => d.type === 'request')));
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ② 正常流：token×3 → done ──');
// ═════════════════════════════════════════════════════════════
{
  reset();
  handler = async (_req, res) => {
    const w = sse(res);
    for (const t of ['逐', '字', '来']) {
      w.token(t);
      await sleep(20);
    }
    w.done();
    w.end();
  };

  const deps = fakeDeps();
  const h = collect();
  withClient(deps).streamChat({ sessionId: 's2', prompt: 'q' }, h.sink);
  await waitTerminal(h);
  await settleAndCheck('②', h, deps);
  check('② 逐字内容完整', h.text() === '逐字来', h.text());
  check('② 终态是 end（不是 error）', h.terminals[0] === 'end', JSON.stringify(h.terminals));
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ③ 首帧到达后停住：**不许**被 15s 首帧超时误杀 ──');
// ═════════════════════════════════════════════════════════════
{
  // 这条是最该被抓住的地方：`dataReceive` 里必须摘掉首帧计时器。
  // 漏了它，任何"首帧已到、但整段回答超过 15s"的正常请求都会被 abort 掉，
  // 并且报成"上游首帧超时"——把一次**中途**的长回答说成"连都没连上"。
  reset();
  handler = (_req, res) => {
    const w = sse(res);
    w.token('首帧');
    // 之后一直挂着：不发 done、不发 error、也不关连接
  };

  const deps = fakeDeps();
  const h = collect();
  const cancel = withClient(deps).streamChat({ sessionId: 's3', prompt: 'q' }, h.sink);

  await sleep(60);
  check('③ 首帧已经收到了', h.text() === '首帧', h.text());

  const destroysBefore = __state.destroyCalls;
  deps.fireAll(); // 手动把 15s 推到：计时器若没被首帧摘掉，这里就会误报
  await sleep(40);
  check('③ 首帧摘掉了计时器 → **不**误报首帧超时', h.terminals.length === 0, JSON.stringify(h.terminals));
  check('③ 没有残留定时器（摘干净了）', deps.pending() === 0, `还挂着 ${deps.pending()} 个`);
  check('③ 也没有把连接断掉', __state.destroyCalls === destroysBefore,
    `destroy 多调了 ${__state.destroyCalls - destroysBefore} 次`);
  cancel();
  await sleep(30);
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ④ 没有凭据：同步报 error，且**不发请求** ──');
// ═════════════════════════════════════════════════════════════
{
  reset();
  handler = (_req, res) => {
    res.statusCode = 500;
    res.end('should not be called');
  };

  const deps = fakeDeps();
  const h = collect();
  withClient(deps, { getToken: () => null }).streamChat({ sessionId: 's4', prompt: 'q' }, h.sink);
  await sleep(40);
  check('④ 一个 error 终态', h.terminals.length === 1 && h.errors().length === 1, JSON.stringify(h.terminals));
  check('④ 消息点明"未登录"', (h.terminals[0] ?? '').includes('未登录'), h.terminals[0]);
  check('④ 根本没发请求', __state.requests.length === 0, JSON.stringify(__state.requests));
  check('④ 没留下定时器', deps.pending() === 0, `还挂着 ${deps.pending()} 个`);
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ⑤ 静默关闭：dataEnd 到了但**没有 done** → 必须 error ──');
// ═════════════════════════════════════════════════════════════
{
  reset();
  handler = (_req, res) => {
    const w = sse(res);
    w.token('只有半截');
    w.end(); // 没有 done 就关连接（上游被掐断 / 反代截断）
  };

  const deps = fakeDeps();
  const h = collect();
  withClient(deps).streamChat({ sessionId: 's5', prompt: 'q' }, h.sink);
  await waitTerminal(h);
  await settleAndCheck('⑤', h, deps);
  check('⑤ 报的是 error 而不是 end', h.terminals[0]?.startsWith('error:') === true, JSON.stringify(h.terminals));
  check('⑤ 消息点明"没收到 done"', (h.terminals[0] ?? '').includes('done'), h.terminals[0]);
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ⑥ cancel：只断连接，**不碰 sink** ──');
// ═════════════════════════════════════════════════════════════
{
  reset();
  handler = (_req, res) => {
    const w = sse(res);
    w.token('开始');
  };

  const deps = fakeDeps();
  const h = collect();
  const cancel = withClient(deps).streamChat({ sessionId: 's6', prompt: 'q' }, h.sink);
  await sleep(60);
  cancel();
  await sleep(60);

  check('⑥ 服务端观察到对端断了', closedByPeer >= 1, `closedByPeer=${closedByPeer}`);
  check('⑥ destroy() 真的被调用', __state.destroyCalls >= 1, String(__state.destroyCalls));
  check('⑥ sink **一个终态都没收到**', h.terminals.length === 0, JSON.stringify(h.terminals));
  check('⑥ 定时器摘掉了', deps.pending() === 0, `还挂着 ${deps.pending()} 个`);
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ⑦ 中文被切成单字节片仍完整（decodeToString 的 {stream:true} 没漏）──');
// ═════════════════════════════════════════════════════════════
{
  reset();
  __state.chunkSize = 1; // 每个字节一片 —— 最坏的多字节切分
  handler = async (_req, res) => {
    const w = sse(res);
    w.token('中文不乱码');
    w.done();
    w.end();
  };

  const deps = fakeDeps();
  const h = collect();
  withClient(deps).streamChat({ sessionId: 's7', prompt: 'q' }, h.sink);
  await waitTerminal(h);
  await settleAndCheck('⑦', h, deps);
  check('⑦ 中文没乱码', h.text() === '中文不乱码', JSON.stringify(h.text()));
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ⑧ 非 2xx：必须报得出**状态码**，不能拖到"首帧超时" ──');
// ═════════════════════════════════════════════════════════════
{
  reset();
  handler = (_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":"invalid token"}');
  };

  const deps = fakeDeps();
  const h = collect();
  withClient(deps).streamChat({ sessionId: 's8', prompt: 'q' }, h.sink);

  await sleep(80); // 等 complete 回调
  check('⑧ 已有一个 error 终态', h.terminals.length === 1, JSON.stringify(h.terminals));
  check('⑧ 消息里带 401（凭据问题），不是含糊的"首帧超时"',
    (h.terminals[0] ?? '').includes('401'), h.terminals[0]);
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ⑨ done 之后的杂散帧不许再进 sink（feed 返回 true 就得停）──');
// ═════════════════════════════════════════════════════════════
{
  reset();
  handler = async (_req, res) => {
    const w = sse(res);
    w.token('A');
    w.done();
    await sleep(30);
    w.token('B'); // done 之后的野帧
    w.end();
  };

  const deps = fakeDeps();
  const h = collect();
  withClient(deps).streamChat({ sessionId: 's9', prompt: 'q' }, h.sink);
  await waitTerminal(h);
  await sleep(120);
  check('⑨ 终态仍然只有一个', h.terminals.length === 1, JSON.stringify(h.terminals));
  check('⑨ 野帧没进 sink', h.text() === 'A', `实际内容 ${JSON.stringify(h.text())}`);
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ⑩ 首帧真的超时：报 error 并且**真的断连** ──');
// ═════════════════════════════════════════════════════════════
{
  // "上游根本没起来"是本地最常撞的一类失败，绝不能表现成界面永远转圈。
  reset();
  handler = (req, res) => {
    // 收到请求但一个字节都不回（也不给响应头）—— 模拟服务端挂住。
    res.writeHead(200, { 'content-type': 'text/event-stream' });
  };

  const deps = fakeDeps();
  const h = collect();
  const before = __state.destroyCalls;
  withClient(deps).streamChat({ sessionId: 's10', prompt: 'q' }, h.sink);

  await sleep(50);
  check('⑩ 还没到 15s：不许有任何终态', h.terminals.length === 0, JSON.stringify(h.terminals));

  deps.fireAll(); // 时间到
  await sleep(40);
  await settleAndCheck('⑩', h, deps);
  check('⑩ 报的是 error', h.terminals[0]?.startsWith('error:') === true, JSON.stringify(h.terminals));
  check('⑩ 消息点明"首帧超时"', (h.terminals[0] ?? '').includes('首帧超时'), h.terminals[0]);
  check('⑩ abortUpstream 真的把连接断了', __state.destroyCalls > before,
    `destroy 从 ${before} 变成 ${__state.destroyCalls}`);
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ⑪ 网络层失败（连不上）：必须报 error，不许永远转圈 ──');
// ═════════════════════════════════════════════════════════════
{
  reset();
  // 指向一个没人监听的端口 —— 模拟"上游没起来 / hdc rport 忘了跑"。
  handler = (_req, res) => {
    res.statusCode = 500;
    res.end('unreachable');
  };

  const deps = fakeDeps();
  const h = collect();
  withClient(deps, { baseUrl: 'http://127.0.0.1:1' }).streamChat({ sessionId: 's11', prompt: 'q' }, h.sink);
  await waitTerminal(h);
  await settleAndCheck('⑪', h, deps);
  check('⑪ 报的是 error', h.terminals[0]?.startsWith('error:') === true, JSON.stringify(h.terminals));
  const netMsg = h.terminals[0] ?? '';
  check('⑪ 消息里带地址（便于定位）', netMsg.includes('上游请求失败'), netMsg);
  // 这两条是变异 O4 逼出来的：只断言"有个前缀"抓不住"把根因吞掉"。
  check('⑪ 带上状态码位（HTTP 0 = 压根没拿到响应，与 401 可区分）',
    netMsg.includes('（HTTP 0）'), netMsg);
  check('⑪ 底层原因没被吞掉（真机上是 BusinessError 的 message）',
    netMsg.includes('fetch failed'), netMsg);
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ⑫ OhosNavigateModel：只做端口适配，不改语义 ──');
// ═════════════════════════════════════════════════════════════
{
  const seen = [];
  const fakeCancel = () => {};
  const client = {
    streamChat(req, sink) {
      seen.push(req);
      sink.onChunk('X');
      sink.onEnd();
      return fakeCancel;
    },
  };
  const deps = fakeDeps();
  const h = collect();
  const model = new OhosNavigateModel({ client, deps });
  const cancel = model.stream({ sessionId: 'sess-1', prompt: '问一句' }, h.sink);

  check('⑫ ModelRequest → ChatRequest 字段一对一搬',
    seen.length === 1 && seen[0].sessionId === 'sess-1' && seen[0].prompt === '问一句',
    JSON.stringify(seen));
  check('⑫ 原样返回 client 的取消函数', cancel === fakeCancel);
  check('⑫ sink 回调原样透传', h.text() === 'X' && h.terminals[0] === 'end',
    `${h.text()} / ${JSON.stringify(h.terminals)}`);
}

server.close();

// ─────────────────────────────────────────────────────────────
console.log('');
if (failures.length === 0) {
  console.log(`✅ verify-navigate-client-ohos：${passed} 条断言全部通过 🎉`);
  process.exit(0);
}
console.log(`❌ verify-navigate-client-ohos：${failures.length} 条失败 / 共 ${passed + failures.length} 条`);
for (const f of failures) console.log(`   - ${f}`);
process.exit(1);

/* ─────────────────────────────────────────────────────────────
 * 待真机确认（本脚本**测不到**，别当成已验）
 * ─────────────────────────────────────────────────────────────
 * ① 非 2xx 时 `@ohos.net.http` 到底发不发 `dataReceive` / `dataEnd`？
 *    本脚本按上游实测口径假设"异常路径不发 dataEnd"，于是只有 complete 回调
 *    能告知失败。真机要先 `hilog` 打一遍四个事件的顺序再定。
 * ② `requestInStream` 回调里的 `err` 是否覆盖 HTTP 401/404（还是只覆盖网络层 2300xxx）？
 *    这决定"状态码人话"该从哪儿取。
 * ③ `extraData` 作为 Object 是否被正确序列化成 JSON body（取决于 Content-Type）。
 */
