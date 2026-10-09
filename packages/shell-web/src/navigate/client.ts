/**
 * navigate 上游的 **HTTP/SSE IO 实现** —— Web 壳这一份。
 *
 * ══════════════════════════════════════════════════════════════════
 * 与 Electron 壳的差别**只有两行**，而且是有意的
 * ══════════════════════════════════════════════════════════════════
 *   1. **认证**：浏览器里凭据是**同源 httpOnly cookie**，由浏览器自动带上 ——
 *      所以 `credentials: 'same-origin'`，**不往 URL 上塞 token**。
 *      （Electron 主进程没有 cookie jar，只能 `?token=`。）
 *   2. 出错时说"地址不对"的措辞。
 *
 * 其余（首帧超时、SSE 解析、帧 → 语义动作、权威全文差量、终态幂等、取消记账）
 * 全在 `core/net/navigateStream.ts`，一行不用重写。
 *
 * ⚠️ **不落地任何凭据**：没有 tokenStore。往 `localStorage` 存 token
 *    等于把它送给任何一个 XSS —— 而 httpOnly cookie 拿不到。
 *
 * ⚠️ **为什么必须同源**（T8 的前置决策，走 A：反代，不动服务端）：
 *    T3 实测 navigate 响应头里**没有任何 `access-control-*`** → 跨源 fetch 会被
 *    浏览器挡掉；且登录 cookie 是 `HttpOnly` + `SameSite=Lax` → **跨站根本不带**。
 *    所以 Web 壳的产物要么放进 navigate 的 `public/`，要么由 Caddy 同域反代。
 *    在 dev/自检里，`baseUrl` 必须与 navigate 同 host:port，否则跑的是跨域路径（假绿）。
 */

import {
  NAVIGATE_CHAT_PATH,
  NavigateStream,
  createNavigateReporter,
  describeNavigateHttpStatus,
  errorMessage,
} from '@crossdeck/core';
import type {
  AgentDeps,
  Cancel,
  ChatClient,
  ChatRequest,
  ModelSink,
  NavigateDiagnostic,
} from '@crossdeck/core';

export interface WebNavigateClientConfig {
  /**
   * 上游地址前缀。**同源部署时留空** —— 于是打的是相对路径
   * （`/api/resume/chat`），浏览器按当前 origin 解析，cookie 自然带上。
   * 传绝对地址只在"确实做了跨域且服务端开了 CORS + `SameSite=None; Secure`"时成立。
   */
  readonly baseUrl?: string;
  /**
   * 首帧超时（ms）。**必须有** —— 没有它，"上游没起来 / 反代没配好"
   * 会表现为界面永远转圈，而这恰恰是本地最常撞的那一类失败。
   */
  readonly firstFrameTimeoutMs: number;
  readonly deps: AgentDeps;
  /** 诊断出口。不给就落 console。 */
  readonly onDiagnostic?: (d: NavigateDiagnostic) => void;
}

export function createWebNavigateClient(cfg: WebNavigateClientConfig): ChatClient {
  const report = cfg.onDiagnostic ?? createNavigateReporter(console);
  const base = (cfg.baseUrl ?? '').replace(/\/+$/, '');
  // base 为空 → 纯相对路径。**不拼 location.origin**：相对路径让浏览器
  // 自己按当前 origin 解析，改端口/改域名都不用改代码。
  const endpoint = `${base}${NAVIGATE_CHAT_PATH}`;

  return {
    streamChat(req: ChatRequest, sink: ModelSink): Cancel {
      const ac = new AbortController();
      const stream = new NavigateStream({
        sink,
        deps: cfg.deps,
        firstFrameTimeoutMs: cfg.firstFrameTimeoutMs,
        abortUpstream: () => ac.abort(),
        report,
      });

      const pump = async (): Promise<void> => {
        let res: Response;
        try {
          res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
            body: JSON.stringify({ question: req.prompt }),
            // 同源 httpOnly cookie 的开关。写成 `include` 也能带，但 `same-origin`
            // 更严：跨源时它**不发** cookie —— 而这正是我们要的（跨源本来也不通）。
            credentials: 'same-origin',
            signal: ac.signal,
          });
        } catch (err) {
          if (stream.cancelled) return;
          stream.settleError(
            `无法连接上游 ${endpoint}：${errorMessage(err)}` +
              '（同源部署下请确认反代把 ' +
              NAVIGATE_CHAT_PATH +
              ' 也代理到 navigate）',
          );
          return;
        }

        if (!res.ok) {
          stream.settleError(describeNavigateHttpStatus(res.status, res.headers.get('retry-after')));
          return;
        }
        if (res.body === null) {
          stream.settleError(`上游响应没有响应体，无法读取流（HTTP ${res.status}）`);
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let stop = false;

        try {
          while (!stop) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value === undefined || value.byteLength === 0) continue;

            stream.markFirstByte();

            // 与 Electron 壳**逐字一致**（含 `{ stream: true }`）。
            const text = decoder.decode(value, { stream: true });
            if (text.length === 0) continue;

            if (stream.feed(text)) {
              stop = true;
              break;
            }
          }
        } catch (err) {
          if (stream.cancelled) return; // abort 自己触发的读取失败，不是错误
          stream.settleError(`读取上游流失败：${errorMessage(err)}`);
          return;
        }

        if (stream.cancelled) return;
        if (stream.settled) {
          await reader.cancel().catch(() => undefined);
          return;
        }

        // 流结束了但没见过 `done` → 被截断（正常路径一定会发 done）。
        stream.finishStream();
      };

      // Web 壳没有"取 token"这一步：凭据由浏览器按同源规则自动带上，
      // 所以永远先发请求，让 401 来说"未登录"—— 那比在客户端猜更诚实。
      stream.armFirstFrameTimer();
      report({ type: 'request', at: cfg.deps.now(), endpoint, auth: 'cookie' });

      void pump();

      // 浏览器里**只有** `AbortSignal` 能真断连接；
      // "把 reader 丢掉"只是不再读，连接依旧开着（那是假的取消）。
      return () => {
        stream.cancel();
        ac.abort();
      };
    },
  };
}
