/**
 * navigate 上游的**配置与登录**契约。
 *
 * 与 `net/navigateStream.ts` 的分工：那边是"流式问答怎么解析"（壳无关引擎），
 * 这里是"连哪个上游、以什么身份连"（配置面）。
 *
 * ⚠️ 这里**没有 token 字段，也不会有**。
 *    凭据只活在主进程（`safeStorage` 加密落盘），跨到渲染层就等于把它交给了
 *    任何一段能执行脚本的代码。登录结果的形状本身就是这条约束的**编译期**证明 ——
 *    见 `verify-type-alignment.mjs` 的负例 N（写 `res.token` 必须编译失败）。
 */

/** navigate 的身份角色。取自上游：`type H5Role = "admin" | "guest"`（src/server/users.ts）。 */
export type NavigateRole = 'admin' | 'guest';

/**
 * 登录失败的**机器可读**细分原因 —— 放进 `SerializedError.detail`。
 *
 * 为什么要它、而不是只看 code：
 *   503（服务端没配体验账号）与 429（限流）给用户的**动作完全不同** ——
 *   前者重试一万次也一样（要让部署方去配），后者等一会儿就好。
 *   UI 必须能分开这两种，而不是都渲染成"登录失败，请重试"。
 */
export const NAVIGATE_AUTH_DETAIL = {
  /** 服务端未装配体验账号（HTTP 503）—— 不是重试能解决的。 */
  guestDisabled: 'GUEST_DISABLED',
  /** 触发了上游限流（HTTP 429）—— 带 `Retry-After`，稍后重试有意义。 */
  rateLimited: 'RATE_LIMITED',
  /** 上游拒绝了这次身份（401 / 403）。 */
  authRejected: 'AUTH_REJECTED',
} as const;

export type NavigateAuthDetail = (typeof NAVIGATE_AUTH_DETAIL)[keyof typeof NAVIGATE_AUTH_DETAIL];

/**
 * 本地登录态 —— **可给 UI 看的部分**。
 *
 * 注意它描述的是"本机此刻握有什么"，不是"上游认为你是谁"：
 * token 可能已被上游吊销（服务端重启会清空内存里的 token 表），
 * 所以它不能用来宣称"当前登录有效"。
 */
export interface NavigateLoginStatus {
  readonly hasToken: boolean;
  /** 登录时上游告知的角色。`null` = 不知道（旧格式凭据 / 从未登录）。 */
  readonly role: NavigateRole | null;
  /** 凭据到期时刻（epoch ms）。`null` = 不知道。 */
  readonly expiresAt: number | null;
  /** 是否**真的**加密落盘。`false` = 已如实降级（见 `note`）。 */
  readonly encrypted: boolean;
  /** 磁盘上真的有这份凭据（内存里临时持有的不算）。 */
  readonly persisted: boolean;
  /** 一句话说明，可直接给 UI 显示。 */
  readonly note: string;
}

/** 当前上游。`kind === 'scripted'` 时 `baseUrl` 必为 `null` —— 两个字段不许自相矛盾。 */
export interface NavigateUpstreamStatus {
  readonly kind: 'scripted' | 'navigate';
  readonly baseUrl: string | null;
}

/** `navigate:status` 的响应，也是三条写通道的响应（写完立刻回一份新状态）。 */
export interface NavigateStatus {
  readonly upstream: NavigateUpstreamStatus;
  readonly login: NavigateLoginStatus;
}

/**
 * guest 登录成功的结果。
 *
 * 刻意**不含 token** —— 见文件头。`expiresInSec` 来自上游（权威），
 * `expiresAt` 由本地时钟按它算出来（渲染层要显示"还剩几分钟"）。
 */
export interface GuestLoginResult {
  readonly role: NavigateRole;
  readonly expiresInSec: number;
  readonly expiresAt: number;
}
