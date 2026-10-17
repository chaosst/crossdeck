/**
 * navigate 的**认证 IO** —— guest 登录与登出（Electron 壳这一份）。
 *
 * 只负责网络：拼地址、超时、读状态码、解析响应体。
 * 「状态码该翻成什么话、什么码」在 core 的 `describeNavigateLoginFailure`（纯逻辑，三端共用）。
 *
 * 刻意**不 import electron**：凭据由调用方（`session.ts`）负责存，
 * 于是这个文件能被裸 Node 加载单独验证 —— 与 `navigate/client.ts` 同一条理由。
 *
 * 认证方式与上游对齐（`src/server/auth-helpers.ts` 的 `getToken`：query → body → cookie）：
 *   · 登录：POST，无凭据（guest 免密）
 *   · 登出：**GET + `?token=`** —— GET 没有 body，而 cookie 是浏览器的机制，主进程里没有
 */

import { AppError } from '@crossdeck/contract';
import {
  NAVIGATE_AUTH_TIMEOUT_MS,
  NAVIGATE_CHALLENGE_NEEDED_PATH,
  NAVIGATE_LOGIN_CODE_PATH,
  NAVIGATE_LOGIN_GUEST_PATH,
  NAVIGATE_LOGIN_PATH,
  NAVIGATE_LOGOUT_PATH,
  describeNavigateLoginFailure,
  errorMessage,
  parseGuestLoginResponse,
} from '@crossdeck/core';
import type { NavigateSession } from '@crossdeck/core';

export interface NavigateAuthConfig {
  /** 已归一化的根地址（`normalizeUpstreamUrl` 的产物），无尾斜杠。 */
  readonly baseUrl: string;
  /** 本地时钟。`expiresAt` 必须由本地时间算，不能把上游的 `expiresIn` 当时间戳。 */
  readonly now: () => number;
  /** 覆盖默认超时（测试用）。 */
  readonly timeoutMs?: number | undefined;
  /** 注入 fetch（测试用）；缺省用全局的。 */
  readonly fetchImpl?: typeof fetch | undefined;
  /** 验证码会话 sid（`createChallenge` 返回的）。带它才能过上游的校验码复核。 */
  readonly sid?: string | undefined;
}

/**
 * 只做网络所需的那部分配置。
 *
 * 单独写一个而不复用 `NavigateAuthConfig`：revoke 是**在登出之后**跑的，
 * 那时"配置里还有一个地址"已经不能保证（用户可以一边登出一边清地址），
 * 所以它的 `baseUrl` 必须能是 `null`，且要有一个明确的"没有上游"分支。
 * （可选字段显式带上 `| undefined`：`exactOptionalPropertyTypes` 下
 *   把 `number | undefined` 赋给 `number?` 是不允许的。）
 */
export interface UpstreamRevokeConfig {
  readonly baseUrl: string | null;
  readonly timeoutMs?: number | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

/**
 * 解析 `Retry-After`。
 *
 * 只认**秒数**这一种写法：上游只发秒数（`String(retryAfterSec)`）。
 * HTTP 规范里还允许 HTTP-date，但既然上游不用，就不去猜一个可能猜错的日期 ——
 * 认不出来时返回 `null`，文案里便不出现"建议 N 秒后重试"这种编出来的数字。
 */
export function parseRetryAfter(raw: string | null): number | null {
  if (raw === null) return null;
  const seconds = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** 带超时的 fetch。超时与"连不上"必须能分开报 —— 两者的排查方向完全不同。 */
async function fetchWithTimeout(
  cfg: { readonly baseUrl: string; readonly timeoutMs?: number | undefined; readonly fetchImpl?: typeof fetch | undefined },
  url: string,
  init: RequestInit,
): Promise<Response> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const timeoutMs = cfg.timeoutMs ?? NAVIGATE_AUTH_TIMEOUT_MS;
  const ac = new AbortController();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, timeoutMs);

  try {
    return await doFetch(url, { ...init, signal: ac.signal });
  } catch (err) {
    throw new AppError(
      'UPSTREAM',
      timedOut
        ? `连接上游 ${cfg.baseUrl} 超时（${timeoutMs}ms）—— 检查地址是否可达`
        : `无法连接上游 ${cfg.baseUrl}：${errorMessage(err)}`,
    );
  } finally {
    // 必须清：漏了的话每次登录都会留一个 10s 的定时器，进程退出前一直挂着。
    clearTimeout(timer);
  }
}

/** 上游的会话 cookie 名（绑定验证码：取图与提交登录都必须带它）。 */
const SID_COOKIE = 'navigate_sid';

/** 从 Set-Cookie 里解出上游的会话 sid；没有就是上游契约变了，大声失败。 */
function readSidCookie(res: Response): string | null {
  const lines = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const line of lines) {
    const m = new RegExp(`(?:^|;)\\s*${SID_COOKIE}=([^;]+)`).exec(line);
    if (m !== null) return decodeURIComponent(m[1]!);
  }
  return null;
}

/** 创建验证码挑战的完整凭据：challengeId + 绑定它的会话 sid（只活主进程）。 */
export interface ChallengeTicket {
  readonly challengeId: string;
  readonly sid: string;
}

/**
 * 领取验证码挑战。
 *
 * 上游领挑战时会种 httpOnly 的 `navigate_sid`，此后取图、提交登录都要带它；
 * 丢了 sid，取图是 404 `{"error":"not found"}`，提交是 401「校验码缺失」。
 */
export async function createChallenge(cfg: NavigateAuthConfig): Promise<ChallengeTicket> {
  const endpoint = `${cfg.baseUrl}${NAVIGATE_LOGIN_CODE_PATH}`;
  const res = await fetchWithTimeout(cfg, endpoint, { method: 'GET' });

  if (!res.ok) {
    const failure = describeNavigateLoginFailure(res.status, parseRetryAfter(res.headers.get('retry-after')));
    throw new AppError(failure.code, failure.message, failure.detail);
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    throw new AppError('UPSTREAM', `上游登录响应不是合法 JSON：${errorMessage(err)}`);
  }

  const challengeId = payload.challengeId;
  if (typeof challengeId !== 'string' || challengeId === '') {
    throw new AppError('UPSTREAM', '上游没有返回 challengeId');
  }
  const sid = readSidCookie(res);
  if (sid === null) {
    throw new AppError('UPSTREAM', `上游没有种会话 cookie（${SID_COOKIE}）—— 无法取回验证码图片`);
  }
  return { challengeId, sid };
}

/** 验证码图片（BMP 原始字节）。 */
export async function fetchChallengeImage(
  cfg: NavigateAuthConfig,
  challengeId: string,
  sid: string,
): Promise<Uint8Array> {
  const endpoint = `${cfg.baseUrl}${NAVIGATE_LOGIN_CODE_PATH}/${encodeURIComponent(challengeId)}/image`;
  const res = await fetchWithTimeout(cfg, endpoint, {
    method: 'GET',
    headers: { cookie: `${SID_COOKIE}=${encodeURIComponent(sid)}`, accept: 'image/bmp' },
  });

  if (!res.ok) {
    throw new AppError('UPSTREAM', `取验证码图片失败：HTTP ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * 当前是否需要校验码（上游 `/api/login/challenge-needed`）。
 *
 * 与提交时的判定完全同源（上游 server 侧同一个 `needsChallenge`），
 * 所以"探测说需要"和"提交被要求校验码"不会各说各话。
 */
export async function fetchChallengeNeeded(cfg: NavigateAuthConfig, username: string): Promise<boolean> {
  const q = username === '' ? '' : `?username=${encodeURIComponent(username)}`;
  const res = await fetchWithTimeout(cfg, `${cfg.baseUrl}${NAVIGATE_CHALLENGE_NEEDED_PATH}${q}`, {
    method: 'GET',
    headers: { accept: 'application/json' },
  });

  if (!res.ok) {
    throw new AppError('UPSTREAM', `探测校验码状态失败：HTTP ${res.status}`);
  }
  const payload = (await res.json()) as { needChallenge?: unknown };
  return payload.needChallenge === true;
}

export interface LoginBody {
  username?: string;
  password?: string; 
  next?: string; 
  challengeId?: string; 
  code?: string;
}

/**
 * 登录失败 —— 在原有错误码/文案之外，额外带上"上游要不要校验码"。
 *
 * detail 用 `|` 拼上 `NEED_CHALLENGE`：它是唯一能原样穿过 IPC 的结构化字段
 * （见 contract 的 SerializedError），渲染层据此决定展开校验码区。
 */
export class LoginFailureError extends AppError {
  readonly needChallenge: boolean;

  constructor(failure: { code: AppError['code']; message: string; detail?: string }, needChallenge: boolean) {
    super(
      failure.code,
      failure.message,
      needChallenge ? joinDetail(failure.detail, NEED_CHALLENGE_DETAIL) : failure.detail,
    );
    this.needChallenge = needChallenge;
  }
}

/** `SerializedError.detail` 里表示"需要校验码"的标记。 */
export const NEED_CHALLENGE_DETAIL = 'NEED_CHALLENGE';

function joinDetail(base: string | undefined, extra: string): string {
  return base === undefined || base === '' ? extra : `${base}|${extra}`;
}

/**
 * 用户登录。失败时抛 `LoginFailureError` —— 不只是错误，还带着"要不要展示校验码"。
 */
export async function login(body: LoginBody, cfg: NavigateAuthConfig): Promise<NavigateSession> {
  const endpoint = `${cfg.baseUrl}${NAVIGATE_LOGIN_PATH}`;
  const res = await fetchWithTimeout(cfg, endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      // 上游在需要校验码时会复核这个会话 cookie；不带它提交一律 401「校验码缺失」。
      ...(cfg.sid === undefined ? {} : { cookie: `${SID_COOKIE}=${encodeURIComponent(cfg.sid)}` }),
    },
    // 上游读 `req.body ?? {}`；带一个空对象比空 body 稳（express.json 对空 body 会报解析错）。
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const failure = describeNavigateLoginFailure(res.status, parseRetryAfter(res.headers.get('retry-after')));
    // 429 也带 needChallenge: false；401 才可能是 true。读不出来就当 false，不臆测。
    let needChallenge = false;
    try {
      const payload = (await res.json()) as { needChallenge?: unknown };
      needChallenge = payload.needChallenge === true;
    } catch {
      // 非 JSON 响应（反代 HTML 等）—— 这里不该抛新错覆盖掉真正的状态码语义
    }
    throw new LoginFailureError(failure, needChallenge);
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch (err) {
    // 200 但 body 不是 JSON —— 多半是地址指到了一个静态站点 / 反代返回了 HTML。
    throw new AppError('UPSTREAM', `上游登录响应不是合法 JSON：${errorMessage(err)}`);
  }

  const parsed = parseGuestLoginResponse(payload, cfg.now());
  if (!parsed.ok) {
    throw new AppError('UPSTREAM', `上游登录响应不符合契约：${parsed.message}`);
  }
  return parsed.session;
}

/**
 * guest 一键登录（`POST /api/login/guest`）。
 *
 * 失败一律抛 `AppError`，**码与 detail 由 core 决定** ——
 * 503（服务端没配体验账号）与 429（限流）因此是可区分的两条路，而不是笼统的"登录失败"。
 */
export async function loginGuest(cfg: NavigateAuthConfig): Promise<NavigateSession> {
  const endpoint = `${cfg.baseUrl}${NAVIGATE_LOGIN_GUEST_PATH}`;

  const res = await fetchWithTimeout(cfg, endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    // 上游读 `req.body ?? {}`；带一个空对象比空 body 稳（express.json 对空 body 会报解析错）。
    body: '{}',
  });

  if (!res.ok) {
    const failure = describeNavigateLoginFailure(res.status, parseRetryAfter(res.headers.get('retry-after')));
    throw new AppError(failure.code, failure.message, failure.detail);
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch (err) {
    // 200 但 body 不是 JSON —— 多半是地址指到了一个静态站点 / 反代返回了 HTML。
    throw new AppError('UPSTREAM', `上游登录响应不是合法 JSON：${errorMessage(err)}`);
  }

  const parsed = parseGuestLoginResponse(payload, cfg.now());
  if (!parsed.ok) {
    throw new AppError('UPSTREAM', `上游登录响应不符合契约：${parsed.message}`);
  }
  return parsed.session;
}

export type UpstreamRevokeResult = 'revoked' | 'revoke-failed' | 'no-upstream';

export interface UpstreamRevoke {
  readonly result: UpstreamRevokeResult;
  /** 失败时的一句话原因（可直接给 UI 显示）。成功/无需吊销时没有。 */
  readonly message?: string;
}

/**
 * 让上游吊销这个 token（`GET /api/logout?token=…`）。
 *
 * **永不抛错**，理由：登出的第一诉求是"把这台机器上的凭据清掉"，那件事已经做完了。
 * 网络不通时再把整个登出操作判成失败，用户看到的是"登出失败"而实际上已经登出了 ——
 * 一个状态与事实不符的界面。这里只如实回报"上游那边到底有没有确认吊销"，
 * 由调用方把它写进登录态的 `note`。
 */
export async function revokeUpstreamSession(
  cfg: UpstreamRevokeConfig,
  token: string,
): Promise<UpstreamRevoke> {
  const { baseUrl } = cfg;
  if (baseUrl === null) {
    return { result: 'no-upstream', message: '当前没有配置上游，无需吊销' };
  }

  // 与 chat 同一条认证通道：`getToken` 的顺序是 query → body → cookie，而 GET 没有 body。
  const url = `${baseUrl}${NAVIGATE_LOGOUT_PATH}?token=${encodeURIComponent(token)}`;

  let res: Response;
  try {
    res = await fetchWithTimeout(
      { baseUrl, timeoutMs: cfg.timeoutMs, fetchImpl: cfg.fetchImpl },
      url,
      { method: 'GET', headers: { accept: 'application/json' } },
    );
  } catch (err) {
    return { result: 'revoke-failed', message: errorMessage(err) };
  }

  // 上游先把 token 从表里删掉再回响应，所以 2xx 就等于"确实吊销了"。
  // 非 2xx 不当作错误处理（token 可能早就过期/被清）—— 但也不谎称吊销成功。
  return res.ok
    ? { result: 'revoked' }
    : { result: 'revoke-failed', message: `上游登出接口返回 HTTP ${res.status}` };
}
