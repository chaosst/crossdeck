/**
 * navigate 上游的 **HTTP/SSE IO 实现** —— Electron 壳这一份。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这个文件只负责四件事（其余全在 `core/net/navigateStream.ts`）
 * ══════════════════════════════════════════════════════════════════
 *   1. **认证**：`?token=`（Bearer 必 401 —— T3 实测）
 *   2. `fetch` + 非 2xx 判定
 *   3. `reader.read()` + `TextDecoder({stream:true})`
 *   4. `AbortController` —— 取消/超时**真的断连接**
 *
 * 状态机（首帧超时的判据、帧 → 语义动作、权威全文的差量补齐、终态幂等）
 * 在 core 里，三端共用。分界线画在**「已解码的文本」**上：
 * core 的 lib 只有 ES2022，拿不到 `Response` / `AbortController` 的类型，
 * 所以网络那半必须留在壳里（详见 `core/src/net/navigateStream.ts` 的文件头）。
 *
 * ⚠️ 这个文件**刻意不 import electron**（凭据外部注入）——
 *    于是它能被裸 Node 加载、单独验证（见 `scripts/verify-navigate-client.mjs`）。
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

export interface NavigateClientConfig {
  /** 形如 `http://127.0.0.1:3001` —— 由 T10 的配置通道注入，**不硬编码**。 */
  readonly baseUrl: string;
  /** 取当前 token；无 token 时返回 null（调用方据此先走 guest 登录）。 */
  readonly getToken: () => string | null;
  /**
   * 首帧超时（ms）。**必须有，不能无限等** —— 没有它，"上游根本没起来"
   * 这个最常见的失败会表现为界面永远转圈。
   */
  readonly firstFrameTimeoutMs: number;
  readonly deps: AgentDeps;
  /** 诊断出口。不给就落 console（见 `NavigateDiagnostic` 的说明）。 */
  readonly onDiagnostic?: (d: NavigateDiagnostic) => void;
}

export function createNavigateClient(cfg: NavigateClientConfig): ChatClient {
  const report = cfg.onDiagnostic ?? createNavigateReporter(console);
  // 只用于诊断/拼 URL，**不含 token**（token 在每次调用时现取）。
  const endpoint = `${cfg.baseUrl.replace(/\/+$/, '')}${NAVIGATE_CHAT_PATH}`;

  return {
    streamChat(req: ChatRequest, sink: ModelSink): Cancel {
      const ac = new AbortController();
      const stream = new NavigateStream({
        sink,
        deps: cfg.deps,
        firstFrameTimeoutMs: cfg.firstFrameTimeoutMs,
        // 引擎不碰网络，需要硬断连时喊这一声。
        abortUpstream: () => ac.abort(),
        report,
      });

      const pump = async (token: string): Promise<void> => {
        let res: Response;
        try {
          const url = new URL(endpoint);
          // 认证只走 query。Bearer 必然 401（T3 实测）。
          url.searchParams.set('token', token);
          res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
            // 上游读的是 `question`（T3 实测；缺它会 400，且 400 说明鉴权已通过）。
            body: JSON.stringify({ question: req.prompt }),
            signal: ac.signal,
          });
        } catch (err) {
          if (stream.cancelled) return;
          stream.settleError(`无法连接上游 ${endpoint}：${errorMessage(err)}`);
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

            // `{ stream: true }` 不能漏 —— 漏了就是跨 chunk 的乱码。
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
          // done / error 已经收尾。把 body 释放掉 —— 服务器可能还在写尾巴。
          await reader.cancel().catch(() => undefined);
          return;
        }

        // 走到这里 = 流结束了，但既没见 `done` 也没报错 → **被截断**。
        stream.finishStream();
      };

      const token = cfg.getToken();
      if (token === null || token.length === 0) {
        // 没有凭据就别假装在连 —— 同步报一个 error 终态。
        // 同步是允许的：runtime 在 `stream()` 返回后会自查 `run.settled`（T6-b 修的那条），
        // 而这条路径**没有启动任何定时器/连接**，所以不存在"没人摘的调度"。
        stream.settleError('未登录：没有可用凭据，请先获取体验账号');
        return () => {};
      }

      stream.armFirstFrameTimer();
      report({ type: 'request', at: cfg.deps.now(), endpoint, auth: 'token' });

      void pump(token);

      // 只断连接，**不碰 sink**（终态归 runtime）。
      return () => {
        stream.cancel();
        ac.abort();
      };
    },
  };
}
