/**
 * 会话仓储**端口** —— 一份可执行语义，两种后端（SQLite / IndexedDB）。
 *
 * 为什么端口放在 core 而不是各壳：这里写的全是**领域不变式**
 * （序号怎么发、事件怎么幂等、删会话要不要连带清孤儿），
 * 与"用什么存"无关。放壳里就会变成两份，且没有人会发现它们漂了。
 *
 * ## 为什么返回 `Awaitable<T>` 而不是 `Promise<T>`
 *
 * SQLite 是同步的，IndexedDB 天生异步。把同步实现硬包成 Promise 会
 * **假装存在一个异步点**：真错误从抛出变成 rejection，调用方的 try/catch
 * 会静默失效。端口只要求"能被 await"，两边各自诚实 —— `await` 一个
 * 非 Promise 值本来就是合法的。
 *
 * 代价是调用方必须 `await`；忘了的话类型上是 `T | Promise<T>`，
 * 当 `T` 用会编译失败，所以这条约束是机器强制的，不靠自觉。
 *
 * ## 语义（两个实现都必须满足）
 *
 * | 不变式 | 为什么 |
 * |---|---|
 * | `seq` 在会话内从 1 起严格递增，取号与插入原子 | 排序只认 seq；并发下也不能撞 |
 * | `insertMessage` 到不存在的会话 → **抛错** | 静默插入会造出孤儿消息 |
 * | `flushMessage` 覆盖正文（不是追加） | 流式每拍写的是**全量草稿** |
 * | `flushMessage` 重放同一事件不产生重复 | 节流窗口会重发 |
 * | `deleteSession` 连带清掉消息与事件 | 事件表没有 sessionId，只能经消息反查 |
 * | `listMessages` 一次取全 | 渲染层按会话打开，N+1 会把首屏拖成秒级 |
 */

import type {
  MessageRole,
  MessageStatus,
  SessionEvent,
  SessionMessage,
  SessionMessageDetail,
  SessionMeta,
  Usage,
} from '@crossdeck/contract';

/** 同步实现直接返回值，异步实现返回 Promise。`await` 两边都能用。 */
export type Awaitable<T> = T | Promise<T>;

/** 仓储的注入依赖。时钟与 id 都必须来自外部 —— 否则用例没法确定化。 */
export interface SessionRepositoryDeps {
  readonly now: () => number;
  readonly newId: (prefix: string) => string;
}

export interface InsertMessageInput {
  readonly sessionId: string;
  readonly role: MessageRole;
  readonly content: string;
  readonly status: MessageStatus;
  readonly runId: string | null;
  readonly usage?: Usage | null;
}

export interface FlushMessageInput {
  readonly messageId: string;
  /** **全量**正文，不是增量。 */
  readonly content: string;
  readonly status: MessageStatus;
  readonly usage: Usage | null;
  readonly error: string | null;
  /** 上次写入之后新产生的事件；重放必须无副作用。 */
  readonly events: readonly SessionEvent[];
  /** 进了终态：同时把会话的 `updatedAt` 推到最新。 */
  readonly terminal: boolean;
  /** 这一轮 run 的 id。首个 flush 时补上（调 run 时还不知道 runId）。 */
  readonly runId?: string | null;
}

export interface SessionRepository {
  /** 按 `updatedAt` 倒序 —— 列表页要"最近用过的在最上面"。 */
  listSessions(): Awaitable<SessionMeta[]>;
  /** 不存在返回 `null`（这是查询，不是错误）。 */
  getSession(sessionId: string): Awaitable<SessionMeta | null>;
  createSession(title?: string): Awaitable<SessionMeta>;
  /** 连带删消息与事件。会话不存在返回 `false`（幂等删除不该炸）。 */
  deleteSession(sessionId: string): Awaitable<boolean>;
  /** 取号 + 插入 + 会话 messageCount/updatedAt —— 一个原子操作。 */
  insertMessage(input: InsertMessageInput): Awaitable<SessionMessage>;
  /** 覆盖写草稿 + 追加新事件（一个事务）。 */
  flushMessage(input: FlushMessageInput): Awaitable<void>;
  /** 消息按 seq，事件各自挂回所属消息。 */
  listMessages(sessionId: string): Awaitable<SessionMessageDetail[]>;
}
