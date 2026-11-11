/**
 * 鸿蒙端口的**浏览器桩** —— P3-0 的关键验证件（不装进设备）。
 *
 * 它在浏览器里冒充 ArkTS 的 8 个端口：接住内联脚本 park 的端口、按帧协议
 * 派发 CallFrame、回 ResFrame、推 PushFrame。于是同一份 `rawfile/app` 产物
 * 能在真浏览器里跑完整条自检链路 —— 「打包对不对 / 桥接形状对不对」与
 * 「设备/内核问题」就此彻底分开：设备上再出问题，一定在 ArkTS 侧或内核侧。
 *
 * 诚实边界（这份桩**不是**设备行为的证明）：
 *   · 传输用 cookie 而不是 token-in-body —— 桩要验的是桥与产物，不是传输保真度；
 *   · RDB / @ohos.file.fs / 多窗口 —— 这里是内存实现，语义对齐各端口文档；
 *   · navigate 客户端从 `shell-web/src/navigate/client.ts` 内联复制（那份走 fetch+cookie，
 *     与桩的传输形态一致）—— 复制发生在测试替身里，产品路径零复制。
 */

import { IPC } from '@crossdeck/contract';
import type {
  AgentStreamEvent,
  DirEntry,
  FileStat,
  GuestLoginResult,
  NavigateStatus,
  PerfSampleInput,
  PerfSnapshot,
  SessionChange,
  SessionMeta,
  SessionMessage,
  SessionMessageDetail,
  UploadedDocument,
  Usage,
  Workspace,
} from '@crossdeck/contract';
import {
  AgentRuntime,
  DEFAULT_FIRST_FRAME_TIMEOUT_MS,
  DEFAULT_UPLOAD_POLICY,
  NAVIGATE_CHAT_PATH,
  NavigateStream,
  ScriptedModel,
  WorkspaceStore,
  checkOpenUrl,
  checkUploadCandidate,
  createNavigateReporter,
  createPathGuard,
  describeNavigateHttpStatus,
  errorMessage,
  hostOfUrl,
  resolveInWorkspace,
} from '@crossdeck/core';
import type {
  AgentDeps,
  Cancel,
  ChatClient,
  FlushMessageInput,
  InsertMessageInput,
  ModelPort,
  ModelSink,
  NavigateDiagnostic,
} from '@crossdeck/core';

type Args = Record<string, unknown>;
type PortHandler = (args: Args | undefined) => Promise<unknown> | unknown;

const handlers = new Map<string, PortHandler>();
let pushPort: MessagePort | null = null;

function push(channel: string, payload: unknown): void {
  if (pushPort === null) return;
  pushPort.postMessage(JSON.stringify({ v: 1, kind: 'push', channel, payload: JSON.stringify(payload) }));
}

function reply(id: number, res: string | null, err: string | null): void {
  if (pushPort === null) return;
  pushPort.postMessage(JSON.stringify({ v: 1, kind: 'res', id, res, err }));
}

function fail(code: string, message: string, detail?: string): never {
  throw new Error(detail === undefined ? `[${code}] ${message}` : `[${code}:${detail}] ${message}`);
}

function onHostMessage(ev: MessageEvent): void {
  const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
  let msg: { kind: string; id: number; port: string; method: string; args: string };
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg.kind !== 'call') return;

  const args: Args | undefined =
    msg.args === 'null' || msg.args === undefined ? undefined : (JSON.parse(msg.args) as Args);
  void (async () => {
    const handler = handlers.get(`${msg.port}.${msg.method}`);
    if (handler === undefined) {
      reply(msg.id, null, `[NOT_FOUND:PORT_METHOD] 桩里没有 ${msg.port}.${msg.method}（桥与桩的端口表对不上）`);
      return;
    }
    try {
      const res = await handler(args);
      reply(msg.id, res === undefined ? null : JSON.stringify(res), null);
    } catch (err) {
      reply(msg.id, null, err instanceof Error ? err.message : String(err));
    }
  })();
}

// ─────────────────────────────────────────────────────────────
// deps（与三个壳同形）
// ─────────────────────────────────────────────────────────────
const BOOT_AT = Date.now();
const deps: AgentDeps = {
  now: () => Date.now(),
  every: (ms, fn) => {
    const t = setInterval(fn, ms);
    return () => clearInterval(t);
  },
  newId: (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`,
};

// ─────────────────────────────────────────────────────────────
// system 端口
// ─────────────────────────────────────────────────────────────
handlers.set('system.info', () => ({
  platform: 'ohos',
  appVersion: 'stub',
  osVersion: navigator.userAgent,
  locale: navigator.language,
  capabilities: ['fs.scope', 'notify.system'],
}));

handlers.set('system.perfSample', (req?: Args): PerfSnapshot => {
  const input = (req ?? {}) as PerfSampleInput;
  const snapshot: PerfSnapshot = {
    coldStartMs: Date.now() - BOOT_AT,
    mainRssBytes: 0,
    rendererRssBytes: 0,
    streamFps: input.firstPaint === true ? 0 : (input.streamFps ?? 0),
  };
  return snapshot;
});

// ─────────────────────────────────────────────────────────────
// navigate 端口（传输 = cookie，与 shell-web host 同形）
// ─────────────────────────────────────────────────────────────
let upstreamOverride: string | null | undefined; // undefined = 没动过，用 URL 参数
const urlParam = new URLSearchParams(location.search).get('upstream');
const upstreamFromUrl: string | null =
  urlParam === null ? null : urlParam === '' || urlParam === '1' ? '' : urlParam;

function baseUrl(): string | null {
  return upstreamOverride === undefined ? upstreamFromUrl : upstreamOverride;
}

let session: { role: 'guest' | 'admin'; expiresAt: number | null } | null = null;
let username: string | null = null;

function statusNow(): NavigateStatus {
  const base = baseUrl();
  return {
    upstream:
      base === null
        ? { kind: 'scripted', baseUrl: null }
        : { kind: 'navigate', baseUrl: base === '' ? location.origin : base },
    login:
      base === null
        ? { hasToken: true, role: null, expiresAt: null, encrypted: false, persisted: false, note: 'stub: 离线脚本上游' }
        : {
            hasToken: session !== null,
            role: session?.role ?? null,
            expiresAt: session?.expiresAt ?? null,
            encrypted: false,
            persisted: session !== null,
            note: 'stub: 凭据是同源 httpOnly cookie',
          },
  };
}

async function me(): Promise<{ username: string | null } | null> {
  const base = baseUrl();
  if (base === null) return null;
  const res = await fetch(`${base}/api/me`, { credentials: 'same-origin' });
  if (!res.ok) return null;
  const body = (await res.json()) as { username?: unknown };
  if (typeof body.username === 'string' && body.username !== '') username = body.username;
  return { username };
}

handlers.set('navigate.status', () => statusNow());

handlers.set('navigate.setUpstream', (req?: Args): NavigateStatus => {
  const raw = (req?.['upstreamUrl'] ?? null) as string | null;
  if (raw === null || raw.trim() === '' || raw.trim() === '1') {
    upstreamOverride = null;
  } else {
    try {
      const parsed = new URL(raw.trim());
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        fail('BAD_REQUEST', `只支持 http / https：${parsed.protocol}`);
      }
      upstreamOverride = '';
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('[')) throw err;
      fail('BAD_REQUEST', `不是合法的绝对地址：${JSON.stringify(raw)}`);
    }
  }
  session = null;
  return statusNow();
});

handlers.set('navigate.currentAccount', async () => {
  const hit = await me();
  return { username: hit?.username ?? null };
});

handlers.set('navigate.loginGuest', async (): Promise<GuestLoginResult> => {
  const base = baseUrl();
  if (base === null) fail('UNSUPPORTED', 'stub: 离线脚本上游没有登录接口');
  const res = await fetch(`${base}/api/login/guest`, { method: 'POST', credentials: 'same-origin' });
  if (!res.ok) fail('UPSTREAM', `登录失败：HTTP ${res.status}`);
  const body = (await res.json()) as { role?: unknown };
  session = { role: body.role === 'admin' ? 'admin' : 'guest', expiresAt: null };
  return { role: session.role, expiresInSec: 1800, expiresAt: Date.now() + 1800_000 };
});

handlers.set('navigate.login', (req?: Args) => handlers.get('navigate.loginGuest')!(req));
handlers.set('navigate.loginCode', (): never => fail('UNSUPPORTED', 'stub 未实现验证码（probeUi 不覆盖它）'));
handlers.set('navigate.challengeNeeded', () => ({ needChallenge: false }));
handlers.set('navigate.logout', async (): Promise<NavigateStatus> => {
  session = null;
  const base = baseUrl();
  if (base !== null) await fetch(`${base}/api/logout`, { credentials: 'same-origin' }).catch(() => undefined);
  return statusNow();
});

// ─────────────────────────────────────────────────────────────
// session 端口（内存仓储；语义对齐 SessionRepository 端口文档）
// ─────────────────────────────────────────────────────────────
const sessions = new Map<string, SessionMeta>();
const messages = new Map<string, SessionMessageDetail>();
let caseSeq = 0;

handlers.set('session.switch', (req?: Args): null => {
  const accountKey = String(req?.['accountKey'] ?? 'local');
  void accountKey;
  sessions.clear();
  messages.clear();
  caseSeq += 1;
  push(IPC.sessionChanged, { reason: 'switched' } satisfies SessionChange);
  return null;
});

handlers.set('session.list', (): SessionMeta[] => [...sessions.values()]);

handlers.set('session.create', (req?: Args): SessionMeta => {
  const now = Date.now();
  const title = typeof req?.['title'] === 'string' ? (req['title'] as string).trim().slice(0, 64) : '';
  const meta: SessionMeta = {
    id: `s_stub_${caseSeq}_${sessions.size + 1}`,
    title: title.length > 0 ? title : 'New chat',
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
  };
  sessions.set(meta.id, meta);
  push(IPC.sessionChanged, { sessionId: meta.id, reason: 'created' } satisfies SessionChange);
  return meta;
});

handlers.set('session.remove', (req?: Args): null => {
  const id = String(req?.['sessionId'] ?? '');
  if (!sessions.delete(id)) fail('NOT_FOUND', `会话不存在：${id}`);
  for (const [messageId, detail] of messages) {
    if (detail.sessionId === id) messages.delete(messageId);
  }
  push(IPC.sessionChanged, { sessionId: id, reason: 'deleted' } satisfies SessionChange);
  return null;
});

handlers.set('session.messages', (req?: Args): SessionMessageDetail[] => {
  const id = String(req?.['sessionId'] ?? '');
  return [...messages.values()].filter((m) => m.sessionId === id).sort((a, b) => a.seq - b.seq);
});

// 桩内仓储（给 agent 用；insert/flush 语义与三个 SQL/IDB/RDB 后端一致）
const stubRepo = {
  getSession(id: string): SessionMeta | null {
    return sessions.get(id) ?? null;
  },
  insertMessage(input: InsertMessageInput): SessionMessage {
    const meta = sessions.get(input.sessionId);
    if (meta === undefined) throw new Error(`[NOT_FOUND] 会话不存在：${input.sessionId}`);
    const now = Date.now();
    const messageId = deps.newId('m');
    const seq = [...messages.values()].filter((m) => m.sessionId === input.sessionId).length + 1;
    const detail: SessionMessageDetail = {
      messageId,
      sessionId: input.sessionId,
      seq,
      role: input.role,
      content: input.content,
      status: input.status,
      runId: input.runId,
      usage: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      events: [],
    };
    messages.set(messageId, detail);
    meta.messageCount += 1;
    meta.updatedAt = now;
    return { ...detail };
  },
  flushMessage(input: FlushMessageInput): void {
    const row = messages.get(input.messageId);
    if (row === undefined) throw new Error(`[NOT_FOUND] 消息不存在：${input.messageId}`);
    row.content = input.content;
    row.status = input.status;
    row.usage = input.usage;
    row.error = input.error;
    row.runId = input.runId ?? null;
    row.updatedAt = Date.now();
    for (const event of input.events) row.events.push(event);
  },
  listMessages(sessionId: string): SessionMessageDetail[] {
    return [...messages.values()].filter((m) => m.sessionId === sessionId).sort((a, b) => a.seq - b.seq);
  },
};

// ─────────────────────────────────────────────────────────────
// agent 端口（与 shell-web host/agent.ts 同一编排：两条消息 + 写入器）
// ─────────────────────────────────────────────────────────────
let cached: { url: string; model: ModelPort } | null = null;

/** navigate 客户端（内联自 shell-web/src/navigate/client.ts，cookie 形态）。 */
function makeChatClient(url: string): ChatClient {
  return {
    streamChat(req: { sessionId: string; prompt: string }, sink: ModelSink): Cancel {
      const controller = new AbortController();
      void (async () => {
        const report = createNavigateReporter(console);
        const stream = new NavigateStream({
          sink,
          deps,
          firstFrameTimeoutMs: DEFAULT_FIRST_FRAME_TIMEOUT_MS,
          abortUpstream: () => controller.abort(),
          report,
        });
        const endpoint = `${url === '' ? '' : url}${NAVIGATE_CHAT_PATH}`;
        try {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
            body: JSON.stringify({ sessionId: req.sessionId, question: req.prompt }),
            credentials: 'same-origin',
            signal: controller.signal,
          });
          if (!res.ok || res.body === null) {
            stream.settleError(describeNavigateHttpStatus(res.status, null));
            return;
          }
          stream.armFirstFrameTimer();
          const diag: NavigateDiagnostic = { type: 'request', at: deps.now(), endpoint, auth: 'cookie' };
          report(diag);
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            stream.markFirstByte();
            const text = decoder.decode(value, { stream: true });
            if (text.length > 0) stream.feed(text);
          }
          const tail = decoder.decode();
          if (tail.length > 0) stream.feed(tail);
          stream.finishStream();
        } catch (err) {
          if (!stream.settled && !stream.cancelled) {
            stream.settleError(`读取上游流失败：${errorMessage(err)}`);
          }
        }
      })();
      // 只断连接，不碰 sink（终态归 runtime）——与三个壳同一约定。
      return () => {
        controller.abort();
      };
    },
  };
}

function navigateModelFor(url: string): ModelPort {
  if (cached?.url === url) return cached.model;
  const client = makeChatClient(url);
  const model: ModelPort = {
    stream(req, sink): Cancel {
      return client.streamChat({ sessionId: req.sessionId, prompt: req.prompt }, sink);
    },
  };
  cached = { url, model };
  return model;
}

const agentRuntime = new AgentRuntime({
  deps,
  model: {
    stream(req, sink) {
      const url = baseUrl();
      return url === null
        ? new ScriptedModel({ deps }).stream(req, sink)
        : navigateModelFor(url).stream(req, sink);
    },
  },
});

interface StubWriter {
  runId: string | null;
  push(event: AgentStreamEvent): void;
  stop(): void;
}

interface StubDraft {
  content: string;
  status: 'streaming' | 'done' | 'aborted' | 'failed';
  usage: Usage | null;
  error: string | null;
}

/**
 * 桩里的写入器：事件 → 覆盖写内存仓储。节流粒度与三端一致（间隔 flush +
 * 终态兜底），但不需要 WriteScheduler 的完整背压 —— 这里没有 IO 抖动。
 */
function makeWriter(sessionId: string, messageId: string): StubWriter {
  const draft: StubDraft = { content: '', status: 'streaming', usage: null, error: null };
  const pending: AgentStreamEvent[] = [];
  let closed = false;
  let terminalNotified = false;
  let runId: string | null = null;
  let charsSinceFlush = 0;

  function flush(): void {
    const events = pending.splice(0);
    try {
      stubRepo.flushMessage({
        messageId,
        content: draft.content,
        status: draft.status,
        usage: draft.usage,
        error: draft.error,
        // 桩不持久化事件行（tool/action/sources 的装配语义归设备端口验），
        // probeUi 的断言只覆盖消息正文与终态。
        events: [],
        terminal: draft.status !== 'streaming',
        runId,
      });
    } catch (err) {
      pending.unshift(...events);
      console.error('[stub] 落库失败：', err);
      return;
    }
    if (draft.status !== 'streaming' && !terminalNotified) {
      terminalNotified = true;
      push(IPC.sessionChanged, { sessionId, reason: 'updated' } satisfies SessionChange);
    }
  }

  return {
    get runId() {
      return runId;
    },
    set runId(value: string | null) {
      runId = value;
    },
    push(event: AgentStreamEvent): void {
      if (closed) return;
      pending.push(event);
      if (event.type === 'token') charsSinceFlush += event.text.length;
      if (event.type === 'done') {
        draft.status = 'done';
        draft.usage = event.usage;
      } else if (event.type === 'error') {
        draft.status = 'failed';
        draft.error = event.message;
      }
      // 每 2KB 落一次中间态；终态交给订阅回调里的 stop() 兜底
      if (charsSinceFlush >= 2048 || draft.status !== 'streaming') {
        charsSinceFlush = 0;
        flush();
      }
    },
    stop(): void {
      if (closed) return;
      closed = true;
      flush();
    },
  };
}

const writers = new Map<string, StubWriter>();
let pendingWriter: StubWriter | null = null;

agentRuntime.bus.subscribe((event: AgentStreamEvent) => {
  // 投递与落库互不影响：写失败不该让用户看不到已经收到的字。
  push(IPC.agentStream, event);

  let writer = writers.get(event.runId);
  if (writer === undefined && pendingWriter !== null) {
    // 首个事件（start）在 startRun 里同步发出，早于 writers.set —— 认领 pending。
    writer = pendingWriter;
    writer.runId = event.runId;
    writers.set(event.runId, writer);
    pendingWriter = null;
  }
  if (writer === undefined) return;
  writer.push(event);
  if (event.type === 'done' || event.type === 'error') {
    writers.delete(event.runId);
    writer.stop();
  }
});

handlers.set('agent.run', (req?: Args): { runId: string } => {
  const sessionId = String(req?.['sessionId'] ?? '');
  const input = String(req?.['input'] ?? '');
  if (stubRepo.getSession(sessionId) === null) fail('NOT_FOUND', `会话不存在：${sessionId}`);
  stubRepo.insertMessage({ sessionId, role: 'user', content: input, status: 'done', runId: null });
  // 占位必须先写：流到一半被关掉，下次要靠它认出"上次异常退出"。
  const assistant = stubRepo.insertMessage({ sessionId, role: 'assistant', content: '', status: 'streaming', runId: null });
  const writer = makeWriter(sessionId, assistant.messageId);
  pendingWriter = writer;
  const { runId } = agentRuntime.startRun({ sessionId, input });
  writer.runId = runId;
  writers.set(runId, writer);
  pendingWriter = null;
  return { runId };
});

handlers.set('agent.abort', (req?: Args): null => {
  agentRuntime.abort(String(req?.['runId'] ?? ''));
  return null;
});

handlers.set('agent.control', (req?: Args): null => {
  const runId = String(req?.['runId'] ?? '');
  const type = req?.['type'] === 'resume' ? 'resume' : 'pause';
  if (!agentRuntime.pauseOrResume(runId, type)) fail('NOT_FOUND', `run 不存在或已结束：${runId}`);
  return null;
});

// ─────────────────────────────────────────────────────────────
// workspace 端口（内存 fs + WorkspaceStore/PathGuard，scope 算法归 core）
// ─────────────────────────────────────────────────────────────
const workspaces = new WorkspaceStore({ caseInsensitive: false });
const guard = createPathGuard(workspaces, { realpath: (p) => Promise.resolve(p) });
const memFs = new Map<string, { kind: 'file' | 'directory'; text?: string; mtimeMs: number }>();

function ensureDemoFixture(): void {
  if (memFs.has('/ws/demo')) return;
  memFs.set('/ws/demo', { kind: 'directory', mtimeMs: BOOT_AT });
  memFs.set('/ws/demo/hello.txt', { kind: 'file', text: 'hello from stub workspace\n', mtimeMs: BOOT_AT });
  memFs.set('/ws/demo/notes', { kind: 'directory', mtimeMs: BOOT_AT });
  memFs.set('/ws/demo/notes/todo.md', { kind: 'file', text: '- 装进 rawfile\n', mtimeMs: BOOT_AT });
}

async function resolveOrThrow(workspaceId: string, relPath: string): Promise<string> {
  const resolved = await resolveInWorkspace(workspaces, guard, workspaceId, relPath);
  if (!resolved.ok) fail('SCOPE_DENIED', '路径不在任何已授权工作区之内', resolved.reason);
  return resolved.absolute;
}

handlers.set('workspace.list', (): Workspace[] => workspaces.list());

handlers.set('workspace.grant', (): Workspace | null => {
  ensureDemoFixture();
  const granted = workspaces.grant({ root: '/ws/demo', mode: 'readwrite' });
  if (!granted.ok) fail('BAD_REQUEST', `授权失败：${granted.reason}`);
  return granted.workspace;
});

handlers.set('workspace.revoke', (req?: Args): null => {
  workspaces.revoke(String(req?.['workspaceId'] ?? ''));
  return null;
});

handlers.set('workspace.listDir', async (req?: Args): Promise<DirEntry[]> => {
  const abs = await resolveOrThrow(String(req?.['workspaceId'] ?? ''), String(req?.['path'] ?? '.'));
  const prefix = abs.endsWith('/') ? abs : `${abs}/`;
  const out: DirEntry[] = [];
  for (const [path, node] of memFs) {
    if (!path.startsWith(prefix) || path === abs) continue;
    const rest = path.slice(prefix.length);
    if (rest.includes('/')) continue; // 只列直接子项
    out.push({ name: rest, path: rest, kind: node.kind, size: node.text?.length ?? 0, mtimeMs: node.mtimeMs });
  }
  return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1));
});

handlers.set('workspace.readFile', async (req?: Args): Promise<{ text: string; truncated: boolean }> => {
  const abs = await resolveOrThrow(String(req?.['workspaceId'] ?? ''), String(req?.['path'] ?? ''));
  const node = memFs.get(abs);
  if (node === undefined || node.kind !== 'file') fail('NOT_FOUND', '读文件失败：文件不存在');
  return { text: node.text ?? '', truncated: false };
});

handlers.set('workspace.writeFile', async (req?: Args): Promise<null> => {
  const abs = await resolveOrThrow(String(req?.['workspaceId'] ?? ''), String(req?.['path'] ?? ''));
  memFs.set(abs, { kind: 'file', text: String(req?.['data'] ?? ''), mtimeMs: Date.now() });
  return null;
});

handlers.set('workspace.stat', async (req?: Args): Promise<FileStat> => {
  const abs = await resolveOrThrow(String(req?.['workspaceId'] ?? ''), String(req?.['path'] ?? '.'));
  const node = memFs.get(abs);
  if (node === undefined) fail('NOT_FOUND', '取文件信息失败：文件不存在');
  return { kind: node.kind, size: node.text?.length ?? 0, mtimeMs: node.mtimeMs };
});

// ─────────────────────────────────────────────────────────────
// document / action / shell / selfcheck
// ─────────────────────────────────────────────────────────────
handlers.set('document.upload', async (req?: Args): Promise<UploadedDocument> => {
  const abs = await resolveOrThrow(String(req?.['workspaceId'] ?? ''), String(req?.['path'] ?? ''));
  const node = memFs.get(abs);
  if (node === undefined || node.kind !== 'file') fail('BAD_REQUEST', '只能上传文件，不能上传目录');
  const fileName = abs.split('/').pop() ?? abs;
  const size = node.text?.length ?? 0;
  const hit = checkUploadCandidate({ fileName, sizeBytes: size }, DEFAULT_UPLOAD_POLICY);
  if (!hit.ok) fail('BAD_REQUEST', hit.message, hit.reason);

  const base = baseUrl();
  if (base === null) fail('UNSUPPORTED', '当前是离线脚本上游，没有上传接口');

  push(IPC.documentUploadProgress, { sentBytes: 0, totalBytes: size, ratio: 0, bytesPerSec: null, etaSec: null });
  const file = new File([node.text ?? ''], fileName, { type: 'text/plain' });
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${base}/api/upload`, { method: 'POST', body: form, credentials: 'same-origin' });
  push(IPC.documentUploadProgress, { sentBytes: size, totalBytes: size, ratio: 1, bytesPerSec: null, etaSec: null });
  if (res.status === 403) fail('FORBIDDEN', '当前身份没有上传权限（游客不能上传文档）');
  if (!res.ok) fail('UPSTREAM', `上传失败：HTTP ${res.status}`);
  const body = (await res.json()) as { documentId?: unknown };
  return {
    docId: typeof body.documentId === 'string' ? body.documentId : `stub_${Date.now()}`,
    filename: fileName,
    chunks: 1,
  };
});

handlers.set('action.open', (req?: Args): null => {
  const url = String(req?.['url'] ?? '');
  const base = baseUrl();
  const upstreamHost = base === null ? location.hostname : (hostOfUrl(base === '' ? location.origin : base) ?? location.hostname);
  const decision = checkOpenUrl(url, [location.hostname, upstreamHost]);
  if (!decision.ok) fail('FORBIDDEN', `外链被拒（${decision.reason}）`, decision.reason);
  window.open(decision.url, '_blank', 'noopener');
  return null;
});

handlers.set('shell.windowOpen', (): never => fail('UNSUPPORTED', 'stub 里没有子窗口（真设备按能力表走）'));
handlers.set('shell.updateCheck', (): null => null);
handlers.set('shell.updateDownload', (): never => fail('UNSUPPORTED', 'stub 无更新'));
handlers.set('shell.updateInstall', (): never => fail('UNSUPPORTED', 'stub 无更新'));

handlers.set('selfcheck.fixture', async () => {
  const res = await fetch('/__selfcheck/nav-fixture');
  if (!res.ok) fail('UPSTREAM', `取不到场景词表：HTTP ${res.status}`);
  return (await res.json()) as unknown;
});

// ─────────────────────────────────────────────────────────────
// 装配：接住内联脚本 park 的端口 + 注册 report 代理
// ─────────────────────────────────────────────────────────────
const channel = new MessageChannel();
pushPort = channel.port1;
channel.port1.onmessage = onHostMessage;
channel.port1.start();

/**
 * 投端口给页面的内联脚本 —— 它会把 ports[0] park 到 window.__crossdeckPort。
 *
 * ⚠️ **必须等 DOMContentLoaded**：桩经 CDP 在 document-start 注入，此时 HTML
 * 还没解析到内联脚本，立刻投递 = 监听不存在 = 端口永久丢失（真机没这个问题，
 * ArkTS 在 onPageEnd 投递，页面早已就绪）。页面用的是生产路径的 message 监听，
 * 不为桩加任何后门。
 */
function deliverPort(): void {
  window.postMessage('__crossdeck__', location.origin, [channel.port2]);
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', deliverPort, { once: true });
} else {
  deliverPort();
}

Object.defineProperty(window, 'crossdeckHost', {
  value: {
    report(json: string): void {
      (window as unknown as { __selfcheckReportJson?: string }).__selfcheckReportJson = json;
      console.log('[selfcheck] report received');
    },
  },
  writable: false,
});
