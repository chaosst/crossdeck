/**
 * 鸿蒙壳的 29 条 invoke 通道 —— 与 `shell-web/src/host/bridge.ts` 同构的**通道层**。
 *
 * 「同构」指 `Handlers` 映射的写法与错误信封的翻译方式 —— **不是** BridgeContext 的字段：
 * Web 壳的 JS 自己就是主进程（领域对象活在页面里），鸿蒙按 B 案分工
 * （业务编排归 JS、系统调用归 ArkTS），领域对象全在端口里 ——
 * 所以这里只有 `{ rpc, appVersion }`，Web 壳那串 SessionScope/AgentHost/NavigateHost
 * 的对应物是 ArkTS 的 session/agent/navigate 端口。
 *
 * 29 个 handler 归三种形态：
 *   ① 纯转发（大多数）            —— call(port, method, args)
 *   ② 本地短路（不发 RPC）         —— 鸿蒙永远如此的能力缺口，如实答
 *   ③ 带编排的少数派              —— 编排（换库时序、能力缺口的语义）归 JS
 */

import { IPC } from '@crossdeck/contract';
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
  PerfSnapshot,
  PushChannel,
  PushPayload,
  SessionMeta,
  SystemInfo,
  UploadedDocument,
  Workspace,
} from '@crossdeck/contract';
import type { PortCaller } from './rpc';
import { fail } from './errors';

export interface BridgeContext {
  readonly rpc: PortCaller;
  /** 版本号由构建期注入（见 vite.config.ts 的 `define`）。 */
  readonly appVersion: string;
}

/** 每条通道一个实现 —— 缺一条编译期就红。 */
type Handlers = {
  [K in InvokeChannel]: (req: IpcInvokeMap[K]['req']) => Promise<IpcInvokeMap[K]['res']>;
};

export function createBridge(ctx: BridgeContext): BridgeApi {
  /**
   * 登录 / 登出 / 换上游之后对齐会话库（每账号一个 RDB 库文件）。
   *
   * 这就是 Web 壳 `SessionScope.switchTo` 的鸿蒙形态：**不是持有仓储的类，
   * 而是 handler 里的时序追加** —— 仓储实例只有 ArkTS 能建（RDB），
   * "什么时候换"是编排（归 JS），"换库"本身是系统调用（归 session 端口）。
   */
  async function adoptAccount(username: string | null): Promise<void> {
    await ctx.rpc.call('session', 'switch', { accountKey: username ?? 'local' });
  }

  /** 登录类编排的公共尾巴：拿账号名 → 换库。账号名 best-effort，拿不到落 local。 */
  async function adoptAfterLogin(result: GuestLoginResult): Promise<GuestLoginResult> {
    const me = await ctx.rpc.call<{ username: string | null }>('navigate', 'currentAccount', null);
    await adoptAccount(me.username);
    return result;
  }

  const handlers: Handlers = {
    // ── 系统 ──────────────────────────────────────────────
    async [IPC.systemInfo](): Promise<SystemInfo> {
      return ctx.rpc.call('system', 'info', null);
    },

    /**
     * 新窗口。2in1/tablet 才有能力开子窗口；手机形态端口直接回 UNSUPPORTED，
     * UI 本就按能力表不渲染这个入口 —— 与三端同一张能力表说话。
     */
    async [IPC.windowOpen](req): Promise<{ windowId: number }> {
      return ctx.rpc.call('shell', 'windowOpen', req);
    },

    // ── 会话 ──────────────────────────────────────────────
    // created/deleted 的 session:changed 由 session 端口在 ArkTS 侧推（数据与推送同源，不重不漏）。
    async [IPC.sessionList](): Promise<SessionMeta[]> {
      return ctx.rpc.call('session', 'list', null);
    },

    async [IPC.sessionCreate](req): Promise<SessionMeta> {
      return ctx.rpc.call('session', 'create', req);
    },

    async [IPC.sessionDelete](req): Promise<void> {
      return ctx.rpc.call('session', 'remove', req);
    },

    async [IPC.sessionMessages](req) {
      return ctx.rpc.call('session', 'messages', req);
    },

    // ── 动作卡片：外链 ────────────────────────────────────
    // 协议与 host 白名单（checkOpenUrl）在 action 端口 —— 上游 host 只有 ArkTS 知道。
    async [IPC.actionOpen](req): Promise<void> {
      return ctx.rpc.call('action', 'open', req);
    },

    // ── Agent 运行 ────────────────────────────────────────
    async [IPC.agentRun](req): Promise<{ runId: string }> {
      return ctx.rpc.call('agent', 'run', req);
    },

    // run 已经结束也算成功 —— 诉求是"让它别跑了"，目标已达成。
    async [IPC.agentAbort](req): Promise<void> {
      return ctx.rpc.call('agent', 'abort', req);
    },

    // 与 abort 有意不同：那边要求"改变状态"，run 不存在必须回 NOT_FOUND。
    async [IPC.agentControl](req): Promise<void> {
      return ctx.rpc.call('agent', 'control', req);
    },

    // ── 工作区 ────────────────────────────────────────────
    // PathGuard + @ohos.file.fs 全在 workspace 端口（scope 算法归 core、系统调用归 ArkTS）。
    async [IPC.workspaceList](): Promise<Workspace[]> {
      return ctx.rpc.call('workspace', 'list', null);
    },

    async [IPC.workspaceGrant](): Promise<Workspace | null> {
      return ctx.rpc.call('workspace', 'grant', null);
    },

    async [IPC.workspaceRevoke](req): Promise<void> {
      return ctx.rpc.call('workspace', 'revoke', req);
    },

    // ── 文件系统（每条都先在端口里过 scope 校验）──────────
    async [IPC.fsListDir](req): Promise<DirEntry[]> {
      return ctx.rpc.call('workspace', 'listDir', req);
    },

    async [IPC.fsReadFile](req): Promise<{ text: string; truncated: boolean }> {
      return ctx.rpc.call('workspace', 'readFile', req);
    },

    async [IPC.fsWriteFile](req): Promise<void> {
      return ctx.rpc.call('workspace', 'writeFile', req);
    },

    async [IPC.fsStat](req): Promise<FileStat> {
      return ctx.rpc.call('workspace', 'stat', req);
    },

    // ── 上传 ──────────────────────────────────────────────
    async [IPC.documentUpload](req): Promise<UploadedDocument> {
      return ctx.rpc.call('document', 'upload', req);
    },

    // ── 自动更新 ──────────────────────────────────────────
    /** 鸿蒙更新走 AppGallery：没有可装的新版本是**事实**，不是降级。 */
    async [IPC.updateCheck](): Promise<null> {
      return null;
    },

    /** 静默成功会让 UI 以为"已经开始下载了"，然后等一个永不到来的进度。 */
    async [IPC.updateDownload](): Promise<void> {
      fail('UNSUPPORTED', '鸿蒙没有应用内自更新：更新走应用市场（update.auto 不在能力表里）');
    },

    async [IPC.updateInstall](): Promise<void> {
      fail('UNSUPPORTED', '鸿蒙没有"重启并安装"这回事（update.auto 不在能力表里）');
    },

    // ── navigate：配置 + 登录 ─────────────────────────────
    async [IPC.navigateStatus](): Promise<NavigateStatus> {
      return ctx.rpc.call('navigate', 'status', null);
    },

    /** 换上游 = 旧凭据作废：清 token（端口里做）→ 会话库回到 local。 */
    async [IPC.navigateSetUpstream](req): Promise<NavigateStatus> {
      const status = await ctx.rpc.call<NavigateStatus>('navigate', 'setUpstream', req);
      await adoptAccount(null);
      return status;
    },

    async [IPC.navigateLoginGuest](): Promise<GuestLoginResult> {
      const result = await ctx.rpc.call<GuestLoginResult>('navigate', 'loginGuest', null);
      return adoptAfterLogin(result);
    },

    async [IPC.navigateLogin](req): Promise<GuestLoginResult> {
      const result = await ctx.rpc.call<GuestLoginResult>('navigate', 'login', req);
      return adoptAfterLogin(result);
    },

    async [IPC.navigateLoginCode](): Promise<LoginCodeResult> {
      return ctx.rpc.call('navigate', 'loginCode', null);
    },

    async [IPC.navigateChallengeNeeded](req): Promise<LoginChallengeNeeded> {
      return ctx.rpc.call('navigate', 'challengeNeeded', req);
    },

    /** 登出后库也回到 local —— 与登录对称，"这台机器上不再带这个身份"成立到底。 */
    async [IPC.navigateLogout](): Promise<NavigateStatus> {
      const status = await ctx.rpc.call<NavigateStatus>('navigate', 'logout', null);
      await adoptAccount(null);
      return status;
    },

    // ── 性能采样 ──────────────────────────────────────────
    // 冷启动起点（模块加载时刻）在端口里；firstPaint/streamFps 由渲染层带上、端口汇合。
    async [IPC.perfSample](req): Promise<PerfSnapshot> {
      return ctx.rpc.call('system', 'perfSample', req);
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
      return ctx.rpc.on(channel, handler as (payload: unknown) => void);
    },
  };
}
