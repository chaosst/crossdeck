/** agent 端口 —— AgentRuntime + 流式落库装配（第一次把鸿蒙的持久化接上）。 */
import type {
  AgentStreamEvent,
  IpcErrorCode,
  SessionChange,
  SessionEvent,
  SessionMessage,
  SessionMeta,
} from '../../shared/contract/index';
import { formatIpcError } from '../../shared/contract/index';
import type {
  AgentDeps,
  Awaitable,
  Cancel,
  FlushMessageInput,
  FlushReason,
  InsertMessageInput,
  MessageDraft,
  ModelPort,
  ModelRequest,
  ModelSink,
} from '../../shared/core/index';
import {
  AgentRuntime,
  DEFAULT_FIRST_FRAME_TIMEOUT_MS,
  ScriptedModel,
  WriteScheduler,
  createDraft,
  foldStreamEvent,
  isTerminalStatus,
} from '../../shared/core/index';
import type { OhosPort } from '../HostBridge';
import { createOhosNavigateClient } from '../../navigate/NavigateClient';
import { OhosNavigateModel } from '../../navigate/NavigateModel';

class RunReq {
  sessionId: string = '';
  input: string = '';
}

class ControlReq {
  runId: string = '';
  type: string = 'pause';
}

class RunHandle {
  runId: string = '';

  constructor(runId: string) {
    this.runId = runId;
  }
}

class CachedModel {
  readonly url: string;
  readonly model: ModelPort;

  constructor(url: string, model: ModelPort) {
    this.url = url;
    this.model = model;
  }
}

/**
 * agent 依赖的仓储子集（SessionPort 的 RdbSessionRepository 结构上满足它）。
 *
 * 返回 `Awaitable` 而不是硬写同步：端口签名得和 `SessionRepository` 对齐，
 * 否则 `Promise<RdbSessionRepository>` 赋不进 `Promise<RunRepo>`（协变要求逐成员兼容）。
 * RDB 的实现全是同步的，`await` 一个非 Promise 是零成本。
 */
export interface RunRepo {
  getSession(sessionId: string): Awaitable<SessionMeta | null>;
  insertMessage(input: InsertMessageInput): Awaitable<SessionMessage>;
  flushMessage(input: FlushMessageInput): Awaitable<void>;
}

export interface AgentPortEnv {
  readonly deps: AgentDeps;
  /** 当前上游根；`null` = 脚本上游。每次开跑现取。 */
  readonly baseUrl: () => string | null;
  readonly getToken: () => string | null;
  /** 开库（agent.run 要先拿到仓储）。 */
  readonly repo: () => Promise<RunRepo>;
  readonly pushStream: (event: AgentStreamEvent) => void;
  readonly pushSessionChanged: (change: SessionChange) => void;
}

/** 一次 run 落库的写入器：事件 → 装配器 → 节流调度器 → 仓储（RDB flush 是同步的）。 */
class OhosRunWriter {
  readonly sessionId: string;
  readonly messageId: string;
  runId: string | null = null;

  private readonly repo: RunRepo;
  private readonly deps: AgentDeps;
  private readonly onChanged: (change: SessionChange) => void;
  private readonly scheduler: WriteScheduler;
  private draft: MessageDraft = createDraft();
  private pending: SessionEvent[] = [];
  private closed = false;
  private terminalWritten = false;

  constructor(repo: RunRepo, deps: AgentDeps, onChanged: (change: SessionChange) => void, sessionId: string, messageId: string) {
    this.repo = repo;
    this.deps = deps;
    this.onChanged = onChanged;
    this.sessionId = sessionId;
    this.messageId = messageId;
    this.scheduler = new WriteScheduler({
      now: deps.now,
      every: deps.every,
      write: (_reason: FlushReason): void => {
        this.flush();
      },
    });
  }

  push(event: AgentStreamEvent): void {
    if (this.closed) return;
    const chars: number = event.type === 'token' ? event.text.length : 0;
    const result = foldStreamEvent(this.draft, event, {
      messageId: this.messageId,
      newId: this.deps.newId,
      now: this.deps.now,
    });
    this.draft = result.draft;
    if (result.append !== null) this.pending.push(result.append);
    this.scheduler.mark(chars, result.terminal);
  }

  stop(): void {
    if (this.closed) return;
    this.scheduler.stop();
    this.closed = true;
    this.flush();
  }

  private flush(): void {
    const events: SessionEvent[] = this.pending;
    this.pending = [];
    const terminal: boolean = isTerminalStatus(this.draft.status);
    try {
      this.repo.flushMessage({
        messageId: this.messageId,
        content: this.draft.content,
        status: this.draft.status,
        usage: this.draft.usage,
        error: this.draft.error,
        events,
        terminal,
        runId: this.runId,
      });
    } catch (err) {
      // 写失败不许把事件丢掉：放回队列，下一次 flush 还会带上它们。
      this.pending = events.concat(this.pending);
      return;
    }
    if (terminal && !this.terminalWritten) {
      this.terminalWritten = true;
      const change: SessionChange = { sessionId: this.sessionId, reason: 'updated' };
      this.onChanged(change);
    }
  }
}

/**
 * Agent方法调用的操作接口类
 * type: run / abort / control
 */
export class AgentPort implements OhosPort {
  private readonly env: AgentPortEnv;
  private readonly runtime: AgentRuntime;
  private cachedModel: CachedModel | null = null;
  private readonly writers: Map<string, OhosRunWriter> = new Map<string, OhosRunWriter>();
  private pendingWriter: OhosRunWriter | null = null;

  constructor(env: AgentPortEnv) {
    this.env = env;
    this.runtime = new AgentRuntime({
      deps: env.deps,
      model: {
        stream: (req: ModelRequest, sink: ModelSink): Cancel => {
          const url = env.baseUrl();
          return url === null
            ? new ScriptedModel({ deps: env.deps }).stream(req, sink)
            : this.navigateModelFor(url).stream(req, sink);
        },
      },
    });
    this.runtime.bus.subscribe((event: AgentStreamEvent): void => {
      // 投递与落库互不影响：写失败不该让用户看不到已经收到的字。
      this.env.pushStream(event);
      this.record(event);
    });
  }

  private navigateModelFor(url: string): ModelPort {
    const cached = this.cachedModel;
    if (cached !== null && cached.url === url) return cached.model;
    const model = new OhosNavigateModel({
      deps: this.env.deps,
      client: createOhosNavigateClient({
        baseUrl: url,
        getToken: (): string | null => this.env.getToken(),
        firstFrameTimeoutMs: DEFAULT_FIRST_FRAME_TIMEOUT_MS,
        deps: this.env.deps,
      }),
    });
    this.cachedModel = new CachedModel(url, model);
    return model;
  }

  handle(method: string, argsJson: string): Promise<string | null> {
    if (method === 'run') {
      const req = JSON.parse(argsJson) as RunReq;
      return this.run(req.sessionId, req.input).then((handle: RunHandle): string => JSON.stringify(handle));
    }
    if (method === 'abort') {
      const req = JSON.parse(argsJson) as ControlReq;
      // run 已经结束也算成功 —— 诉求是"让它别跑了"。
      this.runtime.abort(req.runId);
      return Promise.resolve(null);
    }
    if (method === 'control') {
      const req = JSON.parse(argsJson) as ControlReq;
      const type: 'pause' | 'resume' = req.type === 'resume' ? 'resume' : 'pause';
      if (!this.runtime.pauseOrResume(req.runId, type)) {
        return Promise.reject(new Error(formatIpcError('NOT_FOUND' as IpcErrorCode, `run 不存在或已结束：${req.runId}`)));
      }
      return Promise.resolve(null);
    }
    return Promise.reject(new Error(formatIpcError('NOT_FOUND' as IpcErrorCode, `agent 端口没有方法 ${method}`, 'METHOD')));
  }

  private run(sessionId: string, input: string): Promise<RunHandle> {
    return this.env.repo().then(async (repo: RunRepo): Promise<RunHandle> => {
      if ((await repo.getSession(sessionId)) === null) {
        throw new Error(formatIpcError('NOT_FOUND' as IpcErrorCode, `会话不存在：${sessionId}`));
      }
      await repo.insertMessage({ sessionId, role: 'user', content: input, status: 'done', runId: null });
      // 占位必须先写：流到一半被关掉，下次要靠它认出"上次异常退出"。
      const assistant: SessionMessage = await repo.insertMessage({
        sessionId,
        role: 'assistant',
        content: '',
        status: 'streaming',
        runId: null,
      });

      const writer = new OhosRunWriter(repo, this.env.deps, this.env.pushSessionChanged, sessionId, assistant.messageId);
      this.pendingWriter = writer;
      const runId: string = this.runtime.startRun({ sessionId, input }).runId;
      writer.runId = runId;
      this.writers.set(runId, writer);
      this.pendingWriter = null;
      return new RunHandle(runId);
    });
  }

  private record(event: AgentStreamEvent): void {
    let writer: OhosRunWriter | undefined = this.writers.get(event.runId);
    if (writer === undefined && this.pendingWriter !== null) {
      // 首个事件（start）在 startRun 里同步发出，早于 writers.set —— 认领 pending。
      writer = this.pendingWriter;
      writer.runId = event.runId;
      this.writers.set(event.runId, writer);
      this.pendingWriter = null;
    }
    if (writer === undefined) return;
    writer.push(event);
    if (event.type === 'done' || event.type === 'error') {
      this.writers.delete(event.runId);
      writer.stop();
    }
  }
}
