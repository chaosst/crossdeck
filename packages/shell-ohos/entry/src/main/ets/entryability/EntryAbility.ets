import { AbilityConstant, UIAbility, Want, errorManager } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { rememberWindowStage } from '../host/AppHost';

const DOMAIN: number = 0x3200;
const TAG: string = 'crossdeck';

/** 自检配置通道用到的 key。页面侧用 `@StorageLink` / `AppStorage.get` 读同一批 key。 */
const SELFCHECK_PARAMS: string[] = ['upstreamUrl', 'ohosToken', 'selfcheck', 'ui'];

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    errorManager.on('error', {
      onUnhandledException(errMsg: string): void {
        hilog.error(DOMAIN, TAG, '未捕获异常：%{public}s', errMsg);
      },
    });
    errorManager.on('unhandledRejection', (reason: ESObject): void => {
      const err = reason instanceof Error ? reason : new Error(String(reason));
      hilog.error(DOMAIN, TAG, '未处理的 Promise 拒绝：%{public}s | 堆栈 %{public}s',
        err.message, err.stack ?? '无');
    });
    // ─────────────────────────────────────────────────────────────
    // 自检配置通道：`aa start -a EntryAbility -b <bundle> --ps upstreamUrl … --ps ohosToken …`
    //
    // 为什么参数要经 `AppStorage` 中转：命令行参数只有 UIAbility 的 `want.parameters`
    // 拿得到，而页面是另一个文件。AppStorage 是两者之间唯一的现成共享区
    // （页面侧 `@StorageLink` 读同一个 key）。
    //
    // ⚠️ 参数**缺失时什么都不做** —— 页面于是拿到默认值 `''`，也就是脚本上游。
    //    这是刻意的：不能给一个"猜出来的默认地址"，那会让"没配上游"看起来像"配了但连不上"。
    // ⚠️ 日志里**只打 key、不打值** —— ohosToken 是凭据，凭据不该进 hilog。
    // ─────────────────────────────────────────────────────────────
    for (const key of SELFCHECK_PARAMS) {
      this.injectParam(want, key);
    }
    hilog.info(DOMAIN, TAG, 'EntryAbility onCreate');
  }

  private injectParam(want: Want, key: string): void {
    const params = want.parameters;
    if (params === undefined) return;
    // 值类型是 Object，`typeof` 收窄不动它 —— 只能按官方样例那样 `as string`。
    const raw: Object | undefined = params[key];
    if (raw === undefined || raw === null) return;
    const value: string = raw as string;
    if (value.length === 0) return;
    AppStorage.setOrCreate<string>(key, value);
    hilog.info(DOMAIN, TAG, '自检参数 %{public}s 已注入（值不打印）', key);
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    // 端口在页面里建，WindowStage 只有这里拿得到 —— 先记一笔再加载页面。
    rememberWindowStage(windowStage);
    windowStage.loadContent(this.entryPage(), (err) => {
      if (err.code) {
        hilog.error(DOMAIN, TAG, 'loadContent failed: %{public}s', JSON.stringify(err) ?? '');
        return;
      }
      hilog.info(DOMAIN, TAG, 'loadContent ok');
    });
  }

  /**
   * `--ps ui web`（默认）= 共享 UI 容器页；`--ps ui arkui` = 旧的 ArkUI 原生页。
   *
   * 原生页留着不是情怀：它是"没有 WebView 时也能自证 core/RDB"的兜底
   * （`verify-ohos --legacy` 走的就是它）。
   */
  private entryPage(): string {
    const ui: string = AppStorage.get<string>('ui') ?? '';
    return ui === 'arkui' ? 'pages/Index' : 'pages/WebShell';
  }
}
