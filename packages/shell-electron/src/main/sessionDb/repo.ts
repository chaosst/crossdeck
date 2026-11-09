/**
 * 会话库的三张表读写 —— **SQLite 后端**。
 *
 * 只认注入进来的 db —— 不碰 electron、不碰文件系统，因此可在裸 Node 里用真库断言。
 * 所有写操作走 `BEGIN IMMEDIATE`：取号与插入必须原子，唯一索引是最后一道闸。
 *
 * 输入类型与端口都来自 core：同一套语义在 Web 壳有一份 IndexedDB 实现，
 * 候选实现必须过同一份可执行规格（`checkSessionRepository`）。
 */

import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '@crossdeck/contract';
import type {
  MessageRole,
  MessageStatus,
  SessionEvent,
  SessionMessage,
  SessionMessageDetail,
  SessionMeta,
  Usage,
} from '@crossdeck/contract';
import type { FlushMessageInput, InsertMessageInput, SessionRepository } from '@crossdeck/core';
import { EVENT_SQL, MESSAGE_SQL, SESSION_SQL, selectEventsForMessages } from '@crossdeck/core';

export type { FlushMessageInput, InsertMessageInput };

export interface RepoDeps {
  readonly now: () => number;
  readonly newId: (prefix: string) => string;
}

interface SessionRowShape {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

interface MessageRowShape {
  messageId: string;
  sessionId: string;
  seq: number;
  role: string;
  content: string;
  status: string;
  runId: string | null;
  usage: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

interface EventRowShape {
  eventId: string;
  messageId: string;
  seq: number;
  kind: string;
  payload: string;
  createdAt: number;
}

const MESSAGE_STATUSES: readonly MessageStatus[] = ['streaming', 'done', 'aborted', 'failed'];

function toStatus(value: string): MessageStatus {
  return MESSAGE_STATUSES.includes(value as MessageStatus) ? (value as MessageStatus) : 'failed';
}

function toRole(value: string): MessageRole {
  return value === 'user' ? 'user' : 'assistant';
}

/** 用量落 TEXT。解析失败给 null —— 一条坏字段不该让整条消息读不出来。 */
function parseUsage(raw: string | null): Usage | null {
  if (raw === null || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as Usage;
  } catch {
    return null;
  }
}

/** 事件载荷只存 kind 之外的部分，公共字段在列上。 */
function encodeEvent(event: SessionEvent): { kind: string; payload: string } {
  switch (event.kind) {
    case 'tool':
      return {
        kind: event.kind,
        payload: JSON.stringify({
          callId: event.callId,
          name: event.name,
          argsPreview: event.argsPreview,
          resultPreview: event.resultPreview,
          ok: event.ok,
          ms: event.ms,
        }),
      };
    case 'action':
      return {
        kind: event.kind,
        payload: JSON.stringify({ actionId: event.actionId, label: event.label, url: event.url }),
      };
    case 'sources':
      return { kind: event.kind, payload: JSON.stringify({ sources: event.sources }) };
  }
}

function decodeEvent(row: EventRowShape): SessionEvent | null {
  const base = { eventId: row.eventId, messageId: row.messageId, seq: row.seq, createdAt: row.createdAt };
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(row.payload) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    payload = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  if (row.kind === 'tool') {
    return {
      ...base,
      kind: 'tool',
      callId: String(payload.callId ?? ''),
      name: String(payload.name ?? ''),
      argsPreview: String(payload.argsPreview ?? ''),
      resultPreview: String(payload.resultPreview ?? ''),
      ok: payload.ok === true,
      ms: typeof payload.ms === 'number' ? payload.ms : 0,
    };
  }
  if (row.kind === 'action') {
    return {
      ...base,
      kind: 'action',
      actionId: String(payload.actionId ?? ''),
      label: String(payload.label ?? ''),
      url: String(payload.url ?? ''),
    };
  }
  if (row.kind === 'sources') {
    const raw = Array.isArray(payload.sources) ? payload.sources : [];
    return {
      ...base,
      kind: 'sources',
      sources: raw.filter((v): v is string => typeof v === 'string'),
    };
  }
  return null;
}

/**
 * SQLite 后端。同步方法正好满足端口（`Awaitable<T>` 允许直接返回值）——
 * 不需要把那几个同步调用包成 `async`，那会假装存在一个异步点。
 */
export class SessionRepo implements SessionRepository {
  readonly #db: DatabaseSync;
  readonly #deps: RepoDeps;

  constructor(db: DatabaseSync, deps: RepoDeps) {
    this.#db = db;
    this.#deps = deps;
  }

  // ── 会话 ────────────────────────────────────────────────

  listSessions(): SessionMeta[] {
    const rows = this.#db.prepare(SESSION_SQL.listSessions).all() as unknown as SessionRowShape[];
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      messageCount: r.messageCount,
    }));
  }

  getSession(sessionId: string): SessionMeta | null {
    const row = this.#db.prepare(SESSION_SQL.getSession).get(sessionId) as unknown as SessionRowShape | undefined;
    if (row === undefined) return null;
    return {
      id: row.id,
      title: row.title,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      messageCount: row.messageCount,
    };
  }

  createSession(title?: string): SessionMeta {
    const now = this.#deps.now();
    const raw = title?.trim() ?? '';
    const meta: SessionMeta = {
      id: this.#deps.newId('s'),
      title: raw.length > 0 ? raw.slice(0, 64) : 'New chat',
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
    };
    this.#db
      .prepare(SESSION_SQL.createSession)
      .run(meta.id, meta.title, meta.createdAt, meta.updatedAt, meta.messageCount);
    return meta;
  }

  /** 删除会话并连带清掉消息与事件。三张表都要动 —— 事件表没有 sessionId，只能经消息反查。 */
  deleteSession(sessionId: string): boolean {
    const exists = this.getSession(sessionId) !== null;
    if (!exists) return false;

    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.prepare(SESSION_SQL.deleteEventsOfSession).run(sessionId);
      this.#db.prepare(SESSION_SQL.deleteMessagesOfSession).run(sessionId);
      this.#db.prepare(SESSION_SQL.deleteSession).run(sessionId);
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#rollback();
      throw err;
    }
    return true;
  }

  // ── 消息 ────────────────────────────────────────────────

  /** 插入一条消息并分配会话内序。取号与插入在同一事务里。 */
  insertMessage(input: InsertMessageInput): SessionMessage {
    if (this.getSession(input.sessionId) === null) {
      throw new AppError('NOT_FOUND', `会话不存在：${input.sessionId}`);
    }

    const now = this.#deps.now();
    const messageId = this.#deps.newId('m');

    this.#db.exec('BEGIN IMMEDIATE');
    let seq: number;
    try {
      const row = this.#db.prepare(MESSAGE_SQL.nextSeq).get(input.sessionId) as unknown as { next?: number } | undefined;
      seq = typeof row?.next === 'number' ? row.next : 1;

      this.#db
        .prepare(MESSAGE_SQL.insert)
        .run(
          messageId,
          input.sessionId,
          seq,
          input.role,
          input.content,
          input.status,
          input.runId,
          input.usage === undefined || input.usage === null ? null : JSON.stringify(input.usage),
          now,
          now,
        );
      this.#db.prepare(SESSION_SQL.bumpMessageCount).run(now, input.sessionId);
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#rollback();
      throw err instanceof AppError ? err : new AppError('INTERNAL', `写消息失败：${String(err)}`);
    }

    return {
      messageId,
      sessionId: input.sessionId,
      seq,
      role: input.role,
      content: input.content,
      status: input.status,
      runId: input.runId,
      usage: input.usage ?? null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  /** 覆盖写一条消息的草稿，并追加本次新增的事件（一个事务）。 */
  flushMessage(input: FlushMessageInput): void {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const now = this.#deps.now();
      const result = this.#db
        .prepare(MESSAGE_SQL.updateDraft)
        .run(
          input.content,
          input.status,
          input.usage === null ? null : JSON.stringify(input.usage),
          input.error,
          now,
          input.runId ?? null,
          input.messageId,
        );

      if (result.changes === 0) {
        this.#rollback();
        throw new AppError('NOT_FOUND', `消息不存在：${input.messageId}`);
      }

      const insert = this.#db.prepare(EVENT_SQL.insert);
      for (const event of input.events) {
        const encoded = encodeEvent(event);
        insert.run(event.eventId, event.messageId, event.seq, encoded.kind, encoded.payload, event.createdAt);
      }

      if (input.terminal) {
        this.#db.prepare(SESSION_SQL.touchSessionOfMessage).run(now, input.messageId);
      }
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#rollback();
      throw err;
    }
  }

  /** 一次取全：消息按 seq，事件按 messageId 批量查再一次分组（不做 N+1）。 */
  listMessages(sessionId: string): SessionMessageDetail[] {
    const rows = this.#db
      .prepare(MESSAGE_SQL.listBySession)
      .all(sessionId) as unknown as MessageRowShape[];
    if (rows.length === 0) return [];

    const eventRows = this.#db
      .prepare(selectEventsForMessages(rows.length))
      .all(...rows.map((r) => r.messageId)) as unknown as EventRowShape[];

    const byMessage = new Map<string, SessionEvent[]>();
    for (const row of eventRows) {
      const event = decodeEvent(row);
      if (event === null) continue;
      const list = byMessage.get(row.messageId);
      if (list === undefined) byMessage.set(row.messageId, [event]);
      else list.push(event);
    }

    return rows.map((row) => ({
      messageId: row.messageId,
      sessionId: row.sessionId,
      seq: row.seq,
      role: toRole(row.role),
      content: row.content,
      status: toStatus(row.status),
      runId: row.runId,
      usage: parseUsage(row.usage),
      error: row.error,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      events: byMessage.get(row.messageId) ?? [],
    }));
  }

  #rollback(): void {
    try {
      this.#db.exec('ROLLBACK');
    } catch {
      // 事务可能已被 SQLite 自动回滚。
    }
  }
}
