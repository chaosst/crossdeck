/**
 * 自检用的**假 navigate 上游** —— 在**被测进程内**用 `node:http` 起。
 *
 * 为什么不 spawn 一个真服务器：本机沙箱里 Node 派生 piped 子进程**必 EBUSY**
 * （异步 `spawn` 可以、`spawnSync` 不行），而自检又要能在无网络 / CI / 受限会话里跑。
 * 放在进程内还顺带解决了两件事：端口由系统分配（不会撞端口）、
 * 收尾时不需要跨进程等待（`close()` 直接 await）。
 *
 * ⚠️ 这个文件**只在 `--selfcheck` 分支被调用**，不属于任何用户路径。
 *    它出现在 main 产物里只是因为打包是整包的 —— 别从这里被 import 到别处。
 *
 * 协议与真上游逐字对齐（凭据/帧形状以真帧语料为准，见 `docs/evidence/navigate-sse/`）：
 *   · `POST /api/login/guest` → `{token, role, expiresIn, next}` + `set-cookie`
 *   · `POST /api/resume/chat?token=…` + body `{question}` → SSE
 *   · `GET /api/logout?token=…` → 吊销该 token
 *   · 事件名 `token` / `error` / `done`；**`done` 的 data 是裸字面量 `__DONE__`，
 *     而 `token` 的 data 是 JSON 字符串** —— 假上游必须照抄这个不对称，
 *     否则测的是"一个更方便的上游"，而不是真的那个。
 *
 * 五个场景（由 `question` 决定，见 `FAKE_SCENARIO_PROMPTS`）：
 *   normal          token×N → done
 *   silent-close    token×N → **干净 EOF**（`res.end()`，不发 done）
 *   killed          token×N → **socket 被销毁**（模拟"把上游进程杀了"）
 *   upstream-error  token×N → `event: error`
 *   abort           **慢慢滴**字，留给客户端中途 abort
 *
 * 为什么 silent-close 与 killed 要分成两个：它们在客户端走的是**两条不同的代码路径** ——
 * 干净 EOF 触发 `finishStream()`（"没收到 done 帧"），socket 销毁触发 `reader.read()` 抛错。
 * 合成一个就会漏掉另一条，而两条的失败模式（一个报"提前关闭"、一个报"读取失败"）并不相同。
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { NAVIGATE_CHAT_PATH, NAVIGATE_DONE_LITERAL } from '@crossdeck/core';

export type FakeScenario = 'normal' | 'silent-close' | 'killed' | 'upstream-error' | 'abort';

/**
 * 场景 → 触发它的 prompt。
 *
 * 为什么用 prompt 而不是"多个端口"或"服务端可变状态"：`/api/resume/chat` 只吃
 * `{ question }`，所以"这一次要演哪个剧本"本来就只能从 question 里读 ——
 * 这样场景选择走的是**真实请求内容**，不需要测试专用旁路。
 */
export const FAKE_SCENARIO_PROMPTS: Readonly<Record<FakeScenario, string>> = {
  normal: 'selfcheck:navigate-normal',
  'silent-close': 'selfcheck:navigate-close',
  killed: 'selfcheck:navigate-killed',
  'upstream-error': 'selfcheck:navigate-error',
  abort: 'selfcheck:navigate-abort',
};

/** 正常场景吐的文本，切成 5 片 —— 客户端应当分 5 次 `onChunk` 收到（不是一次到齐）。 */
export const FAKE_NORMAL_CHUNKS: readonly string[] = ['SELF', 'CHECK-', 'NAV', 'IGATE-', 'OK!!'];

/** 拼起来的全文（断言 textLength 用它，避免在断言里手抄一遍字符串）。 */
export const FAKE_NORMAL_TEXT = FAKE_NORMAL_CHUNKS.join('');

export interface FakeUpstreamStats {
  /** guest 登录次数 */
  logins: number;
  /** 每个场景服务端实际写出的 token 帧数 */
  frames: Record<string, number>;
  /** 服务端把响应写完（`res.end()` 过）的场景 */
  ended: string[];
  /** 发过 done 帧的场景 */
  doneSent: string[];
  /**
   * 客户端**在服务端写完之前**断开连接的场景。
   * abort 场景必须出现在这里 —— 这是"停止真的断了连接"的**上游侧**证据。
   */
  clientGone: string[];
}

export interface FakeNavigateUpstream {
  /** 形如 `http://127.0.0.1:<port>`（端口由系统分配）。 */
  readonly baseUrl: string;
  readonly stats: FakeUpstreamStats;
  /** 当前仍然有效的 token —— 登出会把它删掉（与真上游同义）。 */
  readonly liveTokens: Set<string>;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function startFakeNavigateUpstream(): Promise<FakeNavigateUpstream> {
  let seq = 0;
  const liveTokens = new Set<string>();
  const stats: FakeUpstreamStats = { logins: 0, frames: {}, ended: [], doneSent: [], clientGone: [] };

  const sendFrame = (res: ServerResponse, event: string, data: string): void => {
    res.write(`event: ${event}\ndata: ${data}\n\n`);
  };

  const scenarioFor = (question: string): FakeScenario | null => {
    for (const [name, prompt] of Object.entries(FAKE_SCENARIO_PROMPTS)) {
      if (prompt === question) return name as FakeScenario;
    }
    return null;
  };

  /** SSE 响应头 —— `flushHeaders()` 不能省，否则客户端在服务端累积到一定字节前收不到首字节。 */
  const openSse = (res: ServerResponse): void => {
    res.statusCode = 200;
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('connection', 'keep-alive');
    res.flushHeaders();
  };

  const streamScenario = (scenario: FakeScenario, res: ServerResponse): void => {
    openSse(res);
    stats.frames[scenario] = 0;

    let stopped = false;
    let timer: NodeJS.Timeout | null = null;

    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      if (timer !== null) clearInterval(timer);
    };

    // 「客户端断开了吗」的判据是 `close` 且**没写过 end**：
    // 正常写完也会 close，所以单看 close 事件会把每个正常请求都算成断开。
    res.on('close', () => {
      if (!res.writableEnded && !stats.clientGone.includes(scenario)) {
        stats.clientGone.push(scenario);
      }
      stop();
    });

    const frame = (event: string, data: string): void => {
      sendFrame(res, event, data);
      if (event === 'token') stats.frames[scenario] = (stats.frames[scenario] ?? 0) + 1;
      if (event === 'done') stats.doneSent.push(scenario);
    };

    if (scenario === 'abort') {
      // 慢慢滴：给客户端留出"中途点停止"的时间窗。停不下来（=没断连）时本定时器会一直跑，
      // 由收尾的 `close()` 兜住 —— 所以下面每一拍都先自查 `stopped`。
      timer = setInterval(() => {
        if (stopped || res.writableEnded || res.destroyed) return stop();
        frame('token', JSON.stringify('滴'));
      }, 60);
      return;
    }

    let i = 0;
    timer = setInterval(() => {
      if (stopped || res.writableEnded || res.destroyed) return stop();

      if (i < FAKE_NORMAL_CHUNKS.length) {
        frame('token', JSON.stringify(FAKE_NORMAL_CHUNKS[i]));
        i += 1;
        return;
      }

      stop();
      switch (scenario) {
        case 'normal':
          frame('done', NAVIGATE_DONE_LITERAL);
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
          // 粗暴断开：客户端读到的是流错误，不是 EOF。两条路必须都覆盖。
          res.destroy();
          return;
        default:
          return;
      }
    }, 20);
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://fake');

      const json = (status: number, payload: unknown): void => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(payload));
      };

      if (req.method === 'POST' && url.pathname === '/api/login/guest') {
        seq += 1;
        const token = `selfcheck-token-${seq}`;
        liveTokens.add(token);
        stats.logins += 1;
        res.setHeader('set-cookie', `navigate_session=${token}; Path=/; HttpOnly; SameSite=Lax`);
        json(200, { token, role: 'guest', expiresIn: 1800, next: '/' });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/logout') {
        const token = url.searchParams.get('token');
        json(200, { ok: true, revoked: token !== null && liveTokens.delete(token) });
        return;
      }

      if (req.method === 'POST' && url.pathname === NAVIGATE_CHAT_PATH) {
        const token = url.searchParams.get('token');
        // 真实上游的闸门：不在活动表里就是 401。自检断言"登出后旧 token 不再可用"靠它。
        if (token === null || !liveTokens.has(token)) return json(401, { error: 'unauthorized' });

        let question = '';
        try {
          const parsed: unknown = JSON.parse(await readBody(req));
          if (typeof parsed === 'object' && parsed !== null && 'question' in parsed) {
            question = String((parsed as { question: unknown }).question);
          }
        } catch {
          // body 不是 JSON 就当空 question —— 下面会按"不认识的场景"回 400。
        }

        const scenario = scenarioFor(question);
        if (scenario === null) {
          json(400, { error: `自检假上游不认识这个场景：${question}` });
          return;
        }
        streamScenario(scenario, res);
        return;
      }

      json(404, { error: 'unknown route' });
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('假上游监听成功但拿不到端口 —— 无法给出 baseUrl');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    stats,
    liveTokens,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // keep-alive 连接会挡住 close —— SSE 场景下这是常态，直接掐掉。
        server.closeAllConnections();
      }),
  };
}
