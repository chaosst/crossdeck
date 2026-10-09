/**
 * 自检用的**假 navigate 上游**（宿主侧，零依赖）—— Web 壳自检与鸿蒙壳验证共用这一份。
 *
 * ## 为什么要有这个共享模块（而不是各自在脚本里抄一遍）
 *
 * 到 T14 为止，需要"假上游"的地方有两个宿主脚本：
 *   · `packages/shell-web/scripts/web-selfcheck.mjs`（同源：挂在自己的静态服务器上）
 *   · `packages/shell-ohos/scripts/verify-ohos.mjs`（宿主侧起，经 `hdc rport` 映射进模拟器）
 *
 * 抄两份的代价不是"多写几十行"，而是**场景词表会有两个版本**：
 * 一端改了 prompt，另一端还认旧的 —— 而症状是"这个场景不存在（400）"，
 * 看起来像客户端的问题。共用一份就没有这个可能。
 *
 * ⚠️ Electron 壳那一份**没有搬过来**（仍是 `shell-electron/src/main/fakeNavigateUpstream.ts`）：
 *    它跑在 Electron 主进程内，要跟着 main 一起被打包，而这边是宿主脚本。
 *    两者刻意保留同样的场景词表 —— 但这是"约定一致"，不是"同一份代码"。
 *    真要合并，得先有跨 TS/JS 的共享机制，那是另一件事。
 *
 * ## 协议与真上游逐字对齐
 *
 *   · `POST <loginPath>` → `{token, role, expiresIn, next}`（cookie 模式额外 `set-cookie`）
 *   · `POST <chatPath>`  → SSE
 *   · 事件名 `token` / `error` / `done`；**`done` 的 data 是裸字面量 `__DONE__`，
 *     而 `token` 的 data 是 JSON 字符串** —— 假上游必须照抄这个不对称，
 *     否则测的是"一个更方便的上游"。
 *
 * ## 五个场景（由 `question` 决定）
 *
 *   normal          token×N → done
 *   silent-close    token×N → **干净 EOF**（`res.end()`，不发 done）
 *   killed          token×N → **socket 被销毁**（模拟"把上游进程杀了"）
 *   upstream-error  token×N → `event: error`
 *   abort           **慢慢滴**字，留给客户端中途 abort
 *   slow            token×N，每片 700ms —— **给抓拍用的**（20ms 那一档 300ms 就完了，
 *                   截图只能拍到"还没开始"或"已经结束"），不参与断言
 *
 * silent-close 与 killed 必须分成两个：客户端走的是**两条不同的代码路径** ——
 * 干净 EOF 触发 `finishStream()`（"没收到 done 帧"），socket 销毁触发 `reader.read()` 抛错。
 * 合成一个就会漏掉另一条，而两条的失败模式并不相同。
 *
 * ## 鉴权两种形态（壳之间真实存在的差异，不是开关好玩的）
 *
 *   `auth: 'cookie'` —— Web 壳：凭据是同源 httpOnly cookie，由浏览器自动带上
 *   `auth: 'token'`  —— Electron / 鸿蒙壳：token 进请求体
 * 两种都要**真的挡住**：没凭据就 401。否则"未登录也连上了"会把一条断言变成摆设。
 */

/** 场景 → 触发它的 prompt。 */
export const NAV_SCENARIO_PROMPTS = {
  normal: 'selfcheck:navigate-normal',
  'silent-close': 'selfcheck:navigate-close',
  killed: 'selfcheck:navigate-killed',
  'upstream-error': 'selfcheck:navigate-error',
  abort: 'selfcheck:navigate-abort',
  /**
   * 慢流：同样 5 片，但每片间隔 700ms（≈4s 才收尾）。
   *
   * 为什么要单独有它：20ms 那一档整条流 **300ms 就结束了** —— 抓拍永远只能拍到
   * "还没开始"或"已经结束"，而"截图要能看到逐字流"正是要拍到中间那一帧。
   * 它是**给拍照用的**，不参与断言（断言靠 diagnostics / 事件序列，不靠时序）。
   */
  slow: 'selfcheck:navigate-slow',
};

/** 正常场景吐的文本，切成 5 片 —— 客户端应当分多次收到（不是一次到齐）。 */
export const NAV_NORMAL_CHUNKS = ['SELF', 'CHECK-', 'NAV', 'IGATE-', 'OK!!'];

/** 一个必然不被认识的场景名 —— 调用方拿它做反例。 */
export const NAV_UNKNOWN_PROMPT = 'selfcheck:navigate-not-a-scenario';

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function cookieToken(req) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === 'navigate_session') return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * 造一个假上游。`chatPath` / `doneLiteral` 由调用方从 **core 的真实产物** 注入，
 * 不在这里再抄一遍 —— 抄一份就等于给"协议漂移"留了一条静默通道。
 *
 * @param {object} opts
 * @param {string} opts.chatPath        navigate 的问答路径（来自 core）
 * @param {string} opts.doneLiteral     `done` 帧的裸字面量（来自 core）
 * @param {'cookie'|'token'} [opts.auth='cookie']
 * @param {string} [opts.loginPath='/api/login/guest']
 * @param {string} [opts.fixedToken]    只接受这一个 token（鸿蒙用：token 由验证脚本从命令行注入）
 */
export function createFakeNavigateUpstream(opts) {
  const { chatPath, doneLiteral } = opts;
  const auth = opts.auth ?? 'cookie';
  const loginPath = opts.loginPath ?? '/api/login/guest';
  const fixedToken = opts.fixedToken ?? null;

  const liveTokens = new Set();
  const timers = new Set();
  let seq = 0;
  const stats = { logins: 0, frames: {}, ended: [], doneSent: [], clientGone: [], unknown: [] };

  if (fixedToken !== null) liveTokens.add(fixedToken);

  const json = (res, status, payload) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(payload));
  };

  const openSse = (res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('connection', 'keep-alive');
    // `flushHeaders()` 不能省：不 flush 的话要等服务端攒够一定字节才发首字节，
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
     * 不然 `close` 那一判会把"我把它杀了"也算成"客户端跑了" —— 于是 `clientGone`
     * 里混进一个假条目，而它正是 abort 那条断言**唯一**的证据来源。
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
    // 慢流每片 700ms —— 见 `slow` 场景的说明（它是给抓拍用的，不是给断言用的）。
    const gapMs = scenario === 'slow' ? 700 : 20;
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
          killedByUs = true;
          res.destroy();
          return;
        default:
          return;
      }
    }, gapMs);
    timers.add(timer);
  };

  const fixture = {
    chatPath,
    auth,
    scenarios: NAV_SCENARIO_PROMPTS,
    normalChunks: NAV_NORMAL_CHUNKS,
    normalText: NAV_NORMAL_CHUNKS.join(''),
    unknownPrompt: NAV_UNKNOWN_PROMPT,
  };

  /** @returns true = 已处理（调用方的静态/其他路由不必再看）。 */
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
    if (req.method === 'POST' && url.pathname === loginPath) {
      seq += 1;
      const token = fixedToken ?? `selfcheck-token-${seq}`;
      liveTokens.add(token);
      stats.logins += 1;
      if (auth === 'cookie') {
        res.setHeader('set-cookie', `navigate_session=${token}; Path=/; HttpOnly; SameSite=Lax`);
      }
      // 真上游的响应体里本来也回一份 token（Electron 壳就靠它），照抄。
      json(res, 200, { token, role: 'guest', expiresIn: 1800, next: '/' });
      return true;
    }
    if (req.method === 'POST' && url.pathname === chatPath) {
      let question = '';
      let bodyToken = null;
      try {
        const parsed = JSON.parse(await readBody(req));
        if (parsed !== null && typeof parsed === 'object') {
          if ('question' in parsed) question = String(parsed.question);
          if ('token' in parsed) bodyToken = String(parsed.token);
        }
      } catch {
        // body 不是 JSON 就当空 question —— 下面按"不认识的场景"回 400。
      }

      // 与真上游同一条闸门（其顺序是 `?token=` → body.token → cookie）：
      // 没有有效凭据就是 401。调用方靠它验证"未登录"这条反向路径真的被挡住。
      const presented =
        auth === 'cookie' ? cookieToken(req) : (url.searchParams.get('token') ?? bodyToken);
      if (presented === null || !liveTokens.has(presented)) {
        json(res, 401, { error: 'unauthorized' });
        return true;
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
    fixture,
    handle,
    close: () => {
      for (const t of timers) clearInterval(t);
      timers.clear();
    },
  };
}
