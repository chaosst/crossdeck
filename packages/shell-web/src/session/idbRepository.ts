/**
 * 会话仓储的 **IndexedDB 后端** —— 端口抽象的第二个实现。
 *
 * 它要证明的事情很具体：**同一套语义不必是同一套 SQL**。
 * 所以这里没有语句字符串、没有行编码（`JSON.stringify(usage)` 那类），
 * 结构化克隆直接存对象。凡是「只有 SQL 才需要」的层，这里一概没有 ——
 * 硬把它们抄过来，就不是第二个实现，而是第一个实现的方言版。
 *
 * ## 与 SQLite 后端的**刻意不同**
 *
 * | | SQLite | IndexedDB |
 * |---|---|---|
 * | 调用形态 | 同步（`Awaitable` 允许直接返回） | 异步（事务天生排队） |
 * | 存什么 | 行（`usage` / `payload` 是 JSON 文本） | 领域对象（结构化克隆） |
 * | 序号发号 | `SELECT MAX(seq)+1`（同一事务） | 会话行里的自增游标 `nextSeq` |
 * | 唯一性 | `CREATE UNIQUE INDEX` | `createIndex(..., { unique: true })` |
 *
 * `nextSeq` 是**实现细节**：读出去必须摘掉（`toMeta`）。它是 O(1) 发号，
 * 观测上与 `MAX(seq)+1` 等价 —— 用例只认后者，因为那才是语义。
 *
 * ## 事务纪律
 *
 * IndexedDB 的事务在「没有挂起请求且控制权回到事件循环」时**自动提交**。
 * 所以事务里只许 `await` IndexedDB 请求，一旦 `await` 了别的东西
 * （fetch / setTimeout），后续操作会撞 `TransactionInactiveError` ——
 * 而且往往只在慢机器上偶发。这个类里所有 `await` 都直接挂在请求上。
 */

import { AppError } from '@crossdeck/contract';
import type {
  MessageRole,
  MessageStatus,
  SessionEvent,
  SessionMessage,
  SessionMessageDetail,
  SessionMeta,
} from '@crossdeck/contract';
import type {
  FlushMessageInput,
  InsertMessageInput,
  SessionRepository,
  SessionRepositoryDeps,
} from '@crossdeck/core';

const DB_PREFIX = 'crossdeck-session-';
const SCHEMA_VERSION = 1;

const S_SESSIONS = 'sessions';
const S_MESSAGES = 'messages';
const S_EVENTS = 'events';

const IX_UPDATED = 'by_updated';
const IX_SESSION = 'by_session';
const IX_SESSION_SEQ = 'by_session_seq';
const IX_MESSAGE = 'by_message';
const IX_MESSAGE_SEQ = 'by_message_seq';

/** 库里存的会话行 = 会话元信息 + 一个发号游标。 */
interface StoredSession extends SessionMeta {
  /** 本会话下一个可用的 seq。**不对外暴露** —— 它是实现细节。 */
  nextSeq: number;
}

const MESSAGE_STATUSES: readonly MessageStatus[] = ['streaming', 'done', 'aborted', 'failed'];

function toStatus(value: unknown): MessageStatus {
  return typeof value === 'string' && MESSAGE_STATUSES.includes(value as MessageStatus)
    ? (value as MessageStatus)
    : 'failed';
}

function toRole(value: unknown): MessageRole {
  return value === 'user' ? 'user' : 'assistant';
}

/** 摘掉 `nextSeq`：读出去的必须是 `SessionMeta`，不许带实现细节。 */
function toMeta(row: StoredSession): SessionMeta {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    messageCount: row.messageCount,
  };
}

function toMessage(row: SessionMessage): SessionMessage {
  return {
    messageId: row.messageId,
    sessionId: row.sessionId,
    seq: row.seq,
    role: toRole(row.role),
    content: row.content,
    status: toStatus(row.status),
    runId: row.runId,
    usage: row.usage ?? null,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务被中止'));
  });
}

// ─────────────────────────────────────────────────────────────
// 账号 → 库名
// ─────────────────────────────────────────────────────────────

/** FNV-1a 32 位。只在 `crypto.subtle` 不可用时兜底。 */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

async function sha256Hex(text: string): Promise<string | null> {
  const holder = globalThis as unknown as {
    crypto?: { subtle?: { digest?: (alg: string, data: Uint8Array) => Promise<ArrayBuffer> } };
  };
  const digest = holder.crypto?.subtle?.digest;
  if (typeof digest !== 'function') return null;
  try {
    const bytes = new TextEncoder().encode(text);
    const buffer = await holder.crypto!.subtle!.digest!('SHA-256', bytes);
    const view = new Uint8Array(buffer);
    let out = '';
    // 只取前 8 字节 → 16 个 hex，与 SQLite 后端的文件名长度对齐
    for (let i = 0; i < 8; i += 1) out += (view[i] ?? 0).toString(16).padStart(2, '0');
    return out;
  } catch {
    return null;
  }
}

/**
 * 账号键 → 库名。
 *
 * 和 SQLite 后端取哈希的理由一样：账号名可能含任意字符、大小写歧义、超长。
 * 差别只在工具链 —— node 有同步 sha256，浏览器只有异步 `crypto.subtle`，
 * 而它要求安全上下文（https 或 localhost）。所以留一条 FNV 兜底：
 * 兜底时碰撞概率高于 sha256，但**只会发生在拿不到 subtle 的降级环境里**，
 * 比"没有隔离、所有账号共用一个库"好得多。
 */
export async function sessionDatabaseName(accountKey: string): Promise<string> {
  const digest = await sha256Hex(accountKey);
  if (digest !== null) return `${DB_PREFIX}${digest}`;
  return `${DB_PREFIX}fnv${fnv1a(accountKey)}`;
}

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open(name, SCHEMA_VERSION);

    opening.onupgradeneeded = () => {
      const db = opening.result;
      if (!db.objectStoreNames.contains(S_SESSIONS)) {
        const sessions = db.createObjectStore(S_SESSIONS, { keyPath: 'id' });
        // 列表页按最近更新倒序；游标反向遍历，不做全量排序
        sessions.createIndex(IX_UPDATED, 'updatedAt');
      }
      if (!db.objectStoreNames.contains(S_MESSAGES)) {
        const messages = db.createObjectStore(S_MESSAGES, { keyPath: 'messageId' });
        messages.createIndex(IX_SESSION, 'sessionId');
        // 与 SQL 的 ux_messages_session_seq 同一个约束：会话内 seq 不许重复
        messages.createIndex(IX_SESSION_SEQ, ['sessionId', 'seq'], { unique: true });
      }
      if (!db.objectStoreNames.contains(S_EVENTS)) {
        const events = db.createObjectStore(S_EVENTS, { keyPath: 'eventId' });
        events.createIndex(IX_MESSAGE, 'messageId');
        events.createIndex(IX_MESSAGE_SEQ, ['messageId', 'seq'], { unique: true });
      }
    };

    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error ?? new Error(`打不开会话库 ${name}`));
    opening.onblocked = () => reject(new Error(`会话库 ${name} 被另一个标签页占用，请关掉其它窗口再试`));
  });
}

/** 删掉一个库（按库名）。切账号 / 自检清理用，正常退出**不**删。 */
export async function deleteSessionDatabase(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`删不掉会话库 ${name}`));
    request.onblocked = () => reject(new Error(`会话库 ${name} 还被占用，删不掉`));
  });
}

export interface IdbSessionRepositoryOptions extends SessionRepositoryDeps {
  /** 账号键。未登录时调用方传 `local`。 */
  readonly accountKey: string;
}

export class IdbSessionRepository implements SessionRepository {
  readonly #accountKey: string;
  readonly #deps: SessionRepositoryDeps;
  #opening: Promise<IDBDatabase> | null = null;

  constructor(opts: IdbSessionRepositoryOptions) {
    this.#accountKey = opts.accountKey;
    this.#deps = { now: opts.now, newId: opts.newId };
  }

  get accountKey(): string {
    return this.#accountKey;
  }

  /** 库名（诊断用：同一个账号该看到同一个名字）。 */
  async databaseName(): Promise<string> {
    return sessionDatabaseName(this.#accountKey);
  }

  /** 关连接。关掉之后再调用会抛 —— 不许静默成功。 */
  async close(): Promise<void> {
    const opening = this.#opening;
    this.#opening = null;
    if (opening === null) return;
    (await opening).close();
  }

  /** 删库。切账号 / 自检清理用 —— 正常退出**不**删。 */
  async destroy(): Promise<void> {
    await this.close();
    await deleteSessionDatabase(await this.databaseName());
  }

  #db(): Promise<IDBDatabase> {
    if (this.#opening === null) {
      this.#opening = this.databaseName().then(openDatabase);
    }
    return this.#opening;
  }

  /**
   * 一个读事务。
   *
   * `done` 必须在 `run` 之前挂上 —— 事务可能在 `run` 的第一个 await 之后
   * 立刻完成，晚挂就永远等不到 `oncomplete`。
   */
  async #read<T>(stores: string[], run: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    const db = await this.#db();
    const tx = db.transaction(stores, 'readonly');
    const done = txDone(tx);
    const result = await run(tx);
    await done;
    return result;
  }

  /** 一个写事务。`run` 抛错时**主动 abort**：半截写入比没写更难查。 */
  async #write<T>(stores: string[], run: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    const db = await this.#db();
    const tx = db.transaction(stores, 'readwrite');
    const done = txDone(tx);
    let result: T;
    try {
      result = await run(tx);
    } catch (err) {
      try {
        tx.abort();
      } catch {
        // 已经结束了，abort 会抛；原始错误更重要
      }
      await done.catch(() => undefined);
      throw err;
    }
    await done;
    return result;
  }

  // ── 会话 ────────────────────────────────────────────────

  async listSessions(): Promise<SessionMeta[]> {
    return this.#read([S_SESSIONS], async (tx) => {
      // 反向游标走 `by_updated` 索引：排序交给索引，不在内存里排
      const rows = await new Promise<StoredSession[]>((resolve, reject) => {
        const out: StoredSession[] = [];
        const cursor = tx.objectStore(S_SESSIONS).index(IX_UPDATED).openCursor(null, 'prev');
        cursor.onsuccess = () => {
          const current = cursor.result;
          if (current === null) {
            resolve(out);
            return;
          }
          out.push(current.value as StoredSession);
          current.continue();
        };
        cursor.onerror = () => reject(cursor.error ?? new Error('遍历会话索引失败'));
      });
      return rows.map(toMeta);
    });
  }

  async getSession(sessionId: string): Promise<SessionMeta | null> {
    return this.#read([S_SESSIONS], async (tx) => {
      const row = (await req(tx.objectStore(S_SESSIONS).get(sessionId))) as StoredSession | undefined;
      return row === undefined ? null : toMeta(row);
    });
  }

  async createSession(title?: string): Promise<SessionMeta> {
    const now = this.#deps.now();
    const raw = title?.trim() ?? '';
    const row: StoredSession = {
      id: this.#deps.newId('s'),
      title: raw.length > 0 ? raw.slice(0, 64) : 'New chat',
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      nextSeq: 1,
    };
    return this.#write([S_SESSIONS], async (tx) => {
      await req(tx.objectStore(S_SESSIONS).add(row));
      return toMeta(row);
    });
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    return this.#write([S_SESSIONS, S_MESSAGES, S_EVENTS], async (tx) => {
      const sessions = tx.objectStore(S_SESSIONS);
      const messages = tx.objectStore(S_MESSAGES);
      const events = tx.objectStore(S_EVENTS);

      const existing = await req(sessions.get(sessionId));
      if (existing === undefined) return false;

      // 事件表没有 sessionId，只能经消息反查 —— 与 SQL 后端同一条路径
      const owned = (await req(messages.index(IX_SESSION).getAll(sessionId))) as SessionMessage[];
      for (const message of owned) {
        const attached = (await req(events.index(IX_MESSAGE).getAll(message.messageId))) as SessionEvent[];
        for (const event of attached) await req(events.delete(event.eventId));
        await req(messages.delete(message.messageId));
      }
      await req(sessions.delete(sessionId));
      return true;
    });
  }

  // ── 消息 ────────────────────────────────────────────────

  async insertMessage(input: InsertMessageInput): Promise<SessionMessage> {
    const now = this.#deps.now();
    return this.#write([S_SESSIONS, S_MESSAGES], async (tx) => {
      const sessions = tx.objectStore(S_SESSIONS);
      const session = (await req(sessions.get(input.sessionId))) as StoredSession | undefined;
      if (session === undefined) {
        throw new AppError('NOT_FOUND', `会话不存在：${input.sessionId}`);
      }

      const seq = session.nextSeq;
      const row: SessionMessage = {
        messageId: this.#deps.newId('m'),
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
      // 放与改会话行在同一个事务里：seq 发了但消息没落，下次就会跳号
      await req(tx.objectStore(S_MESSAGES).add(row));
      await req(
        sessions.put({
          ...session,
          nextSeq: seq + 1,
          messageCount: session.messageCount + 1,
          updatedAt: now,
        } satisfies StoredSession),
      );
      return row;
    });
  }

  async flushMessage(input: FlushMessageInput): Promise<void> {
    const now = this.#deps.now();
    await this.#write([S_SESSIONS, S_MESSAGES, S_EVENTS], async (tx) => {
      const messages = tx.objectStore(S_MESSAGES);
      const events = tx.objectStore(S_EVENTS);

      const existing = (await req(messages.get(input.messageId))) as SessionMessage | undefined;
      if (existing === undefined) {
        throw new AppError('NOT_FOUND', `消息不存在：${input.messageId}`);
      }

      const next: SessionMessage = {
        ...existing,
        content: input.content,
        status: input.status,
        usage: input.usage,
        error: input.error,
        runId: input.runId ?? existing.runId,
        updatedAt: now,
      };
      await req(messages.put(next));

      const seqIndex = events.index(IX_MESSAGE_SEQ);
      for (const event of input.events) {
        // 幂等：同一个事件（按 id）或同一个位次（按 messageId+seq）已经在了就跳过。
        // 两个都查，是因为 SQL 的 INSERT OR IGNORE 两条唯一约束都管。
        const byId = await req(events.get(event.eventId));
        const bySeq = await req(seqIndex.getKey([event.messageId, event.seq]));
        if (byId !== undefined || bySeq !== undefined) continue;
        await req(events.add(event));
      }

      if (input.terminal) {
        const sessions = tx.objectStore(S_SESSIONS);
        const session = (await req(sessions.get(next.sessionId))) as StoredSession | undefined;
        if (session !== undefined) await req(sessions.put({ ...session, updatedAt: now }));
      }
    });
  }

  async listMessages(sessionId: string): Promise<SessionMessageDetail[]> {
    return this.#read([S_MESSAGES, S_EVENTS], async (tx) => {
      const messages = tx.objectStore(S_MESSAGES);
      const events = tx.objectStore(S_EVENTS);

      const rows = (await req(messages.index(IX_SESSION).getAll(sessionId))) as SessionMessage[];
      // 索引的键只有 sessionId，同会话内的顺序是主键序 —— 必须自己按 seq 排
      rows.sort((a, b) => a.seq - b.seq);

      const out: SessionMessageDetail[] = [];
      for (const row of rows) {
        const attached = (await req(events.index(IX_MESSAGE).getAll(row.messageId))) as SessionEvent[];
        attached.sort((a, b) => a.seq - b.seq);
        out.push({ ...toMessage(row), events: attached });
      }
      return out;
    });
  }
}
