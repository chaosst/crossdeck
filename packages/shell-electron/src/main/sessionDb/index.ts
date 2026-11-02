/**
 * 壳内会话库单例 —— 一个账号一个文件，切换账号就换库。
 *
 * 库文件名取账号键的哈希：username 可能含路径分隔符、大小写歧义、超长，直接拼进路径不安全。
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { AppError } from '@crossdeck/contract';
import type { DatabaseSync } from 'node:sqlite';
import { openSessionDb } from './open.js';
import type { OpenedSessionDb } from './open.js';
import { SessionRepo } from './repo.js';
import type { RepoDeps } from './repo.js';

export interface OpenSessionRepoOptions {
  /** 存放库文件的目录。自检与断言用各自的临时目录，不写用户真实 userData。 */
  readonly dir: string;
  /** 账号键。未登录时是 `local`。 */
  readonly accountKey: string;
  readonly deps: RepoDeps;
}

interface Active {
  readonly accountKey: string;
  readonly filePath: string;
  readonly opened: OpenedSessionDb;
  readonly repo: SessionRepo;
}

let active: Active | null = null;
let lastError: string | null = null;
let configured: { readonly dir: string; readonly deps: RepoDeps } | null = null;

/** 启动时定下库目录（userData 或自检目录）。 */
export function configureSessionDb(config: { readonly dir: string; readonly deps: RepoDeps }): void {
  configured = config;
}

/** 按账号键打开库；已在该账号上时是幂等的。 */
export function ensureSessionRepo(accountKey: string): SessionRepo {
  if (configured === null) {
    throw new AppError('INTERNAL', '会话库目录未配置（启动流程漏了 configureSessionDb）');
  }
  return openSessionRepo({ dir: configured.dir, accountKey, deps: configured.deps });
}

/** 账号键 → 文件名。取哈希前缀，避免路径分隔符与大小写坑。 */
export function sessionDbFileName(accountKey: string): string {
  const digest = createHash('sha256').update(accountKey).digest('hex').slice(0, 16);
  return `${digest}.db`;
}

/** 打开（或切换到）某个账号的库。重复打开同一个账号是幂等的。 */
export function openSessionRepo(opts: OpenSessionRepoOptions): SessionRepo {
  if (active !== null && active.accountKey === opts.accountKey) return active.repo;

  closeSessionRepo();

  const filePath = join(opts.dir, sessionDbFileName(opts.accountKey));
  try {
    const opened = openSessionDb(filePath);
    const repo = new SessionRepo(opened.db, opts.deps);
    active = { accountKey: opts.accountKey, filePath, opened, repo };
    lastError = null;
    return repo;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

/** 当前库的仓储。没打开就抛 —— 静默降级成内存库会让用户以为存住了。 */
export function sessionRepo(): SessionRepo {
  if (active === null) {
    throw new AppError(
      'INTERNAL',
      lastError === null ? '会话库尚未打开（启动流程没跑到打开库那一步）' : `会话库不可用：${lastError}`,
    );
  }
  return active.repo;
}

export function sessionAccountKey(): string | null {
  return active?.accountKey ?? null;
}

export function sessionDbPath(): string | null {
  return active?.filePath ?? null;
}

/** 关库。关闭后再访问会抛 —— 不许静默成功。 */
export function closeSessionRepo(): void {
  if (active === null) return;
  const closing = active;
  active = null;
  try {
    closing.opened.close();
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }
}

/** 断言/自检用：直接拿到底层连接做原始查询。 */
export function rawSessionDb(): DatabaseSync {
  if (active === null) throw new AppError('INTERNAL', '会话库尚未打开');
  return active.opened.db;
}
