/**
 * 页内主进程的 29 条 invoke 通道 —— 桌面壳 `handlers.ts` 的那一半。
 *
 * 写法上有一个硬约束：`Handlers` 是映射类型，**少实现一条通道就编译不过**。
 * 桌面壳靠 `registeredChannels()` 在运行期查"注册齐了没有"，这里把它提前到编译期。
 *
 * 分工与桌面壳一致：
 *   · 规则归 core（WorkspaceStore / PathGuard / 外链校验 / 上传体检）
 *   · 平台能力归本壳（OPFS、XHR、window.open、navigator）
 *   · 这里只做"翻译"：把领域结果翻成契约类型，把领域拒绝翻成 `[CODE]` 前缀的错误
 */

import { IPC, PATH_DENY_MESSAGES } from '@crossdeck/contract';
import type {
  BridgeApi,
  DirEntry,
  FileStat,
  GuestLoginResult,
  IpcInvokeMap,
  InvokeArgs,
  InvokeChannel,
  LoginChallengeNeeded,
  LoginCodeResult,
  NavigateStatus,
  PathGuard,
  PerfSnapshot,
  PushChannel,
  PushPayload,
  SessionMeta,
  SystemInfo,
  UploadedDocument,
  Workspace,
} from '@crossdeck/contract';
import {
  DEFAULT_UPLOAD_POLICY,
  checkOpenUrl,
  checkUploadCandidate,
  describeOpenUrlReason,
  hostOfUrl,
  resolveInWorkspace,
} from '@crossdeck/core';
import type { WorkspaceStore } from '@crossdeck/core';
import { uploadDocumentViaXhr } from '../navigate/upload.js';
import type { WebShell } from '../ports.js';
import type { AgentHost } from './agent.js';
import { errorText, fail } from './errors.js';
import type { LoginBody, NavigateHost } from './navigate.js';
import { notePerfSample, readPerfSnapshot } from './perf.js';
import type { PushHub } from './push.js';
import type { SessionScope } from './sessions.js';

export interface BridgeContext {
  readonly shell: WebShell;
  readonly workspaces: WorkspaceStore;
  readonly guard: PathGuard;
  readonly scope: SessionScope;
  readonly agent: AgentHost;
  readonly navigate: NavigateHost;
  readonly push: PushHub;
  /** 版本号由构建期注入（见 vite.config.ts 的 `define`）。 */
  readonly appVersion: string;
}

/** 每条通道一个实现 —— 缺一条编译期就红。 */
type Handlers = {
  [K in InvokeChannel]: (req: IpcInvokeMap[K]['req']) => Promise<IpcInvokeMap[K]['res']>;
};

export function createBridge(ctx: BridgeContext): BridgeApi {
  /**
   * `{workspaceId, path}` → 已授权的绝对路径。
   *
   * 拼接 + 限定工作区 + 逃逸判定全在 core（与桌面壳同一份 `resolveInWorkspace`）；
   * 这里只把领域结果翻成错误码。
   */
  async function resolveOrThrow(workspaceId: string, relPath: string): Promise<string> {
    const resolved = await resolveInWorkspace(ctx.workspaces, ctx.guard, workspaceId, relPath);
    if (!resolved.ok) {
      fail('SCOPE_DENIED', PATH_DENY_MESSAGES[resolved.reason], resolved.reason);
    }
    return resolved.absolute;
  }

  /** 浏览器抛的是 DOMException / 带 `ENOENT:` 前缀的 Error；不翻译就全落成 INTERNAL。 */
  async function withFsErrors<T>(what: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      const text = errorText(err);
      if (text.startsWith('ENOENT')) fail('NOT_FOUND', `${what}失败：文件不存在`);
      if (text.startsWith('EACCES')) fail('FORBIDDEN', `${what}失败：没有权限`);
      fail('INTERNAL', `${what}失败：${text}`);
    }
  }

  /** 登录 / 登出 / 换上游之后对齐会话库（每账号一个库）。 */
  async function adoptAccount(): Promise<void> {
    await ctx.scope.switchTo(await ctx.navigate.refreshAccount());
  }

  const handlers: Handlers = {
    // ── 系统 ──────────────────────────────────────────────
    async [IPC.systemInfo](): Promise<SystemInfo> {
      return {
        platform: 'web',
        appVersion: ctx.appVersion,
        osVersion: navigator.userAgent,
        locale: navigator.language,
        capabilities: [...ctx.shell.capabilities],
      };
    },

    /**
     * 打开窗口。
     *
     * 浏览器没有真窗口（`window.multi` 不在能力表里，UI 本就不显示这个入口）；
     * 真被调到时开一个标签页 —— 这是这一侧能做到的最接近的东西，
     * 而不是返回一个不存在的 windowId 假装成功。
     */
    async [IPC.windowOpen](req): Promise<{ windowId: number }> {
      const opened = window.open(`${location.pathname}#${req.kind}`, '_blank');
      if (opened === null) fail('UNSUPPORTED', '浏览器拦住了新窗口（不是用户手势触发）');
      return { windowId: 0 };
    },

    // ── 会话 ──────────────────────────────────────────────
    async [IPC.sessionList](): Promise<SessionMeta[]> {
      return (await ctx.scope.current()).listSessions();
    },

    async [IPC.sessionCreate](req): Promise<SessionMeta> {
      const created = await (await ctx.scope.current()).createSession(req.title);
      ctx.push.emit(IPC.sessionChanged, { sessionId: created.id, reason: 'created' });
      return created;
    },

    async [IPC.sessionDelete](req): Promise<void> {
      const deleted = await (await ctx.scope.current()).deleteSession(req.sessionId);
      // 删不掉和删成功是两件事：前端要能区分（前者提示刷新列表）
      if (!deleted) fail('NOT_FOUND', `会话不存在：${req.sessionId}`);
      ctx.push.emit(IPC.sessionChanged, { sessionId: req.sessionId, reason: 'deleted' });
    },

    async [IPC.sessionMessages](req) {
      return (await ctx.scope.current()).listMessages(req.sessionId);
    },

    // ── 动作卡片：外链 ────────────────────────────────────
    /**
     * 外链绝不直接丢给 `window.open` —— 那等于把「打开任意网址」的能力交给上游。
     * 协议与 host 白名单走 core 的 `checkOpenUrl`，与桌面壳同一份判据。
     */
    async [IPC.actionOpen](req): Promise<void> {
      const base = ctx.navigate.baseUrl();
      const upstreamHost = base === null ? null : hostOfUrl(base === '' ? location.origin : base);
      const allowed = upstreamHost === null ? [location.hostname] : [location.hostname, upstreamHost];

      const decision = checkOpenUrl(req.url, allowed);
      if (!decision.ok) fail('FORBIDDEN', describeOpenUrlReason(decision.reason));

      const opened = window.open(decision.url, '_blank', 'noopener');
      if (opened === null) fail('UNSUPPORTED', '浏览器拦住了新窗口（外链需要在点击的同一拍打开）');
    },

    // ── Agent 运行 ────────────────────────────────────────
    async [IPC.agentRun](req): Promise<{ runId: string }> {
      return ctx.agent.run(req.sessionId, req.input);
    },

    /**
     * 中断。
     *
     * run 已经结束也算成功 —— 诉求是"让它别跑了"，目标已达成。
     * 与 `agent:control` 有意不同：那边要求"改变状态"，静默成功会让 UI 与事实不一致。
     */
    async [IPC.agentAbort](req): Promise<void> {
      ctx.agent.abort(req.runId);
    },

    async [IPC.agentControl](req): Promise<void> {
      if (!ctx.agent.control(req.runId, req.type)) {
        fail('NOT_FOUND', `run 不存在或已结束：${req.runId}`);
      }
    },

    // ── 工作区 ────────────────────────────────────────────
    async [IPC.workspaceList](): Promise<Workspace[]> {
      return ctx.workspaces.list();
    },

    /**
     * 授权目录。
     *
     * 有 File System Access 就弹系统目录选择器；没有（或用户取消）就退到 OPFS 的
     * 演示目录 —— 后者是自检唯一能走的那条路（headless 里没有用户手势）。
     * 两条路都经过同一个 `WorkspaceStore.grant`，授权语义不打折。
     */
    async [IPC.workspaceGrant](): Promise<Workspace | null> {
      const picked = await ctx.shell.ports.dialog.pickDirectory();
      const root = picked ?? (ctx.shell.capabilities.has('fs.scope') ? '/ws/demo' : null);
      if (root === null) {
        fail('UNSUPPORTED', '这个浏览器既没有目录选择器也没有 OPFS —— 文件访问不可用');
      }

      const granted = ctx.workspaces.grant({ root, mode: 'readwrite' });
      if (!granted.ok) fail('BAD_REQUEST', `授权失败：${granted.reason}`);
      return granted.workspace;
    },

    async [IPC.workspaceRevoke](req): Promise<void> {
      ctx.workspaces.revoke(req.workspaceId);
    },

    // ── 文件系统（每条都必须先过 scope 校验）────────────────
    async [IPC.fsListDir](req): Promise<DirEntry[]> {
      const abs = await resolveOrThrow(req.workspaceId, req.path);
      return withFsErrors('列目录', () => ctx.shell.fs.listDir(abs));
    },

    async [IPC.fsReadFile](req): Promise<{ text: string; truncated: boolean }> {
      const abs = await resolveOrThrow(req.workspaceId, req.path);
      return withFsErrors('读文件', () => ctx.shell.fs.readFile(abs));
    },

    async [IPC.fsWriteFile](req): Promise<void> {
      const abs = await resolveOrThrow(req.workspaceId, req.path);
      await withFsErrors('写文件', () => ctx.shell.fs.writeFile(abs, req.data));
    },

    async [IPC.fsStat](req): Promise<FileStat> {
      const abs = await resolveOrThrow(req.workspaceId, req.path);
      return withFsErrors('取文件信息', () => ctx.shell.fs.stat(abs));
    },

    /**
     * 上传文档。
     *
     * 三道闸门与桌面壳同序：scope 校验 → 本地体检 → 上游。
     * 体检必须在本地说"不行"，因为服务端既没有体积限制也没有类型限制 ——
     * 让它发出去再回 413 是白烧用户的流量。
     */
    async [IPC.documentUpload](req): Promise<UploadedDocument> {
      const abs = await resolveOrThrow(req.workspaceId, req.path);
      const stat = await withFsErrors('读文件信息', () => ctx.shell.fs.stat(abs));
      if (stat.kind !== 'file') fail('BAD_REQUEST', '只能上传文件，不能上传目录');

      const fileName = req.path.split('/').pop() ?? req.path;
      const policyHit = checkUploadCandidate({ fileName, sizeBytes: stat.size }, DEFAULT_UPLOAD_POLICY);
      if (!policyHit.ok) fail('BAD_REQUEST', policyHit.message, policyHit.reason);

      const base = ctx.navigate.baseUrl();
      if (base === null) fail('UNSUPPORTED', '当前是离线脚本上游，没有上传接口');

      const file = await withFsErrors('读文件内容', () => ctx.shell.fs.readBlob(abs));
      const outcome = await uploadDocumentViaXhr({
        file,
        baseUrl: base,
        onProgress: (progress) => ctx.push.emit(IPC.documentUploadProgress, progress),
      }).promise;

      if (outcome.ok) return outcome.document;

      // 405/403 是"这个身份不行"，与"网络抖了"给的下一步动作不同
      if (outcome.stage === 'rejected-local') fail('BAD_REQUEST', outcome.message);
      if (outcome.stage === 'http') fail('FORBIDDEN', outcome.message);
      fail('UPSTREAM', outcome.message);
    },

    // ── 自动更新 ──────────────────────────────────────────
    /** 浏览器里"刷新即最新"：没有可装的新版本是**事实**，不是降级。 */
    async [IPC.updateCheck]() {
      return null;
    },

    /** 没有更新包可下。静默成功会让 UI 以为"已经开始下载了"，然后等一个永不到来的进度。 */
    async [IPC.updateDownload](): Promise<void> {
      fail('UNSUPPORTED', '浏览器里没有更新包：刷新页面就是最新版本（update.auto 不在能力表里）');
    },

    async [IPC.updateInstall](): Promise<void> {
      fail('UNSUPPORTED', '浏览器里没有"重启并安装"这回事（update.auto 不在能力表里）');
    },

    // ── navigate：配置 + 登录 ─────────────────────────────
    async [IPC.navigateStatus](): Promise<NavigateStatus> {
      return ctx.navigate.status();
    },

    async [IPC.navigateSetUpstream](req): Promise<NavigateStatus> {
      const status = ctx.navigate.setUpstream(req.upstreamUrl);
      await adoptAccount();
      return status;
    },

    async [IPC.navigateLoginGuest](): Promise<GuestLoginResult> {
      const result = await ctx.navigate.loginGuest();
      await adoptAccount();
      return result;
    },

    async [IPC.navigateLogin](req: object): Promise<GuestLoginResult> {
      const result = await ctx.navigate.login(req as LoginBody);
      await adoptAccount();
      return result;
    },

    async [IPC.navigateLoginCode](): Promise<LoginCodeResult> {
      return ctx.navigate.loginCode();
    },

    async [IPC.navigateChallengeNeeded](req): Promise<LoginChallengeNeeded> {
      return ctx.navigate.challengeNeeded(req.username ?? '');
    },

    async [IPC.navigateLogout](): Promise<NavigateStatus> {
      const status = await ctx.navigate.logout();
      await adoptAccount();
      return status;
    },

    // ── 性能采样 ──────────────────────────────────────────
    /** 一次调用两件事：记账渲染层带上来的采样点，再回当前快照。 */
    async [IPC.perfSample](req): Promise<PerfSnapshot> {
      notePerfSample(req);
      return readPerfSnapshot();
    },
  };

  return {
    async invoke<K extends InvokeChannel>(
      channel: K,
      ...args: InvokeArgs<K>
    ): Promise<IpcInvokeMap[K]['res']> {
      const handler = handlers[channel] as unknown as (req: unknown) => Promise<unknown>;
      return (await handler(args[0])) as IpcInvokeMap[K]['res'];
    },

    on<K extends PushChannel>(channel: K, handler: (payload: PushPayload<K>) => void): () => void {
      return ctx.push.on(channel, handler);
    },
  };
}
