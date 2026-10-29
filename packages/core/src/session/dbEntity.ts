/**
 * 数据库行类型与列定义。
 *
 * 与 contract 的传输实体**刻意分开**：传输类型加一个纯展示字段时，不该连带改表结构。
 */

/** SQLite 存储类型。没有 BOOLEAN —— 布尔一律 INTEGER 存 0/1。 */
export type SqlType = 'TEXT' | 'INTEGER' | 'REAL';

/** 一列。`key` 受行类型约束，拼错的字段名编译失败。 */
export interface ColumnDef<T> {
  /** 用 `keyof T` 而非 `keyof T & string`：ArkTS 不支持交叉类型。 */
  key: keyof T;
  type: SqlType;
  primaryKey?: boolean;
  notNull?: boolean;
  /** 原样拼进 SQL，如 `0` / `''` / `CURRENT_TIMESTAMP`。 */
  default?: string;
}

/** 一张表。索引表达不了"哪几列唯一"，所以单独列。 */
export interface TableDef<T> {
  name: string;
  columns: ColumnDef<T>[];
  indexes?: string[];
}

/** 会话行。 */
export interface SessionRow {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

/** 消息行。`usage` 是 JSON 文本，读出后由仓储解析。 */
export interface MessageRow {
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

/** 事件行。`payload` 是 JSON 文本，结构由 `kind` 决定。 */
export interface EventRow {
  eventId: string;
  messageId: string;
  seq: number;
  kind: string;
  payload: string;
  createdAt: number;
}
