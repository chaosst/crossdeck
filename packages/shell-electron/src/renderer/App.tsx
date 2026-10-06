import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { assertNever } from '@crossdeck/contract';
import type {
  AgentStreamEvent,
  DirEntry,
  SessionMeta,
  SystemInfo,
  Usage,
  WindowKind,
  Workspace,
} from '@crossdeck/contract';
import {
  controlAgentRun,
  createSession,
  deleteSession,
  describeIpcError,
  getSystemInfo,
  grantWorkspace,
  listDir,
  listSessions,
  listWorkspaces,
  onAgentEvent,
  openWindow,
  readFileText,
  startAgentRun,
} from './api';

type BootStatus = 'loading' | 'ready' | 'error';

/** 从 hash 取窗口种类 —— 各壳用同一种声明方式表达"这个窗口是干嘛的"。 */
function kindFromHash(): WindowKind {
  const raw = window.location.hash.replace(/^#\/?/, '');
  if (raw === 'session' || raw === 'settings' || raw === 'inspector') return raw;
  return 'main';
}

export default function App() {
  const kind = kindFromHash();

  const [status, setStatus] = useState<BootStatus>('loading');
  const [bootError, setBootError] = useState<string | null>(null);
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const [streamText, setStreamText] = useState('');
  const [runningRunId, setRunningRunId] = useState<string | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // ── M4：工作区与文件浏览 ──
  const [paused, setPaused] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWsId, setActiveWsId] = useState<string | null>(null);
  const [cwd, setCwd] = useState('.');
  /** `null` = 还没请求过（不是"空"）—— 两者在界面上必须能区分 */
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [preview, setPreview] = useState<{ path: string; text: string; truncated: boolean } | null>(
    null,
  );
  const [fsError, setFsError] = useState<string | null>(null);

  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  const activeWsIdRef = useRef<string | null>(null);
  activeWsIdRef.current = activeWsId;

  // ── 启动：走完 renderer → preload → main → core 整条链才置 ready ──
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [systemInfo, list] = await Promise.all([getSystemInfo(), listSessions()]);
        if (cancelled) return;
        setInfo(systemInfo);
        setSessions(list);
        setStatus('ready');
      } catch (err) {
        if (cancelled) return;
        setBootError(describeIpcError(err).text);
        setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── 流式事件订阅：卸载时必须退订，否则每次挂载都会多一个监听器 ──
  useEffect(() => {
    return onAgentEvent((event: AgentStreamEvent) => {
      switch (event.type) {
        case 'start':
          setStreamText('');
          setUsage(null);
          setPaused(false);
          setRunningRunId(event.runId);
          break;
        case 'token':
          setStreamText((prev) => prev + event.text);
          break;
        case 'tool':
        case 'tool_end':
        case 'plan':
          // M3 会把工具调用与 plan 步骤渲染成时间线，这里先忽略
          break;
        case 'done':
          setRunningRunId(null);
          setPaused(false);
          setUsage(event.usage);
          break;
        case 'error':
          setRunningRunId(null);
          setPaused(false);
          setActionError(`[${event.code}] ${event.message}`);
          break;
        default:
          // 契约里新增事件类型而这里忘了处理 → 编译期就报错，不会静默漏掉
          assertNever(event);
      }
    });
  }, []);

  const handleCreate = useCallback(async () => {
    setActionError(null);
    try {
      const created = await createSession();
      setSessions((prev) => [created, ...prev]);
      setActiveId(created.id);
      setStreamText('');
      setUsage(null);
    } catch (err) {
      setActionError(describeIpcError(err).text);
    }
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    setActionError(null);
    try {
      await deleteSession(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (activeIdRef.current === id) setActiveId(null);
    } catch (err) {
      // 这条路径会被 selfcheck 的反向探针覆盖：删不存在的会话必须抛 NOT_FOUND
      setActionError(describeIpcError(err).text);
    }
  }, []);

  const handleSend = useCallback(async () => {
    setActionError(null);
    try {
      let sessionId = activeIdRef.current;
      if (!sessionId) {
        const created = await createSession('流式自检');
        setSessions((prev) => [created, ...prev]);
        setActiveId(created.id);
        sessionId = created.id;
      }
      const { runId } = await startAgentRun(sessionId, '自检：流式通道是否可用');
      setRunningRunId(runId);
    } catch (err) {
      setActionError(describeIpcError(err).text);
    }
  }, []);

  // ── 工作区：授权 → 列表 ────────────────────────────────

  /**
   * 切到某个工作区的某个目录。
   *
   * 失败时把 entries 置回 `null`（"不知道"）而不是留着上一份列表 ——
   * 留着会让界面显示"上一个目录的内容"，看起来像这次读成功了。
   */
  const browse = useCallback(async (workspaceId: string, path: string) => {
    setFsError(null);
    setPreview(null);
    try {
      const list = await listDir(workspaceId, path);
      setActiveWsId(workspaceId);
      setCwd(path);
      setEntries(list);
    } catch (err) {
      // 这条路径就是"越界被拒"的可见化：错误信封里的 SCOPE_DENIED 会原样显示
      setEntries(null);
      setFsError(describeIpcError(err).text);
    }
  }, []);

  const loadWorkspaces = useCallback(async () => {
    try {
      const list = await listWorkspaces();
      setWorkspaces(list);
      // ⚠️ 只设 activeWsId 是不够的：那只是"选中"，目录内容还没请求过。
      //    少了这次 browse，界面会把"没加载"渲染成"（空目录）"——
      //    而"空目录"和"没去读"是两件完全不同的事（fs.ts 里同一条原则）。
      if (list.length > 0 && activeWsIdRef.current === null) {
        await browse(list[0]!.id, '.');
      }
    } catch (err) {
      setFsError(describeIpcError(err).text);
    }
  }, [browse]);

  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  const handleGrant = useCallback(async () => {
    setFsError(null);
    try {
      const granted = await grantWorkspace();
      // 用户在系统对话框里点了取消 → 返回 null，这不是错误
      if (granted === null) return;
      await loadWorkspaces();
      await browse(granted.id, '.');
    } catch (err) {
      setFsError(describeIpcError(err).text);
    }
  }, [loadWorkspaces, browse]);

  const openFile = useCallback(
    async (name: string) => {
      const wsId = activeWsIdRef.current;
      if (wsId === null) return;
      const rel = cwd === '.' ? name : `${cwd}/${name}`;
      setFsError(null);
      try {
        const res = await readFileText(wsId, rel);
        setPreview({ path: rel, text: res.text, truncated: res.truncated });
      } catch (err) {
        setPreview(null);
        setFsError(describeIpcError(err).text);
      }
    },
    [cwd],
  );

  /** 必然失败的探针：把 `..` 塞进相对路径，让"越界被拒"在界面上肉眼可见。 */
  const probeEscape = useCallback(async () => {
    const wsId = activeWsIdRef.current;
    if (wsId === null) return;
    setPreview(null);
    try {
      await readFileText(wsId, '../outside/secret.txt');
      // 真的读到了才该走这里 —— 说明 PathGuard 漏了，必须显式喊出来
      setFsError('⚠ 越界读取竟然成功了 —— PathGuard 存在漏洞，请立即排查。');
    } catch (err) {
      const described = describeIpcError(err);
      setFsError(
        `${described.text}\n（detail=${described.detail ?? '无'}）—— 这是预期的拒绝。`,
      );
    }
  }, []);

  const handlePauseResume = useCallback(async () => {
    const runId = runningRunId;
    if (runId === null) return;
    const next = !paused;
    try {
      await controlAgentRun(runId, next ? 'pause' : 'resume');
      setPaused(next);
    } catch (err) {
      setActionError(describeIpcError(err).text);
    }
  }, [runningRunId, paused]);

  return (
    <div className="min-h-screen bg-[#f6f5f2] text-[#1c1b19]">
      <header className="border-b border-[#e2dfd7] bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-6 py-3">
          <span className="text-[15px] font-semibold tracking-tight">crossdeck</span>
          <span className="text-[12px] text-[#8a857c]">
            一个平台无关的 core · 多端壳
          </span>
          <span className="ml-auto text-[12px] text-[#8a857c]">
            {kind === 'main' ? 'main 窗口' : `${kind} 窗口`}
          </span>
          <span
            data-testid="boot-status"
            data-state={status}
            className={
              'rounded-full px-2.5 py-0.5 text-[11px] font-medium ' +
              (status === 'ready'
                ? 'bg-[#e3f5e8] text-[#1f6b3a]'
                : status === 'loading'
                  ? 'bg-[#f0eee8] text-[#7a756c]'
                  : 'bg-[#fbe4e4] text-[#a12626]')
            }
          >
            {status === 'ready' ? '链路已就绪' : status === 'loading' ? '正在握手…' : '握手失败'}
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-4 px-6 py-6">
        {status === 'error' && (
          <Card title="启动失败" tone="danger">
            <p className="text-[13px]">{bootError}</p>
            <p className="mt-2 text-[12px] text-[#8a857c]">
              最常见的原因：preload 没打成 CJS（sandbox 下不支持 ESM preload）、
              或 CSP 拦掉了入口脚本。
            </p>
          </Card>
        )}

        {info && (
          <Card title="系统信息 · 来自 main 进程的真实探测">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-4">
              <Field label="platform" value={info.platform} />
              <Field label="appVersion" value={info.appVersion} />
              <Field label="locale" value={info.locale} />
              <Field label="osVersion" value={info.osVersion} />
            </dl>
            <div className="mt-3">
              <div className="text-[11px] uppercase tracking-wide text-[#8a857c]">
                capabilities（core 做 UI 降级的唯一依据）
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {info.capabilities.map((c) => (
                  <span
                    key={c}
                    className="rounded border border-[#dfdbd2] bg-[#faf9f6] px-1.5 py-0.5 font-mono text-[11px] text-[#4a4640]"
                  >
                    {c}
                  </span>
                ))}
              </div>
            </div>
          </Card>
        )}

        {kind === 'main' && (
          <>
            <Card
              title="会话"
              action={
                <div className="flex gap-2">
                  <Button onClick={handleCreate}>新建会话</Button>
                  <Button onClick={() => void openWindow('session')}>新开一个窗口</Button>
                </div>
              }
            >
              {sessions.length === 0 ? (
                <p className="text-[13px] text-[#8a857c]">
                  还没有会话。点「新建会话」——它由 core 的 SessionStore 创建，不经过任何平台 API。
                </p>
              ) : (
                <ul className="divide-y divide-[#eeebe4]">
                  {sessions.map((s) => (
                    <li key={s.id} className="flex items-center gap-3 py-2 text-[13px]">
                      <button
                        type="button"
                        onClick={() => setActiveId(s.id)}
                        className={
                          'flex-1 truncate text-left ' +
                          (s.id === activeId ? 'font-medium text-[#1c1b19]' : 'text-[#5c5750]')
                        }
                      >
                        {s.title}
                        <span className="ml-2 font-mono text-[11px] text-[#a09a90]">{s.id}</span>
                      </button>
                      <span className="text-[11px] text-[#a09a90]">msg {s.messageCount}</span>
                      <button
                        type="button"
                        onClick={() => void handleDelete(s.id)}
                        className="text-[11px] text-[#a12626] hover:underline"
                      >
                        删除
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card
              title="工作区 · 本地文件访问的边界"
              action={
                <div className="flex gap-2">
                  <Button onClick={() => void handleGrant()}>授权目录…</Button>
                  <Button onClick={() => void probeEscape()} disabled={activeWsId === null}>
                    <span data-testid="ws-probe-escape">试读 ../</span>
                  </Button>
                </div>
              }
            >
              <p className="text-[12px] text-[#8a857c]">
                所有 fs 通道都必须带上 workspaceId。core 的 PathGuard 做归一化 → 最长 root 前缀匹配 →
                限定工作区 → symlink 逃逸校验；越界一律拒绝，而不是静默返回空。
              </p>

              {workspaces.length === 0 ? (
                <p className="mt-2 text-[13px] text-[#8a857c]">
                  还没授权任何目录。点「授权目录…」——选中的路径会由 main 进程登记进 WorkspaceStore，
                  之后 core 才认它是可访问范围（未授权时连 `listDir` 都会以 NO_WORKSPACE 被拒）。
                </p>
              ) : (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {workspaces.map((w) => (
                    <button
                      key={w.id}
                      type="button"
                      onClick={() => void browse(w.id, '.')}
                      className={
                        'rounded border px-2 py-0.5 font-mono text-[11px] ' +
                        (w.id === activeWsId
                          ? 'border-[#b9b3a5] bg-[#f0eee8] text-[#1c1b19]'
                          : 'border-[#dfdbd2] bg-[#faf9f6] text-[#5c5750]')
                      }
                      title={w.root}
                    >
                      {w.mode === 'readwrite' ? 'rw' : 'ro'} · {w.root}
                    </button>
                  ))}
                </div>
              )}

              {activeWsId !== null && (
                <>
                  <div className="mt-3 flex items-center gap-3 text-[12px]">
                    <span className="font-mono text-[#8a857c]">
                      {cwd === '.' ? '（工作区根）' : cwd}
                    </span>
                    {cwd !== '.' && (
                      <button
                        type="button"
                        onClick={() => {
                          const parent = cwd.includes('/')
                            ? cwd.slice(0, cwd.lastIndexOf('/'))
                            : '.';
                          void browse(activeWsId, parent);
                        }}
                        className="text-[11px] text-[#5c5750] hover:underline"
                      >
                        返回上级
                      </button>
                    )}
                  </div>

                  {entries === null ? (
                    <p className="mt-2 text-[12px] text-[#a09a90]">（尚未读取）</p>
                  ) : entries.length === 0 ? (
                    <p className="mt-2 text-[12px] text-[#a09a90]">（空目录）</p>
                  ) : (
                    <ul className="mt-1 divide-y divide-[#eeebe4]">
                      {entries.map((e) => (
                        <li key={e.path} className="flex items-center gap-3 py-1.5 text-[12px]">
                          <span className="w-10 shrink-0 font-mono text-[10px] uppercase text-[#a09a90]">
                            {e.kind}
                          </span>
                          <button
                            type="button"
                            data-testid="ws-entry"
                            data-kind={e.kind}
                            onClick={() => {
                              if (e.kind === 'directory') void browse(activeWsId, e.path);
                              else void openFile(e.name);
                            }}
                            className="flex-1 truncate text-left text-[#3c3933] hover:underline"
                          >
                            {e.name}
                          </button>
                          <span className="text-[11px] text-[#a09a90]">{e.size}</span>
                        </li>
                      ))}
                    </ul>
                  )}

                  {preview && (
                    <pre className="mt-3 max-h-[200px] overflow-auto whitespace-pre-wrap rounded border border-[#e5e2da] bg-[#faf9f6] p-3 font-mono text-[12px] leading-relaxed text-[#33302b]">
                      {preview.text}
                      {preview.truncated && '\n… (已按 maxReadBytes 截断)'}
                    </pre>
                  )}
                </>
              )}

              {fsError && (
                <pre className="mt-3 whitespace-pre-wrap rounded border border-[#e8c9c9] bg-[#fdf6f6] p-3 font-mono text-[11px] leading-relaxed text-[#a12626]">
                  {fsError}
                </pre>
              )}
            </Card>

            <Card
              title="流式通道"
              action={
                <div className="flex gap-2">
                  <Button
                    onClick={() => void handlePauseResume()}
                    disabled={runningRunId === null}
                  >
                    {paused ? '继续' : '暂停'}
                  </Button>
                  <Button onClick={handleSend} disabled={runningRunId !== null}>
                    发送
                  </Button>
                </div>
              }
            >
              <p className="text-[12px] text-[#8a857c]">
                `agent:stream` 是不走 invoke 的单向推送通道。产字与推字解耦：上游每 12ms 产一批字进队列，
                下游每 16ms flush 一次（对齐一帧）；队列超 2000 字符时合并中间态而非丢尾部。
                暂停走反向通道 `agent:control`（invoke，有 ack），暂停期间**零推送**。
              </p>
              <pre className="mt-3 min-h-[88px] whitespace-pre-wrap rounded border border-[#e5e2da] bg-[#faf9f6] p-3 font-mono text-[12px] leading-relaxed text-[#33302b]">
                {streamText || (runningRunId ? '等待首个 token…' : '(尚未发送)')}
              </pre>
              <div className="mt-2 flex items-center gap-4 text-[11px] text-[#8a857c]">
                <span>
                  状态：{runningRunId ? (paused ? '已暂停（背压中）' : '流式中') : '空闲'}
                </span>
                {usage && (
                  <span>
                    首 token {usage.ttftMs ?? '?'}ms · 共 {usage.totalMs}ms ·{' '}
                    {usage.completionTokens} token
                    {usage.mergedChunks !== undefined && usage.mergedChunks > 0 && (
                      <> · 合并 {usage.mergedChunks} 次</>
                    )}
                  </span>
                )}
              </div>
            </Card>
          </>
        )}

        {kind !== 'main' && (
          <Card title={`${kind} 窗口`}>
            <p className="text-[13px] text-[#5c5750]">
              这是由 `window:open` 通道创建的独立 BrowserWindow。它复用了同一个 core，
              走的是同一份 preload 白名单 —— 多窗口不是多一套实现。
            </p>
          </Card>
        )}

        {actionError && (
          <Card title="操作失败（错误信封已跨进程保真）" tone="danger">
            <p className="font-mono text-[12px]">{actionError}</p>
          </Card>
        )}
      </main>
    </div>
  );
}

function Card({
  title,
  children,
  action,
  tone,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
  tone?: 'danger';
}) {
  return (
    <section
      className={
        'rounded-lg border bg-white p-4 ' +
        (tone === 'danger' ? 'border-[#e8c9c9]' : 'border-[#e2dfd7]')
      }
    >
      <div className="mb-2.5 flex items-center gap-3">
        <h2 className="text-[13px] font-semibold tracking-tight">{title}</h2>
        <div className="ml-auto">{action}</div>
      </div>
      {children}
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-[#8a857c]">{label}</dt>
      <dd className="font-mono text-[12px]">{value}</dd>
    </div>
  );
}

function Button({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled === true}
      className="rounded border border-[#d9d5cb] bg-[#faf9f6] px-2.5 py-1 text-[12px] text-[#3c3933] transition hover:bg-[#f2f0ea] disabled:cursor-not-allowed disabled:opacity-45"
    >
      {children}
    </button>
  );
}
