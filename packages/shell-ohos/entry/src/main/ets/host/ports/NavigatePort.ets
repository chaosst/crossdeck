/** navigate 端口 —— 凭据（token）只活在这里，永不过桥。 */
import { formatIpcError } from '../../shared/contract/index';
import type {
  GuestLoginResult,
  IpcErrorCode,
  LoginCodeResult,
  LoginChallengeNeeded,
  NavigateLoginStatus,
  NavigateStatus,
  NavigateUpstreamStatus,
  NavigateRole,
} from '../../shared/contract/index';
import type { NavigateSession } from '../../shared/core/index';
import { NAVIGATE_CHALLENGE_NEEDED_PATH, NAVIGATE_LOGIN_CODE_PATH, NAVIGATE_LOGIN_GUEST_PATH, NAVIGATE_LOGIN_PATH, NAVIGATE_LOGOUT_PATH, NAVIGATE_ME_PATH, NAVIGATE_AUTH_TIMEOUT_MS, describeNavigateLoginFailure, parseGuestLoginResponse } from '../../shared/core/index';
import type { OhosPort } from '../HostBridge';
import { httpRequestText } from '../httpUtil';
import { http } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';

export type NavigateCredentialSink = (session: NavigateSession | null) => void;

/** 请求 DTO 一律「接口 + 可选字段」：JSON.parse 出的是裸对象，类字段的默认值不存在（jscrash 教训）。 */
interface UpstreamReq {
  upstreamUrl?: string | null;
}

interface LoginReq {
  username?: string;
  password?: string;
  challengeId?: string;
  code?: string;
}

interface ChallengeReq {
  username?: string;
}

/** `/api/me` 的账号名信封 —— 端口只回这一个字段，`session.switch` 用它挑库。 */
class AccountEnvelope {
  username: string | null = null;

  constructor(username: string | null) {
    this.username = username;
  }
}

class LoginBody {
  username: string = '';
  password: string = '';

  constructor(username: string, password: string) {
    this.username = username;
    this.password = password;
  }
}

class LoginWithChallengeBody {
  username: string = '';
  password: string = '';
  challengeId: string = '';
  code: string = '';

  constructor(username: string, password: string, challengeId: string, code: string) {
    this.username = username;
    this.password = password;
    this.challengeId = challengeId;
    this.code = code;
  }
}

/** 上游三个响应的最小形状（`.ets` 不许用内联对象字面量当类型）。 */
interface ChallengePayload {
  challengeId: string;
}

interface MePayload {
  username: string;
}

interface NeedChallengePayload {
  needChallenge: boolean;
}

/** 联合 → 扁平视图。`.ets` 既不支持 `in` 也不按布尔字面量收窄（P3 实测）。 */
interface LoginParseView {
  readonly ok: boolean;
  readonly session: NavigateSession;
  readonly message: string;
}

/**
 * navigate服务器相关的接口类
 * type: status / setUpstream / login / loginGuest / loginCode / challengeNeeded / logout / currentAccount
 */
export class NavigatePort implements OhosPort {
  /** 当前上游根；`null` = 脚本上游（离线演示形态）。 */
  private base: string | null;
  /** 进程内覆盖（navigate:set-upstream 写的），不落盘 —— 与桌面壳同义。 */
  private override: string | null | undefined = undefined;
  private session: NavigateSession | null = null;
  private readonly onCredential: NavigateCredentialSink;

  constructor(upstreamParam: string, onCredential: NavigateCredentialSink) {
    // 参数缺失 = 脚本上游：不猜默认地址，"没配上游"就该长得像"没配上游"。
    this.base = upstreamParam.length > 0 ? upstreamParam : null;
    this.onCredential = onCredential;
  }

  baseUrl(): string | null {
    return this.override === undefined ? this.base : this.override;
  }

  getToken(): string | null {
    return this.session === null ? null : this.session.token;
  }

  handle(method: string, argsJson: string): Promise<string | null> {
    if (method === 'status') {
      return this.status().then((s: NavigateStatus): string => JSON.stringify(s));
    }
    if (method === 'setUpstream') {
      const req = JSON.parse(argsJson) as UpstreamReq;
      return Promise.resolve(JSON.stringify(this.setUpstream(req.upstreamUrl ?? null)));
    }
    if (method === 'loginGuest') {
      return this.loginGuest().then((r: GuestLoginResult): string => JSON.stringify(r));
    }
    if (method === 'login') {
      const req = JSON.parse(argsJson) as LoginReq;
      return this.login(req).then((r: GuestLoginResult): string => JSON.stringify(r));
    }
    if (method === 'loginCode') {
      return this.loginCode().then((r: LoginCodeResult): string => JSON.stringify(r));
    }
    if (method === 'challengeNeeded') {
      const req = JSON.parse(argsJson) as ChallengeReq;
      return this.challengeNeeded(req.username ?? '').then((r: LoginChallengeNeeded): string => JSON.stringify(r));
    }
    if (method === 'logout') {
      return this.logout().then((s: NavigateStatus): string => JSON.stringify(s));
    }
    if (method === 'currentAccount') {
      return this.currentAccount().then((u: string | null): string => JSON.stringify(new AccountEnvelope(u)));
    }
    return Promise.reject(new Error(formatIpcError('NOT_FOUND' as IpcErrorCode, `navigate 端口没有方法 ${method}`, 'METHOD')));
  }

  status(): Promise<NavigateStatus> {
    // 登录态以本地持有的 token 为权威（ArkTS 真持有凭据，不像 Web 壳要问 /api/me）。
    return Promise.resolve(this.statusNow());
  }

  statusNow(): NavigateStatus {
    const base = this.baseUrl();
    const upstream: NavigateUpstreamStatus =
      base === null ? { kind: 'scripted', baseUrl: null } : { kind: 'navigate', baseUrl: base };
    const login: NavigateLoginStatus =
      base === null
        ? { hasToken: true, role: null, expiresAt: null, encrypted: false, persisted: false, note: '上游是离线脚本，不需要登录' }
        : {
            hasToken: this.session !== null,
            role: this.session === null ? null : this.session.role,
            expiresAt: this.session === null ? null : this.session.expiresAt,
            // P3 不做 token 持久化：内存持有，如实上报（要持久化留到 P4 裁决）
            encrypted: false,
            persisted: false,
            note: this.session === null ? '未登录：token 只在内存里' : 'token 在 ArkTS 侧持有（内存），不落盘',
          };
    const status: NavigateStatus = { upstream, login };
    return status;
  }

  setUpstream(url: string | null): NavigateStatus {
    if (url === null || url.trim() === '' || url.trim() === '1') {
      this.override = null;
      this.session = null;
      this.onCredential(null);
      return this.statusNow();
    }
    const trimmed = url.trim();
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
      throw new Error(formatIpcError('BAD_REQUEST' as IpcErrorCode, `只支持 http / https：${trimmed}`));
    }
    this.override = trimmed;
    this.session = null;
    this.onCredential(null);
    return this.statusNow();
  }

  loginGuest(): Promise<GuestLoginResult> {
    return this.doLogin(NAVIGATE_LOGIN_GUEST_PATH, '{}');
  }

  login(req: LoginReq): Promise<GuestLoginResult> {
    // 页面可能省略 challengeId / code（无验证码登录）—— 裸对象上就是 undefined。
    const username = req.username ?? '';
    const password = req.password ?? '';
    const challengeId = req.challengeId ?? '';
    const code = req.code ?? '';
    const body: Object = challengeId.length > 0
      ? new LoginWithChallengeBody(username, password, challengeId, code)
      : new LoginBody(username, password);
    return this.doLogin(NAVIGATE_LOGIN_PATH, JSON.stringify(body));
  }

  private requireBase(action: string): string {
    const base = this.baseUrl();
    if (base === null) {
      throw new Error(formatIpcError('UNSUPPORTED' as IpcErrorCode, `当前是离线脚本上游，没有${action}接口`));
    }
    return base;
  }

  private doLogin(path: string, bodyJson: string): Promise<GuestLoginResult> {
    let base: string;
    try {
      base = this.requireBase('登录');
    } catch (e) {
      return Promise.reject(e as Error);
    }
    return httpRequestText(`${base}${path}`, http.RequestMethod.POST, bodyJson, NAVIGATE_AUTH_TIMEOUT_MS).then(
      (res): GuestLoginResult => {
        if (!res.ok) {
          const failure = describeNavigateLoginFailure(res.status, null);
          throw new Error(formatIpcError(failure.code as IpcErrorCode, failure.message, failure.detail));
        }
        let payload: Object | null = null;
        try {
          payload = JSON.parse(res.body) as Object;
        } catch (e) {
          throw new Error(formatIpcError('UPSTREAM' as IpcErrorCode, '登录响应不是合法 JSON'));
        }
        const parsed = parseGuestLoginResponse(payload, Date.now()) as Object as LoginParseView;
        if (!parsed.ok) {
          throw new Error(formatIpcError('UPSTREAM' as IpcErrorCode, `上游登录响应不符合契约：${parsed.message}`));
        }
        this.session = parsed.session;
        this.onCredential(parsed.session);
        const result: GuestLoginResult = {
          role: parsed.session.role,
          expiresInSec: parsed.session.expiresInSec,
          expiresAt: parsed.session.expiresAt,
        };
        return result;
      },
    );
  }

  loginCode(): Promise<LoginCodeResult> {
    let base: string;
    try {
      base = this.requireBase('领取验证码');
    } catch (e) {
      return Promise.reject(e as Error);
    }
    return httpRequestText(`${base}${NAVIGATE_LOGIN_CODE_PATH}`, http.RequestMethod.GET, null, NAVIGATE_AUTH_TIMEOUT_MS).then(
      (res): Promise<LoginCodeResult> => {
        if (!res.ok) {
          const failure = describeNavigateLoginFailure(res.status, null);
          throw new Error(formatIpcError(failure.code as IpcErrorCode, failure.message, failure.detail));
        }
        const payload = JSON.parse(res.body) as ChallengePayload;
        const challengeId: string = typeof payload.challengeId === 'string' ? payload.challengeId : '';
        if (challengeId.length === 0) {
          throw new Error(formatIpcError('UPSTREAM' as IpcErrorCode, '上游没有返回 challengeId'));
        }
        return this.fetchCodeImage(base, challengeId);
      },
    );
  }

  private async fetchCodeImage(base: string, challengeId: string): Promise<LoginCodeResult> {
    const client = http.createHttp();
    try {
      const res = await client.request(`${base}${NAVIGATE_LOGIN_CODE_PATH}/${encodeURIComponent(challengeId)}/image`, {
        method: http.RequestMethod.GET,
        expectDataType: http.HttpDataType.ARRAY_BUFFER,
        connectTimeout: NAVIGATE_AUTH_TIMEOUT_MS,
        readTimeout: NAVIGATE_AUTH_TIMEOUT_MS,
      });
      if (res.responseCode < 200 || res.responseCode >= 300) {
        throw new Error(formatIpcError('UPSTREAM' as IpcErrorCode, `取验证码图片失败：HTTP ${res.responseCode}`));
      }
      const bytes = new Uint8Array(res.result as ArrayBuffer);
      const base64 = new util.Base64Helper().encodeToStringSync(bytes);
      const result: LoginCodeResult = { challengeId, imageDataUrl: `data:image/bmp;base64,${base64}` };
      return result;
    } finally {
      client.destroy();
    }
  }

  challengeNeeded(username: string): Promise<LoginChallengeNeeded> {
    let base: string;
    try {
      base = this.requireBase('探测校验码');
    } catch (e) {
      return Promise.reject(e as Error);
    }
    const query = username.length === 0 ? '' : `?username=${encodeURIComponent(username)}`;
    return httpRequestText(`${base}${NAVIGATE_CHALLENGE_NEEDED_PATH}${query}`, http.RequestMethod.GET, null, NAVIGATE_AUTH_TIMEOUT_MS).then(
      (res): LoginChallengeNeeded => {
        if (!res.ok) {
          throw new Error(formatIpcError('UPSTREAM' as IpcErrorCode, `探测校验码状态失败：HTTP ${res.status}`));
        }
        const payload = JSON.parse(res.body) as NeedChallengePayload;
        const out: LoginChallengeNeeded = { needChallenge: payload.needChallenge === true };
        return out;
      },
    );
  }

  logout(): Promise<NavigateStatus> {
    const base = this.baseUrl();
    const token = this.getToken();
    this.session = null;
    this.onCredential(null);
    if (base === null) return Promise.resolve(this.statusNow());
    // 上游没确认吊销只该影响 note，不该让用户看到"登出失败"。
    return httpRequestText(`${base}${NAVIGATE_LOGOUT_PATH}?token=${encodeURIComponent(token ?? '')}`, http.RequestMethod.GET, null, NAVIGATE_AUTH_TIMEOUT_MS)
      .then((): NavigateStatus => this.statusNow())
      .catch((): NavigateStatus => this.statusNow());
  }

  /** 账号名（/api/me 的 username）；拿不到返回 null —— 会话库落 local。 */
  currentAccount(): Promise<string | null> {
    const base = this.baseUrl();
    if (base === null) return Promise.resolve(null);
    const token = this.getToken();
    if (token === null) return Promise.resolve(null);
    return httpRequestText(`${base}${NAVIGATE_ME_PATH}?token=${encodeURIComponent(token)}`, http.RequestMethod.GET, null, NAVIGATE_AUTH_TIMEOUT_MS).then(
      (res): string | null => {
        if (!res.ok) return null;
        try {
          const payload = JSON.parse(res.body) as MePayload;
          return typeof payload.username === 'string' && payload.username.length > 0 ? payload.username : null;
        } catch (e) {
          return null;
        }
      },
    );
  }
}
