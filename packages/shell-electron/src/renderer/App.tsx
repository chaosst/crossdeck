import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { assertNever } from '@crossdeck/contract';
import type { AgentStreamEvent, SessionMeta, SystemInfo, Usage, WindowKind } from '@crossdeck/contract';
import {
  createSession,
  deleteSession,
  describeIpcError,
  getSystemInfo,
  listSessions,
  onAgentEvent,
  openWindow,
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

  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

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
          setUsage(event.usage);
          break;
        case 'error':
          setRunningRunId(null);
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
              title="流式通道"
              action={
                <div className="flex gap-2">
                  <Button onClick={handleSend} disabled={runningRunId !== null}>
                    发送
                  </Button>
                </div>
              }
            >
              <p className="text-[12px] text-[#8a857c]">
                `agent:stream` 是不走 invoke 的单向推送通道。当前内容由 main 的脚本化运行时逐块推送，
                M3 会换成真正接 core Agent 内核的调用 —— 事件类型不变。
              </p>
              <pre className="mt-3 min-h-[88px] whitespace-pre-wrap rounded border border-[#e5e2da] bg-[#faf9f6] p-3 font-mono text-[12px] leading-relaxed text-[#33302b]">
                {streamText || (runningRunId ? '等待首个 token…' : '(尚未发送)')}
              </pre>
              <div className="mt-2 flex items-center gap-4 text-[11px] text-[#8a857c]">
                <span>状态：{runningRunId ? '流式中' : '空闲'}</span>
                {usage && (
                  <span>
                    首 token {usage.ttftMs ?? '?'}ms · 共 {usage.totalMs}ms ·{' '}
                    {usage.completionTokens} token
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
