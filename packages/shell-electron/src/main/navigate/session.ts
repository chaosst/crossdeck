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
import type { GuestLoginResult, NavigateStatus, NavigateUpstreamStatus } from '@crossdeck/contract';
import { loginGuest, revokeUpstreamSession } from './auth.js';
import { navigateSettings } from './settings.js';
import { navigateTokenStore } from './tokenStore.js';
import { normalizeUpstreamUrl } from './upstream.js';

/** 当前上游根地址；`null` = 脚本上游（离线可跑）。 */
export function currentUpstreamUrl(): string | null {
  return navigateSettings.getUpstreamUrl();
}

/**
 * 当前上游。`kind` 与 `baseUrl` **由同一个变量推出来**，所以不可能出现
 * "说自己在连 navigate 却没给地址"这种自相矛盾的状态。
 */
export function upstreamStatus(): NavigateUpstreamStatus {
  const url = currentUpstreamUrl();
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

  navigateSettings.setUpstreamUrl(decision.value);
  return navigateStatus();
}

/**
 * guest 一键登录：拿凭据 → **落到主进程** → 只把"是谁、还剩多久"回给渲染层。
 *
 * 没有配置上游时直接拒绝，而不是悄悄退回脚本上游 ——
 * "点了登录却连的是脚本"是这个项目最不该出现的诚实性缺口。
 */
export async function loginAsGuest(): Promise<GuestLoginResult> {
  const url = currentUpstreamUrl();
  if (url === null) {
    throw new AppError(
      'BAD_REQUEST',
      '还没有配置上游地址 —— 先填一个（形如 http://127.0.0.1:3001），再点登录',
    );
  }

  const session = await loginGuest({ baseUrl: url, now: () => Date.now() });
  navigateTokenStore.set(session);

  return { role: session.role, expiresInSec: session.expiresInSec, expiresAt: session.expiresAt };
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
  const url = currentUpstreamUrl();
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
