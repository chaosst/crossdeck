/**
 * 会话库的 DML 单一真源（SQLite 语法，参数用 `?` 占位）。
 *
 * SQLite 与鸿蒙 RDB 共用这一份 —— 后端差异只在绑定方式与事务 API。
 */

/** 会话表 CRUD。 */
export const SESSION_SQL = {
  listSessions: 'SELECT id, title, createdAt, updatedAt, messageCount FROM sessions ORDER BY updatedAt DESC',
  getSession: 'SELECT id, title, createdAt, updatedAt, messageCount FROM sessions WHERE id = ?',
  createSession: 'INSERT INTO sessions (id, title, createdAt, updatedAt, messageCount) VALUES (?, ?, ?, ?, ?)',
  deleteEventsOfSession: 'DELETE FROM events WHERE messageId IN (SELECT messageId FROM messages WHERE sessionId = ?)',
  deleteMessagesOfSession: 'DELETE FROM messages WHERE sessionId = ?',
  deleteSession: 'DELETE FROM sessions WHERE id = ?',
  bumpMessageCount: 'UPDATE sessions SET messageCount = messageCount + 1, updatedAt = ? WHERE id = ?',
  touchSessionOfMessage: 'UPDATE sessions SET updatedAt = ? WHERE id = (SELECT sessionId FROM messages WHERE messageId = ?)',
};

/** 消息表 DML。 */
export const MESSAGE_SQL = {
  nextSeq: 'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE sessionId = ?',
  insert:
    'INSERT INTO messages (messageId, sessionId, seq, role, content, status, runId, usage, error, createdAt, updatedAt) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)',
  exists: 'SELECT 1 FROM messages WHERE messageId = ?',
  updateDraft:
    'UPDATE messages SET content = ?, status = ?, usage = ?, error = ?, updatedAt = ?, runId = COALESCE(?, runId) ' +
    'WHERE messageId = ?',
  listBySession:
    'SELECT messageId, sessionId, seq, role, content, status, runId, usage, error, createdAt, updatedAt ' +
    'FROM messages WHERE sessionId = ? ORDER BY seq ASC',
};

/** 事件表 DML。 */
export const EVENT_SQL = {
  insert: 'INSERT OR IGNORE INTO events (eventId, messageId, seq, kind, payload, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
};

/**
 * 按消息批查事件（`IN (?, ?, …)`）。
 * 数量非法时抛错 —— 空 IN 是语法错，不是"查不到"。
 */
export function selectEventsForMessages(count: number): string {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`事件批查的消息数必须是正整数：${count}`);
  }
  const placeholders: string[] = [];
  for (let i = 0; i < count; i += 1) placeholders.push('?');
  return `SELECT eventId, messageId, seq, kind, payload, createdAt FROM events WHERE messageId IN (${placeholders.join(', ')}) ORDER BY seq ASC`;
}
