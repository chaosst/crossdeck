import { net, protocol, session } from 'electron';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 渲染层的自有协议 `app://` —— 替代 `file://`。
 *
 * 为什么不用 file://（两个都是硬理由）：
 *   1. `file://` 下 ES module 会被 CORS 拦掉（origin 为 null），
 *      而 Vite 产出的入口就是 `<script type="module">`。这是"能不能跑"的问题。
 *   2. `file://` 无法下发自定义响应头 —— 装不了 CSP。
 *      而 CSP 是 Electron 安全基线里唯一能约束渲染进程能力的东西。
 *      用自有协议，响应头由我们构造，CSP 可以写死。
 *
 * 顺带解决路径穿越：所有请求在 resolve 之后必须仍在 rendererDir 内，
 * 否则直接 403（`app://crossdeck/../../secret.txt` 这类尝试会被挡住）。
 */

export const APP_SCHEME = 'app';
export const APP_HOST = 'crossdeck';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/** 必须在 app ready 之前调用。 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

/** 生产模式的 CSP：写死，不给渲染层任何外联能力。 */
const PROD_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  // Tailwind / React 会注入行内样式，style-src 必须放开 'unsafe-inline'，
  // 但 script-src 保持 'self' —— 行内脚本才是 XSS 的主要入口。
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** 开发模式：Vite 的 HMR 需要 ws，React Refresh 注入行内脚本，故必须放宽。 */
const DEV_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' ws: http://localhost:*",
  "base-uri 'none'",
].join('; ');

/** 生产模式：把 dist/renderer 挂到 app:// 上。 */
export function serveRenderer(rendererDir: string): void {
  const root = resolve(rendererDir);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;

  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const target = resolve(root, rel === '' ? 'index.html' : rel);

    if (target !== root && !target.startsWith(rootWithSep)) {
      return new Response('Forbidden: path escapes renderer root', { status: 403 });
    }

    const upstream = await net.fetch(pathToFileURL(target).toString());
    const headers = new Headers(upstream.headers);
    headers.set('Content-Security-Policy', PROD_CSP);
    // 本地资源不需要被缓存器/嗅探器插一脚
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.delete('content-security-policy-report-only');

    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    });
  });
}

/** 开发模式：给 http://localhost:5173 的响应补 dev CSP（协议处理器不会经过这里）。 */
export function installDevCsp(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [DEV_CSP],
      },
    });
  });
}

/** 收拢渲染进程的权限面 —— 这个项目不需要摄像头/麦克风/定位等任何一项。 */
export function denyAllPermissions(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
}
