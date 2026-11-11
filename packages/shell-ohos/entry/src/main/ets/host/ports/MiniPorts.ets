/** 三个小端口：system（info/perf）、action（外链）、selfcheck（fixture 通道 + 仓储一致性，仅自检用）。 */
import { bundleManager } from '@kit.AbilityKit';
import { deviceInfo } from '@kit.BasicServicesKit';
import { i18n } from '@kit.LocalizationKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { formatIpcError } from '../../shared/contract/index';
import type { IpcErrorCode, PerfSnapshot, SystemInfo } from '../../shared/contract/index';
import type { Capability } from '../../shared/contract/index';
import { detectCapabilities } from '../../shared/ports';
import type { ConformanceResult, OpenUrlReason } from '../../shared/core/index';
import { checkOpenUrl, describeOpenUrlReason } from '../../shared/core/index';
import { runRepoConformance } from '../../session/repoHarness';
import type { common } from '@kit.AbilityKit';
import type { OhosPort } from '../HostBridge';
import { httpRequestText, HttpResult } from '../httpUtil';
import { http } from '@kit.NetworkKit';

const BOOT_AT: number = Date.now();
const DOMAIN: number = 0x3200;
const TAG: string = 'Selfcheck';

// ── system ────────────────────────────────────────────────
class PerfReq {
  firstPaint: boolean = false;
  streamFps: number = 0;
}

/**
 * 当前应用信息相关的接口类
 * type: info / perfSample
 */
export class SystemPort implements OhosPort {
  private firstPaintAt: number = 0;

  handle(method: string, argsJson: string): Promise<string | null> {
    if (method === 'info') {
      const info: SystemInfo = {
        platform: 'ohos',
        appVersion: bundleVersion(),
        osVersion: deviceInfo.osFullName,
        locale: i18n.System.getSystemLanguage(),
        capabilities: detectCapabilities(),
      };
      return Promise.resolve(JSON.stringify(info));
    }
    if (method === 'perfSample') {
      const req = JSON.parse(argsJson) as PerfReq;
      if (req.firstPaint === true && this.firstPaintAt === 0) this.firstPaintAt = Date.now();
      const snapshot: PerfSnapshot = {
        coldStartMs: this.firstPaintAt === 0 ? Date.now() - BOOT_AT : this.firstPaintAt - BOOT_AT,
        mainRssBytes: 0,
        rendererRssBytes: 0,
        streamFps: req.streamFps ?? 0,
      };
      return Promise.resolve(JSON.stringify(snapshot));
    }
    return Promise.reject(new Error(formatIpcError('NOT_FOUND' as IpcErrorCode, `system 端口没有方法 ${method}`, 'METHOD')));
  }
}

function bundleVersion(): string {
  try {
    const info = bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT);
    return info.versionName;
  } catch (e) {
    return 'unknown';
  }
}

// ── action ────────────────────────────────────────────────
class OpenReq {
  url: string = '';
}

/** 联合 → 扁平视图。`.ets` 既不支持 `in` 也不按布尔字面量收窄（P3 实测）。 */
interface OpenUrlView {
  readonly ok: boolean;
  readonly url: string;
  readonly reason: OpenUrlReason;
}

export class ActionPort implements OhosPort {
  private readonly context: common.UIAbilityContext;
  private readonly upstreamHost: () => string | null;

  constructor(context: common.UIAbilityContext, upstreamHost: () => string | null) {
    this.context = context;
    this.upstreamHost = upstreamHost;
  }

  handle(method: string, argsJson: string): Promise<string | null> {
    if (method !== 'open') {
      return Promise.reject(new Error(formatIpcError('NOT_FOUND' as IpcErrorCode, `action 端口没有方法 ${method}`, 'METHOD')));
    }
    const req = JSON.parse(argsJson) as OpenReq;
    // 外链绝不直接丢给系统浏览器 —— 协议与 host 白名单走 core，与桌面壳同一份判据。
    const host = this.upstreamHost();
    const allowed: string[] = host === null ? [] : [host];
    const decision = checkOpenUrl(req.url ?? '', allowed) as Object as OpenUrlView;
    if (!decision.ok) {
      return Promise.reject(new Error(formatIpcError('FORBIDDEN' as IpcErrorCode, describeOpenUrlReason(decision.reason), decision.reason)));
    }
    return this.context.openLink(decision.url).then((): string | null => null).catch((e: Object): string | null => {
      throw new Error(formatIpcError('INTERNAL' as IpcErrorCode, `打开外链失败：${String(e)}`));
    });
  }
}

// ── selfcheck（不映射任何 invoke 通道，只有页面自检在用）────
export class SelfcheckPort implements OhosPort {
  private readonly context: common.Context;
  private readonly baseUrl: () => string | null;
  private repoStarted: boolean = false;

  constructor(context: common.Context, baseUrl: () => string | null) {
    this.context = context;
    this.baseUrl = baseUrl;
  }

  /**
   * 后台跑一遍仓储一致性（22 条 core 用例跑在 RDB 上）。
   *
   * 不挂到页面的 RPC 上：一轮用例要开/关 22 个库，耗时远超一次调用的合理预算。
   * 结果只打 hilog（`[SELFCHECK] repo …`），判定归设备侧脚本（`judgeRepo`）。
   */
  startRepoConformance(): void {
    if (this.repoStarted) return;
    this.repoStarted = true;
    runRepoConformance(this.context).then((result: ConformanceResult): void => {
      hilog.info(DOMAIN, TAG, '[SELFCHECK] repo total=%{public}d passed=%{public}d failed=%{public}d skipped=%{public}d',
        result.total, result.passed, result.failures.length, result.skipped.length);
      for (const failure of result.failures) {
        hilog.error(DOMAIN, TAG, '[SELFCHECK] repoFail %{public}s', failure);
      }
    }).catch((e: Object): void => {
      hilog.error(DOMAIN, TAG, '[SELFCHECK] repoError %{public}s', String(e));
    });
  }

  handle(method: string, argsJson: string): Promise<string | null> {
    const base = this.baseUrl();
    if (base === null) {
      return Promise.reject(new Error(formatIpcError('UNSUPPORTED' as IpcErrorCode, '当前是离线脚本上游，没有自检 fixture')));
    }
    const path = method === 'fixture' ? '/__selfcheck/nav-fixture' : method === 'stats' ? '/__selfcheck/nav-stats' : null;
    if (path === null) {
      return Promise.reject(new Error(formatIpcError('NOT_FOUND' as IpcErrorCode, `selfcheck 端口没有方法 ${method}`, 'METHOD')));
    }
    return httpRequestText(`${base}${path}`, http.RequestMethod.GET, null, 8000).then((res: HttpResult): string => {
      if (!res.ok || res.body.length === 0) {
        throw new Error(formatIpcError('UPSTREAM' as IpcErrorCode, `取不到 ${path}（${res.detail}）—— 上游没起，或没经 hdc rport 映射进来`));
      }
      // 原样透传（已是 JSON 文本），不在这里解一层再序列化
      return res.body;
    });
  }
}
