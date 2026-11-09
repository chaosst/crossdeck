import { NAVIGATE_CHAT_PATH, NavigateStream, createNavigateReporter, describeNavigateHttpStatus } from '../shared/core/index';
import type { Cancel, ChatClient, ModelSink, ChatRequest, AgentDeps, NavigateDiagnostic } from '../shared/core/index';
import { http } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { util } from '@kit.ArkTS';

export interface OhosNavigateClientConfig {
  readonly baseUrl: string;
  readonly getToken: () => string | null;
  readonly firstFrameTimeoutMs: number;
  readonly deps: AgentDeps;
  readonly onDiagnostic?: (d: NavigateDiagnostic) => void;
}

/** BusinessError 不是 Error 实例，`errorMessage` 只会给出 `[object Object]`。 */
function describeError(err: BusinessError<void>): string {
  const message = err.message ?? '';
  return message.length > 0 ? `${message}（code=${err.code}）` : `code=${err.code}`;
}

export function createOhosNavigateClient(cfg: OhosNavigateClientConfig): ChatClient {
  const report = cfg.onDiagnostic ?? createNavigateReporter(console);
  const endpoint = `${cfg.baseUrl.replace(/\/+$/, '')}${NAVIGATE_CHAT_PATH}`;

  return {
    streamChat(req: ChatRequest, sink: ModelSink): Cancel {
      const httpRequest = http.createHttp();
      const stream = new NavigateStream({
        sink,
        deps: cfg.deps,
        firstFrameTimeoutMs: cfg.firstFrameTimeoutMs,
        abortUpstream: () => httpRequest.destroy(),
        report,
      });

      const token = cfg.getToken();
      if (token === null || token.length === 0) {
        // 没有凭据就别假装在连。
        stream.settleError('未登录：没有可用凭据，请先获取体验账号');
        return () => {};
      }

      const decoder = util.TextDecoder.create('utf-8', { fatal: false, ignoreBOM: true });

      httpRequest.on('dataReceive', (data: ArrayBuffer) => {
        // 终态之后上游可能还有残帧；引擎的 feed() 返回 true 就是在说"该停了"。
        if (stream.settled || stream.cancelled) return;
        // 判据是**字节**到了，不是解出的文本非空（多字节字符被切开时解出来是空串）。
        stream.markFirstByte();
        const text = decoder.decodeToString(new Uint8Array(data), { stream: true });
        if (text.length > 0) stream.feed(text);
      });

      // 非 2xx 也是一条**完整的响应**：dataEnd 会照常来。终态必须等 complete 回调的
      // statusCode 才能定 —— 在 dataEnd 里就 finishStream 会把 HTTP 400 误报成
      // "没收到 done 帧"，两种失败模式（上游拒绝 / 上游截断）就搅在一起了。
      let sawDataEnd = false;

      httpRequest.on('dataEnd', () => {
        if (stream.settled || stream.cancelled) return;
        sawDataEnd = true;
        const tail = decoder.decodeToString(new Uint8Array(0), { stream: false });
        if (tail.length > 0) stream.feed(tail);
      });

      stream.armFirstFrameTimer();
      report({ type: 'request', at: cfg.deps.now(), endpoint, auth: 'token' });

      httpRequest.requestInStream(endpoint, {
        method: http.RequestMethod.POST,
        // navigate 的 getToken 顺序是 ?token= → body.token → cookie，放 body 即可。
        extraData: { token, question: req.prompt },
        header: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
        readTimeout: 120000,
        connectTimeout: 30000,
      }, (err: BusinessError<void>, statusCode: number) => {
        if (stream.cancelled || stream.settled) return;
        httpRequest.destroy();
        if (err) {
          // 走到这里 = 连接层失败（socket 被销毁 / 连不上），一个字节都没能读完。
          // statusCode 在这个分支拿不到（undefined），写 0：表示"压根没拿到响应"，与 401 可区分。
          const code = statusCode === undefined ? 0 : statusCode;
          stream.settleError(`上游请求失败（HTTP ${code}）：${describeError(err)}`);
          return;
        }
        if (!sawDataEnd) {
          stream.settleError(describeNavigateHttpStatus(statusCode, null));
          return;
        }
        if (statusCode >= 200 && statusCode < 300) {
          // 见过 done 时是 no-op；没见过 done 就是被截断 —— 由引擎判定并报错。
          stream.finishStream();
        } else {
          stream.settleError(describeNavigateHttpStatus(statusCode, null));
        }
      });

      // 只断连接，不碰 sink（终态归 runtime）。
      return () => {
        stream.cancel();
        httpRequest.destroy();
      };
    },
  };
}
