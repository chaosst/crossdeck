import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { NAVIGATE_AUTH_DETAIL, PERF_TARGETS, assertNever, formatBytes, meetsTarget } from '@crossdeck/contract';
import type {
  AgentStreamEvent,
  DirEntry,
  GuestLoginResult,
  NavigateStatus,
  PerfSnapshot,
  SessionMeta,
  SystemInfo,
  UpdateStatus,
  Usage,
  WindowKind,
  Workspace,
} from '@crossdeck/contract';
import {
  checkForUpdate,
  controlAgentRun,
  createSession,
  deleteSession,
  describeIpcError,
  downloadUpdate,
  getNavigateStatus,
  getSystemInfo,
  grantWorkspace,
  installUpdate,
  listDir,
  listSessions,
  listWorkspaces,
  loginNavigateGuest,
  logoutNavigate,
  onAgentEvent,
  onUpdateStatus,
  openWindow,
  readFileText,
  samplePerf,
  setNavigateUpstream,
  startAgentRun,
  startStreamFpsProbe,
  stopStreamFpsProbe,
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
  /**
   * 流式阶段 —— 单独一个状态，不复用 `runningRunId` + `actionError` 的组合。
   *
   * 为什么不让自检去推：终态有三个（done / error / 还在跑），"没在跑"同时对应
   * "跑完了"和"从没跑过"；靠派生值会逼自检去猜。而 `data-stage` 是自检与
   * 主进程状态、订阅到的最后一帧做**三处一致**比对的那个锚点 —— 猜出来的锚点
   * 比没有锚点更糟。
   */
  const [streamStage, setStreamStage] = useState<'idle' | 'streaming' | 'done' | 'error'>('idle');

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

  // ── M5：自动更新 ──
  /**
   * `null` = **还没查过**。
   *
   * 与 `idle` 刻意分开：idle 的语义是"查过了、没有可装的新版"，
   * 而 null 是"不知道"。把两者合并会让界面在启动瞬间就宣称"已是最新" ——
   * 那是在说一句它并不知道的话。
   */
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);

  // ── M6-1：性能量化 ──
  const [perf, setPerf] = useState<PerfSnapshot | null>(null);

  // ── T10：上游配置 + guest 登录 ──
  const [navStatus, setNavStatus] = useState<NavigateStatus | null>(null);
  /** 输入框是受控的，但**只在读回状态时**才覆盖它 —— 边打字边被状态刷新顶掉是最恼人的那种 bug。 */
  const [navInput, setNavInput] = useState('');
  const [navBusy, setNavBusy] = useState(false);
  const [navError, setNavError] = useState<ReturnType<typeof describeIpcError> | null>(null);
  const [navNotice, setNavNotice] = useState<string | null>(null);

  /**
   * 只有 available / downloading / ready 三种状态带 info。
   * 提成局部变量而不是在 JSX 里写 `'info' in update`：`in` 收窄在 JSX 的属性访问
   * 位置上不好使（TS 会把联合摊平后再报"某分支上没有 info"）。
   */
  const updateInfo = update !== null && 'info' in update ? update.info : null;
  /** 更新入口只由**能力**决定 —— 见下方卡片注释。 */
  const supportsAutoUpdate = info?.capabilities.includes('update.auto') === true;

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
        // 「首帧可交互」必须等 DOM 真的画出来 —— 直接用 setStatus 之后的时刻
        // 报的是"数据到了"，不是"用户看得到"。两层 rAF：第一层等本次 commit
        // 落地，第二层等它被绘制。这也是 main 侧冷启动计时的终点。
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            void samplePerf({ firstPaint: true })
              .then(setPerf)
              .catch(() => {
                /* 采样失败不该影响启动 —— 报告里体现为"没测到"即可 */
              });
          });
        });
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
          setStreamStage('streaming');
          // 帧率探针跟着流一起起停：测的就是"这段流式期间画面跟不跟得上"
          startStreamFpsProbe();
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
          setStreamStage('done');
          // 终态才停探针并上报 —— 中途停会把"半程帧率"当成整段读数
          void samplePerf({ streamFps: stopStreamFpsProbe() })
            .then(setPerf)
            .catch(() => {});
          break;
        case 'error':
          setRunningRunId(null);
          setPaused(false);
          setActionError(`[${event.code}] ${event.message}`);
          setStreamStage('error');
          void samplePerf({ streamFps: stopStreamFpsProbe() })
            .then(setPerf)
            .catch(() => {});
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

  // ── 更新进度订阅 ──
  // 与 agent 流同一个理由：卸载不摘监听，每次挂载都会多一个 ——
  // 但对更新来说后果更难看（同一条进度会被推 N 次，进度条看起来像在抽搐）。
  useEffect(() => {
    return onUpdateStatus((s) => setUpdate(s));
  }, []);

  const handleCheckUpdate = useCallback(async () => {
    setUpdateError(null);
    setUpdateBusy(true);
    try {
      const found = await checkForUpdate();
      // 返回 null 的语义是"没有可装的新版"。但**只有**在推送状态也是 idle 时才这么写 ——
      // 若走的是 UNSUPPORTED 那条路，这里根本到不了（会先抛错）。
      if (found === null) setUpdate((prev) => prev ?? { stage: 'idle' });
    } catch (err) {
      // 未打包形态会在这里抛 UNSUPPORTED —— 如实显示，不给"重试"按钮
      setUpdateError(describeIpcError(err).text);
    } finally {
      setUpdateBusy(false);
    }
  }, []);

  const handleDownloadUpdate = useCallback(async () => {
    setUpdateError(null);
    setUpdateBusy(true);
    try {
      await downloadUpdate();
    } catch (err) {
      setUpdateError(describeIpcError(err).text);
    } finally {
      setUpdateBusy(false);
    }
  }, []);

  const handleInstallUpdate = useCallback(async () => {
    setUpdateError(null);
    setUpdateBusy(true);
    try {
      await installUpdate();
      // 到这里进程马上就要消失了 —— 后面的 setState 不会有人看见。
      // 之所以还能走到 finally，是因为主进程把 quitAndInstall 放进了 setImmediate。
    } catch (err) {
      setUpdateError(describeIpcError(err).text);
    } finally {
      setUpdateBusy(false);
    }
  }, []);

  // ── T10：上游配置 + guest 登录 ──────────────────────────
  /**
   * 把状态写进界面**并**同步输入框。
   *
   * 只有在"刚读回/刚写完状态"时才覆盖输入框 —— 否则用户打字打到一半，
   * 任何一次状态刷新都会把他输入的内容顶掉。
   */
  const applyNavStatus = useCallback((s: NavigateStatus) => {
    setNavStatus(s);
    setNavInput(s.upstream.baseUrl ?? '');
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        applyNavStatus(await getNavigateStatus());
      } catch (err) {
        setNavError(describeIpcError(err));
      }
    })();
  }, [applyNavStatus]);

  /** 三条写操作共用一套 忙/错/提示 处理 —— 它们的失败形态与成功反馈是同一种东西。 */
  const runNavAction = useCallback(
    async (
      run: () => Promise<NavigateStatus | GuestLoginResult>,
      notice: (s: NavigateStatus) => string,
    ) => {
      setNavError(null);
      setNavNotice(null);
      setNavBusy(true);
      try {
        const result = await run();
        // 三条写通道回的**就是写完后的状态**（少一次往返，也就少一个能读成旧值的窗口）；
        // 登录回的是"你是谁"（凭据不回渲染层），所以只有它要补读一次状态。
        const after: NavigateStatus = 'upstream' in result ? result : await getNavigateStatus();
        applyNavStatus(after);
        setNavNotice(notice(after));
      } catch (err) {
        setNavError(describeIpcError(err));
      } finally {
        setNavBusy(false);
      }
    },
    [applyNavStatus],
  );

  const handleSaveUpstream = useCallback(() => {
    // 空串 = 明确清空 → 退回脚本上游。这与"填了个错地址"是两件事，由 main 侧判定。
    const raw = navInput.trim() === '' ? null : navInput;
    return runNavAction(() => setNavigateUpstream(raw), () => '已保存上游地址');
  }, [navInput, runNavAction]);

  const handleLoginGuest = useCallback(
    () => runNavAction(loginNavigateGuest, (s) => `已获取体验账号（role=${s.login.role ?? '未知'}）`),
    [runNavAction],
  );

  const handleLogout = useCallback(() => runNavAction(logoutNavigate, (s) => s.login.note), [runNavAction]);

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
              title="上游与登录 · 配置通道 + guest 登录"
              action={
                <div className="flex gap-2">
                  <Button onClick={() => void handleSaveUpstream()} disabled={navBusy}>
                    <span data-testid="nav-save">保存地址</span>
                  </Button>
                  <Button onClick={() => void handleLoginGuest()} disabled={navBusy}>
                    <span data-testid="nav-login">获取体验账号</span>
                  </Button>
                  <Button onClick={() => void handleLogout()} disabled={navBusy || navStatus?.login.hasToken !== true}>
                    <span data-testid="nav-logout">登出</span>
                  </Button>
                </div>
              }
            >
              <p className="text-[12px] text-[#8a857c]">
                这是本壳**唯一**新增的 IPC 通道（配置通道只能由壳提供 —— 它要写 userData 目录）。
                凭据只落主进程（safeStorage 加密），响应类型里压根没有 token 字段，
                所以下面这块界面**拿不到**它。地址留空 = 退回脚本上游（离线可跑）。
              </p>

              <input
                value={navInput}
                onChange={(e) => setNavInput(e.target.value)}
                placeholder="http://127.0.0.1:3001（留空 = 脚本上游）"
                data-testid="nav-upstream-input"
                className="mt-2 w-full rounded border border-[#d9d5cb] bg-white px-2 py-1 font-mono text-[12px] text-[#33302b]"
              />

              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[#8a857c]">
                {/*
                  data-* 是给自检用的：断言"界面如实报上游"不该去 parse 中文文案。
                  （T12 的自检会对着它跑。）
                */}
                <span data-testid="navigate-upstream" data-kind={navStatus?.upstream.kind ?? 'unknown'}>
                  上游：
                  {navStatus === null
                    ? '（尚未读取）'
                    : navStatus.upstream.kind === 'navigate'
                      ? `navigate ${navStatus.upstream.baseUrl ?? ''}`
                      : '脚本（离线可跑，**不是**真上游）'}
                </span>
                <span
                  data-testid="navigate-login-state"
                  data-has-token={String(navStatus?.login.hasToken ?? false)}
                  data-role={navStatus?.login.role ?? ''}
                >
                  登录：
                  {navStatus === null
                    ? '（尚未读取）'
                    : navStatus.login.hasToken
                      ? `已持有凭据（role=${navStatus.login.role ?? '未知'}${
                          navStatus.login.expiresAt === null
                            ? ''
                            : ` · 到期 ${new Date(navStatus.login.expiresAt).toLocaleTimeString()}`
                        }）`
                      : '未登录'}
                </span>
              </div>

              {navStatus !== null && (
                <p className="mt-1 text-[11px] text-[#a09a90]">{navStatus.login.note}</p>
              )}

              {navNotice !== null && (
                <p className="mt-1 text-[12px] text-[#1f6b3a]" data-testid="navigate-notice">
                  {navNotice}
                </p>
              )}

              {/*
                错误**连同下一步一起**显示：503（服务端没配体验账号）与 429（限流）
                是两条动作完全不同的路，把它们都渲染成"登录失败，请重试"等于没说。
                code / detail 也落在 data-* 上，自检据此断言"两者确实能分开"。
                404 / 400 这类是**用户填错了地址**，更不该出现"重试"按钮。
              */}
              {navError !== null && (
                <pre
                  data-testid="navigate-error"
                  data-code={navError.code}
                  data-detail={navError.detail ?? ''}
                  className="mt-2 whitespace-pre-wrap rounded border border-[#e8c9c9] bg-[#fdf6f6] p-3 font-mono text-[11px] leading-relaxed text-[#a12626]"
                >
                  {navError.text}
                  {'\n'}下一步：{navNextStep(navError.code, navError.detail)}
                </pre>
              )}
            </Card>

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
              <pre
                data-testid="stream-text"
                data-len={streamText.length}
                className="mt-3 min-h-[88px] whitespace-pre-wrap rounded border border-[#e5e2da] bg-[#faf9f6] p-3 font-mono text-[12px] leading-relaxed text-[#33302b]"
              >
                {streamText || (runningRunId ? '等待首个 token…' : '(尚未发送)')}
              </pre>
              <div className="mt-2 flex items-center gap-4 text-[11px] text-[#8a857c]">
                <span data-testid="stream-stage" data-stage={streamStage}>
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

            {/*
              更新入口由**能力**决定，不是由平台决定 ——
              core 里没有一行 `if (platform === 'electron')`。
              Web 壳的 capabilities 里没有 update.auto，这块就自然不出现。
            */}
            {supportsAutoUpdate && (
              <Card
                title="自动更新 · 靠 update.auto 能力探测，不靠平台判断"
                action={
                  <div className="flex gap-2">
                    <Button onClick={() => void handleCheckUpdate()} disabled={updateBusy}>
                      <span data-testid="update-check">检查更新</span>
                    </Button>
                    <Button
                      onClick={() => void handleDownloadUpdate()}
                      disabled={updateBusy || update?.stage !== 'available'}
                    >
                      下载
                    </Button>
                    <Button
                      onClick={() => void handleInstallUpdate()}
                      disabled={updateBusy || update?.stage !== 'ready'}
                    >
                      重启并安装
                    </Button>
                  </div>
                }
              >
                <p className="text-[12px] text-[#8a857c]">
                  版本比较、该不该升、进度是否可信这三件事都在 core 里（纯逻辑，可断言）；
                  这里只把状态如实画出来。无签名 / 未打包环境下**必须**落到 error 或
                  UNSUPPORTED，不允许停在「检查中…」。
                </p>

                <div
                  data-testid="update-status"
                  data-stage={update?.stage ?? 'never'}
                  data-retryable={update?.stage === 'error' ? String(update.retryable) : ''}
                  data-percent={
                    update?.stage === 'downloading' ? String(update.percent) : ''
                  }
                  className="mt-3 rounded border border-[#e5e2da] bg-[#faf9f6] p-3"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={
                        'rounded-full px-2 py-0.5 text-[11px] font-medium ' +
                        (update?.stage === 'error'
                          ? 'bg-[#fbe4e4] text-[#a12626]'
                          : update?.stage === 'ready'
                            ? 'bg-[#e3f5e8] text-[#1f6b3a]'
                            : 'bg-[#f0eee8] text-[#7a756c]')
                      }
                    >
                      {update?.stage ?? '尚未检查'}
                    </span>
                    <span className="text-[13px] text-[#33302b]">{updateLine(update)}</span>
                  </div>

                  {update?.stage === 'downloading' && (
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-[#eae7e0]">
                      <div
                        className="h-full bg-[#1f6b3a] transition-[width] duration-200"
                        style={{ width: `${update.percent}%` }}
                      />
                    </div>
                  )}

                  {updateInfo !== null && (
                    <details className="mt-2 text-[11px] text-[#5c5750]">
                      <summary className="cursor-pointer text-[#8a857c]">
                        更新说明（{updateInfo.version}）
                      </summary>
                      <pre className="mt-1 whitespace-pre-wrap font-sans leading-relaxed">
                        {updateInfo.notes ?? '（这一版没有提供说明）'}
                      </pre>
                    </details>
                  )}

                  {update?.stage === 'error' && (
                    <p className="mt-2 text-[11px] text-[#8a857c]">
                      {update.retryable
                        ? '这类失败重试有意义（网络抖动）——可以过一会儿再点一次。'
                        : '这类失败重试一万次也一样（签名/配置问题）——已刻意不给「重试」入口。'}
                    </p>
                  )}
                </div>

                {/*
                  状态机已经在说这件事时（stage=error），就不再重复一遍抛错文本 ——
                  两条链路都会把失败讲出来，但 UI 只该说一次。
                  结构化错误码仍然完整存在于 invoke 的抛错里（自检断言的就是它），
                  只是不该同时挤在屏幕上。
                */}
                {updateError !== null && update?.stage !== 'error' && (
                  <pre className="mt-2 whitespace-pre-wrap rounded border border-[#e8c9c9] bg-[#fdf6f6] p-3 font-mono text-[11px] leading-relaxed text-[#a12626]">
                    {updateError}
                  </pre>
                )}
              </Card>
            )}
          </>
        )}

        {perf !== null && (
          <Card title="性能量化（M6-1）">
            <p className="text-[12px] text-[#8a857c]">
              冷启动从 main 模块加载算到首帧可交互；内存一项来自主进程、一项来自渲染进程；
              帧率是流式期间用 requestAnimationFrame 实测（0 表示还没跑过流式）。
              目标值定义在 contract 的 <code>PERF_TARGETS</code>，完整报告见 docs/perf.md。
            </p>
            <table className="mt-3 w-full text-[12px]" data-testid="perf-snapshot">
              <thead>
                <tr className="text-left text-[#8a857c]">
                  <th className="py-1 font-normal">指标</th>
                  <th className="py-1 font-normal">实测</th>
                  <th className="py-1 font-normal">目标</th>
                  <th className="py-1 font-normal">判定</th>
                </tr>
              </thead>
              <tbody className="text-[#33302b]">
                {perfRows(perf, usage?.ttftMs ?? null).map((row) => (
                  <tr key={row.metric} className="border-t border-[#efece5]">
                    <td className="py-1">{row.label}</td>
                    <td className="py-1 font-mono" data-metric={row.metric}>
                      {row.actual}
                    </td>
                    <td className="py-1 font-mono text-[#8a857c]">{row.target}</td>
                    <td className={row.ok ? 'py-1 text-[#1f6b3a]' : 'py-1 text-[#a12626]'}>
                      {row.ok ? '达标' : '未达标'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
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

/**
 * 把状态折成**一句人话**。
 *
 * switch 走判别联合并留 assertNever 兜底：契约里新增一个阶段而这里忘了画，
 * 编译期就报错，而不是在界面上静默漏掉一整个状态 ——
 * 「永远转圈」这类 bug 有一半就是这么来的。
 */
/**
 * 把快照折成表格行。
 *
 * 「未达标」**不是错误**，而是一条要如实展示的事实 —— 所以它是红字不是异常。
 * 面试场景里最没价值的是一张全绿的假表；有价值的是"这一项为什么没达标"。
 */
function perfRows(
  p: PerfSnapshot,
  ttftMs: number | null,
): { metric: string; label: string; actual: string; target: string; ok: boolean }[] {
  const rows: { metric: string; label: string; actual: string; target: string; ok: boolean }[] = [
    {
      metric: 'coldStartMs',
      label: '冷启动到首帧可交互',
      actual: p.coldStartMs === 0 ? '未测到' : `${p.coldStartMs} ms`,
      target: `< ${PERF_TARGETS.coldStartMs} ms`,
      ok: p.coldStartMs !== 0 && meetsTarget('coldStartMs', p.coldStartMs),
    },
    {
      metric: 'mainRssBytes',
      label: '主进程常驻内存',
      actual: formatBytes(p.mainRssBytes),
      target: `< ${formatBytes(PERF_TARGETS.mainRssBytes)}`,
      ok: meetsTarget('mainRssBytes', p.mainRssBytes),
    },
    {
      metric: 'rendererRssBytes',
      label: '渲染进程内存',
      actual: p.rendererRssBytes === 0 ? '未测到' : formatBytes(p.rendererRssBytes),
      target: `< ${formatBytes(PERF_TARGETS.rendererRssBytes)}`,
      ok: p.rendererRssBytes !== 0 && meetsTarget('rendererRssBytes', p.rendererRssBytes),
    },
    {
      metric: 'streamFps',
      label: '流式期间帧率',
      actual: p.streamFps === 0 ? '未测到' : `${p.streamFps} fps`,
      target: `≥ ${PERF_TARGETS.streamFps} fps`,
      ok: p.streamFps !== 0 && meetsTarget('streamFps', p.streamFps),
    },
  ];

  // 首 token 延迟不进 PerfSnapshot：它是一次 run 的属性（usage），不是进程的属性。
  // 但报告要的 6 项指标里有它，所以在这里并进来。
  if (ttftMs !== null) {
    rows.splice(3, 0, {
      metric: 'streamTtftMs',
      label: '流式首 token 延迟',
      actual: `${ttftMs} ms`,
      target: `< ${PERF_TARGETS.streamTtftMs} ms`,
      ok: meetsTarget('streamTtftMs', ttftMs),
    });
  }
  return rows;
}

/**
 * 失败的**下一步**。
 *
 * 这张表就是"为什么 503 与 429 必须能区分"的答案：两条路的下一步完全不同 ——
 * 一个要去找部署方配置，一个只要等一会儿。压成一句"登录失败，请重试"
 * 会把前者变成一个永远重试不成功的按钮。
 *
 * 分支用 `NAVIGATE_AUTH_DETAIL` 的常量而不是字面量：那是唯一事实源，
 * 写错在编译期就会报错。
 */
function navNextStep(code: string, detail: string | undefined): string {
  switch (detail) {
    case NAVIGATE_AUTH_DETAIL.guestDisabled:
      return '重试不会解决 —— 要让部署方配一个 role=guest 的账号。';
    case NAVIGATE_AUTH_DETAIL.rateLimited:
      return '等一会儿再点一次（上游已给出建议秒数）。';
    case NAVIGATE_AUTH_DETAIL.authRejected:
      return '这份凭据已被吊销 —— 重新获取体验账号。';
    default:
      break;
  }
  if (code === 'BAD_REQUEST') return '改地址，不要重试（重试一万次还是同一个错地址）。';
  if (code === 'UNSUPPORTED') return '这条路在当前部署上不存在 —— 需要部署方开启。';
  if (code === 'UPSTREAM') return '上游不可达 —— 检查地址与网络，稍后可重试。';
  return '看上面的原文。';
}

function updateLine(s: UpdateStatus | null): string {
  if (s === null) return '不知道有没有新版本 —— 还没查过。';
  switch (s.stage) {
    case 'idle':
      return '已是最新（查过了，没有可装的新版本）。';
    case 'checking':
      return '正在问更新源…';
    case 'available':
      return `发现新版本 ${s.info.version}，可以下载。`;
    case 'downloading':
      return `正在下载 ${s.info.version} · ${s.percent}%`;
    case 'ready':
      return `${s.info.version} 已下载完成，重启后安装。`;
    case 'error':
      return s.message;
    default:
      return assertNever(s);
  }
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
