/** 端口装配 —— 8+1 个端口的组装点（依赖图单向，无环）。 */
import type { common } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import type { webview } from '@kit.ArkWeb';
import { IPC } from '../shared/contract/index';
import type { AgentStreamEvent, Capability, SessionChange, UploadProgress } from '../shared/contract/index';
import type { AgentDeps } from '../shared/core/index';
import { hostOfUrl } from '../shared/core/index';
import { detectCapabilities } from '../shared/ports';
import { HostBridge } from './HostBridge';
import { NavigatePort } from './ports/NavigatePort';
import { SessionPort } from './ports/SessionPort';
import { AgentPort } from './ports/AgentPort';
import type { RunRepo } from './ports/AgentPort';
import { WorkspacePort } from './ports/WorkspacePort';
import { DocumentPort } from './ports/DocumentPort';
import { ShellPort } from './ports/ShellPort';
import { ActionPort, SelfcheckPort, SystemPort } from './ports/MiniPorts';

const DOMAIN: number = 0x3200;
const TAG: string = 'HostBridge';

/**
 * WindowStage 只有 UIAbility 拿得到，端口却活在页面里 —— 由 EntryAbility 在
 * `onWindowStageCreate` 先记一笔，页面后建端口时来取（早于任何页面加载）。
 */
let stageRef: window.WindowStage | null = null;

export function rememberWindowStage(stage: window.WindowStage): void {
  stageRef = stage;
}

/** 能力表只探一次：`deviceInfo.deviceType` 在一次运行里不会变。 */
let capsCache: Capability[] | null = null;

function capabilities(): Capability[] {
  if (capsCache === null) capsCache = detectCapabilities();
  return capsCache;
}

export class AppHost {
  readonly bridge: HostBridge;
  readonly navigate: NavigatePort;
  readonly sessions: SessionPort;
  readonly workspaces: WorkspacePort;
  private readonly selfcheck: SelfcheckPort;
  private readonly deps: AgentDeps;
  /** 每个窗口一个出口；推送广播到全部（只推一个窗口 = 另一个窗口静默丢帧）。 */
  private readonly sinks: ((frameJson: string) => void)[] = [];

  constructor(context: common.UIAbilityContext) {
    this.deps = {
      now: (): number => Date.now(),
      every: (intervalMs: number, fn: () => void): (() => void) => {
        const timer: number = setInterval(fn, intervalMs);
        return (): void => {
          clearInterval(timer);
        };
      },
      newId: (prefix: string): string => `${prefix}_${Math.floor(Math.random() * 1000000000).toString(36)}`,
    };

    // 上游来自 EntryAbility 注入 AppStorage 的 `--ps upstreamUrl`（缺失 = 脚本上游）。
    const upstreamParam: string = AppStorage.get<string>('upstreamUrl') ?? '';
    this.navigate = new NavigatePort(upstreamParam, (): void => {});

    this.workspaces = new WorkspacePort(context);

    this.bridge = new HostBridge({ 
      sink: (frameJson: string): void => {
        for (const sink of this.sinks) sink(frameJson);
      }
    });

    this.sessions = new SessionPort(context, this.deps, (change: SessionChange): void => {
      this.bridge.push(IPC.sessionChanged, change);
    });

    const agent = new AgentPort({
      deps: this.deps,
      baseUrl: (): string | null => this.navigate.baseUrl(),
      getToken: (): string | null => this.navigate.getToken(),
      repo: (): Promise<RunRepo> => this.sessions.current(),
      pushStream: (event: AgentStreamEvent): void => {
        this.bridge.push(IPC.agentStream, event);
      },
      pushSessionChanged: (change: SessionChange): void => {
        this.bridge.push(IPC.sessionChanged, change);
      },
    });

    const shell = new ShellPort((): window.WindowStage | null => stageRef, (): Capability[] => capabilities());

    this.bridge.registerPort('system', new SystemPort());
    this.bridge.registerPort('session', this.sessions);
    this.bridge.registerPort('agent', agent);
    this.bridge.registerPort('workspace', this.workspaces);
    this.bridge.registerPort('document', new DocumentPort({
      baseUrl: (): string | null => this.navigate.baseUrl(),
      getToken: (): string | null => this.navigate.getToken(),
      store: this.workspaces.store,
      guard: this.workspaces.guard,
      pushProgress: (progress: UploadProgress): void => {
        this.bridge.push(IPC.documentUploadProgress, progress);
      },
    }));
    this.bridge.registerPort('navigate', this.navigate);
    this.bridge.registerPort('action', new ActionPort(context, (): string | null => {
      const base = this.navigate.baseUrl();
      return base === null ? null : hostOfUrl(base);
    }));
    this.bridge.registerPort('shell', shell);
    this.selfcheck = new SelfcheckPort(context, (): string | null => this.navigate.baseUrl());
    this.bridge.registerPort('selfcheck', this.selfcheck);
  }

  /** WebShell 在 onControllerAttached 时接上：proxy 先注册，端口在 onPageEnd 投递。 */
  attachWebview(controller: webview.WebviewController): void {
    controller.registerJavaScriptProxy(this, 'crossdeckHost', ['report'], []);
  }

  /** WebShell 在 onPageEnd 时调用：端口只投递一次（页面内联脚本已注册好监听）。 */
  deliverPort(controller: webview.WebviewController, origin: string): void {
    const ports: webview.WebMessagePort[] = controller.createWebMessagePorts();
    const first: webview.WebMessagePort | undefined = ports[0];
    const second: webview.WebMessagePort | undefined = ports[1];
    if (first === undefined || second === undefined) {
      hilog.error(DOMAIN, TAG, 'createWebMessagePorts 返回不足两个端口');
      return;
    }
    second.onMessageEvent((result: webview.WebMessage) => {
      this.onPageMessage(String(result));
    });
    this.sinks.push((frameJson: string): void => {
      second.postMessageEvent(frameJson);
    });
    controller.postMessage('__crossdeck__', [first], origin);
    hilog.info(DOMAIN, TAG, '端口已投递（窗口数 %{public}d）', this.sinks.length);

    // 自检形态下顺带跑一遍仓储一致性：22 条用例，独立库，不挡页面。
    const selfcheck: string = AppStorage.get<string>('selfcheck') ?? '';
    if (selfcheck.length > 0) this.selfcheck.startRepoConformance();
  }

  /** 页面 → 宿主的一条消息。同步异常必须就地拦下：抛出 ArkWeb 回调 = 进程直接退出。 */
  onPageMessage(raw: string): void {
    try {
      this.bridge.onMessage(raw);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      hilog.error(DOMAIN, TAG, 'onMessage 同步异常：%{public}s | 堆栈 %{public}s | 帧 %{public}s',
        err.message, err.stack ?? '无', raw.slice(0, 120));
    }
  }

  /** proxy 的同步上报（页面自检用）；invoke 不走 proxy。 */  report(json: string): void {
    // hilog 单条有长度上限：截断会让「结论缺失」看起来像「探针没跑」。
    // 分片带序号，设备侧按序号拼回原文再判 JSON。
    const CHUNK: number = 700;
    const total: number = Math.ceil(json.length / CHUNK);
    for (let i = 0; i < json.length; i += CHUNK) {
      hilog.info(DOMAIN, TAG, '[SELFCHECKPAGE] %{public}d/%{public}d %{public}s',
        i / CHUNK + 1, total, json.slice(i, i + CHUNK));
    }
  }
}

/** 页面与 ability 共用同一个装配点：端口持有 RDB 连接，重复构造会开两份库。 */
export class AppHostHolder {
  private static host: AppHost | null = null;

  static shared(context: common.UIAbilityContext): AppHost {
    if (AppHostHolder.host === null) AppHostHolder.host = new AppHost(context);
    return AppHostHolder.host;
  }
}
