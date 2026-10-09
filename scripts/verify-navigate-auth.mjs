#!/usr/bin/env node
/**
 * navigate **配置通道 + guest 登录**的验收（Electron 壳）。
 *
 * 被测源码：
 *   core        `core/src/net/navigateAuth.ts`     —— 状态码 → 话术/码（纯逻辑，三端共用）
 *   shell       `shell-electron/src/main/navigate/{upstream,auth,settings,tokenStore,session}.ts`
 *
 * 为什么需要这个脚本（而不是等壳自检）：
 *
 *   本卡的判据里有两条**在界面上根本看不出来**：
 *     ① 「503 与 429 可区分」——两者都能渲染成一句红字，用户看不出客户端其实分得清；
 *     ② 「登出后 token 不再可用」——这是**反向断言**：本机把凭据删掉了很好观察，
 *        但"上游那边是不是真的吊销了"不真的打一次服务器就无从判断。
 *   还有一条最重要的：**凭据不许出现在渲染层能看到的东西里** ——
 *   这条只能靠"把响应序列化出来 grep 一遍 secret"来证明，人工点是点不出来的。
 *
 *   T12 的壳自检负责端到端（主进程状态 / 渲染层 / DOM `data-*` 三处一致 + 截图）；
 *   本脚本只测客户端这一层（不启动 Electron、不看 DOM）。
 *
 * 零依赖（除仓库自己的 esbuild）、**无子进程**：
 *   被测源码 import 了 `electron`（settings / tokenStore 要写 userData），
 *   Node 里没有它 → 用 esbuild 的 `onResolve` 把 `electron` 换成一个**假模块**，
 *   它的 `userDataDir` 指向本脚本的临时目录，`safeStorage` 可切换可用/不可用
 *   （于是"加密不可用时如实降级"这条也能被真的验一遍）。
 *   `@crossdeck/core` / `@crossdeck/contract` 的 exports 指向 `.ts` 源，
 *   所以 esbuild **现场从 src 打包** —— 改完实现直接重跑，不存在"加载旧 dist"的假结果。
 *
 * 三者装进**同一个 bundle**（通过一个临时入口 `export *`）是必须的：
 *   分成两个 bundle 的话各自会带一份 `AppError` 类，`instanceof` 判不出来，
 *   错误码会被 `toSerializedError` 压成 INTERNAL —— 那正好把要验的东西验没了。
 *
 * 时间：`expiresAt` 由注入的假时钟算，登录超时用 `timeoutMs` 压到 120ms。
 *
 * ══════════════════════════════════════════════════════════════════
 * 变异测试记录（确认这些断言真的有鉴别力）
 * ══════════════════════════════════════════════════════════════════
 * 做法：把实现改坏一个点 → 重跑本脚本 → 数挂了几条（脚本**现场从 src 打包**，
 *       改完直接重跑，没有"加载旧 dist"那种假结果）。
 *
 *   ID   改坏的点                                               挂掉条数
 *   ────────────────────────────────────────────────────────────────────
 *   M1   503 的 code：UNSUPPORTED → UPSTREAM（给一个没用的重试入口）      5
 *   M2   503 的 detail → RATE_LIMITED                                  6
 *   M3   429 丢掉 Retry-After 秒数                                      2   ← 见 ①
 *   M4   认不出的 role 一律当 guest                                     2
 *   M5   expiresAt 直接拿 expiresIn 当时间戳（差 1000 倍 + 时长当时刻）   3
 *   M6   status() 里多塞一个 token 字段                                  1
 *   M7   登出只清本机、不通知上游                                       3
 *   M8   上游地址不落盘（只留内存 → 重启要重填）                          2
 *   M9   不去尾斜杠（拼出 `//api`）                                      7（后续场景连锁失败）
 *   M10  放行 `?query` / `#hash`（会被静默丢掉，报错却指向上游）           2
 *   M11  协议白名单失效（ftp: / javascript: / file: 都能进 fetch）        7
 *   M12  没配上游时登录不报错、返回一份假凭据                             2
 *   M13  fetchWithTimeout 漏 clearTimeout（每次登录留个定时器）           1
 *   M14  v1 旧凭据的 role 猜成 guest                                    1
 *   M15  密文解不开就把密文当 token 用                                   1
 *   M16  revokeUpstreamSession 网络失败时抛错                            1   ← 见 ②
 *   ────────────────────────────────────────────────────────────────────
 *   **16 发全杀**（每发都同时满足：退出码非 0 且挂 ≥1 条）。
 *
 * 变异测出来的是**脚本自己的两个缺陷**（均已修）：
 *   ① M3 起初存活 0 条。断言写的是 `message.includes('42')`，而 "HTTP 429" 里
 *      本来就含子串 `42` —— 把 retry 秒数整段删掉，它照样 ✅。
 *      改成锚定整句 `建议 42s 后重试` 后 M3 挂 2 条。
 *      **弱断言比没断言更危险**：它让人以为这块被测过了。
 *   ② M16 起初是「0 条 ❌ + 退出码 1」。场景里意外抛错把整个报告吞掉了，
 *      只剩一个堆栈 —— 只 `grep '^  ❌'` 会判成"测试没鉴别力"，其实测试**发现了**。
 *      补了 uncaughtException / unhandledRejection 兜底（都走唯一的 `finish()`）
 *      → 现在它挂 1 条，且报告完整。
 *      （这就是"失败有两种形态，判定必须同时看退出码"。）
 *
 * 复现：每条变异给一个**唯一**锚点（不唯一直接判 MISS，避免"改错地方还以为验过"），
 *       bash 循环里 apply → 跑本脚本 → revert。驱动是**一次性草稿**（仓库根 `_tmp_mut/`，
 *       已被 `_tmp_*` 忽略，不入库）—— 要重跑照这张表把锚点补回去即可。
 *       ⚠️ 本环境 Node 的 `spawnSync` 一律 EBUSY，驱动只能在 **Bash 层循环**里跑。
 *       ⚠️ 跑完用 md5sum 复核实现文件已还原（改坏的东西不许留在工作区）。
 *
 * 另：`verify:ipc`（类型对齐）新增了 N / O / P 三条负例，证明"渲染层读不到 token"
 * 是**编译期**约束。鉴别力做法：临时给 `GuestLoginResult` / `NavigateLoginStatus`
 * 加一个可选 `token?: string | null` → N、O 立刻从"被拦住"变成"编译通过"（16 → 14），
 * 而 P（参数个数）不受影响 —— 说明 N / O 卡的正是"token 字段在不在"这件事。
 */

import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NAV = join(ROOT, 'packages', 'shell-electron', 'src', 'main', 'navigate');

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
 * 收尾：**唯一的**总结出口。
 *
 * 崩溃型失败（场景里意外抛错）必须也走这里 —— 否则报告只剩一个堆栈，
 * 退出码非 0 却一条 ❌ 都没有，看输出的人很容易把它误判成"脚本坏了、不算数"。
 * （变异表里的 M16 就是这么暴露出来的：它明明是**被发现了**，报告上却是 0 条。）
 */
function finish() {
  const total = passed + failures.length;
  console.log(`\n${failures.length === 0 ? '✅' : '❌'} verify-navigate-auth：${passed}/${total} 条通过`);
  if (failures.length > 0) {
    console.log('失败项：');
    for (const f of failures) console.log(`  · ${f}`);
  }
  process.exit(failures.length === 0 ? 0 : 1);
}

for (const evt of ['uncaughtException', 'unhandledRejection']) {
  process.on(evt, (err) => {
    check(`场景意外抛错（${evt}）—— 本不该走到这里`, false, err instanceof Error ? err.message : String(err));
    finish();
  });
}

// 兜底：任何一条场景把 promise 挂死都不许让脚本无声卡住（两种失败形态都要能看见）。
setTimeout(() => {
  console.error('\n❌ verify-navigate-auth: 超过 60s 仍未结束，判定失败（有场景挂死了）');
  process.exit(1);
}, 60_000).unref();

// ─────────────────────────────────────────────────────────────
// 假 electron —— 只实现这两个模块真正用到的那几件
// ─────────────────────────────────────────────────────────────
const WORK = mkdtempSync(join(tmpdir(), 'crossdeck-auth-'));
const FAKE_DIR = join(WORK, 'fake');
mkdirSync(FAKE_DIR, { recursive: true });

/** 与 bundle 之间的**唯一**通道：bundle 里会打进假模块的一份拷贝，靠 globalThis 通信。 */
globalThis.__fakeElectron = {
  userDataDir: join(WORK, 'userData'),
  encryptionAvailable: true,
};

writeFileSync(
  join(FAKE_DIR, 'electron.mjs'),
  `export const app = {
  getPath(name) {
    if (name !== 'userData') throw new Error('假 electron 只实现了 userData，收到：' + name);
    return globalThis.__fakeElectron.userDataDir;
  },
};
export const safeStorage = {
  isEncryptionAvailable: () => globalThis.__fakeElectron.encryptionAvailable,
  // 前后缀让"这确实是密文"和"这段密文能不能解开"两件事都可控。
  encryptString: (s) => Buffer.from('FAKEENC:' + s, 'utf8'),
  decryptString: (buf) => {
    const text = buf.toString('utf8');
    if (!text.startsWith('FAKEENC:')) throw new Error('假 safeStorage 解不开这段密文');
    return text.slice('FAKEENC:'.length);
  },
};
`,
  'utf8',
);

// ─────────────────────────────────────────────────────────────
// 用一个临时入口把 contract + 被测源码装进**同一个** bundle
// ─────────────────────────────────────────────────────────────
// 放仓库根（`_tmp_*` 已被 gitignore），这样里面可以写相对路径说明符。
const ENTRY = join(ROOT, '_tmp_verify_auth_entry.ts');
const OUT_FILE = join(WORK, 'bundle.mjs');

const rel = (p) => './' + p.split('\\').join('/');
writeFileSync(
  ENTRY,
  [
    `export * from '${rel(join('packages', 'contract', 'src', 'index.ts'))}';`,
    // core 的那份纯逻辑（状态码→码/话术）单独列出来：它是三端共用的那份，不能被漏掉。
    // ⚠️ core 的 `exports` 指向 `src/index.ts`（源码）而不是 dist —— 所以这里**没有**"加载旧 dist"的假结果。
    `export * from '${rel(join('packages', 'core', 'src', 'net', 'navigateAuth.ts'))}';`,
    `export * from '${rel(join('packages', 'shell-electron', 'src', 'main', 'navigate', 'upstream.ts'))}';`,
    `export * from '${rel(join('packages', 'shell-electron', 'src', 'main', 'navigate', 'auth.ts'))}';`,
    `export * from '${rel(join('packages', 'shell-electron', 'src', 'main', 'navigate', 'settings.ts'))}';`,
    `export * from '${rel(join('packages', 'shell-electron', 'src', 'main', 'navigate', 'tokenStore.ts'))}';`,
    `export * from '${rel(join('packages', 'shell-electron', 'src', 'main', 'navigate', 'session.ts'))}';`,
    '',
  ].join('\n'),
  'utf8',
);

process.on('exit', () => {
  rmSync(ENTRY, { force: true });
  rmSync(WORK, { recursive: true, force: true });
});

const require = createRequire(import.meta.url);
let esbuildMod;
try {
  esbuildMod = await import(pathToFileURL(require.resolve('esbuild', { paths: [join(ROOT, 'packages', 'shell-electron')] })).href);
} catch (err) {
  console.error('❌ 找不到 esbuild（shell-electron 的 devDependency）。先跑 `pnpm install`。');
  console.error(`   ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const esbuild = esbuildMod.build === undefined ? esbuildMod.default : esbuildMod;

try {
  await esbuild.build({
    entryPoints: [ENTRY],
    outfile: OUT_FILE,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'warning',
    plugins: [
      {
        // `electron` 在 Node 里不存在，换成假模块（写法与鸿蒙那份 verify 脚本同款）。
        name: 'fake-electron',
        setup(build) {
          build.onResolve({ filter: /^electron$/ }, () => ({ path: join(FAKE_DIR, 'electron.mjs') }));
        },
      },
    ],
  });
} catch (err) {
  console.error('❌ 打包失败：');
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const bundle = await import(pathToFileURL(OUT_FILE).href);
const {
  AppError,
  NAVIGATE_AUTH_DETAIL,
  encodeBridgeError,
  parseIpcError,
  describeNavigateLoginFailure,
  parseGuestLoginResponse,
  normalizeUpstreamUrl,
  loginGuest,
  revokeUpstreamSession,
  parseRetryAfter,
  navigateStatus,
  upstreamStatus,
  setUpstreamUrl,
  loginAsGuest,
  logout,
  navigateTokenStore,
} = bundle;

for (const [name, value] of Object.entries({
  describeNavigateLoginFailure,
  parseGuestLoginResponse,
  normalizeUpstreamUrl,
  loginGuest,
  setUpstreamUrl,
  loginAsGuest,
  logout,
  navigateTokenStore,
})) {
  if (value === undefined) {
    console.error(`❌ bundle 里没有 ${name} —— 导出面或入口写错了`);
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────
// 假上游：进程内 node:http（不 spawn），带"token 有效性"这张表
// ─────────────────────────────────────────────────────────────
const up = {
  /** 'ok' | 'guest-disabled' | 'rate-limited' | 'not-found' | 'server-error' | 'html' | 'malformed' | 'slow' */
  mode: 'ok',
  /** 发出去过的 token（用来在脚本里重放，而**不是**从客户端骗出来）。 */
  issued: [],
  /** 仍然有效的 token —— 登出的反向断言就看它。 */
  live: new Set(),
  requests: [],
};

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
    up.requests.push(entry);

    const url = new URL(entry.url, 'http://fake');
    const token = url.searchParams.get('token');
    const json = (status, payload) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(payload));
    };

    if (entry.method === 'POST' && url.pathname === '/api/login/guest') {
      switch (up.mode) {
        case 'guest-disabled':
          return json(503, { error: '未配置体验账号：请在 H5_LOGIN_USERS 中添加 role=guest 的账号' });
        case 'rate-limited':
          res.setHeader('retry-after', '42');
          return json(429, { error: '尝试过于频繁，请稍后再试', retryAfterSec: 42 });
        case 'not-found':
          return json(404, { error: 'not found' });
        case 'server-error':
          return json(500, { error: 'boom' });
        case 'html':
          res.statusCode = 200;
          res.setHeader('content-type', 'text/html');
          return res.end('<html><body>登录页</body></html>');
        case 'malformed':
          // role 不认识 + token 为空 —— 上游出 bug 的样子
          return json(200, { token: '', role: 'root', expiresIn: 60 });
        case 'slow':
          // 超时场景：先不响应，等测试判完再收尾（unref 免得拖着进程）
          setTimeout(() => {
            if (!res.writableEnded) res.end('late');
          }, 5_000).unref();
          return;
        case 'ok': {
          const t = `TOK-${up.issued.length + 1}`;
          up.issued.push(t);
          up.live.add(t);
          res.setHeader(
            'set-cookie',
            `navigate_session=${t}; Path=/; HttpOnly; SameSite=Lax`,
          );
          return json(200, { token: t, role: 'guest', expiresIn: 1800, next: '/' });
        }
      }
    }

    if (entry.method === 'GET' && url.pathname === '/api/logout') {
      const revoked = token !== null && up.live.delete(token);
      return json(200, { ok: true, revoked });
    }

    // 真实上游的鉴权闸门：token 不在活动表里就是 401。
    // 登出后拿**旧 token** 重放，靠的就是这一条。
    if (entry.method === 'POST' && url.pathname === '/api/resume/chat') {
      if (token === null || !up.live.has(token)) return json(401, { error: 'unauthorized' });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.end('event: done\ndata: __DONE__\n\n');
    }

    return json(404, { error: 'unknown route' });
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;
process.on('exit', () => server.close());

/** 用大 Recording 断言"上游收到的请求形状"。 */
const lastRequest = () => up.requests[up.requests.length - 1];

/** 反向断言用：拿一个 token 直接打 chat 闸门，看上游还认不认它。 */
async function upstreamAccepts(token) {
  const res = await fetch(`${BASE}/api/resume/chat?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'probe' }),
  });
  return res.status;
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ① 上游地址归一化（用户输入的第一道关）────────────');
// ═════════════════════════════════════════════════════════════
{
  const ok = (input, expected) => {
    const d = normalizeUpstreamUrl(input);
    return d.ok && d.value === expected;
  };
  const rejected = (input) => normalizeUpstreamUrl(input);

  check('null → 清空（退回脚本上游）', ok(null, null));
  check('空串 → 清空（用户在输入框里删光了）', ok('', null));
  check('全是空格 → 清空', ok('   ', null));
  check('两侧空格被去掉', ok('  http://h:3001  ', 'http://h:3001'));
  check('尾斜杠被去掉（否则会拼出 //api）', ok('http://h:3001/', 'http://h:3001'));
  check('多个尾斜杠也被去掉', ok('http://h:3001///', 'http://h:3001'));
  check('保留路径前缀，只去尾斜杠', ok('http://h:3001/proxy/', 'http://h:3001/proxy'));

  check('非绝对地址被拒（没有协议）', rejected('h:3001').ok === false);
  check('ftp:// 被拒（协议白名单）', rejected('ftp://h:3001').ok === false);
  check('javascript: 被拒（不许有任何机会进 fetch）', rejected('javascript:alert(1)').ok === false);
  check('file:// 被拒', rejected('file:///etc/passwd').ok === false);
  check('带用户名/密码被拒（会被写进诊断日志）', rejected('http://u:p@h:3001').ok === false);
  check('带 ?query 被拒（拼路径时会静默丢掉）', rejected('http://h:3001?x=1').ok === false);
  check('带 #hash 被拒', rejected('http://h:3001#x').ok === false);
  check('https 放行（远端部署）', ok('https://navigate.example.com', 'https://navigate.example.com'));

  const bad = rejected('nope');
  check('被拒时给出**可操作**的说明（不是一句"非法输入"）', bad.ok === false && bad.message.includes('http'));
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ② 状态码 → 码/话术（本卡的核心判据）─────────────');
// ═════════════════════════════════════════════════════════════
{
  const guestDisabled = describeNavigateLoginFailure(503, null);
  const rateLimited = describeNavigateLoginFailure(429, '42');
  const rejected401 = describeNavigateLoginFailure(401, null);
  const notFound = describeNavigateLoginFailure(404, null);
  const serverError = describeNavigateLoginFailure(500, null);

  check('503 → UNSUPPORTED（本轮不存在这条路，重试无意义）', guestDisabled.code === 'UNSUPPORTED', guestDisabled.code);
  check('503 detail = GUEST_DISABLED', guestDisabled.detail === 'GUEST_DISABLED', String(guestDisabled.detail));
  check(
    '503 的 detail 与 contract 的常量**同一份**（跨包不许各写一份字符串）',
    guestDisabled.detail === NAVIGATE_AUTH_DETAIL.guestDisabled,
  );
  check('503 文案说清了"重试不会解决"', guestDisabled.message.includes('重试不会解决'));

  check('429 → UPSTREAM（外部依赖暂时拒绝，重试有意义）', rateLimited.code === 'UPSTREAM', rateLimited.code);
  check('429 detail = RATE_LIMITED', rateLimited.detail === 'RATE_LIMITED', String(rateLimited.detail));
  // ⚠️ 断言必须锚在**那句完整的话**上，不能只找 `'42'`：
  //    "HTTP 429" 里本来就含子串 `42` —— 只找 `42` 的话，把 retry 秒数整段删掉
  //    这条断言照样 ✅（变异表 M3 抓到的就是这个：断言假通过）。
  check('429 文案带上了上游给的秒数', rateLimited.message.includes('建议 42s 后重试'), rateLimited.message);

  check(
    '🔴 503 与 429 的 (code, detail) **组合不同** —— 这是"能被区分"的字面判据',
    guestDisabled.code !== rateLimited.code && guestDisabled.detail !== rateLimited.detail,
    `${guestDisabled.code}/${guestDisabled.detail} vs ${rateLimited.code}/${rateLimited.detail}`,
  );
  check('503 与 429 的话术不同（不是同一句"登录失败"）', guestDisabled.message !== rateLimited.message);
  check(
    '拿到 429 但**没有** Retry-After 时不编一个数字出来',
    describeNavigateLoginFailure(429, null).message.includes('建议') === false,
  );
  check('429 + 秒数为 0 也当"没给"处理', describeNavigateLoginFailure(429, 0).message.includes('建议') === false);

  check('401 → FORBIDDEN + AUTH_REJECTED', rejected401.code === 'FORBIDDEN' && rejected401.detail === 'AUTH_REJECTED');
  check('403 → 同 401 一条路（都是身份被拒）', describeNavigateLoginFailure(403, null).detail === 'AUTH_REJECTED');
  check('404 → BAD_REQUEST（地址填错了，不是"上游坏了"）', notFound.code === 'BAD_REQUEST', notFound.code);
  check('404 文案引导去改地址', notFound.message.includes('根地址'));
  check('500 → UPSTREAM', serverError.code === 'UPSTREAM', serverError.code);

  check('Retry-After 解析：整数', parseRetryAfter('42') === 42);
  check('Retry-After 解析：带空格', parseRetryAfter(' 7 ') === 7);
  check('Retry-After 解析：认不出来就给 null（不猜 HTTP-date）', parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT') === null);
  check('Retry-After 解析：缺失给 null', parseRetryAfter(null) === null);
  check('Retry-After 解析：0 / 负数给 null', parseRetryAfter('0') === null && parseRetryAfter('-3') === null);
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ③ 上游登录响应的解析（形状不对就说形状不对）──────');
// ═════════════════════════════════════════════════════════════
{
  const now = 1_700_000_000_000;
  const good = parseGuestLoginResponse({ token: 'abc', role: 'guest', expiresIn: 1800, next: '/' }, now);
  check('合法响应 → ok', good.ok === true);
  check('token 原样带出', good.ok && good.session.token === 'abc');
  check('role 原样带出', good.ok && good.session.role === 'guest');
  check('expiresAt 由**本地时钟**算（不是把 expiresIn 当时间戳）', good.ok && good.session.expiresAt === now + 1_800_000);
  check('expiresInSec 保留上游的权威值', good.ok && good.session.expiresInSec === 1800);
  check('admin 角色被接受', parseGuestLoginResponse({ token: 'a', role: 'admin', expiresIn: 60 }, now).ok === true);

  const noToken = parseGuestLoginResponse({ role: 'guest', expiresIn: 60 }, now);
  check('缺 token → 失败', noToken.ok === false);
  const emptyToken = parseGuestLoginResponse({ token: '', role: 'guest', expiresIn: 60 }, now);
  check('空 token → 失败（空串不是凭据）', emptyToken.ok === false);

  // 这条是安全项：认不出的 rôle 被悄悄当成 guest 或 admin，都是把上游的 bug 变成越权/误拒。
  const weirdRole = parseGuestLoginResponse({ token: 'a', role: 'root', expiresIn: 60 }, now);
  check('🔴 未知名角色 → 失败（**不许猜**）', weirdRole.ok === false);
  check('未知名角色的报错里带出实际拿到的值', weirdRole.ok === false && weirdRole.message.includes('root'));

  check('expiresIn 缺失 → 失败', parseGuestLoginResponse({ token: 'a', role: 'guest' }, now).ok === false);
  check('expiresIn 为 0 / 负 → 失败', parseGuestLoginResponse({ token: 'a', role: 'guest', expiresIn: 0 }, now).ok === false);
  check('expiresIn 为 NaN → 失败', parseGuestLoginResponse({ token: 'a', role: 'guest', expiresIn: Number.NaN }, now).ok === false);
  check('响应不是对象 → 失败', parseGuestLoginResponse('nope', now).ok === false);
  check('响应是 null → 失败', parseGuestLoginResponse(null, now).ok === false);
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ④ 登录 IO（真打进程内的假上游）───────────────────');
// ═════════════════════════════════════════════════════════════
{
  up.mode = 'ok';
  const now = () => Date.now();
  up.requests.length = 0;

  const session = await loginGuest({ baseUrl: BASE, now });
  const req = lastRequest();
  check('登录成功并拿到凭据', typeof session.token === 'string' && session.token.length > 0);
  check('角色来自上游（guest）', session.role === 'guest');
  check(
    '请求形状：POST /api/login/guest',
    req.method === 'POST' && req.url === '/api/login/guest',
    `${req.method} ${req.url}`,
  );
  check('请求形状：content-type 是 JSON', String(req.headers['content-type']).includes('application/json'));
  check('请求形状：body 是空对象（express.json 对空 body 会解析报错）', req.body === '{}');
  check('登录请求**不带**任何 token（guest 免密）', req.headers.authorization === undefined && !req.url.includes('token'));

  up.mode = 'guest-disabled';
  let thrown = null;
  try {
    await loginGuest({ baseUrl: BASE, now });
  } catch (err) {
    thrown = err;
  }
  check('503 → 抛错（不是静默返回 null）', thrown instanceof AppError);
  check('503 → code UNSUPPORTED', thrown?.code === 'UNSUPPORTED', String(thrown?.code));
  check('503 → detail GUEST_DISABLED（跨 IPC 后仍能取回）', thrown?.detail === 'GUEST_DISABLED', String(thrown?.detail));
  // 真的走一遍 preload/renderer 用的那对编解码 —— 而不是假设它保真。
  const bridged503 = parseIpcError(encodeBridgeError(thrown));
  check(
    '503 过了 contextBridge 编码后 code/detail 仍然完整',
    bridged503.code === 'UNSUPPORTED' && bridged503.detail === 'GUEST_DISABLED',
    `${bridged503.code}:${String(bridged503.detail)}`,
  );

  up.mode = 'rate-limited';
  thrown = null;
  try {
    await loginGuest({ baseUrl: BASE, now });
  } catch (err) {
    thrown = err;
  }
  check('429 → code UPSTREAM', thrown?.code === 'UPSTREAM', String(thrown?.code));
  check('429 → detail RATE_LIMITED', thrown?.detail === 'RATE_LIMITED', String(thrown?.detail));
  // 同上：不能只找 `42`（"429" 自带这个子串），要锚在整句话上。
  check('429 → 文案里带上了 Retry-After 的 42 秒', thrown?.message.includes('建议 42s 后重试') === true, thrown?.message);
  const bridged429 = parseIpcError(encodeBridgeError(thrown));
  check('429 过桥后 detail 仍然完整', bridged429.detail === 'RATE_LIMITED');
  check(
    '🔴 UI 侧拿到两种失败能**分出**不同（这条就是"不是笼统压成 INTERNAL"）',
    bridged503.code !== bridged429.code && bridged503.detail !== bridged429.detail,
  );

  for (const [mode, expectedCode] of [
    ['not-found', 'BAD_REQUEST'],
    ['server-error', 'UPSTREAM'],
  ]) {
    up.mode = mode;
    thrown = null;
    try {
      await loginGuest({ baseUrl: BASE, now });
    } catch (err) {
      thrown = err;
    }
    check(`${mode} → ${expectedCode}`, thrown?.code === expectedCode, String(thrown?.code));
  }

  up.mode = 'html';
  thrown = null;
  try {
    await loginGuest({ baseUrl: BASE, now });
  } catch (err) {
    thrown = err;
  }
  check('200 但 body 是 HTML → 明确报"不是合法 JSON"（多半是地址指到了静态站点）', thrown?.message.includes('不是合法 JSON') === true, thrown?.message);

  up.mode = 'malformed';
  thrown = null;
  try {
    await loginGuest({ baseUrl: BASE, now });
  } catch (err) {
    thrown = err;
  }
  check('200 但形状不对 → 报"不符合契约"（不是假装登录成功）', thrown?.message.includes('不符合契约') === true, thrown?.message);

  // 连不上：与"超时"必须能分开报
  thrown = null;
  try {
    await loginGuest({ baseUrl: 'http://127.0.0.1:1', now, timeoutMs: 800 });
  } catch (err) {
    thrown = err;
  }
  check('连不上 → UPSTREAM 且说"无法连接"', thrown?.code === 'UPSTREAM' && thrown.message.includes('无法连接'), thrown?.message);

  up.mode = 'slow';
  thrown = null;
  const t0 = Date.now();
  try {
    await loginGuest({ baseUrl: BASE, now, timeoutMs: 120 });
  } catch (err) {
    thrown = err;
  }
  check('超时 → UPSTREAM 且说"超时"（不是"无法连接"）', thrown?.code === 'UPSTREAM' && thrown.message.includes('超时'), thrown?.message);
  check('超时真的按注入的值生效（120ms 而不是 10s）', Date.now() - t0 < 3000, `${Date.now() - t0}ms`);

  up.mode = 'ok';

  // 定时器泄漏：超时用的 setTimeout 必须被清掉，否则每次登录都挂一个到进程结束。
  const timeoutsBefore = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  await loginGuest({ baseUrl: BASE, now, timeoutMs: 30_000 });
  const timeoutsAfter = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  check(
    '登录结束后不留定时器（漏清 setTimeout 会挂 30s 到进程结束）',
    timeoutsAfter <= timeoutsBefore,
    `${timeoutsBefore} → ${timeoutsAfter}`,
  );
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ⑤ 配置通道 + 凭据落盘（用例层）───────────────────');
// ═════════════════════════════════════════════════════════════
{
  const userData = globalThis.__fakeElectron.userDataDir;
  const tokenFile = join(userData, 'navigate-token.json');
  const settingsFile = join(userData, 'navigate-settings.json');

  const initial = navigateStatus();
  check('初始：没有配上游 → scripted', initial.upstream.kind === 'scripted' && initial.upstream.baseUrl === null);
  check('初始：没有凭据', initial.login.hasToken === false);
  check('初始：盘上没有凭据文件', initial.login.persisted === false && existsSync(tokenFile) === false);

  // 非法地址：必须被拒，且**不能**写盘（"写了一半"比"拒绝"更难查）
  let badAddr = null;
  try {
    setUpstreamUrl('h:3001');
  } catch (err) {
    badAddr = err;
  }
  check('非法地址 → BAD_REQUEST', badAddr?.code === 'BAD_REQUEST', `${String(badAddr?.code)} ${String(badAddr?.message)}`);
  check('非法地址**没有**写盘', navigateStatus().upstream.kind === 'scripted');
  check('非法地址没有留下配置文件', existsSync(settingsFile) === false);

  const saved = setUpstreamUrl(`${BASE}/`);
  check('合法地址写入后 status 立刻是 navigate', saved.upstream.kind === 'navigate');
  check('尾斜杠在落盘前就被去掉了（拼路径时不会再出 //api）', saved.upstream.baseUrl === BASE, String(saved.upstream.baseUrl));
  check('地址真的落盘了（重启不用重填）', existsSync(settingsFile) === true);

  up.mode = 'ok';
  const result = await loginAsGuest();
  const secret = up.issued[up.issued.length - 1];
  check('登录结果有 role / expiresInSec / expiresAt', result.role === 'guest' && result.expiresInSec === 1800 && result.expiresAt > Date.now() - 1000);

  // ⚠️ 本卡最重要的一条：凭据**不许**出现在任何回给渲染层的东西里。
  check(
    '🔴 登录结果里没有 token 字段',
    Object.keys(result).includes('token') === false,
    Object.keys(result).join(','),
  );
  const afterLogin = navigateStatus();
  check(
    '🔴 status 里没有 token 字段',
    Object.keys(afterLogin.login).includes('token') === false,
    Object.keys(afterLogin.login).join(','),
  );
  check(
    '🔴 把 status 整个序列化后 grep 不到那个 token（比"字段名有没有"更强）',
    JSON.stringify(afterLogin).includes(secret) === false,
  );
  check('status 报出了角色与到期时间（UI 才能说"以什么身份、还剩多久"）', afterLogin.login.role === 'guest' && (afterLogin.login.expiresAt ?? 0) > Date.now());

  // 盘上**有** token（加密的），但那份只在主进程里
  const rawEnvelope = JSON.parse(readFileSync(tokenFile, 'utf8'));
  check('凭据真的落盘了', existsSync(tokenFile) === true);
  check('落盘用的是 v2 信封（v1 只存 token，装不下角色/有效期）', rawEnvelope.v === 2);
  check('safeStorage 可用时，盘上 data 是密文而不是明文 token', rawEnvelope.enc === true && rawEnvelope.data !== secret);
  check('密文里也不该出现明文 token', JSON.parse(readFileSync(tokenFile, 'utf8')).data.includes(secret) === false);

  // 重启模拟：换一个全新的模块实例再读一次
  const fresh = await import(`${pathToFileURL(OUT_FILE).href}?fresh=1`);
  check('重启后仍认得这份凭据（真的持久化，不是只在内存里）', fresh.navigateTokenStore.get() === secret);
  check('重启后角色/到期时间也还在', fresh.navigateStatus().login.role === 'guest' && fresh.navigateStatus().login.hasToken === true);
  check('重启后上游地址也还在', fresh.navigateStatus().upstream.baseUrl === BASE);
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ⑥ 旧格式 / 降级 / 坏文件（没人愿意写、但一定会遇到）');
// ═════════════════════════════════════════════════════════════
{
  const userData = globalThis.__fakeElectron.userDataDir;
  const tokenFile = join(userData, 'navigate-token.json');

  // v1：只有 token。绝不能把"不知道角色"编成某个具体角色。
  writeFileSync(tokenFile, JSON.stringify({ v: 1, enc: false, data: 'LEGACY-TOKEN' }), 'utf8');
  const v1 = await import(`${pathToFileURL(OUT_FILE).href}?v1=1`);
  check('v1 旧格式仍能读出 token（不许因为格式升级把用户登出）', v1.navigateTokenStore.get() === 'LEGACY-TOKEN');
  const v1Status = v1.navigateStatus().login;
  check('v1 的 role 如实报 null（不是猜一个 guest）', v1Status.role === null, String(v1Status.role));
  check('v1 的 expiresAt 如实报 null', v1Status.expiresAt === null);
  check('v1 的 note 说明了"建议重新登录"', v1Status.note.includes('重新登录'));

  // 密文解不开（换了机器）：不许把密文当 token 用
  writeFileSync(tokenFile, JSON.stringify({ v: 2, enc: true, data: Buffer.from('GARBAGE').toString('base64') }), 'utf8');
  const broken = await import(`${pathToFileURL(OUT_FILE).href}?broken=1`);
  check('🔴 密文解不开 → 视为无凭据（把密文当 token 会把 401 伪装成"过期"）', broken.navigateTokenStore.get() === null);
  check('解不开时 note 如实说明原因', broken.navigateStatus().login.note.includes('无法解密'));

  // 版本不认识
  writeFileSync(tokenFile, JSON.stringify({ v: 9, enc: false, data: 'X' }), 'utf8');
  const weird = await import(`${pathToFileURL(OUT_FILE).href}?v9=1`);
  check('版本不认识 → 忽略（不崩、也不假装读懂了）', weird.navigateTokenStore.get() === null);
  check('版本不认识时 note 带出实际版本号', weird.navigateStatus().login.note.includes('v=9'));

  // v2 但 role 是垃圾
  writeFileSync(tokenFile, JSON.stringify({ v: 2, enc: false, data: JSON.stringify({ token: 'T', role: 'root', expiresAt: 1 }) }), 'utf8');
  const badRole = await import(`${pathToFileURL(OUT_FILE).href}?badrole=1`);
  check('v2 里 role 不在白名单 → 整份作废（凭据最不该"尽力而为"）', badRole.navigateTokenStore.get() === null);

  // safeStorage 不可用 → 如实降级（写明文但标注），不许假装加密了
  rmSync(tokenFile, { force: true });
  globalThis.__fakeElectron.encryptionAvailable = false;
  const noCrypto = await import(`${pathToFileURL(OUT_FILE).href}?nocrypto=1`);
  noCrypto.navigateTokenStore.set({ token: 'PLAIN-TOKEN', role: 'guest', expiresInSec: 60, expiresAt: Date.now() + 60_000 });
  const plainEnvelope = JSON.parse(readFileSync(tokenFile, 'utf8'));
  check('加密不可用时 enc=false（**如实降级**，不假装加密）', plainEnvelope.enc === false);
  check('降级时 note 明确写出"明文"', noCrypto.navigateStatus().login.note.includes('明文'));
  check('降级后凭据仍然可用（不是干脆不存了）', noCrypto.navigateTokenStore.get() === 'PLAIN-TOKEN');
  globalThis.__fakeElectron.encryptionAvailable = true;
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ⑦ 登出（含那条反向断言：上游那边真的吊销了吗）────');
// ═════════════════════════════════════════════════════════════
{
  const userData = globalThis.__fakeElectron.userDataDir;
  const tokenFile = join(userData, 'navigate-token.json');
  rmSync(tokenFile, { force: true });

  // 用一个干净的实例，从"已登录"开始
  const fresh = await import(`${pathToFileURL(OUT_FILE).href}?logout=1`);
  fresh.setUpstreamUrl(BASE);
  up.mode = 'ok';
  await fresh.loginAsGuest();
  const token = up.issued[up.issued.length - 1];

  check('登出前：本机有凭据', fresh.navigateStatus().login.hasToken === true);
  check('登出前：上游认这个 token（200）', (await upstreamAccepts(token)) === 200);

  const after = await fresh.logout();

  check('登出后：本机不再持有凭据（**先清本机**，不被网络拖累）', after.login.hasToken === false);
  check('登出后：盘上的凭据文件被删掉', existsSync(tokenFile) === false && after.login.persisted === false);
  check('登出后：note 说明上游已确认吊销', after.login.note.includes('上游已确认吊销'), after.login.note);
  check(
    '🔴 登出后：拿**旧 token** 打上游 → 401（上游侧真的吊销了，不是只删了本地）',
    (await upstreamAccepts(token)) === 401,
  );
  check('登出请求走的是 GET /api/logout 且带 ?token=', up.requests.some((r) => r.method === 'GET' && r.url.startsWith('/api/logout?token=')));

  // 上游不可达时登出：本机必须照样清干净，且不许谎称已吊销
  up.mode = 'ok';
  await fresh.loginAsGuest();
  const token2 = up.issued[up.issued.length - 1];
  fresh.setUpstreamUrl('http://127.0.0.1:1');
  const offline = await fresh.logout();
  check('上游不可达时登出：本机仍然清干净（用户的诉求不能被网络挡住）', offline.login.hasToken === false);
  check('上游不可达时登出：note **如实**说"未确认吊销"', offline.login.note.includes('未确认吊销'), offline.login.note);
  check('上游不可达时登出：旧 token 在上游仍然有效（如实暴露，不谎报）', (await upstreamAccepts(token2)) === 200);

  // 没有配置上游：不该出现"未确认吊销"这种看着吓人的话
  fresh.setUpstreamUrl(null);
  const noUpstream = fresh.navigateStatus();
  check('清空地址后 → 回到 scripted（离线可跑）', noUpstream.upstream.kind === 'scripted');
  const noUp = await fresh.logout();
  check('没有上游时登出：note 不出现"未确认吊销"', noUp.login.note.includes('未确认吊销') === false, noUp.login.note);

  // 没有上游就登录 → 必须拒绝，不许悄悄用脚本上游
  let noUpLogin = null;
  try {
    await fresh.loginAsGuest();
  } catch (err) {
    noUpLogin = err;
  }
  check('🔴 没配上游就点登录 → BAD_REQUEST（不悄悄退回脚本上游）', noUpLogin?.code === 'BAD_REQUEST', String(noUpLogin?.code));
  check('拒绝时给出可操作的说明', noUpLogin?.message.includes('http') === true, noUpLogin?.message);
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ⑧ revoke 的边界（不抛错的那份契约）─────────────');
// ═════════════════════════════════════════════════════════════
{
  check('没有上游 → no-upstream（并说明无需吊销）', (await revokeUpstreamSession({ baseUrl: null }, 'T')).result === 'no-upstream');
  check('上游不可达 → revoke-failed 且带原因', (await revokeUpstreamSession({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 }, 'T')).result === 'revoke-failed');
  check('正常吊销 → revoked', (await revokeUpstreamSession({ baseUrl: BASE }, 'A-NONEXISTENT')).result === 'revoked');
  // ⚠️ 这条必须**真的**去调用一次：写成 `check(..., true)` 是个恒真断言，
  //    看起来在验"不抛错"，其实什么都没验（记入变异表：这类断言变异存活率 100%）。
  let revokeThrew = null;
  try {
    await revokeUpstreamSession({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 300 }, 'T');
  } catch (err) {
    revokeThrew = err;
  }
  check('revoke 永不抛错（登出不能因为网络失败而失败）', revokeThrew === null, String(revokeThrew));
}

// ─────────────────────────────────────────────────────────────
finish();
