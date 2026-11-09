/**
 * navigate 的配置与登录 —— 页内主进程这一份。
 *
 * ## 与桌面壳最大的差别：凭据不在我们手里
 *
 * 桌面壳拿 token，加密落盘，随时能读出来算「还剩几分钟」。浏览器里凭据是
 * **同源 httpOnly cookie**：JS 读不到，也不该读。于是"我登录了吗"这个问题
 * 只能去问上游 —— `/api/me` 认这个 cookie 就算登录着。
 *
 * 这不是降级，是换了个权威：桌面壳的权威是本地 token 存储，Web 的权威是上游应答。
 * `NavigateLoginStatus.note` 里如实写清楚，UI 才有机会说一句真话。
 *
 * ## 同源是唯一形态
 *
 * httpOnly + `SameSite=Lax` 的 cookie 跨源既带不上、也过不了 CORS（上游不开 CORS）。
 * 所以 `setUpstream` 在这里只接受三种输入：`null`（脚本上游）、空串 / `'1'`（同源）、
 * 与当前 origin 相同的绝对地址。给别的地址不是"尽力而为"，是明确拒绝。
 */

import {
  NAVIGATE_CHALLENGE_NEEDED_PATH,
  NAVIGATE_LOGIN_CODE_PATH,
  NAVIGATE_LOGIN_GUEST_PATH,
  NAVIGATE_LOGIN_PATH,
  NAVIGATE_LOGOUT_PATH,
  NAVIGATE_ME_PATH,
  NAVIGATE_AUTH_TIMEOUT_MS,
  describeNavigateLoginFailure,
  parseGuestLoginResponse,
  parseNavigateRole,
} from '@crossdeck/core';
import type {
  GuestLoginResult,
  LoginChallengeNeeded,
  LoginCodeResult,
  NavigateLoginStatus,
  NavigateStatus,
  NavigateUpstreamStatus,
} from '@crossdeck/contract';
import { errorText, fail } from './errors.js';

/** 登录时上游接受的身体。与桌面壳同形（上游读 `req.body ?? {}`）。 */
export interface LoginBody {
  username?: string;
  password?: string;
  next?: string;
  challengeId?: string;
  code?: string;
}

/** `detail` 里的"需要校验码"标记 —— 与桌面壳同一个字面量（Login.tsx 按它展开校验码区）。 */
const NEED_CHALLENGE = 'NEED_CHALLENGE';

export interface NavigateHostOptions {
  readonly now: () => number;
  /** `location.search` 的 `?upstream=`：缺省 = 脚本上游。 */
  readonly upstreamParam: string | null;
}

export class NavigateHost {
  readonly #options: NavigateHostOptions;
  /** URL 参数给的上游（`null` = 没给 → 脚本上游）。 */
  readonly #fromUrl: string | null;
  /** 进程内覆盖（`navigate:set-upstream` 写的），不落盘 —— 与桌面壳同义。 */
  #override: { url: string | null } | null = null;

  /** 已确认登录的身份。`null` = 没有 / 还没探测过。 */
  #session: { role: GuestLoginResult['role']; expiresAt: number | null } | null = null;
  #username: string | null = null;
  #probed = false;
  /** 上一次探测的结论（给 `note` 用）。 */
  #probeNote: string | null = null;

  constructor(options: NavigateHostOptions) {
    this.#options = options;
    this.#fromUrl = options.upstreamParam;
  }

  /** 当前上游根地址。`null` = 脚本上游；`''` = 同源。 */
  baseUrl(): string | null {
    return this.#override === null ? this.#fromUrl : this.#override.url;
  }

  upstreamStatus(): NavigateUpstreamStatus {
    const url = this.baseUrl();
    return url === null
      ? { kind: 'scripted', baseUrl: null }
      : { kind: 'navigate', baseUrl: url === '' ? location.origin : url };
  }

  /**
   * 改上游。浏览器只认同源 —— 见文件头。
   *
   * `null`/空串/`'1'` 三种写法都要接住：前两个是"清空"，`'1'` 是地址栏里
   * "打开同源"的旗标写法（与 `main.ts` 解析 URL 参数时同一套约定）。
   */
  setUpstream(url: string | null): NavigateStatus {
    if (url === null || url.trim() === '' || url.trim() === '1') {
      this.#override = { url: null };
      this.#session = null;
      this.#probed = false;
      return this.statusNow();
    }

    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      fail('BAD_REQUEST', `不是合法的绝对地址：${JSON.stringify(url)}（要形如 http://主机:端口）`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      fail('BAD_REQUEST', `只支持 http / https，拿到的是 ${parsed.protocol}`);
    }
    if (parsed.origin !== location.origin) {
      fail(
        'BAD_REQUEST',
        `浏览器里只支持同源上游：${parsed.origin} 与页面 origin ${location.origin} 不同。` +
          'httpOnly + SameSite=Lax 的凭据跨源带不上，上游也不开 CORS —— 请用同域反代。',
      );
    }

    this.#override = { url: '' };
    this.#session = null;
    this.#probed = false;
    return this.statusNow();
  }

  /** 读登录态。第一次读会问上游（`/api/me`），之后用记下的结论。 */
  async status(): Promise<NavigateStatus> {
    const base = this.baseUrl();
    if (base === null) return this.statusNow();
    if (!this.#probed) await this.#probe(base);
    return this.statusNow();
  }

  /** 同步版本 —— 已经探测过时才用（`set-upstream` 的返回值走这里）。 */
  statusNow(): NavigateStatus {
    return { upstream: this.upstreamStatus(), login: this.loginStatus() };
  }

  loginStatus(): NavigateLoginStatus {
    const base = this.baseUrl();
    if (base === null) {
      return {
        hasToken: true,
        role: null,
        expiresAt: null,
        encrypted: false,
        persisted: false,
        note: '上游是离线脚本，不需要登录（页面上不会出现登录闸门）',
      };
    }

    const session = this.#session;
    return {
      hasToken: session !== null,
      role: session?.role ?? null,
      expiresAt: session?.expiresAt ?? null,
      // 凭据由浏览器管理：本壳拿不到也就谈不上加密，false 是**如实**而不是"没做"
      encrypted: false,
      persisted: session !== null,
      note:
        session === null
          ? (this.#probeNote ?? '未登录：/api/me 没有接受当前 cookie')
          : '凭据是同源 httpOnly cookie（JS 读不到），登录态以 /api/me 的应答为准',
    };
  }

  /** 账号名（`/api/me` 的 username）。拿不到返回 null —— 这时会话库落 `local`。 */
  get username(): string | null {
    return this.#username;
  }

  async loginGuest(): Promise<GuestLoginResult> {
    const base = this.#requireBase('登录');
    const res = await this.#request(`${base}${NAVIGATE_LOGIN_GUEST_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: '{}',
    });
    if (!res.ok) this.#throwLoginFailure(res);
    return this.#adopt(await this.#readJson(res, '登录响应'), base);
  }

  async login(body: LoginBody): Promise<GuestLoginResult> {
    const base = this.#requireBase('登录');
    const res = await this.#request(`${base}${NAVIGATE_LOGIN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      // 上游在需要校验码时会回 `{needChallenge:true}`；读不出来就当 false，不臆测
      let needChallenge = false;
      try {
        const payload = (await res.json()) as { needChallenge?: unknown };
        needChallenge = payload.needChallenge === true;
      } catch {
        /* 非 JSON 响应（反代 HTML）—— 不要用新错误盖掉真正的状态码 */
      }
      const failure = describeNavigateLoginFailure(res.status, retryAfterSec(res));
      fail(
        failure.code,
        failure.message,
        needChallenge ? (failure.detail === undefined ? NEED_CHALLENGE : `${failure.detail}|${NEED_CHALLENGE}`) : failure.detail,
      );
    }

    return this.#adopt(await this.#readJson(res, '登录响应'), base);
  }

  /**
   * 领一张验证码。
   *
   * 桌面壳要自己保存上游种的 `navigate_sid` 并在取图时手动带上；
   * 浏览器不用 —— cookie 由浏览器自动带上，这也正是"凭据不归壳管"的另一面。
   */
  async loginCode(): Promise<LoginCodeResult> {
    const base = this.#requireBase('领取验证码');
    const res = await this.#request(`${base}${NAVIGATE_LOGIN_CODE_PATH}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      const failure = describeNavigateLoginFailure(res.status, retryAfterSec(res));
      fail(failure.code, failure.message, failure.detail);
    }

    const payload = (await this.#readJson(res, '验证码响应')) as { challengeId?: unknown };
    const challengeId = payload.challengeId;
    if (typeof challengeId !== 'string' || challengeId === '') {
      fail('UPSTREAM', '上游没有返回 challengeId');
    }

    const image = await this.#request(
      `${base}${NAVIGATE_LOGIN_CODE_PATH}/${encodeURIComponent(challengeId)}/image`,
      { method: 'GET', headers: { accept: 'image/bmp' } },
    );
    if (!image.ok) fail('UPSTREAM', `取验证码图片失败：HTTP ${image.status}`);

    const bytes = await image.blob();
    return { challengeId, imageDataUrl: await toDataUrl(bytes) };
  }

  async challengeNeeded(username: string): Promise<LoginChallengeNeeded> {
    const base = this.#requireBase('探测校验码');
    const query = username === '' ? '' : `?username=${encodeURIComponent(username)}`;
    const res = await this.#request(`${base}${NAVIGATE_CHALLENGE_NEEDED_PATH}${query}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) fail('UPSTREAM', `探测校验码状态失败：HTTP ${res.status}`);
    const payload = (await this.#readJson(res, '校验码状态')) as { needChallenge?: unknown };
    return { needChallenge: payload.needChallenge === true };
  }

  /** 登出：上游吊销 + 本地忘掉。**永不因网络失败而报错**（本地那份已经清掉了）。 */
  async logout(): Promise<NavigateStatus> {
    const base = this.baseUrl();
    this.#session = null;
    this.#username = null;
    this.#probed = true;
    this.#probeNote = '已登出（本页不再认为登录着）';

    if (base === null) return this.statusNow();

    try {
      await this.#request(`${base}${NAVIGATE_LOGOUT_PATH}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
      });
    } catch (err) {
      // 与桌面壳同一条取舍：登出的第一诉求是"这台机器上不再带这个身份"，
      // 上游没确认吊销只该写进 note，不该让用户看到"登出失败"。
      this.#probeNote = `已登出；上游未确认吊销（${errorText(err)}）`;
    }
    return this.statusNow();
  }

  /** 换上游之后重新问一次上游的账号名（会话库按它分文件）。 */
  async refreshAccount(): Promise<string> {
    const base = this.baseUrl();
    if (base === null) {
      this.#username = null;
      return 'local';
    }
    const me = await this.#fetchMe(base);
    return this.#username ?? 'local';
  }

  async #probe(base: string): Promise<void> {
    this.#probed = true;
    try {
      const me = await this.#fetchMe(base);
      if (me === null) {
        this.#session = null;
        this.#probeNote = '未登录：/api/me 没有接受当前 cookie';
        return;
      }
      this.#session = { role: me.role, expiresAt: null };
      this.#probeNote = null;
    } catch (err) {
      this.#session = null;
      this.#probeNote = `登录态未知：问不到 /api/me（${errorText(err)}）`;
    }
  }

  /** `/api/me` 的应答 —— 认了 cookie 才算登录着。 */
  async #fetchMe(base: string): Promise<{ role: GuestLoginResult['role']; } | null> {
    const res = await this.#request(`${base}${NAVIGATE_ME_PATH}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;

    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      return null;
    }
    const record = (payload ?? {}) as { username?: unknown; role?: unknown };
    if (typeof record.username === 'string' && record.username !== '') this.#username = record.username;
    // 角色认不出来时按 guest 处理：/api/me 没有角色白名单义务，
    // 而这里只用于显示与会话库分文件，不参与任何鉴权判断。
    const role = parseNavigateRole(record.role) ?? 'guest';
    return { role };
  }

  /** 把一次成功登录的结果记下来（token 一律丢弃 —— 它在 cookie 里）。 */
  #adopt(payload: unknown, base: string): GuestLoginResult {
    const parsed = parseGuestLoginResponse(payload, this.#options.now());
    if (!parsed.ok) fail('UPSTREAM', `上游登录响应不符合契约：${parsed.message}`);

    this.#session = { role: parsed.session.role, expiresAt: parsed.session.expiresAt };
    this.#probed = true;
    this.#probeNote = null;

    // 账号名 best-effort：拿不到就退到角色（与桌面壳 currentAccountKey 同一条降级）
    void this.#fetchMe(base).catch(() => undefined);

    return {
      role: parsed.session.role,
      expiresInSec: parsed.session.expiresInSec,
      expiresAt: parsed.session.expiresAt,
    };
  }

  #requireBase(action: string): string {
    const base = this.baseUrl();
    if (base === null) {
      fail('UNSUPPORTED', `当前是离线脚本上游，没有${action}接口 —— 用 ?upstream=1 指向同源 navigate`);
    }
    return base;
  }

  async #request(url: string, init: RequestInit): Promise<Response> {
    // 与问答同一条认证通道：同源 cookie 由浏览器带上，**不往 URL 塞 token**
    return fetch(url, { ...init, credentials: 'same-origin', signal: AbortSignal.timeout(NAVIGATE_AUTH_TIMEOUT_MS) });
  }

  async #readJson(res: Response, what: string): Promise<unknown> {
    try {
      return await res.json();
    } catch (err) {
      fail('UPSTREAM', `${what}不是合法 JSON：${errorText(err)}（地址可能指到了静态站点）`);
    }
  }

  #throwLoginFailure(res: Response): never {
    const failure = describeNavigateLoginFailure(res.status, retryAfterSec(res));
    fail(failure.code, failure.message, failure.detail);
  }
}

function retryAfterSec(res: Response): number | null {
  const raw = res.headers.get('retry-after');
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('验证码图片读取失败'));
    reader.readAsDataURL(blob);
  });
}
