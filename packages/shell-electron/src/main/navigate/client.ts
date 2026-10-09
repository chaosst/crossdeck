/**
 * navigate 上游的 **HTTP/SSE IO 实现** —— Electron 壳这一份。
 *
 * ══════════════════════════════════════════════════════════════════
 * 五个坑，每个都有对应断言（改之前先读）
 * ══════════════════════════════════════════════════════════════════
 *
 * ① **认证走 `?token=`，不要用 `Authorization: Bearer`。**
 *
 * ② **`decoder.decode(value, { stream: true })` 少了 `{ stream: true }` 会偶发乱码。**
 *
 * ③ **正常路径一定发 `done`；没收到 done 就断 = 被截断，必须报错。**
 *
 * ④ **首帧超时不能等 runtime 的 60s 兜底。**
 *
 * ⑤ **`cancel()` 只断连接，绝不碰 sink。**
 */

import { SseParser, dedupeSources, errorMessage, mapNavigateFrames } from '@crossdeck/core';
import type { AgentDeps, Cancel, ModelSink, NavigateAction } from '@crossdeck/core';

/** 上游路径。**已定决策：只接 `/api/resume/chat`**（权限最低、真逐 token 流）。 */
export const NAVIGATE_CHAT_PATH = '/api/resume/chat';

export const DEFAULT_FIRST_FRAME_TIMEOUT_MS = 15_000;

/**
 * 诊断事件。
 *
 * （计划里写的是"计数 + 日志"）。
 * 把"计数"做成可注入的回调，断言才抓得住"确实上报了"；
 * 不给回调时落到 console（与计划里的"日志"一致）。
 * 刻意**不把 `sources` / `unknown` 塞进 `ModelSink`** ——
 * 那是 core 的端口契约，为了一端的诊断需求去改它会污染三端。
 */
export type NavigateDiagnostic =
  /** 请求已发出。**刻意只记 endpoint（不含 token）** —— 凭据不许进日志。 */
  | { readonly type: 'request'; readonly at: number; readonly endpoint: string; readonly hasToken: boolean }
  /** 一片增量到达。`at` 是 `deps.now()`，用于肉眼确认"是逐帧到的，不是一次性到齐"。 */
  | { readonly type: 'chunk'; readonly at: number; readonly len: number; readonly total: number }
  /** 收到引用来源（已去重）。 */
  | { readonly type: 'sources'; readonly at: number; readonly sources: readonly string[] }
  /** 未识别的事件名 —— **上报，不静默**（上游加新事件时三端不该静默失灵）。 */
  | { readonly type: 'unknown-event'; readonly at: number; readonly event: string; readonly raw: string }
  /** `authoritative` 前缀成立 → 只补吐了尾巴。 */
  | { readonly type: 'authoritative-delta'; readonly at: number; readonly added: number }
  /**
   * `authoritative` 前缀**不成立** → 增量表达不了替换，只能按全文补吐（可能重复）。
   * 这是"契约理解可能错了"的信号：正常路径压根不发 `answer`，
   * 所以这个分支不该频繁出现 —— 频繁出现就要回来找 lead 对契约。
   */
  | { readonly type: 'authoritative-replace'; readonly at: number; readonly emittedLen: number; readonly textLen: number }
  /** 终态。`message` 在 `kind === 'end'` 时为 null。 */
  | { readonly type: 'terminal'; readonly at: number; readonly kind: 'end' | 'error'; readonly message: string | null };

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

export interface ChatRequest {
  readonly sessionId: string;
  readonly prompt: string;
}

/**
 * 比 `ModelPort` 更低的一层 IO 端口：各壳各写一份实现，**接口只有一份**。
 *
 * 本轮**先在壳里定义** —— 到 T8 两端同形之后再上提进 core（判据是"第二次出现"，
 * 不是"怕重复"；与 `errorMessage` 那次同一条准则）。名字保持不变，只是换个文件放。
 */
export interface ChatClient {
  /** 同步返回取消函数；数据经 sink 回调推。 */
  streamChat(req: ChatRequest, sink: ModelSink): Cancel;
}

export function createNavigateClient(cfg: NavigateClientConfig): ChatClient {
  const report = cfg.onDiagnostic ?? defaultReport;
  // 只用于诊断/拼 URL，**不含 token**（token 在每次调用时现取）。
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const endpoint = `${base}${NAVIGATE_CHAT_PATH}`;

  return {
    streamChat(req: ChatRequest, sink: ModelSink): Cancel {
      const ac = new AbortController();

      /** 外部调过 cancel。此后不再交任何终态给 sink（终态归 runtime 决定）。 */
      let cancelled = false;
      /** 已经交过终态（onEnd / onError）。**幂等位** —— sink 契约要求"恰好一次"。 */
      let settled = false;
      /** 是否已有字节到达（首帧超时的判据）。 */
      let firstByteSeen = false;
      /** 已经 `onChunk` 出去的内容累计 —— `authoritative` 差量补齐的基准。 */
      let emitted = '';
      let firstFrameTimer: Cancel | null = null;

      const clearFirstFrameTimer = (): void => {
        if (firstFrameTimer === null) return;
        firstFrameTimer();
        firstFrameTimer = null;
      };

      const settleError = (message: string): void => {
        if (cancelled || settled) return;
        settled = true;
        clearFirstFrameTimer();
        report({ type: 'terminal', at: cfg.deps.now(), kind: 'error', message });
        sink.onError(message);
      };

      const settleEnd = (): void => {
        if (cancelled || settled) return;
        settled = true;
        clearFirstFrameTimer();
        report({ type: 'terminal', at: cfg.deps.now(), kind: 'end', message: null });
        sink.onEnd();
      };

      const pushChunk = (text: string): void => {
        if (text.length === 0) return;
        emitted += text;
        report({ type: 'chunk', at: cfg.deps.now(), len: text.length, total: emitted.length });
        sink.onChunk(text);
      };

      /**
       * 处理一个语义动作。
       * @returns true = 本次流该停了（已收到终态）。
       */
      const dispatch = (action: NavigateAction): boolean => {
        switch (action.kind) {
          case 'text':
            pushChunk(action.text);
            return false;

          case 'authoritative': {
            // 语义是**替换**，但 `ModelSink` 只有增量 `onChunk` —— 无法表达替换。
            // 正常路径压根不发这个帧（T3 revA 语料是 token×105 → sources → done），
            // 只有上游退化成"一次性到齐"时才补发。所以这里处理的是**兜底路径**，
            // 但不能省 —— 省了就是"上游一退化就出拼接错误"。
            if (action.text.startsWith(emitted)) {
              const tail = action.text.slice(emitted.length);
              report({ type: 'authoritative-delta', at: cfg.deps.now(), added: tail.length });
              pushChunk(tail);
            } else {
              // 前缀不成立 → 无法用增量表达。**宁可重复，也不静默丢内容**，
              // 但必须留下可观测的痕迹（计数 + 日志）。
              report({
                type: 'authoritative-replace',
                at: cfg.deps.now(),
                emittedLen: emitted.length,
                textLen: action.text.length,
              });
              pushChunk(action.text);
            }
            return false;
          }

          case 'sources':
            // ⚠️ 这里**只能上报**，送不进 sink：`ModelSink` 没有"来源"通道，
            //    `contract` 的 `AgentStreamEvent` 目前也没有 `sources` 事件。
            //    要让 UI 展示引用来源，得先在 contract 加事件 —— 那是另一张卡的事。
            //    现在假装"已经送给 UI 了"才是诚实性缺口。
            report({ type: 'sources', at: cfg.deps.now(), sources: dedupeSources(action.sources) });
            return false;

          case 'done':
            settleEnd();
            return true;

          case 'error':
            settleError(`上游报错：${action.message}`);
            return true;

          case 'unknown':
            report({ type: 'unknown-event', at: cfg.deps.now(), event: action.event, raw: action.raw });
            return false;
        }
      };

      const pump = async (token: string): Promise<void> => {
        let res: Response;
        try {
          const url = new URL(endpoint);
          // 坑 ①：认证只走 query。Bearer 必然 401（T3 实测）。
          url.searchParams.set('token', token);
          res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
            // 上游读的是 `question`（T3 实测；缺它会 400，且 400 说明鉴权已通过）。
            body: JSON.stringify({ question: req.prompt }),
            signal: ac.signal,
          });
        } catch (err) {
          if (cancelled) return;
          settleError(`无法连接上游 ${endpoint}：${errorMessage(err)}`);
          return;
        }

        if (!res.ok) {
          settleError(describeHttpStatus(res.status, res.headers.get('retry-after')));
          return;
        }
        if (res.body === null) {
          settleError(`上游响应没有响应体，无法读取流（HTTP ${res.status}）`);
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const parser = new SseParser();
        let stop = false;

        try {
          while (!stop) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value === undefined || value.byteLength === 0) continue;

            // 首帧判据是"**字节**有没有到"，不是"解出文本没有"：
            // 一个被切开的多字节字符解出来是空串，但它确实到了。
            if (!firstByteSeen) {
              firstByteSeen = true;
              clearFirstFrameTimer();
            }

            // 坑 ②：`{ stream: true }` 不能漏 —— 漏了就是跨 chunk 的乱码。
            const text = decoder.decode(value, { stream: true });
            if (text.length === 0) continue;

            for (const action of mapNavigateFrames(parser.push(text))) {
              if (dispatch(action)) {
                stop = true;
                break;
              }
            }
          }
        } catch (err) {
          if (cancelled) return; // abort 自己触发的读取失败，不是错误
          settleError(`读取上游流失败：${errorMessage(err)}`);
          return;
        }

        if (cancelled) return;
        if (settled) {
          // done / error 已经收尾。把 body 释放掉 —— 服务器可能还在写尾巴。
          await reader.cancel().catch(() => undefined);
          return;
        }

        // 走到这里 = 流结束了，但既没见 `done` 也没报错 → **被截断**（坑 ③）。
        const tail = parser.end();
        settleError(
          '上游提前关闭连接：没收到 done 帧' +
            (tail.hasPending ? `（缓冲区还有 ${tail.pendingChars} 个字符的残帧）` : '') +
            ' —— 回答可能被截断',
        );
      };

      const token = cfg.getToken();
      if (token === null || token.length === 0) {
        // 没有凭据就别假装在连 —— 同步报一个 error 终态。
        // 同步是允许的：runtime 在 `stream()` 返回后会自查 `run.settled`（T6-b 修的那条），
        // 而这条路径**没有启动任何定时器/连接**，所以不存在"没人摘的调度"。
        settleError('未登录：没有可用凭据，请先获取体验账号');
        return () => {};
      }

      // 坑 ④：计时器挂在 `await fetch` 外面。服务端连响应头都不给时，
      // `await fetch` 永远不 resolve —— 计时器若挂在里面，就永远不会启动。
      firstFrameTimer = cfg.deps.every(cfg.firstFrameTimeoutMs, () => {
        clearFirstFrameTimer();
        ac.abort(); // **真断连接**，不只是"不听了"
        settleError(`上游首帧超时：${cfg.firstFrameTimeoutMs}ms 内没有收到任何数据`);
      });

      report({ type: 'request', at: cfg.deps.now(), endpoint, hasToken: true });

      void pump(token);

      // 坑 ⑤：只断连接，**不碰 sink**。
      return () => {
        if (cancelled) return;
        cancelled = true;
        clearFirstFrameTimer();
        ac.abort();
      };
    },
  };
}

/**
 * 把 HTTP 状态翻成**能区分的**人话。
 *
 * 全都压成"请求失败"等于让排查去猜 —— 而 401（凭据）与 429（限流）与
 * 503（服务端没启用）该做的下一步完全不同。项目既有做法：错误码不许拍平。
 */
function describeHttpStatus(status: number, retryAfter: string | null): string {
  if (status === 401 || status === 403) {
    return `上游拒绝：凭据无效或已过期（HTTP ${status}）—— 请重新登录`;
  }
  if (status === 404) {
    return `上游没有这个接口（HTTP 404）—— 确认地址确实是 navigate 的 ${NAVIGATE_CHAT_PATH}`;
  }
  if (status === 429) {
    return `上游限流（HTTP 429）${retryAfter === null ? '' : `，建议 ${retryAfter}s 后重试`}`;
  }
  if (status === 503) {
    return '上游未启用该能力（HTTP 503）—— 服务端可能没配体验账号';
  }
  return `上游返回 HTTP ${status}`;
}

/** 默认诊断出口：打到控制台。`chunk@<ms> len=<n>` 就是"逐帧到达"的肉眼证据。 */
function defaultReport(d: NavigateDiagnostic): void {
  switch (d.type) {
    case 'request':
      console.log(`[navigate] 请求 ${d.endpoint}（带 token: ${d.hasToken ? '是' : '否'}）`);
      return;
    case 'chunk':
      console.log(`[navigate] chunk@${d.at} len=${d.len} total=${d.total}`);
      return;
    case 'sources':
      console.log(`[navigate] sources×${d.sources.length}（已去重）`);
      return;
    case 'unknown-event':
      console.warn(`[navigate] 未识别的事件 "${d.event}"，原文：${truncate(d.raw)}`);
      return;
    case 'authoritative-delta':
      console.log(`[navigate] authoritative 差量补齐 +${d.added}`);
      return;
    case 'authoritative-replace':
      console.warn(
        `[navigate] authoritative 前缀不成立（已吐 ${d.emittedLen} 字符 / 全文 ${d.textLen}）` +
          ' → 按全文补吐，可能出现重复；若频繁出现请对契约',
      );
      return;
    case 'terminal':
      console.log(`[navigate] 终态 ${d.kind}${d.message === null ? '' : `：${d.message}`}`);
      return;
  }
}

function truncate(s: string): string {
  return s.length <= 160 ? s : `${s.slice(0, 160)}…`;
}
