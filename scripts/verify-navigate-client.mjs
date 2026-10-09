#!/usr/bin/env node
/**
 * navigate **IO 层**验收（Electron / Web 两端各一份实现）。
 *
 *   Electron：`shell-electron/src/main/navigate/{client,model}.ts`
 *   Web     ：`shell-web/src/navigate/{client,model}.ts`
 *   共用         ：`core/src/net/navigateStream.ts`（壳无关状态机）＋
 *                  `core/src/net/chatClient.ts`（ChatClient 端口）
 *
 * 为什么需要这个脚本（而不是等壳自检）：
 *
 *   完成判据里有一半是**壳侧兜底**——「首帧超时」「静默关闭不许当正常收尾」
 *   「abort 要真断连接」。这三条在 UI 上表现为"界面转圈 / 少了半截答案"，
 *   而**看起来都像上游的问题**。真连 navigate 手动试能看出来，但：
 *     · 要把 navigate 跑起来、要一个有效凭据、还要在"发出去之后、done 之前"精确杀进程 ——
 *       手一抖就测不到；
 *     · 手工跑没有回归能力，改一行就可能悄悄退化。
 *
 *   所以这里用**进程内**的假 SSE 上游把这些变成确定性的断言。
 *   与自检的分工：本脚本只测**客户端这一层**的规则（不启动 Electron、不看 DOM）；
 *   自检测端到端（主进程状态 / 渲染层最后一帧 / DOM `data-stage` 三处一致 + 截图）。
 *
 *   ⚠️ Web 那几段跑在 **Node 的 fetch** 上，不是浏览器 —— 所以它证明的是
 *      "我们发出去的请求形状对不对"，**不**证明"浏览器真的带上了 cookie"。
 *      后者只有真浏览器能验，归 `pnpm selfcheck:web`。
 *
 * 零依赖（除仓库自己的 esbuild devDependency）、**无子进程**：
 *   被测源码 import 的是 `@crossdeck/core`（指向 .ts 源码），裸 Node 加载不了，
 *   所以用 esbuild 的**进程内 JS API** 打成临时 ESM（三处各打一份：core / electron / web）。
 *   不 spawn 子进程 —— 本机沙箱下用 pipe 派生子进程必 EBUSY（见计划 §2）。
 *   （先例：verify-lint-boundaries.mjs 用 eslint 的 API、verify-type-alignment.mjs 用 typescript。）
 *
 * 时间用手动时钟：`deps.every` 注入假调度器，"15s 首帧超时"在 0ms 内验完。
 *
 * ══════════════════════════════════════════════════════════════════
 * 变异测试记录（用来确认这些断言真的有鉴别力）
 * ══════════════════════════════════════════════════════════════════
 * 做法：把实现改坏一个点 → 重跑本脚本 → 看挂了几条。
 * ⚠️ 本脚本**现场从 src 打包**，所以改完 src 直接重跑即可，不存在"加载旧 dist"
 *    那种假结果（core 的几个脚本需要先 typecheck，这里不需要）。
 *
 * ⚠️ 行尾：三个被变异的文件都必须是 **LF**。曾经 `client.ts` 是 CRLF（编辑器默认），
 *    多行锚点会**静默失配**（表现为一堆 `PATCH-MISS`）。
 *
 * ── core 引擎（`core/src/net/navigateStream.ts`）──
 * | 变异                                   | 挂掉断言数 |
 * |---------------------------------------|--------|
 * | E1  `markFirstByte` 不摘首帧计时器          | 2 |
 * | E2  `settleError` 去掉幂等位               | 2 |
 * | E3  `cancel()` 自己发 `onEnd()`（碰 sink）  | 4 |
 * | E4  静默关闭当正常收尾                      | 5 |
 * | E5  未知事件静默丢弃                        | 2 |
 * | E6  `authoritative` 总走差量（前缀判断架空）  | 5 |
 * | E7  `sources` 不去重                       | 2 |
 * | E8  状态码压平（401/429/503 一条消息）        | 3 |
 * | E9  首帧超时报成 `end`                      | 3 |
 * | E10 `done` 帧不当终态                       | 5 |
 *
 * ── Electron 壳传输层（`shell-electron/.../navigate/client.ts`）──
 * | 变异                                   | 挂掉断言数 |
 * |---------------------------------------|--------|
 * | M1  去掉 `decoder.decode(value,{stream:true})` 的选项 | 2 |
 * | M2  `cancel()` 什么都不做                  | 1 |
 * | M3  认证改用 `Authorization: Bearer`       | 1 |
 * | M4  token 不再放进 query                   | 1 |
 * | M5  没 token 也照发请求                     | 2 |
 * | M6  `abortUpstream` 不真断连               | 1 |
 * | M7  首帧计时器不挂                          | **挂死 → exit≠0**（见下） |
 *
 * ── Web 壳传输层（`shell-web/src/navigate/client.ts`）──
 * | 变异                                   | 挂掉断言数 |
 * |---------------------------------------|--------|
 * | W1  丢掉 `credentials:'same-origin'`       | 1 |
 * | W2  多塞一个 `Authorization` 头             | 1 |
 * | W3  往 URL 上塞 `?token=`                  | 1 |
 * | W4  静默关闭当正常收尾                      | 2 |
 * | W5  `cancel()` 什么都不做                  | 1 |
 * | W6  首帧计时器不挂                          | 2 |
 * | W7  `baseUrl` 缺省时拼成绝对路径              | **崩溃 → exit≠0**（见下） |
 *
 * 🔴 **M7 / W7 第一次算出来是「挂 0 条」，但那是测量假象，不是测试弱。**
 *    脚本的失败有两种形态，我一开始只数了第一种：
 *      ① 断言失败 —— 打 `  ❌ …`，被计数；
 *      ② 脚本**挂死或崩溃** —— 退出码非 0，但一条 `❌` 都不打。
 *    · M7（首帧计时器不挂）→ ④ 场景永远等不到终态 → 60s 兜底 `exit 1`；
 *    · W7（拼 `location.origin`）→ Node 里没有 `location` → `ReferenceError` 崩掉。
 *    两者**都是被抓住的**。教训：用 `grep '^  ❌'` 当唯一判据会漏掉 ② 这一类，
 *    判定时必须**同时看退出码**。（与"变异存活分两种"是同一条纪律的延伸：
 *    先确认测量手段没骗你，再谈测试有没有鉴别力。）
 *
 * 结论：**24/24 全部杀死**（其中 M7、W7 是由"挂死/崩溃 → 退出码非 0"杀死的）。
 *
 * 历史（只有 Electron 一份时，14 发里 M13「首帧到了不摘计时器」首测真存活 0 条 ——
 * 那才属于"测试没有鉴别力"，补场景 ⑫ 后杀死。别删 ⑫，否则会退回去）。
 */

import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = join(ROOT, 'packages', 'shell-electron');
const NAV_DIR = join(SHELL, 'src', 'main', 'navigate');
const WEB_NAV_DIR = join(ROOT, 'packages', 'shell-web', 'src', 'navigate');
const CORE_NET = join(ROOT, 'packages', 'core', 'src', 'net');

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

// 兜底：任何一条场景把 promise 挂死，都不许让脚本无声地卡住。
setTimeout(() => {
  console.error('\n❌ verify-navigate-client: 超过 60s 仍未结束，判定失败（有场景挂死了）');
  process.exit(1);
}, 60_000).unref();

// ─────────────────────────────────────────────────────────────
// 用 esbuild 进程内打包被测源码 → 临时 ESM
// ─────────────────────────────────────────────────────────────
const require = createRequire(import.meta.url);
let esbuildMod;
try {
  esbuildMod = await import(pathToFileURL(require.resolve('esbuild', { paths: [SHELL] })).href);
} catch (err) {
  console.error('❌ 找不到 esbuild（shell-electron 的 devDependency）。先跑 `pnpm install`。');
  console.error(`   ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const esbuild = esbuildMod.build === undefined ? esbuildMod.default : esbuildMod;

const OUT_DIR = mkdtempSync(join(tmpdir(), 'crossdeck-navigate-'));
process.on('exit', () => rmSync(OUT_DIR, { recursive: true, force: true }));

/**
 * 一次打包：`entries` 同一目录（这样 outbase 就是它，产物名可预测），
 * 输出到 `OUT_DIR/<sub>/`。分开放是因为三处都有 `client.ts` / `model.ts`，
 * 混在一个 outdir 里会撞名或被迫带上长路径。
 */
async function bundle(entries, sub) {
  try {
    await esbuild.build({
      entryPoints: entries,
      outdir: join(OUT_DIR, sub),
      // 临时目录里没有 package.json，`.js` 会被当成 CJS —— 必须显式改成 `.mjs`。
      outExtension: { '.js': '.mjs' },
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      logLevel: 'warning',
    });
  } catch (err) {
    console.error(`❌ 打包失败（${sub}）：`);
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

await bundle([join(NAV_DIR, 'client.ts'), join(NAV_DIR, 'model.ts')], 'electron');
await bundle([join(WEB_NAV_DIR, 'client.ts'), join(WEB_NAV_DIR, 'model.ts')], 'web');
// core 的壳无关引擎单独打一份：常量与纯格式化函数从这里取，
// 顺便证明"引擎自己不带任何平台 import"（platform:'node' 下能打出来 ≠ 用了 node）。
await bundle([join(CORE_NET, 'navigateStream.ts')], 'core');

const load = async (sub, file) => import(pathToFileURL(join(OUT_DIR, sub, file)).href);

const { createNavigateClient } = await load('electron', 'client.mjs');
const { NavigateModel } = await load('electron', 'model.mjs');
const { createWebNavigateClient } = await load('web', 'client.mjs');
const { WebNavigateModel } = await load('web', 'model.mjs');
const { NAVIGATE_CHAT_PATH, DEFAULT_FIRST_FRAME_TIMEOUT_MS, formatNavigateDiagnostic, createNavigateReporter } =
  await load('core', 'navigateStream.mjs');

if (typeof createNavigateClient !== 'function') {
  console.error('❌ navigate/client.ts 没有导出 createNavigateClient');
  process.exit(1);
}
if (typeof createWebNavigateClient !== 'function') {
  console.error('❌ shell-web 的 navigate/client.ts 没有导出 createWebNavigateClient');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────
// 假上游：进程内 node:http（不 spawn）
// ─────────────────────────────────────────────────────────────
/** 每个场景自己换 handler；同时记录最近一次收到的请求，供"请求形状"断言用。 */
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
    // 服务端观察到"对端断了"的信号 —— abort 断言就靠它。
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
    // ── 测试驱动口 ──
    /** 把所有在册的周期回调各触发一次（模拟"时间到了"）。 */
    fireAll() {
      for (const [id, tm] of [...timers.entries()]) {
        timers.delete(id);
        tm.fn();
      }
    },
    /** 还挂着几个定时器 —— **必须为 0**（这条断言抓的是"定时器永不摘"那类泄漏）。 */
    pending() {
      return timers.size;
    },
  };
}

/** 收集 sink 回调 + 诊断事件。 */
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

/**
 * 场景收尾的三条通用断言（几乎每个场景都要）：
 *   ① 恰好一个终态 —— 多一个就是 sink 契约被破了（onEnd=2 那个 bug 就是这么来的）
 *   ② 没有残留定时器 —— 少摘一个就是"收尾后还在空转"
 *   ③ 等一下再说 —— 有些重复终态是**异步晚到**的，当场看不出
 */
async function settleAndCheck(label, h, deps) {
  await sleep(40);
  check(`${label} · 恰好一个终态（不是两个）`, h.terminals.length === 1, JSON.stringify(h.terminals));
  check(`${label} · 没有残留定时器`, deps.pending() === 0, `还挂着 ${deps.pending()} 个`);
}

const withClient = (deps, opts = {}) =>
  createNavigateClient({
    baseUrl: BASE_URL,
    getToken: () => 'TOKEN-abc',
    firstFrameTimeoutMs: DEFAULT_FIRST_FRAME_TIMEOUT_MS,
    deps,
    ...opts,
  });

/**
 * Web 壳的同一个上游（**没有 getToken** —— 凭据走同源 cookie，由浏览器带）。
 * `baseUrl` 指向假上游：它在本脚本里代表**同源反代**（真同源要 navigate 与站点
 * 同 host:port，本机跑不动）。
 */
const withWebClient = (deps, opts = {}) =>
  createWebNavigateClient({
    baseUrl: BASE_URL,
    firstFrameTimeoutMs: DEFAULT_FIRST_FRAME_TIMEOUT_MS,
    deps,
    ...opts,
  });

console.log('\n── 常量与配置 ──────────────────────────────────');
check('上游路径就是真上游实测过的那个', NAVIGATE_CHAT_PATH === '/api/resume/chat', NAVIGATE_CHAT_PATH);
check('首帧超时默认 15s（不是"无限等"）', DEFAULT_FIRST_FRAME_TIMEOUT_MS === 15_000,
  String(DEFAULT_FIRST_FRAME_TIMEOUT_MS));

// ═════════════════════════════════════════════════════════════
console.log('\n── ① 请求形状与认证（真上游实测：Bearer 必 401）──');
// ═════════════════════════════════════════════════════════════
{
  requests.length = 0;
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
  await h.terminalArrived;
  await settleAndCheck('①', h, deps);

  const req = requests[0];
  check('① 确实打到了上游', requests.length === 1, `实际 ${requests.length} 次`);
  check('① 方法是 POST', req.method === 'POST', String(req.method));
  const url = new URL(req.url, BASE_URL);
  check('① 路径是 /api/resume/chat', url.pathname === NAVIGATE_CHAT_PATH, url.pathname);
  check('① token 走 ?token=（真上游实测可用的那条路）', url.searchParams.get('token') === 'TOKEN-abc',
    String(url.searchParams.get('token')));
  // 反向断言：Bearer 必然 401。这条断言存在的意义是**防止有人"顺手改成标准写法"**。
  check('① 没有 Authorization 头（Bearer 必 401）', req.headers.authorization === undefined,
    String(req.headers.authorization));
  check('① body 是 {question}（不是 messages / prompt）',
    req.body === JSON.stringify({ question: '你好' }), req.body);
  check('① content-type 是 json', String(req.headers['content-type']).includes('application/json'),
    String(req.headers['content-type']));

  // token 不许进日志：诊断里只该有 endpoint，不该有 token。
  const reqDiag = diag.find((d) => d.type === 'request');
  check('① 诊断只记 endpoint，**不含 token**',
    reqDiag !== undefined && !JSON.stringify(reqDiag).includes('TOKEN-abc'),
    JSON.stringify(reqDiag));
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ② 正常路径：逐帧 → done ──');
// ═════════════════════════════════════════════════════════════
{
  handler = (_req, res) => {
    const w = sse(res);
    w.token('你');
    w.token('好');
    w.frame('sources', JSON.stringify(['a.md', 'a.md', 'b.md']));
    w.done();
    w.end();
  };

  const deps = fakeDeps();
  const diag = [];
  const h = collect();
  withClient(deps, { onDiagnostic: (d) => diag.push(d) }).streamChat(
    { sessionId: 's2', prompt: 'q' },
    h.sink,
  );
  await h.terminalArrived;
  await settleAndCheck('②', h, deps);

  check('② 终态是 end（不是 error）', h.terminals[0] === 'end', JSON.stringify(h.terminals));
  check('② 文本按序拼起来', h.text() === '你好', h.text());
  check('② chunk 是**增量**（收到 2 片，不是 1 片全量）', h.chunks.length === 2, JSON.stringify(h.chunks));
  check('② 诊断里每片都有时刻（"逐帧到达"的肉眼证据）',
    diag.filter((d) => d.type === 'chunk').length === 2,
    JSON.stringify(diag.filter((d) => d.type === 'chunk')));
  const src = diag.find((d) => d.type === 'sources');
  check('② sources 已去重（真上游实测有重复）',
    src !== undefined && JSON.stringify(src.sources) === JSON.stringify(['a.md', 'b.md']),
    JSON.stringify(src));
  check('② sources **不拼进正文**', h.text() === '你好', h.text());
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ③ 静默关闭（reader 结束但没见过 done）—— 不许当正常收尾 ──');
// ═════════════════════════════════════════════════════════════
{
  handler = (_req, res) => {
    const w = sse(res);
    w.token('半截');
    w.end(); // ⚠️ 没有 done
  };

  const deps = fakeDeps();
  const h = collect();
  withClient(deps).streamChat({ sessionId: 's3', prompt: 'q' }, h.sink);
  await h.terminalArrived;
  await settleAndCheck('③', h, deps);

  check('③ 终态是 **error**，不是 end', h.terminals[0].startsWith('error:'), JSON.stringify(h.terminals));
  check('③ 0 个 onEnd（当成正常收尾 = 用户看到半截却以为完整）',
    h.terminals.filter((t) => t === 'end').length === 0, JSON.stringify(h.terminals));
  check('③ 消息点明"没收到 done"', h.terminals[0].includes('done'), h.terminals[0]);
  check('③ 首帧计时器也被摘干净了（不是只在正常路径摘）', deps.pending() === 0, `还挂着 ${deps.pending()}`);
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ④ 首帧超时：服务端连响应头都不给 ──');
// ═════════════════════════════════════════════════════════════
{
  handler = () => {
    /* 什么都不写：连接挂着，一个字节都不回 */
  };

  const deps = fakeDeps();
  const closedBefore = closedByPeer;
  const h = collect();
  withClient(deps).streamChat({ sessionId: 's4', prompt: 'q' }, h.sink);

  // 时间没到之前**不许**误报（"等待"本身不是错误）。
  await sleep(20);
  check('④ 计时器没到时**不**误报（15s 内本来就没字节）', h.terminals.length === 0,
    JSON.stringify(h.terminals));

  deps.fireAll(); // 模拟 15s 到了
  await h.terminalArrived;
  await settleAndCheck('④', h, deps);

  check('④ 终态是 error', h.terminals[0].startsWith('error:'), JSON.stringify(h.terminals));
  check('④ 消息是"首帧超时"（不是 runtime 那条 60s 兜底）',
    h.terminals[0].includes('首帧超时'), h.terminals[0]);
  await sleep(40);
  check('④ abort 真的断了连接（服务端观察到对端关闭）', closedByPeer > closedBefore,
    `closedByPeer ${closedBefore} → ${closedByPeer}`);
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ⑤ cancel() → 真断连接，且**不碰 sink** ──');
// ═════════════════════════════════════════════════════════════
{
  handler = (_req, res) => {
    const w = sse(res);
    w.token('开始');
    // 之后一直挂着（模拟"生成中"）
  };

  const deps = fakeDeps();
  const closedBefore = closedByPeer;
  const h = collect();
  const client = withClient(deps);
  const cancel = client.streamChat({ sessionId: 's5', prompt: 'q' }, h.sink);

  await sleep(60); // 等首帧真的到达（否则取消的是"还没连上"）
  check('⑤ 取消之前先收到了增量', h.text() === '开始', h.text());

  cancel();
  await sleep(60);

  check('⑤ cancel 后**没有**任何终态交给 sink（终态归 runtime 决定）',
    h.terminals.length === 0, JSON.stringify(h.terminals));
  check('⑤ abort 真断了连接', closedByPeer > closedBefore, `closedByPeer ${closedBefore} → ${closedByPeer}`);
  check('⑤ 首帧计时器被摘掉了（取消也要摘）', deps.pending() === 0, `还挂着 ${deps.pending()}`);
  check('⑤ cancel 幂等（再调一次不炸、不多发终态）', (() => {
    try {
      cancel();
      cancel();
      return h.terminals.length === 0;
    } catch {
      return false;
    }
  })(), JSON.stringify(h.terminals));
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ⑥ 多字节字符跨 chunk 被切开（漏 {stream:true} 就乱码）──');
// ═════════════════════════════════════════════════════════════
{
  const frame = Buffer.from('event: token\ndata: "中文"\n\nevent: done\ndata: __DONE__\n\n', 'utf8');
  // 找到"中"的第一个字节，在它**中间**切开：1 字节 + 2 字节。
  const cut = frame.indexOf(Buffer.from('中', 'utf8')) + 1;

  handler = (_req, res) => {
    const w = sse(res);
    w.raw(frame.subarray(0, cut));
    // 隔开一点，确保这是**两个** TCP 分段（TCP 可能把连着写的两段合并 ——
    // 合并之后这条用例就失去鉴别力了，所以宁可慢 80ms）。
    setTimeout(() => {
      w.raw(frame.subarray(cut));
      w.end();
    }, 80);
  };

  const deps = fakeDeps();
  const h = collect();
  withClient(deps).streamChat({ sessionId: 's6', prompt: 'q' }, h.sink);
  await h.terminalArrived;
  await settleAndCheck('⑥', h, deps);

  check('⑥ 乱码字符 U+FFFD **没有**出现', !h.text().includes('\uFFFD'), JSON.stringify(h.text()));
  check('⑥ 切开的"中"完整复原', h.text() === '中文', JSON.stringify(h.text()));
  check('⑥ 终态是 end', h.terminals[0] === 'end', JSON.stringify(h.terminals));
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ⑦ authoritative（权威全文）：差量补齐 / 前缀不成立 ──');
// ═════════════════════════════════════════════════════════════
{
  // 7a：前缀成立 → 只补吐尾巴
  handler = (_req, res) => {
    const w = sse(res);
    w.token('你');
    w.token('好');
    w.frame('answer', JSON.stringify('你好世界'));
    w.done();
    w.end();
  };

  const depsA = fakeDeps();
  const diagA = [];
  const hA = collect();
  withClient(depsA, { onDiagnostic: (d) => diagA.push(d) }).streamChat(
    { sessionId: 's7a', prompt: 'q' },
    hA.sink,
  );
  await hA.terminalArrived;
  await settleAndCheck('⑦a', hA, depsA);

  check('⑦a 增量 + 权威 = 全文，且**没有重复**', hA.text() === '你好世界', hA.text());
  check('⑦a 只补吐了尾巴（不是把全文再吐一遍）',
    hA.chunks.length === 3 && hA.chunks[2] === '世界', JSON.stringify(hA.chunks));
  check('⑦a 上报了"差量补齐"', diagA.some((d) => d.type === 'authoritative-delta'),
    JSON.stringify(diagA.map((d) => d.type)));

  // 7b：前缀**不成立** → 无法用增量表达，宁可重复也不静默丢内容
  handler = (_req, res) => {
    const w = sse(res);
    w.token('你');
    w.frame('answer', JSON.stringify('问好'));
    w.done();
    w.end();
  };

  const depsB = fakeDeps();
  const diagB = [];
  const hB = collect();
  withClient(depsB, { onDiagnostic: (d) => diagB.push(d) }).streamChat(
    { sessionId: 's7b', prompt: 'q' },
    hB.sink,
  );
  await hB.terminalArrived;
  await settleAndCheck('⑦b', hB, depsB);

  check('⑦b 前缀不成立 → 上了可观测信号（不许悄悄吞掉）',
    diagB.some((d) => d.type === 'authoritative-replace'), JSON.stringify(diagB.map((d) => d.type)));
  check('⑦b 全文补吐了（宁可重复，也不丢内容）', hB.text() === '你问好', hB.text());
  check('⑦b 记录里带了两个长度，便于事后判断"契约是不是理解错了"',
    diagB.some((d) => d.type === 'authoritative-replace' && d.emittedLen === 1 && d.textLen === 2),
    JSON.stringify(diagB.filter((d) => d.type === 'authoritative-replace')));
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ⑧ 未知事件必须上报（不许静默失灵）──');
// ═════════════════════════════════════════════════════════════
{
  handler = (_req, res) => {
    const w = sse(res);
    w.frame('thinking', JSON.stringify({ step: 1 }));
    w.token('答');
    w.done();
    w.end();
  };

  const deps = fakeDeps();
  const diag = [];
  const h = collect();
  withClient(deps, { onDiagnostic: (d) => diag.push(d) }).streamChat(
    { sessionId: 's8', prompt: 'q' },
    h.sink,
  );
  await h.terminalArrived;
  await settleAndCheck('⑧', h, deps);

  const unknown = diag.find((d) => d.type === 'unknown-event');
  check('⑧ 未知事件被上报（带事件名）', unknown !== undefined && unknown.event === 'thinking',
    JSON.stringify(unknown));
  check('⑧ 未知事件不被当成正文', h.text() === '答', h.text());
  check('⑧ 未知事件不影响正常收尾', h.terminals[0] === 'end', JSON.stringify(h.terminals));
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ⑨ error 帧：收尾即停，后续字节不再消费 ──');
// ═════════════════════════════════════════════════════════════
{
  handler = (_req, res) => {
    const w = sse(res);
    w.token('开头');
    w.frame('error', JSON.stringify('上游炸了'));
    w.token('不该收到');
    w.done();
    w.end();
  };

  const deps = fakeDeps();
  const h = collect();
  withClient(deps).streamChat({ sessionId: 's9', prompt: 'q' }, h.sink);
  await h.terminalArrived;
  await settleAndCheck('⑨', h, deps);

  check('⑨ 终态是 error 且带上了上游的消息',
    h.terminals[0] === 'error:上游报错：上游炸了', JSON.stringify(h.terminals));
  check('⑨ error 之后不再消费字节（0 个 onEnd，也没吞进后半段）',
    h.text() === '开头', h.text());
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ⑩ 无凭据 / HTTP 状态 / 连不上：错误必须能区分 ──');
// ═════════════════════════════════════════════════════════════
{
  // 10a：没有 token —— 不发请求，同步报错（不许"假装在连"）
  requests.length = 0;
  const depsA = fakeDeps();
  const hA = collect();
  const cancelA = withClient(depsA, { getToken: () => null }).streamChat(
    { sessionId: 's10a', prompt: 'q' },
    hA.sink,
  );
  check('⑩a 无 token → 同步就是 error 终态', hA.terminals.length === 1 &&
    hA.terminals[0].startsWith('error:'), JSON.stringify(hA.terminals));
  await sleep(30);
  check('⑩a 一个请求都没发出去（不假装在连）', requests.length === 0, `实际 ${requests.length} 次`);
  check('⑩a 没留下定时器', depsA.pending() === 0, `还挂着 ${depsA.pending()}`);
  check('⑩a 返回的取消函数可调用', (() => {
    try {
      cancelA();
      return true;
    } catch {
      return false;
    }
  })());

  // 10b：HTTP 状态要能区分（不许全压成"请求失败"）
  const messages = {};
  for (const [key, status, headers] of [
    ['401', 401, {}],
    ['429', 429, { 'retry-after': '30' }],
    ['503', 503, {}],
  ]) {
    handler = (_req, res) => {
      res.writeHead(status, headers);
      res.end('nope');
    };
    const deps = fakeDeps();
    const h = collect();
    withClient(deps).streamChat({ sessionId: `s10b-${key}`, prompt: 'q' }, h.sink);
    await h.terminalArrived;
    await settleAndCheck(`⑩b-${key}`, h, deps);
    messages[key] = h.terminals[0];
    check(`⑩b-${key} 消息里带上了状态码`, h.terminals[0].includes(key), h.terminals[0]);
  }
  check('⑩b 401 说的是"凭据"（不是"限流"/"服务未启用"）', messages['401'].includes('凭据'), messages['401']);
  check('⑩b 429 说的是"限流"且带 Retry-After', messages['429'].includes('限流') &&
    messages['429'].includes('30'), messages['429']);
  check('⑩b 503 说的是"服务端未启用"', messages['503'].includes('未启用'), messages['503']);
  check('⑩b 三条消息**互不相同**（区分得开）',
    new Set([messages['401'], messages['429'], messages['503']]).size === 3,
    JSON.stringify(messages));

  // 10c：连不上
  const depsC = fakeDeps();
  const hC = collect();
  const dead = createNavigateClient({
    baseUrl: 'http://127.0.0.1:1',
    getToken: () => 'T',
    firstFrameTimeoutMs: 15_000,
    deps: depsC,
  });
  dead.streamChat({ sessionId: 's10c', prompt: 'q' }, hC.sink);
  await hC.terminalArrived;
  await settleAndCheck('⑩c', hC, depsC);
  check('⑩c 连不上 → error，且消息说明"无法连接上游"',
    hC.terminals[0].includes('无法连接上游'), hC.terminals[0]);
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ⑪ NavigateModel：只做端口适配，不改语义 ──');
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
  const model = new NavigateModel({ client, deps });
  const cancel = model.stream({ sessionId: 'sess-1', prompt: '问一句' }, h.sink);

  check('⑪ ModelRequest → ChatRequest 字段是一对一搬的',
    seen.length === 1 && seen[0].sessionId === 'sess-1' && seen[0].prompt === '问一句',
    JSON.stringify(seen));
  check('⑪ 原样返回 client 的取消函数（不许包一层丢了）', cancel === fakeCancel);
  check('⑪ sink 回调原样透传', h.text() === 'X' && h.terminals[0] === 'end',
    `${h.text()} / ${JSON.stringify(h.terminals)}`);
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ⑫ 首字节已到之后停住：**不许**误报"首帧超时" ──');
// ═════════════════════════════════════════════════════════════
{
  // 这条断言是**变异测试逼出来的**：原本"首帧到了就摘掉计时器"没有断言覆盖，
  // 把摘除那行删掉照样全绿（变异存活 = 用例没有鉴别力）。
  // 而它并不是纯防御性代码 —— 少了它，"首字节到了、之后又被卡住"会被误报成
  // "首帧超时"，把一次**中途**卡顿说成**连都连不上**，排查方向会被带偏。
  // 正确分工：壳只管"首帧"，中途卡顿交 runtime 的 60s 兜底。
  handler = (_req, res) => {
    const w = sse(res);
    w.token('首帧');
    // 之后一直挂着：不 done、不 error、也不关
  };

  const deps = fakeDeps();
  const h = collect();
  const cancel = withClient(deps).streamChat({ sessionId: 's12', prompt: 'q' }, h.sink);

  await sleep(60);
  check('⑫ 首帧已经收到了', h.text() === '首帧', h.text());

  deps.fireAll(); // 手动把 15s 推到：计时器若没被首帧摘掉，这里就会误报
  await sleep(40);
  check('⑫ 计时器已被首帧摘掉 → **不**误报首帧超时', h.terminals.length === 0,
    JSON.stringify(h.terminals));

  cancel();
  await sleep(40);
  check('⑫ 中途卡顿归 runtime 的 60s 兜底管，壳不在这里抢答',
    h.terminals.length === 0, JSON.stringify(h.terminals));
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ⑬ Web 壳 · 请求形状与认证（同源 cookie，不落地凭据）──');
// ═════════════════════════════════════════════════════════════
{
  requests.length = 0;
  handler = (_req, res) => {
    const w = sse(res);
    w.token('你');
    w.done();
    w.end();
  };

  // 假上游在另一个端口 —— 它在这里**代表同源反代**（真同源要 navigate 与站点同
  // host:port，本机跑不动）。所以下面断言的是**我们发出的那个选项**，
  // 而不是"Node 里 cookie 真的带上了"（Node 的 fetch 根本不实现 cookie jar）。
  const realFetch = globalThis.fetch;
  let seenInit = null;
  globalThis.fetch = (input, init) => {
    seenInit = init;
    return realFetch(input, init);
  };

  const deps = fakeDeps();
  const diag = [];
  const h = collect();
  try {
    withWebClient(deps, { onDiagnostic: (d) => diag.push(d) }).streamChat(
      { sessionId: 'w1', prompt: '你好' },
      h.sink,
    );
    await h.terminalArrived;
    await settleAndCheck('⑬', h, deps);

    const req = requests[0];
    const url = new URL(req.url, BASE_URL);
    check('⑬ 方法是 POST 且路径是 /api/resume/chat',
      req.method === 'POST' && url.pathname === NAVIGATE_CHAT_PATH,
      `${req.method} ${url.pathname}`);
    // 反向断言：Web 壳**不许**把凭据塞进 URL —— 那是 Electron 的做法。
    check('⑬ **没有** ?token=（Web 靠 cookie）', !url.searchParams.has('token'), req.url);
    check('⑬ **没有** Authorization 头', req.headers.authorization === undefined,
      String(req.headers.authorization));
    // 这条是"页面在浏览器里到底会不会带 cookie"的**唯一**客户端开关。
    // 掉了它 → 线上每次都是 401，而本地 Node 测不出来（Node 不实现 cookie）。
    check('⑬ 带了 credentials: same-origin（不写 = 跨源请求默认省略 cookie）',
      seenInit?.credentials === 'same-origin', String(seenInit?.credentials));
    check('⑬ body 是 {question}', req.body === JSON.stringify({ question: '你好' }), req.body);

    const reqDiag = diag.find((d) => d.type === 'request');
    check('⑬ 诊断标识认证方式为 cookie（且不含任何凭据）',
      reqDiag !== undefined && reqDiag.auth === 'cookie' && !JSON.stringify(reqDiag).includes('token='),
      JSON.stringify(reqDiag));
  } finally {
    globalThis.fetch = realFetch;
  }
}

// 同源部署时 baseUrl 留空 → 打**相对路径**（浏览器按当前 origin 解析）。
// 这条只能靠诊断看：Node 的 fetch 不接受相对 URL，发不出去。
{
  const deps = fakeDeps();
  const diag = [];
  const h = collect();
  const cancel = createWebNavigateClient({
    firstFrameTimeoutMs: DEFAULT_FIRST_FRAME_TIMEOUT_MS,
    deps,
    onDiagnostic: (d) => diag.push(d),
  }).streamChat({ sessionId: 'w1b', prompt: 'q' }, h.sink);
  await sleep(30);
  const reqDiag = diag.find((d) => d.type === 'request');
  check('⑬b baseUrl 缺省 → endpoint 是不带 origin 的相对路径',
    reqDiag !== undefined && reqDiag.endpoint === NAVIGATE_CHAT_PATH,
    JSON.stringify(reqDiag));
  cancel();
  await sleep(30);
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ⑭ Web 壳 · 正常路径：逐帧 → done（含多字节跨片）──');
// ═════════════════════════════════════════════════════════════
{
  handler = async (_req, res) => {
    const w = sse(res);
    // 与 Electron 侧同款做法：把**一整帧**的字节在"中"字中间切开（1 字节 + 2 字节），
    // 分两次写、中间隔开，避免 TCP 把两片合并（合并了这条用例就失去鉴别力：
    // `{stream:true}` 漏掉也照样能拼对）。
    const frame = Buffer.from('event: token\ndata: "中文"\n\n', 'utf8');
    const cut = frame.indexOf(Buffer.from('中', 'utf8')) + 1;
    w.raw(frame.subarray(0, cut));
    await sleep(80);
    w.raw(frame.subarray(cut));
    w.token('好');
    w.done();
    w.end();
  };

  const deps = fakeDeps();
  const h = collect();
  withWebClient(deps).streamChat({ sessionId: 'w2', prompt: 'q' }, h.sink);
  await h.terminalArrived;
  await settleAndCheck('⑭', h, deps);
  check('⑭ 中文被切在两片里仍然完整（decoder 的 {stream:true} 没漏）', h.text() === '中文好', h.text());
  check('⑭ 没有出现替换字符 U+FFFD', !h.text().includes('\uFFFD'), JSON.stringify(h.text()));
  check('⑭ 正常收尾是 end 不是 error', h.terminals[0] === 'end', JSON.stringify(h.terminals));
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ⑮ Web 壳 · 静默关闭（无 done）→ 必须 error ──');
// ═════════════════════════════════════════════════════════════
{
  handler = (_req, res) => {
    const w = sse(res);
    w.token('半截答案');
    w.end(); // ← 没有 done
  };

  const deps = fakeDeps();
  const h = collect();
  withWebClient(deps).streamChat({ sessionId: 'w3', prompt: 'q' }, h.sink);
  await h.terminalArrived;
  await settleAndCheck('⑮', h, deps);
  check('⑮ 静默关闭 → error（不是 done）', h.terminals[0]?.startsWith('error:') === true,
    JSON.stringify(h.terminals));
  check('⑮ 错误消息点名"没收到 done"', (h.terminals[0] ?? '').includes('没收到 done'), h.terminals[0]);
  check('⑮ 已经收到的半截内容没被吞掉', h.text() === '半截答案', h.text());
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ⑯ Web 壳 · 首帧超时 15s（不必等 runtime 的 60s 兜底）──');
// ═════════════════════════════════════════════════════════════
{
  handler = (_req, res) => {
    // 给了响应头就不给字节 —— 最像"反代连上了但 navigate 卡住"的形态
    res.writeHead(200, { 'content-type': 'text/event-stream' });
  };

  const deps = fakeDeps();
  const h = collect();
  withWebClient(deps).streamChat({ sessionId: 'w4', prompt: 'q' }, h.sink);
  await sleep(50);
  check('⑯ 还没到时间：不该有任何终态', h.terminals.length === 0, JSON.stringify(h.terminals));
  deps.fireAll();
  await sleep(40);
  await settleAndCheck('⑯', h, deps);
  check('⑯ 首帧超时 → error，且消息写明 15s',
    h.terminals[0]?.startsWith('error:上游首帧超时') && h.terminals[0].includes('15000'),
    h.terminals[0]);
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ⑰ Web 壳 · cancel() → 真断连，且 sink 一个终态都收不到 ──');
// ═════════════════════════════════════════════════════════════
{
  handler = (_req, res) => {
    const w = sse(res);
    w.token('开始');
    // 之后一直挂着：不 done、不 error、也不关
  };

  const before = closedByPeer;
  const deps = fakeDeps();
  const h = collect();
  const cancel = withWebClient(deps).streamChat({ sessionId: 'w5', prompt: 'q' }, h.sink);
  await sleep(60);
  check('⑰ 取消前已经收到内容', h.text() === '开始', h.text());

  cancel();
  await sleep(80);
  check('⑰ 服务端观察到对端断开了（不是"把 reader 丢掉"这种假取消）',
    closedByPeer > before, `${before} → ${closedByPeer}`);
  check('⑰ 取消后 sink **一个终态都没有**（终态归 runtime 决定）',
    h.terminals.length === 0, JSON.stringify(h.terminals));
  check('⑰ 取消后没有残留定时器', deps.pending() === 0, `还挂着 ${deps.pending()} 个`);
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ⑱ Web 壳 · authoritative 差量补齐 / 前缀不成立 ──');
// ═════════════════════════════════════════════════════════════
{
  handler = (_req, res) => {
    const w = sse(res);
    w.token('前半');
    w.frame('answer', JSON.stringify('前半后半')); // 前缀成立 → 只补"后半"
    w.done();
    w.end();
  };
  {
    const deps = fakeDeps();
    const diag = [];
    const h = collect();
    withWebClient(deps, { onDiagnostic: (d) => diag.push(d) }).streamChat({ sessionId: 'w6', prompt: 'q' }, h.sink);
    await h.terminalArrived;
    check('⑱ 前缀成立 → 只补吐尾巴（不是重复全文）', h.text() === '前半后半', h.text());
    check('⑱ 上报了 authoritative-delta', diag.some((d) => d.type === 'authoritative-delta'), diag.map((d) => d.type).join(','));
  }

  handler = (_req, res) => {
    const w = sse(res);
    w.token('已经吐过的');
    w.frame('answer', JSON.stringify('完全不同的全文')); // 前缀不成立
    w.done();
    w.end();
  };
  {
    const deps = fakeDeps();
    const diag = [];
    const h = collect();
    withWebClient(deps, { onDiagnostic: (d) => diag.push(d) }).streamChat({ sessionId: 'w7', prompt: 'q' }, h.sink);
    await h.terminalArrived;
    check('⑱ 前缀不成立 → 宁可重复也不静默丢（补吐全文）',
      h.text() === '已经吐过的完全不同的全文', h.text());
    check('⑱ 上报了 authoritative-replace（这是"契约可能理解错了"的信号）',
      diag.some((d) => d.type === 'authoritative-replace'), diag.map((d) => d.type).join(','));
  }
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ⑲ Web 壳 · 未知事件上报 + sources 去重 ──');
// ═════════════════════════════════════════════════════════════
{
  handler = (_req, res) => {
    const w = sse(res);
    w.token('x');
    w.frame('thinking', '{"step":1}'); // 上游将来新增的事件
    w.frame('sources', JSON.stringify(['a.md', 'a.md', 'b.md']));
    w.done();
    w.end();
  };

  const deps = fakeDeps();
  const diag = [];
  const h = collect();
  withWebClient(deps, { onDiagnostic: (d) => diag.push(d) }).streamChat({ sessionId: 'w8', prompt: 'q' }, h.sink);
  await h.terminalArrived;
  const unknown = diag.find((d) => d.type === 'unknown-event');
  check('⑲ 未识别事件被上报，不静默丢弃', unknown !== undefined && unknown.event === 'thinking',
    JSON.stringify(unknown));
  const src = diag.find((d) => d.type === 'sources');
  check('⑲ sources 去重（3 项 → 2 项）', src !== undefined && src.sources.length === 2,
    JSON.stringify(src?.sources));
  check('⑲ 未知事件不影响正常收尾', h.terminals[0] === 'end', JSON.stringify(h.terminals));
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ⑳ WebNavigateModel：与 Electron 侧签名同形 ──');
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
  const model = new WebNavigateModel({ client, deps });
  const cancel = model.stream({ sessionId: 'sess-w', prompt: '问一句' }, h.sink);

  check('⑳ ModelRequest → ChatRequest 字段一对一搬',
    seen.length === 1 && seen[0].sessionId === 'sess-w' && seen[0].prompt === '问一句', JSON.stringify(seen));
  check('⑳ 原样返回 client 的取消函数', cancel === fakeCancel);
  check('⑳ sink 回调原样透传', h.text() === 'X' && h.terminals[0] === 'end',
    `${h.text()} / ${JSON.stringify(h.terminals)}`);
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ㉑ core 的纯诊断格式化（core 不碰 console，落日志归壳）──');
// ═════════════════════════════════════════════════════════════
{
  const warn = formatNavigateDiagnostic({
    type: 'unknown-event', at: 0, event: 'thinking', raw: 'x',
  });
  check('㉑ 未识别事件是 warn 级', warn.level === 'warn' && warn.text.includes('thinking'), JSON.stringify(warn));

  const end = formatNavigateDiagnostic({ type: 'terminal', at: 0, kind: 'end', message: null });
  check('㉑ 正常终态是 log 级、且不带多余冒号', end.level === 'log' && !end.text.includes('：'), JSON.stringify(end));

  // 注入式日志口：core 不知道 console 是什么，只有形状约束。
  const lines = [];
  const reporter = createNavigateReporter({
    log: (...a) => lines.push(['log', a.join(' ')]),
    warn: (...a) => lines.push(['warn', a.join(' ')]),
  });
  reporter({ type: 'chunk', at: 1, len: 3, total: 3 });
  reporter({ type: 'authoritative-replace', at: 2, emittedLen: 1, textLen: 9 });
  check('㉑ createNavigateReporter 按级别路由到注入的日志口',
    lines.length === 2 && lines[0][0] === 'log' && lines[1][0] === 'warn', JSON.stringify(lines));
}



const total = passed + failures.length;
console.log('\n──────────────────────────────────────────');
if (failures.length === 0) {
  console.log(`✅ verify-navigate-client: ${passed}/${total} 通过`);
} else {
  console.log(`❌ verify-navigate-client: ${passed}/${total} 通过，${failures.length} 条失败`);
  for (const f of failures) console.log(`   - ${f}`);
}
console.log('──────────────────────────────────────────\n');
process.exit(failures.length === 0 ? 0 : 1);
