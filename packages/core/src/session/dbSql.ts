import type { ColumnDef, EventRow, MessageRow, SessionRow, TableDef } from './dbEntity.js';

/** 渲染一列。主键强制 NOT NULL —— SQLite 的 TEXT 主键本身允许 NULL，不写就是漏洞。 */
function renderColumn<T>(c: ColumnDef<T>): string {
  const parts: string[] = [String(c.key), c.type];
  if (c.primaryKey === true) parts.push('PRIMARY KEY');
  if (c.primaryKey === true || c.notNull === true) parts.push('NOT NULL');
  if (c.default !== undefined) parts.push(`DEFAULT ${c.default}`);
  return parts.join(' ');
}

/** 渲染建表语句与索引（一个字符串里多条语句，`exec` 可直接跑）。 */
function renderTable<T>(t: TableDef<T>): string {
  const body = t.columns.map(renderColumn).join(',\n  ');
  return [`CREATE TABLE IF NOT EXISTS ${t.name} (\n  ${body}\n)`, ...(t.indexes ?? [])].join(';\n');
}

const sessionTable: TableDef<SessionRow> = {
  name: 'sessions',
  columns: [
    { key: 'id', type: 'TEXT', primaryKey: true },
    { key: 'title', type: 'TEXT', notNull: true },
    { key: 'createdAt', type: 'INTEGER', notNull: true },
    { key: 'updatedAt', type: 'INTEGER', notNull: true },
    { key: 'messageCount', type: 'INTEGER', notNull: true, default: '0' },
  ],
  // 列表页按最近更新倒序
  indexes: ['CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions (updatedAt DESC)'],
};

const messageTable: TableDef<MessageRow> = {
  name: 'messages',
  columns: [
    { key: 'messageId', type: 'TEXT', primaryKey: true },
    { key: 'sessionId', type: 'TEXT', notNull: true },
    { key: 'seq', type: 'INTEGER', notNull: true },
    { key: 'role', type: 'TEXT', notNull: true },
    { key: 'content', type: 'TEXT', notNull: true, default: "''" },
    { key: 'status', type: 'TEXT', notNull: true },
    { key: 'runId', type: 'TEXT' },
    { key: 'usage', type: 'TEXT' },
    { key: 'error', type: 'TEXT' },
    { key: 'createdAt', type: 'INTEGER', notNull: true },
    { key: 'updatedAt', type: 'INTEGER', notNull: true },
  ],
  // 会话内单调序：靠唯一索引兜住，重建/重放插不出重复 seq
  indexes: ['CREATE UNIQUE INDEX IF NOT EXISTS ux_messages_session_seq ON messages (sessionId, seq)'],
};

const eventTable: TableDef<EventRow> = {
  name: 'events',
  columns: [
    { key: 'eventId', type: 'TEXT', primaryKey: true },
    { key: 'messageId', type: 'TEXT', notNull: true },
    { key: 'seq', type: 'INTEGER', notNull: true },
    { key: 'kind', type: 'TEXT', notNull: true },
    // 窄表：三种事件的载荷都走这一列 JSON，避免宽表一半列永远 NULL
    { key: 'payload', type: 'TEXT', notNull: true },
    { key: 'createdAt', type: 'INTEGER', notNull: true },
  ],
  indexes: ['CREATE UNIQUE INDEX IF NOT EXISTS ux_events_message_seq ON events (messageId, seq)'],
};

/** 升到该版本要执行的语句。**只追加不改**：新版本加在末尾，旧条目永远不动。 */
const MIGRATIONS = new Map<number, string>([
  [1, [renderTable(sessionTable), renderTable(messageTable), renderTable(eventTable)].join(';\n')],
]);

/** 程序认识的最高版本。 */
export const SCHEMA_VERSION = 1;

const CURRENT_SQL = MIGRATIONS.get(SCHEMA_VERSION);
if (CURRENT_SQL === undefined) {
  throw new Error(`SCHEMA_VERSION=${SCHEMA_VERSION} 没有对应的迁移语句`);
}

/** 新库直接用这份建表。 */
export const SCHEMA_SQL = CURRENT_SQL;

/** 布尔 → INTEGER。`node:sqlite` 不接受 boolean 绑定，直接传会抛错。 */
export function toSqlBool(value: boolean): number {
  return value ? 1 : 0;
}

/** INTEGER → 布尔。 */
export function fromSqlBool(value: number): boolean {
  return value !== 0;
}

/**
 * 规划迁移：返回要按顺序执行的语句，末尾一条是版本号提交点。
 * 空数组 = 无需迁移。版本非法一律抛错 —— 猜一次就可能写坏用户的库。
 */
export function planMigration(from: number, to: number): string[] {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0) {
    throw new Error(`迁移版本必须是非负整数：${from} → ${to}`);
  }
  if (from > SCHEMA_VERSION) {
    throw new Error(`库的版本 ${from} 比程序认识的 ${SCHEMA_VERSION} 新，请升级客户端`);
  }
  if (to > SCHEMA_VERSION) {
    throw new Error(`目标版本 ${to} 超过程序认识的 ${SCHEMA_VERSION}`);
  }
  if (to < from) {
    throw new Error(`不支持降级：${from} → ${to}`);
  }
  if (to === from) return [];

  const statements: string[] = [];
  for (let version = from + 1; version <= to; version += 1) {
    const sql = MIGRATIONS.get(version);
    if (sql === undefined) throw new Error(`缺少第 ${version} 版的迁移语句`);
    statements.push(sql);
  }
  // 版本号最后写：中途崩了下次会重跑，上面每条语句都带 IF NOT EXISTS
  statements.push(`PRAGMA user_version = ${to}`);
  return statements;
}
