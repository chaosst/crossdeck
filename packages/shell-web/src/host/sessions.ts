/**
 * 会话库的账号作用域 —— Web 壳这一侧的「每账号一个库」。
 *
 * 语义与桌面壳一致：切账号 = 换一个 IndexedDB 库，切完广播 `{reason:'switched'}`，
 * 因为此时没有任何 sessionId 可指（旧 id 在另一个库里毫无意义）。
 *
 * 与桌面壳的差别只有一处来源：浏览器读不到 httpOnly 凭据，账号名只能问上游
 * （`/api/me`）；问不到就落 `local`，不是拒绝打开库。
 */

import type { SessionChange } from '@crossdeck/contract';
import { IdbSessionRepository } from '../session/idbRepository.js';

export interface SessionScopeOptions {
  readonly now: () => number;
  readonly newId: (prefix: string) => string;
  readonly onChange: (change: SessionChange) => void;
}

export class SessionScope {
  readonly #options: SessionScopeOptions;
  #repo: IdbSessionRepository | null = null;
  #accountKey: string | null = null;

  constructor(options: SessionScopeOptions) {
    this.#options = options;
  }

  get accountKey(): string {
    return this.#accountKey ?? 'local';
  }

  /** 当前库。第一次调用时按已设的账号键建（没设就是 `local`）。 */
  async current(): Promise<IdbSessionRepository> {
    const existing = this.#repo;
    if (existing !== null) return existing;

    const repo = new IdbSessionRepository({
      accountKey: this.accountKey,
      now: this.#options.now,
      newId: this.#options.newId,
    });
    this.#repo = repo;
    return repo;
  }

  /**
   * 换库。同一个账号再次调用是**空操作** —— 否则登录后每次刷新都要重建连接，
   * 而"重建"会让正在读的列表拿到一个已关闭的库。
   */
  async switchTo(accountKey: string): Promise<void> {
    if (this.#repo !== null && this.#accountKey === accountKey) return;

    const previous = this.#repo;
    this.#repo = null;
    this.#accountKey = accountKey;
    if (previous !== null) await previous.close();

    // 换库之后激活项一定失效 —— 广播出去，让 UI 清掉选中并重拉列表。
    // 只在真的换了库时发：首启动那次不该报"切换"。
    if (previous !== null) this.#options.onChange({ reason: 'switched' });
  }
}
