#!/usr/bin/env node
/**
 * T7 验收：Electron 壳的 navigate IO（`navigate/client.ts` + `navigate/model.ts`）。
 *
 * 为什么需要这个脚本（而不是等 T12 的自检）：
 *
 *   T7 的"完成判据"里有一半是**壳侧兜底**——「首帧超时」「静默关闭不许当正常收尾」
 *   「abort 要真断连接」。这三条在 UI 上表现为"界面转圈 / 少了半截答案"，
 *   而**看起来都像上游的问题**。真连 navigate 手动试能看出来，但：
 *     · 要把 navigate 跑起来、要一个有效 token、还要在"发出去之后、done 之前"精确杀进程 ——
 *       手一抖就测不到；
 *     · 手工跑没有回归能力，改一行就可能悄悄退化。
 *
 *   所以这里用**进程内**的假 SSE 上游把这三条变成确定性的断言。
 *   与 T12 的分工：本脚本只测**客户端这一层**的规则（不启动 Electron、不看 DOM）；
 *   T12 测端到端（主进程状态 / 渲染层最后一帧 / DOM `data-stage` 三处一致 + 截图）。
 *
 * 零依赖（除仓库自己的 esbuild devDependency）、**无子进程**：
 *   `client.ts` import 的是 `@crossdeck/core`（指向 .ts 源码），裸 Node 加载不了，
 *   所以用 esbuild 的**进程内 JS API** 打成临时 ESM。
 *   不 spawn 子进程 —— 本机沙箱下用 pipe 派生子进程必 EBUSY（见计划 §2）。
 *   （先例：verify-lint-boundaries.mjs 用 eslint 的 API、verify-type-alignment.mjs 用 typescript。）
 *
 * 时间用手动时钟：`deps.every` 注入假调度器，"15s 首帧超时"在 0ms 内验完。
 *
 * ══════════════════════════════════════════════════════════════════
 * 变异测试记录（用来确认这些断言真的有鉴别力）
 * ══════════════════════════════════════════════════════════════════
 * 做法：把 `navigate/client.ts` 改坏一个点 → 重跑本脚本 → 数挂了几条。
 * ⚠️ 本脚本**现场从 src 打包**，所以改完 src 直接重跑即可，不存在"加载旧 dist"
 *    那种假结果（core 的几个脚本需要先 typecheck，这里不需要）。
 *
 * | 变异                                   | 挂掉断言数 |
 * |---------------------------------------|--------|
 * | M1  去掉 `decoder.decode(value, {stream:true})` 的选项 | 2 |
 * | M2  静默关闭当成正常收尾（`settleEnd()` 顶掉那条 error）  | 3 |
 * | M3  首帧超时报成 `end` 而不是 `error`             | 2 |
 * | M4  `cancel()` 什么都不做（不断连接）              | 1 |
 * | M5  `cancel()` 自己发 `onEnd()`（碰 sink）        | 3 |
 * | M6  `settleError` 去掉幂等位                   | 1 |
 * | M7  未知事件静默丢弃                           | 1 |
 * | M8  `authoritative` 无条件走差量（前缀判断被架空）      | 3 |
 * | M9  `describeHttpStatus` 压成一句通用的           | 3 |
 * | M10 认证改用 `Authorization: Bearer`          | 1 |
 * | M11 token 不再放进 query                      | 1 |
 * | M12 `sources` 不去重                          | 1 |
 * | M13 首帧到了不摘计时器                          | **0** ❗ |
 * | M14 没 token 也照发请求                        | 2 |
 *
 * M13 一开始**存活 0 条** —— 这就是"变异测试捉出没有鉴别力的用例"的活例子：
 * 「首帧到达后摘掉计时器」当时没有任何断言覆盖。而它**不是**纯防御性代码：
 * 少了它，"首字节到了、之后又被卡住"会被误报成**首帧超时**，把一次中途卡顿
 * 说成"连都连不上"，排查方向直接被带偏。
 * → 补了场景 ⑫（首帧已到之后停住）后，M13 实测挂 **2 条**。
 * **后人别删 ⑫**，否则 M13 又会变回不可见。
 *
 * 结论：14/14 均被杀死（M13 需 ⑫ 才杀死）。
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

try {
  await esbuild.build({
    entryPoints: [join(NAV_DIR, 'client.ts'), join(NAV_DIR, 'model.ts')],
    outdir: OUT_DIR,
    // 临时目录里没有 package.json，`.js` 会被当成 CJS —— 必须显式改成 `.mjs`。
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'warning',
  });
} catch (err) {
  console.error('❌ 打包 navigate/client.ts 失败：');
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const { createNavigateClient, NAVIGATE_CHAT_PATH, DEFAULT_FIRST_FRAME_TIMEOUT_MS } =
  await import(pathToFileURL(join(OUT_DIR, 'client.mjs')).href);
const { NavigateModel } = await import(pathToFileURL(join(OUT_DIR, 'model.mjs')).href);

if (typeof createNavigateClient !== 'function') {
  console.error('❌ navigate/client.ts 没有导出 createNavigateClient');
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
 *   ① 恰好一个终态 —— 多一个就是 sink 契约被破了（T6-a 的 onEnd=2 就是这么来的）
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

console.log('\n── T7 · 常量与配置 ─────────────────────────────');
check('上游路径就是 T3 实测过的那个', NAVIGATE_CHAT_PATH === '/api/resume/chat', NAVIGATE_CHAT_PATH);
check('首帧超时默认 15s（不是"无限等"）', DEFAULT_FIRST_FRAME_TIMEOUT_MS === 15_000,
  String(DEFAULT_FIRST_FRAME_TIMEOUT_MS));

// ═════════════════════════════════════════════════════════════
console.log('\n── ① 请求形状与认证（T3 实测：Bearer 必 401）──');
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
  check('① token 走 ?token=（T3 实测可用的那条路）', url.searchParams.get('token') === 'TOKEN-abc',
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
  check('② sources 已去重（T3 实测上游有重复）',
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
  // 正确分工：壳只管"首帧"，中途卡顿交 runtime 的 60s 兜底（T6-b）。
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
server.close();
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
