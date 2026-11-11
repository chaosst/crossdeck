/** session 端口 —— 每账号一个 RDB 库；created/deleted/switched 的推送与数据同源。 */
import { formatIpcError } from '../../shared/contract/index';
import type { IpcErrorCode, SessionChange, SessionMeta, SessionMessageDetail } from '../../shared/contract/index';
import type { AgentDeps, SessionRepositoryDeps } from '../../shared/core/index';
import { openSessionDatabase, RdbSessionRepository } from '../../session/RdbSessionRepo';
import type { common } from '@kit.AbilityKit';
import type { OhosPort } from '../HostBridge';

class TitleReq {
  title: string = '';
}

class IdReq {
  sessionId: string = '';
}

class SwitchReq {
  accountKey: string = '';
}

export type SessionChangedSink = (change: SessionChange) => void;

/**
 * 会话相关的接口类
 * type: switch / list / create / remove / messages
 */
export class SessionPort implements OhosPort {
  private readonly context: common.Context;
  private readonly deps: SessionRepositoryDeps;
  private readonly onChanged: SessionChangedSink;
  private accountKey: string = 'local';
  private repo: RdbSessionRepository | null = null;

  constructor(context: common.Context, deps: AgentDeps, onChanged: SessionChangedSink) {
    this.context = context;
    this.onChanged = onChanged;
    this.deps = { now: deps.now, newId: deps.newId };
  }

  /** 当前账号的仓储；没开过库就开 local。 */
  current(): Promise<RdbSessionRepository> {
    if (this.repo !== null) return Promise.resolve(this.repo);
    return this.open(this.accountKey);
  }

  open(accountKey: string): Promise<RdbSessionRepository> {
    const safe = accountKey.replace(/[^a-zA-Z0-9_-]/g, '_');
    const name = `session_${safe}.db`;
    return openSessionDatabase(this.context, name).then((store): RdbSessionRepository => {
      this.accountKey = accountKey;
      this.repo = new RdbSessionRepository(store, this.deps);
      const change: SessionChange = { reason: 'switched' };
      this.onChanged(change);
      return this.repo;
    });
  }

  handle(method: string, argsJson: string): Promise<string | null> {
    if (method === 'switch') {
      const req = JSON.parse(argsJson) as SwitchReq;
      return this.open(req.accountKey ?? 'local').then((): string | null => null);
    }
    if (method === 'list') {
      // 用 current() 而不是 requireRepo()：首帧就可能来问列表，不该因为"还没 switch 过"抛错。
      return this.current().then((repo): string => JSON.stringify(repo.listSessions()));
    }
    if (method === 'create') {
      const req = JSON.parse(argsJson) as TitleReq;
      return this.current().then((repo): string => {
        const meta: SessionMeta = repo.createSession(req.title);
        const change: SessionChange = { sessionId: meta.id, reason: 'created' };
        this.onChanged(change);
        return JSON.stringify(meta);
      });
    }
    if (method === 'remove') {
      const req = JSON.parse(argsJson) as IdReq;
      return this.current().then((repo): string | null => {
        const deleted: boolean = repo.deleteSession(req.sessionId);
        if (!deleted) {
          throw new Error(formatIpcError('NOT_FOUND' as IpcErrorCode, `会话不存在：${req.sessionId}`));
        }
        const change: SessionChange = { sessionId: req.sessionId, reason: 'deleted' };
        this.onChanged(change);
        return null;
      });
    }
    if (method === 'messages') {
      const req = JSON.parse(argsJson) as IdReq;
      return this.current().then((repo): string => {
        const details: SessionMessageDetail[] = repo.listMessages(req.sessionId);
        return JSON.stringify(details);
      });
    }
    return Promise.reject(new Error(formatIpcError('NOT_FOUND' as IpcErrorCode, `session 端口没有方法 ${method}`, 'METHOD')));
  }
}
