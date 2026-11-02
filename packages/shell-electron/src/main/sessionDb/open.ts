/**
 * 打开端侧会话库并跑迁移。
 *
 * 刻意**不 import electron**：路径由调用方传入，于是它能在裸 Node 里用真库跑断言。
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION, planMigration } from '@crossdeck/core';

export interface OpenedSessionDb {
  readonly db: DatabaseSync;
  readonly filePath: string;
  /** 打开后（迁移完成）的实际版本号。 */
  readonly version: number;
  close(): void;
}

/** 读库里的版本号；新库是 0。 */
export function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined;
  const value = row?.user_version;
  return typeof value === 'number' ? value : 0;
}

/** 连接级设置。`journal_mode` 不能在事务里改，所以迁移之后调。 */
function applyPragmas(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 2000');
  db.exec('PRAGMA foreign_keys = ON');
}

/** 按版本号升级。整批语句一个事务 —— SQLite 的 DDL 可回滚。 */
function migrate(db: DatabaseSync, filePath: string): number {
  const from = readUserVersion(db);
  let plan: string[];
  try {
    plan = planMigration(from, SCHEMA_VERSION);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`会话库版本不兼容（库 ${from} / 程序 ${SCHEMA_VERSION}）：${reason}（${filePath}）`);
  }
  if (plan.length === 0) return from;

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const statement of plan) db.exec(statement);
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 事务可能已被 SQLite 自动回滚；这里失败不该盖住原始错误。
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`会话库迁移失败（${from} → ${SCHEMA_VERSION}）：${reason}（${filePath}）`);
  }

  const after = readUserVersion(db);
  if (after !== SCHEMA_VERSION) {
    throw new Error(`会话库迁移后版本号仍是 ${after}（期望 ${SCHEMA_VERSION}）—— 迁移没有真正生效（${filePath}）`);
  }
  return after;
}

export function openSessionDb(filePath: string): OpenedSessionDb {
  mkdirSync(dirname(filePath), { recursive: true });

  const db = new DatabaseSync(filePath);
  let version: number;
  try {
    version = migrate(db, filePath);
    applyPragmas(db);
  } catch (err) {
    try {
      db.close();
    } catch {
      // 关不掉不影响抛出——原始错误更重要。
    }
    throw err;
  }

  return {
    db,
    filePath,
    version,
    close: () => db.close(),
  };
}
