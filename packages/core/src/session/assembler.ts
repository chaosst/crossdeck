import type { AgentStreamEvent, MessageStatus, SessionEvent, Usage } from '@crossdeck/contract';

/** 工具参数预览的最大长度，与 navigate 侧一致。 */
const ARGS_PREVIEW_MAX = 200;

/** 已开始、未见结束帧的调用。只活在这一轮里，不落库。 */
export interface PendingToolCall {
  readonly callId: string;
  readonly name: string;
  readonly argsPreview: string;
}

/** 一条消息在流式过程中的完整草稿；装配器的唯一状态。 */
export interface MessageDraft {
  readonly status: MessageStatus;
  readonly content: string;
  readonly usage: Usage | null;
  readonly error: string | null;
  readonly pendingTools: readonly PendingToolCall[];
  /** 消息内事件的下一序号，从 1 起。 */
  readonly nextEventSeq: number;
  /** 进终态后被丢弃的事件数。 */
  readonly dropped: number;
}

export interface AssembleContext {
  readonly messageId: string;
  readonly newId: (prefix: string) => string;
  readonly now: () => number;
}

export interface AssembleResult {
  readonly draft: MessageDraft;
  /** 需要追加落库的事件；`null` = 这个事件不进事件表。 */
  readonly append: SessionEvent | null;
  /** 已到终态：调用方必须立刻落盘，不能等节流窗口。 */
  readonly terminal: boolean;
}

export function isTerminalStatus(status: MessageStatus): boolean {
  return status === 'done' || status === 'aborted' || status === 'failed';
}

export function createDraft(): MessageDraft {
  return {
    status: 'streaming',
    content: '',
    usage: null,
    error: null,
    pendingTools: [],
    nextEventSeq: 1,
    dropped: 0,
  };
}

function keep(draft: MessageDraft): AssembleResult {
  return { draft, append: null, terminal: false };
}

/** 参数序列化成一行预览；序列化不了也不许把这一轮打挂。 */
function previewArgs(args: unknown): string {
  let text: string;
  try {
    text = typeof args === 'string' ? args : (JSON.stringify(args) ?? 'null');
  } catch {
    return '<无法序列化>';
  }
  return text.length <= ARGS_PREVIEW_MAX ? text : `${text.slice(0, ARGS_PREVIEW_MAX)}…`;
}

/** 事件 → 新草稿 + 该不该落库。不碰 IO、不读时钟（时钟与 id 都是注入的）。 */
export function foldStreamEvent(
  draft: MessageDraft,
  event: AgentStreamEvent,
  ctx: AssembleContext,
): AssembleResult {
  // 终态幂等：迟到帧一律丢弃，但必须计数
  if (isTerminalStatus(draft.status)) {
    return { draft: { ...draft, dropped: draft.dropped + 1 }, append: null, terminal: false };
  }

  switch (event.type) {
    case 'start':
      return keep(draft);

    case 'plan':
      // plan 是 run 内的瞬时步骤，不进会话事件表
      return keep(draft);

    case 'token':
      return { draft: { ...draft, content: draft.content + event.text }, append: null, terminal: false };

    case 'tool':
      return {
        draft: {
          ...draft,
          pendingTools: [
            ...draft.pendingTools,
            { callId: event.callId, name: event.name, argsPreview: previewArgs(event.args) },
          ],
        },
        append: null,
        terminal: false,
      };

    case 'tool_end': {
      // 与开始帧配对才成一条完整记录；配不上说明中途丢帧，不落孤儿
      const index = draft.pendingTools.findIndex((t) => t.callId === event.callId);
      const call = draft.pendingTools[index];
      if (call === undefined) return keep(draft);

      const append: SessionEvent = {
        kind: 'tool',
        eventId: ctx.newId('ev'),
        messageId: ctx.messageId,
        seq: draft.nextEventSeq,
        createdAt: ctx.now(),
        callId: call.callId,
        name: call.name,
        argsPreview: call.argsPreview,
        resultPreview: '',
        ok: event.ok,
        ms: event.ms,
      };
      return {
        draft: {
          ...draft,
          pendingTools: draft.pendingTools.filter((_, i) => i !== index),
          nextEventSeq: draft.nextEventSeq + 1,
        },
        append,
        terminal: false,
      };
    }

    case 'sources': {
      if (event.sources.length === 0) return keep(draft);
      const append: SessionEvent = {
        kind: 'sources',
        eventId: ctx.newId('ev'),
        messageId: ctx.messageId,
        seq: draft.nextEventSeq,
        createdAt: ctx.now(),
        sources: [...event.sources],
      };
      return { draft: { ...draft, nextEventSeq: draft.nextEventSeq + 1 }, append, terminal: false };
    }

    case 'action': {
      const append: SessionEvent = {
        kind: 'action',
        eventId: ctx.newId('ev'),
        messageId: ctx.messageId,
        seq: draft.nextEventSeq,
        createdAt: ctx.now(),
        actionId: event.actionId,
        label: event.label,
        url: event.url,
      };
      return { draft: { ...draft, nextEventSeq: draft.nextEventSeq + 1 }, append, terminal: false };
    }

    case 'done':
      return {
        draft: { ...draft, status: 'done', usage: event.usage, pendingTools: [] },
        append: null,
        terminal: true,
      };

    case 'error': {
      // ABORTED 是用户主动停止，不是失败：正文原样保留
      const aborted = event.code === 'ABORTED';
      return {
        draft: { ...draft, status: aborted ? 'aborted' : 'failed', error: event.message, pendingTools: [] },
        append: null,
        terminal: true,
      };
    }

    default:
      return assertNeverEvent(event);
  }
}

function assertNeverEvent(value: never): never {
  throw new Error(`未处理的流事件：${JSON.stringify(value)}`);
}
