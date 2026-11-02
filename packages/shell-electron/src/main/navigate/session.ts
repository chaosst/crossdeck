/**
 * navigate 的**配置与登录用例** —— 把三个零件拼起来：
 *
 *   `settings.ts`   上游地址的持久化（明文，不敏感）
 *   `tokenStore.ts` 凭据的持久化（safeStorage 加密，绝不跨 IPC）
 *   `auth.ts`       网络（electron-free，可单独验证）
 *
 * 上层（`handlers.ts` / `agentRuntime.ts`）只跟这个文件打交道，
 * 于是"凭据存在哪、怎么吊销"这件事只有一处答案。
 */

import { AppError } from '@crossdeck/contract';
import type {
  GuestLoginResult,
  LoginChallengeNeeded,
  LoginCodeResult,
  NavigateStatus,
  NavigateUpstreamStatus,
} from '@crossdeck/contract';
import {
  createChallenge,
  fetchChallengeImage,
  fetchChallengeNeeded,
  fetchMe,
  login,
  loginGuest,
  revokeUpstreamSession,
  type LoginBody,
} from './auth.js';
import { navigateTokenStore } from './tokenStore.js';
import { normalizeUpstreamUrl } from './upstream.js';

/** 暂时固定：配置入口已砍，恢复时改回读 navigateSettings。 */
const BASE_URL = 'http://127.0.0.1:3001'

/**
 * 进程内覆盖：`setUpstreamUrl` 写的，自检用它指向假 SSE 服务器。
 *
 * 不落盘 —— 落盘会让自检那次临时端口留在用户配置里，下次启动读到一个已关掉的地址。
 * `{ url: null }` 是**显式要求**脚本上游，与"没被覆盖"（走固定地址）是两件事。
 */
let override: { url: string | null } | null = null

/** 当前上游根地址：固定值，或覆盖成别的地址 / `null`（脚本上游）。 */
export function currentBaseUrl(): string | null {
  return override === null ? BASE_URL : override.url
}

/** 直接改上游（不经 IPC）：自检把进程切到脚本上游时用。 */
export function overrideBaseUrl(url: string | null): void {
  override = { url }
}

/**
 * 本地库的账号键：登录后按账号名分文件，未登录 / 取不到账号名时落 `local`。
 *
 * 先用账号名、退到角色，是因为「每账号一个库」要的是账号粒度；
 * 而 `/api/me` 可能因网络失败取不到，那时退到角色总比拒绝打开库好。
 */
export function currentAccountKey(): string {
  if (navigateTokenStore.get() === null) return 'local';
  const name = navigateTokenStore.accountKey();
  if (name !== null) return name;
  return navigateTokenStore.status().role ?? 'local';
}

/** 登录成功后补记账号名（best-effort：失败不影响登录结果）。 */
async function bindAccountKey(baseUrl: string, token: string): Promise<void> {
  const username = await fetchMe({ baseUrl, now: () => Date.now(), timeoutMs: 3000 }, token);
  if (username !== null) navigateTokenStore.setAccountKey(username);
}

/**
 * 当前上游。`kind` 与 `baseUrl` **由同一个变量推出来**，所以不可能出现
 * "说自己在连 navigate 却没给地址"这种自相矛盾的状态。
 */
export function upstreamStatus(): NavigateUpstreamStatus {
  const url = currentBaseUrl();
  return url === null ? { kind: 'scripted', baseUrl: null } : { kind: 'navigate', baseUrl: url };
}

/** 当前状态 —— 也是三条写通道的统一响应。 */
export function navigateStatus(): NavigateStatus {
  return { upstream: upstreamStatus(), login: navigateTokenStore.status() };
}

/** 设置（或清空）上游地址。校验不过会抛 `BAD_REQUEST` —— 用户输入的错，不是上游的错。 */
export function setUpstreamUrl(raw: string | null): NavigateStatus {
  const decision = normalizeUpstreamUrl(raw);
  if (!decision.ok) throw new AppError('BAD_REQUEST', decision.message);

  override = { url: decision.value };
  return navigateStatus();
}

/**
 * guest 一键登录：拿凭据 → **落到主进程** → 只把"是谁、还剩多久"回给渲染层。
 *
 * 没有配置上游时直接拒绝，而不是悄悄退回脚本上游 ——
 * "点了登录却连的是脚本"是这个项目最不该出现的诚实性缺口。
 */
export async function loginAsGuest(): Promise<GuestLoginResult> {
  const url = currentBaseUrl();
  if (url === null) {
    throw new AppError(
      'BAD_REQUEST',
      '还没有配置上游地址 —— 先填一个（形如 http://127.0.0.1:3001），再点登录',
    );
  }

  const session = await loginGuest({ baseUrl: url, now: () => Date.now() });
  navigateTokenStore.set(session);
  await bindAccountKey(url, session.token);

  return { role: session.role, expiresInSec: session.expiresInSec, expiresAt: session.expiresAt };
}

export async function getLoginCode(): Promise<LoginCodeResult> {
  const url = currentBaseUrl();
  if (url === null) {
    throw new AppError(
      'BAD_REQUEST',
      '还没有配置上游地址 —— 先填一个（形如 http://127.0.0.1:3001），再点登录',
    );
  }

  const cfg = { baseUrl: url, now: () => Date.now() };
  const ticket = await createChallenge(cfg);
  challengeSid = ticket.sid;

  const bmp = await fetchChallengeImage(cfg, ticket.challengeId, ticket.sid);
  return {
    challengeId: ticket.challengeId,
    imageDataUrl: `data:image/bmp;base64,${Buffer.from(bmp).toString('base64')}`,
  };
}

/**
 * 验证码会话（`navigate_sid`）。取图与提交登录都要带它，只活主进程内存：
 * 不落盘、不进 tokenStore、不跨 IPC —— 与 token 同一条隔离纪律。
 */
let challengeSid: string | null = null;

/** 该 IP / 该账号当前是否需要校验码。探测失败**不阻断**登录 —— 只是不提前展开而已。 */
export async function challengeNeeded(username: string): Promise<LoginChallengeNeeded> {
  const url = currentBaseUrl();
  if (url === null) {
    throw new AppError('BAD_REQUEST', '还没有配置上游地址 —— 无法判断是否需要校验码');
  }
  const needChallenge = await fetchChallengeNeeded({ baseUrl: url, now: () => Date.now() }, username);
  return { needChallenge };
}

export async function loginAsUser(body: LoginBody): Promise<GuestLoginResult> {
  const url = currentBaseUrl();
  if (url === null) {
    throw new AppError(
      'BAD_REQUEST',
      '还没有配置上游地址 —— 先填一个（形如 http://127.0.0.1:3001），再点登录',
    );
  }
  try {
    const session = await login(body, {
      baseUrl: url,
      now: () => Date.now(),
      sid: challengeSid ?? undefined,
    });
    navigateTokenStore.set(session);
    await bindAccountKey(url, session.token);
    return { role: session.role, expiresInSec: session.expiresInSec, expiresAt: session.expiresAt };
  } finally {
    // 挑战是一次性的：无论成功还是答错，这张题都已被上游消费，留着只会误导下一次提交。
    challengeSid = null;
  }
}

/**
 * 登出。
 *
 * 顺序是刻意的：**先清本机，再通知上游**。
 * 用户的诉求是"这台机器上别再留着我的凭据"——那件事必须无条件成功，
 * 不能因为网络不通就把整个登出判成失败（那会得到一个"登出失败"但实际已登出的界面）。
 * 上游那边有没有真的吊销，如实写进 `note`。
 */
export async function logout(): Promise<NavigateStatus> {
  const url = currentBaseUrl();
  const token = navigateTokenStore.get();

  navigateTokenStore.clear();

  const base = navigateStatus();
  if (token === null) return base;

  const revoke = await revokeUpstreamSession({ baseUrl: url }, token);
  switch (revoke.result) {
    case 'revoked':
      return withLoginNote(base, '（上游已确认吊销）');
    case 'no-upstream':
      return base;
    case 'revoke-failed':
      console.warn(`[navigate] 上游未确认吊销 token：${revoke.message ?? '未知原因'}`);
      return withLoginNote(
        base,
        `；但**上游未确认吊销**（${revoke.message ?? '未知原因'}）—— 服务器上这份 token 到期前仍然有效`,
      );
  }
}

function withLoginNote(status: NavigateStatus, suffix: string): NavigateStatus {
  return { ...status, login: { ...status.login, note: `${status.login.note}${suffix}` } };
}
