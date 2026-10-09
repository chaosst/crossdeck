import { NAVIGATE_CHAT_PATH, NavigateStream, createNavigateReporter, describeNavigateHttpStatus,
  errorMessage } from '../shared/core/index';
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

      // dataEnd 才是"数据流结束"。complete 是"请求结束"，正常/异常都会到。
      httpRequest.on('dataEnd', () => {
        if (stream.settled || stream.cancelled) return;
        const tail = decoder.decodeToString(new Uint8Array(0), { stream: false });
        if (tail.length > 0) stream.feed(tail);
        // 见过 done 时是 no-op；没见过 done 就是被截断 —— 由引擎判定并报错。
        stream.finishStream();
        httpRequest.destroy();
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
        // 走到这里还没终态 = 请求结束了却没经过 dataEnd（非 2xx 走这条路）→ 用状态码报错。
        if (stream.cancelled || stream.settled) return;
        if (err) {
          stream.settleError(`上游请求失败（HTTP ${statusCode}）：${errorMessage(err)}`);
          return;
        }
        stream.settleError(describeNavigateHttpStatus(statusCode, null));
      });

      // 只断连接，不碰 sink（终态归 runtime）。
      return () => {
        stream.cancel();
        httpRequest.destroy();
      };
    },
  };
}
