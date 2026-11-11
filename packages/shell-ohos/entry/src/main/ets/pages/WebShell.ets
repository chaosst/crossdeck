/**
 * WebShell —— 把共享 UI 装进 ArkWeb 的容器页。
 *
 * 三段顺序是承重的（探针已证，别调换）：
 *   ① onControllerAttached 注册 proxy —— 已注册对象要到**下一次页面加载**才对 JS 可见；
 *   ② onPageEnd 投递端口 —— 过早 createWebMessagePorts 拿不到有效端口；
 *   ③ onInterceptRequest 自建 origin 回 rawfile —— `resource://` 加载不了 ESM（CORS）。
 *
 * 页面只做渲染与编排，系统调用全在 `host/ports/*`；两者之间是帧协议（见 contract/portFrame.ts）。
 */
import { webview } from '@kit.ArkWeb';
import { hilog } from '@kit.PerformanceAnalysisKit';
import type { common } from '@kit.AbilityKit';
import { AppHost, AppHostHolder } from '../host/AppHost';

const DOMAIN: number = 0x3200;
const TAG: string = 'WebShell';
/** 自建 origin：只为绕开 resource:// 的跨域限制，不对应任何真实站点。 */
const ORIGIN: string = 'https://app.crossdeck.local';
const RAW_PREFIX: string = 'app/';

const MIME: Map<string, string> = new Map<string, string>([
  ['html', 'text/html'],
  ['js', 'text/javascript'],
  ['mjs', 'text/javascript'],
  ['css', 'text/css'],
  ['json', 'application/json'],
  ['svg', 'image/svg+xml'],
  ['png', 'image/png'],
  ['woff2', 'font/woff2'],
  ['woff', 'font/woff'],
]);

function mimeOf(path: string): string {
  const dot: number = path.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  const ext: string = path.slice(dot + 1).toLowerCase();
  const hit: string | undefined = MIME.get(ext);
  return hit === undefined ? 'application/octet-stream' : hit;
}

@Entry
@Component
struct WebShell {
  private controller: webview.WebviewController = new webview.WebviewController();
  private app: AppHost | null = null;
  private portDelivered: boolean = false;

  private appHost(): AppHost {
    if (this.app === null) {
      const context = getContext(this) as common.UIAbilityContext;
      this.app = AppHostHolder.shared(context);
    }
    return this.app as AppHost;
  }

  /** `--ps selfcheck 1` 才带 query —— 产品路径不该因为存在自检而改行为。 */
  private pageUrl(): string {
    const on: string = AppStorage.get<string>('selfcheck') ?? '';
    return on.length > 0 ? `${ORIGIN}/index.html?selfcheck=1` : `${ORIGIN}/index.html`;
  }

  build() {
    Column() {
      Web({ src: this.pageUrl(), controller: this.controller })
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .width('100%')
        .layoutWeight(1)
        // ① proxy 只放同步方法：`asyncMethodList` 不返回 Promise（探针结论），invoke 走端口。
        .onControllerAttached(() => {
          this.appHost().attachWebview(this.controller);
          hilog.info(DOMAIN, TAG, 'proxy 已注册');
        })
        // ② 端口只投递一次。页面内联脚本已经注册好监听，重复投递会让端口被消费两次。
        .onPageEnd((event) => {
          hilog.info(DOMAIN, TAG, '页面加载完成：%{public}s', event.url);
          if (this.portDelivered) {
            // 重新加载 = 新 document，端口没了。这条日志是"界面卡在白屏"的第一现场。
            hilog.warn(DOMAIN, TAG, '页面又加载了一次：端口只在首次投递，刷新后需重启');
            return;
          }
          this.portDelivered = true;
          this.appHost().deliverPort(this.controller, ORIGIN);
        })
        // ③ 自建 origin → $rawfile('app/…')；越界（含 '..'）直接拒。
        .onInterceptRequest((event) => {
          const url: string = event.request.getRequestUrl();
          if (!url.startsWith(`${ORIGIN}/`)) return null;
          let rel: string = url.slice(ORIGIN.length + 1);
          const cut: number = rel.search(/[?#]/);
          if (cut >= 0) rel = rel.slice(0, cut);
          if (rel === '') rel = 'index.html';
          if (rel.indexOf('..') >= 0) {
            hilog.error(DOMAIN, TAG, '拒绝越界路径：%{public}s', rel);
            return null;
          }
          const response: WebResourceResponse = new WebResourceResponse();
          response.setResponseData($rawfile(`${RAW_PREFIX}${rel}`));
          response.setResponseEncoding('utf-8');
          response.setResponseMimeType(mimeOf(rel));
          response.setResponseCode(200);
          response.setReasonMessage('OK');
          response.setResponseIsReady(true);
          return response;
        })
        .onErrorReceive((event) => {
          hilog.error(DOMAIN, TAG, '资源错误：%{public}s %{public}s',
            event.request.getRequestUrl(), event.error.getErrorInfo());
        })
        .onConsole((event) => {
          // 页面 console 是自检报告的落地通道之一（哨兵行就从这里进 hilog）。
          hilog.info(DOMAIN, TAG, 'console: %{public}s', event.message.getMessage());
          return false;
        })
    }
    .width('100%')
    .height('100%')
    // 与共享 UI 的 `--color-canvas` 一致：页面挂载前不要闪一下别的底色。
    .backgroundColor('#f6f5f2')
  }
}
