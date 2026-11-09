/**
 * 会话仓储的 **HarmonyOS RDB 后端**（`@kit.ArkData` 的 relationalStore）。
 *
 * 这是端口抽象的第三个实现 —— 与 SQLite 后端共用 `SCHEMA_STATEMENTS`（同一套 SQL，
 * 因为鸿蒙 RDB 底层就是 SQLite），与 IndexedDB 后端共用那 22 条可执行规格。
 *
 * ## 为什么全用同步 API
 *
 * `beginTransaction()` 是**同步**的，而 `executeSql()` 是 Promise。事务里一旦 await，
 * 控制权就回到事件循环，"取号 + 插入"不再是一个不可分割的动作 —— 唯一索引会在
 * 并发下报错，或者更糟：序号跳号而没人发现。RDB 提供 `executeSync` /
 * `querySqlSync`，用它们，事务里就是一条直线。
 *
 * 顺手得到一个好处：端口是 `Awaitable<T>`，同步实现直接返回值即可 —— 不需要把
 * 同步调用硬包成 `async`（那会假装存在一个异步点，见 core 的 repository.ts）。
 *
 * ## 与 SQLite 后端的差别（都是实现细节，用例看不见）
 *
 * | | SQLite | 鸿蒙 RDB |
 * |---|---|---|
 * | 参数绑定 | `run(a, b, c)` 变参 | `executeSync(sql, [a, b, c])` 数组 |
 * | 存在性判断 | `UPDATE` 的 `changes` | 先 `SELECT 1`（同步，同一事务） |
 * | 库标识 | 文件路径 | `StoreConfig.name`（同进程内唯一） |
 */
import { relationalStore } from '@kit.ArkData';
import type { common } from '@kit.AbilityKit';
import { AppError } from '../shared/contract/index';
import type {
  MessageRole,
  MessageStatus,
  SessionActionEvent,
  SessionEvent,
  SessionMessage,
  SessionMessageDetail,
  SessionMeta,
  SessionSourcesEvent,
  SessionToolEvent,
  Usage,
} from '../shared/contract/index';
import type {
  FlushMessageInput,
  InsertMessageInput,
  SessionRepository,
  SessionRepositoryDeps,
} from '../shared/core/index';
import { EVENT_SQL, MESSAGE_SQL, SCHEMA_STATEMENTS, SESSION_SQL, selectEventsForMessages } from '../shared/core/index';

/** 事件载荷的三种形状（只存 `kind` 之外的部分，公共字段在列上）。 */
interface ToolPayload {
  callId?: string;
  name?: string;
  argsPreview?: string;
  resultPreview?: string;
  ok?: boolean;
  ms?: number;
}

interface ActionPayload {
  actionId?: string;
  label?: string;
  url?: string;
}

interface SourcesPayload {
  sources?: string[];
}

interface EncodedEvent {
  kind: string;
  payload: string;
}

function toStatus(value: string): MessageStatus {
  if (value === 'streaming' || value === 'done' || value === 'aborted' || value === 'failed') return value;
  return 'failed';
}

function toRole(value: string): MessageRole {
  return value === 'user' ? 'user' : 'assistant';
}

/** 用量落 TEXT。解析失败给 null —— 一条坏字段不该让整条消息读不出来。 */
function parseUsage(raw: string | null): Usage | null {
  if (raw === null || raw.length === 0) return null;
  try {
    return JSON.parse(raw) as Usage;
  } catch (e) {
    return null;
  }
}

function encodeEvent(event: SessionEvent): EncodedEvent {
  if (event.kind === 'tool') {
    const e = event as SessionToolEvent;
    const payload: ToolPayload = {
      callId: e.callId,
      name: e.name,
      argsPreview: e.argsPreview,
      resultPreview: e.resultPreview,
      ok: e.ok,
      ms: e.ms,
    };
    return { kind: 'tool', payload: JSON.stringify(payload) };
  }
  if (event.kind === 'action') {
    const e = event as SessionActionEvent;
    const payload: ActionPayload = { actionId: e.actionId, label: e.label, url: e.url };
    return { kind: 'action', payload: JSON.stringify(payload) };
  }
  const e = event as SessionSourcesEvent;
  const payload: SourcesPayload = { sources: e.sources };
  return { kind: 'sources', payload: JSON.stringify(payload) };
}

function decodeEvent(rs: relationalStore.ResultSet): SessionEvent | null {
  const eventId = colText(rs, 'eventId');
  const messageId = colText(rs, 'messageId');
  const seq = colNumber(rs, 'seq');
  const createdAt = colNumber(rs, 'createdAt');
  const kind = colText(rs, 'kind');
  const raw = colText(rs, 'payload');

  if (kind === 'tool') {
    const p = JSON.parse(raw) as ToolPayload;
    const event: SessionToolEvent = {
      kind: 'tool',
      eventId,
      messageId,
      seq,
      createdAt,
      callId: p.callId ?? '',
      name: p.name ?? '',
      argsPreview: p.argsPreview ?? '',
      resultPreview: p.resultPreview ?? '',
      ok: p.ok === true,
      ms: p.ms ?? 0,
    };
    return event;
  }
  if (kind === 'action') {
    const p = JSON.parse(raw) as ActionPayload;
    const event: SessionActionEvent = {
      kind: 'action',
      eventId,
      messageId,
      seq,
      createdAt,
      actionId: p.actionId ?? '',
      label: p.label ?? '',
      url: p.url ?? '',
    };
    return event;
  }
  if (kind === 'sources') {
    const p = JSON.parse(raw) as SourcesPayload;
    const event: SessionSourcesEvent = {
      kind: 'sources',
      eventId,
      messageId,
      seq,
      createdAt,
      sources: p.sources ?? [],
    };
    return event;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// ResultSet 取值
// 列名取索引（不写死数字）：SELECT 的列顺序改了也不会静默错位。
// ─────────────────────────────────────────────────────────────
function colText(rs: relationalStore.ResultSet, name: string): string {
  const i = rs.getColumnIndex(name);
  return rs.isColumnNull(i) ? '' : rs.getString(i);
}

function colTextOrNull(rs: relationalStore.ResultSet, name: string): string | null {
  const i = rs.getColumnIndex(name);
  return rs.isColumnNull(i) ? null : rs.getString(i);
}

function colNumber(rs: relationalStore.ResultSet, name: string): number {
  return rs.getLong(rs.getColumnIndex(name));
}

/**
 * 打开（或新建）会话库并建表。
 *
 * 建表逐条执行 —— RDB 的 `executeSql` 一次只跑一条，而语句清单来自 core
 * （`SCHEMA_STATEMENTS`），不是这里自己 split 出来的。
 */
export async function openSessionDatabase(
  context: common.Context,
  name: string,
): Promise<relationalStore.RdbStore> {
  const config: relationalStore.StoreConfig = {
    name: name,
    securityLevel: relationalStore.SecurityLevel.S1,
  };
  const store = await relationalStore.getRdbStore(context, config);
  for (const statement of SCHEMA_STATEMENTS) {
    await store.executeSql(statement);
  }
  return store;
}

export class RdbSessionRepository implements SessionRepository {
  private readonly store: relationalStore.RdbStore;
  private readonly deps: SessionRepositoryDeps;

  constructor(store: relationalStore.RdbStore, deps: SessionRepositoryDeps) {
    this.store = store;
    this.deps = deps;
  }

  // ── 会话 ────────────────────────────────────────────────

  listSessions(): SessionMeta[] {
    const rs = this.store.querySqlSync(SESSION_SQL.listSessions, []);
    const out: SessionMeta[] = [];
    try {
      while (rs.goToNextRow()) out.push(readMeta(rs));
    } finally {
      rs.close();
    }
    return out;
  }

  getSession(sessionId: string): SessionMeta | null {
    const args: relationalStore.ValueType[] = [sessionId];
    const rs = this.store.querySqlSync(SESSION_SQL.getSession, args);
    try {
      return rs.goToNextRow() ? readMeta(rs) : null;
    } finally {
      rs.close();
    }
  }

  createSession(title?: string): SessionMeta {
    const now = this.deps.now();
    const raw = title === undefined ? '' : title.trim();
    const meta: SessionMeta = {
      id: this.deps.newId('s'),
      title: raw.length > 0 ? raw.slice(0, 64) : 'New chat',
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
    };
    const args: relationalStore.ValueType[] = [meta.id, meta.title, meta.createdAt, meta.updatedAt, meta.messageCount];
    this.store.executeSync(SESSION_SQL.createSession, args);
    return meta;
  }

  /** 删会话并连带清消息与事件。事件表没有 sessionId，只能经消息反查。 */
  deleteSession(sessionId: string): boolean {
    if (this.getSession(sessionId) === null) return false;

    this.store.beginTransaction();
    try {
      const args: relationalStore.ValueType[] = [sessionId];
      this.store.executeSync(SESSION_SQL.deleteEventsOfSession, args);
      this.store.executeSync(SESSION_SQL.deleteMessagesOfSession, args);
      this.store.executeSync(SESSION_SQL.deleteSession, args);
      this.store.commit();
    } catch (err) {
      this.rollbackQuietly();
      throw err instanceof Error ? err : new AppError('INTERNAL', `删会话失败：${String(err)}`);
    }
    return true;
  }

  // ── 消息 ────────────────────────────────────────────────

  /** 插入一条消息并分配会话内序。取号与插入在同一事务、同一同步栈上。 */
  insertMessage(input: InsertMessageInput): SessionMessage {
    if (this.getSession(input.sessionId) === null) {
      throw new AppError('NOT_FOUND', `会话不存在：${input.sessionId}`);
    }

    const now = this.deps.now();
    const messageId = this.deps.newId('m');
    let seq = 1;

    this.store.beginTransaction();
    try {
      const seqArgs: relationalStore.ValueType[] = [input.sessionId];
      const rs = this.store.querySqlSync(MESSAGE_SQL.nextSeq, seqArgs);
      try {
        if (rs.goToNextRow()) seq = colNumber(rs, 'next');
      } finally {
        rs.close();
      }

      const insertArgs: relationalStore.ValueType[] = [
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
      ];
      this.store.executeSync(MESSAGE_SQL.insert, insertArgs);

      const countArgs: relationalStore.ValueType[] = [now, input.sessionId];
      this.store.executeSync(SESSION_SQL.bumpMessageCount, countArgs);
      this.store.commit();
    } catch (err) {
      this.rollbackQuietly();
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

  /** 覆盖写草稿，并追加本次新增的事件（一个事务）。 */
  flushMessage(input: FlushMessageInput): void {
    this.store.beginTransaction();
    try {
      const now = this.deps.now();
      const existsArgs: relationalStore.ValueType[] = [input.messageId];
      if (!this.rowExists(MESSAGE_SQL.exists, existsArgs)) {
        this.rollbackQuietly();
        throw new AppError('NOT_FOUND', `消息不存在：${input.messageId}`);
      }

      const updateArgs: relationalStore.ValueType[] = [
        input.content,
        input.status,
        input.usage === null ? null : JSON.stringify(input.usage),
        input.error,
        now,
        input.runId ?? null,
        input.messageId,
      ];
      this.store.executeSync(MESSAGE_SQL.updateDraft, updateArgs);

      for (const event of input.events) {
        const encoded = encodeEvent(event);
        const eventArgs: relationalStore.ValueType[] = [
          event.eventId,
          event.messageId,
          event.seq,
          encoded.kind,
          encoded.payload,
          event.createdAt,
        ];
        this.store.executeSync(EVENT_SQL.insert, eventArgs);
      }

      if (input.terminal) {
        const touchArgs: relationalStore.ValueType[] = [now, input.messageId];
        this.store.executeSync(SESSION_SQL.touchSessionOfMessage, touchArgs);
      }
      this.store.commit();
    } catch (err) {
      this.rollbackQuietly();
      throw err instanceof Error ? err : new AppError('INTERNAL', `写消息草稿失败：${String(err)}`);
    }
  }

  /** 一次取全：消息按 seq，事件批量查再一次分组（不做 N+1）。 */
  listMessages(sessionId: string): SessionMessageDetail[] {
    const msgArgs: relationalStore.ValueType[] = [sessionId];
    const rs = this.store.querySqlSync(MESSAGE_SQL.listBySession, msgArgs);

    const out: SessionMessageDetail[] = [];
    try {
      while (rs.goToNextRow()) {
        const detail: SessionMessageDetail = {
          messageId: colText(rs, 'messageId'),
          sessionId: colText(rs, 'sessionId'),
          seq: colNumber(rs, 'seq'),
          role: toRole(colText(rs, 'role')),
          content: colText(rs, 'content'),
          status: toStatus(colText(rs, 'status')),
          runId: colTextOrNull(rs, 'runId'),
          usage: parseUsage(colTextOrNull(rs, 'usage')),
          error: colTextOrNull(rs, 'error'),
          createdAt: colNumber(rs, 'createdAt'),
          updatedAt: colNumber(rs, 'updatedAt'),
          events: [],
        };
        out.push(detail);
      }
    } finally {
      rs.close();
    }
    if (out.length === 0) return [];

    // 占位符按消息数生成，参数逐条 push（不把 string[] 直接当 ValueType[]）
    const eventArgs: relationalStore.ValueType[] = [];
    for (const row of out) {
      eventArgs.push(row.messageId);
    }
    const evRs = this.store.querySqlSync(selectEventsForMessages(out.length), eventArgs);

    const grouped: Map<string, SessionEvent[]> = new Map<string, SessionEvent[]>();
    try {
      while (evRs.goToNextRow()) {
        const event = decodeEvent(evRs);
        if (event === null) continue;
        const list = grouped.get(event.messageId);
        if (list === undefined) grouped.set(event.messageId, [event]);
        else list.push(event);
      }
    } finally {
      evRs.close();
    }

    for (const row of out) {
      const attached = grouped.get(row.messageId);
      row.events = attached === undefined ? [] : attached;
    }
    return out;
  }

  // ── 内部 ────────────────────────────────────────────────

  private rowExists(sql: string, args: relationalStore.ValueType[]): boolean {
    const rs = this.store.querySqlSync(sql, args);
    try {
      return rs.goToNextRow();
    } finally {
      rs.close();
    }
  }

  private rollbackQuietly(): void {
    try {
      this.store.rollBack();
    } catch (e) {
      // 事务可能已被 RDB 自动回滚 —— 原始错误更重要，别在这里再抛一个
    }
  }
}

function readMeta(rs: relationalStore.ResultSet): SessionMeta {
  const meta: SessionMeta = {
    id: colText(rs, 'id'),
    title: colText(rs, 'title'),
    createdAt: colNumber(rs, 'createdAt'),
    updatedAt: colNumber(rs, 'updatedAt'),
    messageCount: colNumber(rs, 'messageCount'),
  };
  return meta;
}
