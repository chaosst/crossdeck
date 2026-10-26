import type { Usage } from './stream.js';

/**
 * 会话持久化实体：消息与事件。会话本身见 `SessionMeta`。
 */

/** 消息角色。只有用户与助理两种 —— 系统提示不进会话历史。 */
export type MessageRole = 'user' | 'assistant';

/**
 * 消息状态。
 *
 * `streaming` 是脏数据：正常退出不会留下它，看到即上次异常退出。
 * `aborted` 保留已收到的正文，不是清空。
 */
export type MessageStatus = 'streaming' | 'done' | 'aborted' | 'failed';

/** 一条消息。正文与状态是主体；工具、动作、引用另存为事件。 */
export interface SessionMessage {
  messageId: string;
  sessionId: string;
  /** 会话内单调序。**排序只认它，不认时间戳**（同毫秒会退化）。 */
  seq: number;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  /** 写入它的那一次 run；非 run 产生的消息为 null。 */
  runId: string | null;
  /** 用量。字段是**字符数**不是 token，标签一律写「字符」。 */
  usage: Usage | null;
  /** 失败 / 中断的原因，与 status 对应。 */
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 会话事件的公共字段。 */
interface SessionEventBase {
  eventId: string;
  messageId: string;
  /** 与消息同一套会话内序，保证卡片插在正文的正确位置。 */
  seq: number;
  createdAt: number;
}

/** 一次**已完成**的工具调用。开始帧只活在前端推送里，不落库。 */
export interface SessionToolEvent extends SessionEventBase {
  kind: 'tool';
  callId: string;
  name: string;
  argsPreview: string;
  resultPreview: string;
  ok: boolean;
  /** 0 = 上游未提供耗时。 */
  ms: number;
}

/** 端侧动作卡片。`url` 在执行前必须过协议与 host 白名单。 */
export interface SessionActionEvent extends SessionEventBase {
  kind: 'action';
  actionId: string;
  label: string;
  url: string;
}

/** 引用来源，已去重保序。 */
export interface SessionSourcesEvent extends SessionEventBase {
  kind: 'sources';
  sources: string[];
}

/**
 * 会话事件。用可辨识联合而不是 `kind + payload: any`：
 * 消费端 `switch (e.kind)` 能收窄到具体成员，写错访问路径是编译错误。
 */
export type SessionEvent = SessionToolEvent | SessionActionEvent | SessionSourcesEvent;

export type SessionEventKind = SessionEvent['kind'];

/** 消息及其事件。读路径组装，DB 里是两张表。 */
export interface SessionMessageDetail extends SessionMessage {
  events: SessionEvent[];
}

/** 会话变更通知。只报"哪个会话动了"，不塞全量数据。 */
export interface SessionChange {
  sessionId: string;
  reason: 'created' | 'updated' | 'deleted';
}

/** 上传成功后的文档，字段对齐 navigate `POST /api/upload` 的响应。 */
export interface UploadedDocument {
  docId: string;
  filename: string;
  chunks: number;
}
