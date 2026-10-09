/**
 * navigate **认证**里与平台无关的那一半。
 *
 * 为什么这些放 core 而不是各壳各写一份：
 *   「HTTP 状态 → 给用户看的话 + 给 UI 分流的码」是**纯规则**，三端（Electron / Web /
 *   鸿蒙）遇到的状态码一模一样，要讲给用户的话也必须一模一样。
 *   各壳各抄一份的话，Web 壳漏掉 503 那条只是个时间问题 —— 而它偏偏是最该说清的一条
 *   （服务端没配体验账号，重试一万次也一样）。
 *
 * 与 `navigateStream.ts` 的分工：那边是"流式问答"，这里是"怎么登进去"。
 *
 * ⚠️ core 不能构造 `AppError`（那是 contract 的运行时类，core 对 contract 只做
 *    `import type`）。所以这里只产出**描述符**，由壳翻成 AppError ——
 *    与 `formatNavigateDiagnostic` 同一个手法（core 给数据，落日志是 IO）。
 */

import type { IpcErrorCode, NavigateAuthDetail, NavigateRole } from '@crossdeck/contract';

/** guest 登录端点。取自上游 `src/server/login.ts`。 */
export const NAVIGATE_LOGIN_GUEST_PATH = '/api/login/guest';

/** 登出端点（上游是 GET，吊销 token 并清 cookie）。 */
export const NAVIGATE_LOGOUT_PATH = '/api/logout';

/**
 * 登录请求的超时（ms）。
 *
 * 不能省：地址填错时（比如指向一台会丢包的机器）`fetch` 会**永远不 resolve**，
 * 而这是个 IPC 调用 —— UI 会一直转圈且没有终态。首帧超时（`DEFAULT_FIRST_FRAME_TIMEOUT_MS`）
 * 解决的是流式那一侧，这里解决登录这一侧。
 */
export const NAVIGATE_AUTH_TIMEOUT_MS = 10_000;

/**
 * 登录失败的结构化描述。壳负责 `new AppError(f.code, f.message, f.detail)`。
 *
 * `code` 是粗分类（决定"要不要给重试入口"），`detail` 是细分原因（决定"说哪句话"）。
 * 两者都要 —— 只给 code 的话，UI 必须"在登录这件事的语境下"去理解一个通用码，
 * 以后别处也用同一个码时就悄悄错了。
 */
export interface NavigateLoginFailure {
  readonly code: IpcErrorCode;
  readonly message: string;
  readonly detail?: NavigateAuthDetail;
}

/**
 * HTTP 状态 → 登录失败的描述符。
 *
 * 三条**下一步动作完全不同**的路，必须能分开（这是本卡的核心判据）：
 *   · 503 服务端没配体验账号 —— 重试无意义，要让部署方去配
 *   · 429 限流                 —— 等 `Retry-After` 秒再试
 *   · 401/403 身份被拒          —— 凭据问题，要重新走登录
 */
export function describeNavigateLoginFailure(
  status: number,
  retryAfterSec: number | null,
): NavigateLoginFailure {
  if (status === 503) {
    return {
      code: 'UNSUPPORTED',
      detail: 'GUEST_DISABLED',
      message:
        '服务端未启用体验账号（HTTP 503）—— 需要在服务端配一个 role=guest 的账号' +
        '（H5_GUEST_USERNAME / H5_GUEST_PASSWORD，或写进 H5_LOGIN_USERS）。重试不会解决这个问题。',
    };
  }

  if (status === 429) {
    // 上游只在真的算出了秒数时才给这个头，拿不到就别编一个数字出来。
    const wait = retryAfterSec !== null && retryAfterSec > 0 ? `，建议 ${retryAfterSec}s 后重试` : '';
    return {
      code: 'UPSTREAM',
      detail: 'RATE_LIMITED',
      message: `上游限流（HTTP 429）${wait}`,
    };
  }

  if (status === 401 || status === 403) {
    return {
      code: 'FORBIDDEN',
      detail: 'AUTH_REJECTED',
      message: `上游拒绝了这次登录（HTTP ${status}）—— 凭据无效或已被吊销`,
    };
  }

  if (status === 404) {
    // 这不是"上游坏了"，而是"你填的地址不是 navigate" —— 动作是改配置，不是重试。
    return {
      code: 'BAD_REQUEST',
      message: `这个地址上没有登录接口（HTTP 404）—— 确认填的是 navigate 的根地址（形如 http://主机:3001）`,
    };
  }

  return { code: 'UPSTREAM', message: `上游登录接口返回 HTTP ${status}` };
}

// ─────────────────────────────────────────────────────────────
// 上游响应的解析（同样是纯逻辑）
// ─────────────────────────────────────────────────────────────

/**
 * 登录后本机持有的会话。
 *
 * ⚠️ **含 token，只能在主进程里流动**。它不是契约类型（`GuestLoginResult` 才是），
 *    跨 IPC 的那一份刻意没有 token 字段。
 */
export interface NavigateSession {
  readonly token: string;
  readonly role: NavigateRole;
  /** 上游给的有效期（秒）—— **权威值**，别用本地时钟反推。 */
  readonly expiresInSec: number;
  /** 到期时刻（epoch ms，本地时钟换算）。渲染层用它显示"还剩多久"。 */
  readonly expiresAt: number;
}

export type GuestLoginParseResult =
  | { readonly ok: true; readonly session: NavigateSession }
  | { readonly ok: false; readonly message: string };

/**
 * 把上游 `POST /api/login/guest` 的响应体解析成会话。
 *
 * 为什么**不许**容错（比如 role 认不出来就按 guest 处理）：
 *   `role` 决定这个身份能不能干 admin 的事。一个认不出来的 role 被悄悄降级/升级，
 *   都是把上游的 bug 变成客户端的越权或误拒。**形状不对就说形状不对** ——
 *   这条路径必须存在，否则"上游改了字段名"会表现成"登录成功但什么都干不了"。
 *
 * `nowMs` 由调用方给（core 不读时钟，deps 才有时钟）——
 * `expiresAt` 必须由本地时钟算出，不能直接把上游的 `expiresIn` 当时间戳用。
 */
export function parseGuestLoginResponse(value: unknown, nowMs: number): GuestLoginParseResult {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, message: '上游登录响应不是对象' };
  }
  const v = value as { token?: unknown; role?: unknown; expiresIn?: unknown };

  if (typeof v.token !== 'string' || v.token.length === 0) {
    return { ok: false, message: '上游登录响应里没有可用的 token 字段' };
  }
  const role = parseNavigateRole(v.role);
  if (role === null) {
    return {
      ok: false,
      message: `上游登录响应里的 role 不是已知角色（拿到 ${JSON.stringify(v.role)}）`,
    };
  }
  if (typeof v.expiresIn !== 'number' || !Number.isFinite(v.expiresIn) || v.expiresIn <= 0) {
    return {
      ok: false,
      message: `上游登录响应里的 expiresIn 不是正数（拿到 ${JSON.stringify(v.expiresIn)}）`,
    };
  }

  return {
    ok: true,
    session: {
      token: v.token,
      role,
      expiresInSec: v.expiresIn,
      expiresAt: nowMs + v.expiresIn * 1000,
    },
  };
}

/**
 * 角色白名单。上游是 `type H5Role = "admin" | "guest"`，
 * 但**类型不穿越网络** —— 运行期必须真的看一眼。
 */
export function parseNavigateRole(value: unknown): NavigateRole | null {
  return value === 'admin' || value === 'guest' ? value : null;
}

