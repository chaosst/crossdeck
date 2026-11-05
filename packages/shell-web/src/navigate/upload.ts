/**
 * 上传 —— Web 壳这一份。
 *
 * ## 为什么是 `XMLHttpRequest` 而不是 `fetch`
 *
 * `fetch` 没有**上传**进度。它只有一个 `ReadableStream` 请求体的"我写完了"，
 * 拿不到"对端收了多少"。要进度就得用 `xhr.upload.onprogress`。
 * 这不是怀旧，是浏览器 API 的现实分工：
 *
 * | | `fetch` | `XMLHttpRequest` |
 * |---|---|---|
 * | 上传进度 | ❌ | ✅ `xhr.upload.onprogress` |
 * | 取消 | `AbortSignal` | `xhr.abort()` |
 * | 流式请求体 | 要 `duplex: 'half'`，且不是所有浏览器都放开 | ❌ 只能给 Blob/FormData |
 *
 * 所以：**问答走 fetch（要读流），上传走 XHR（要进度）**。
 *
 * ## 与 Electron 壳的差别：multipart 由浏览器拼
 *
 * 桌面壳那边是手写 framing（boundary / CRLF / 精确 content-length），
 * 因为它要一边从磁盘读一边发，不能把 20MB 全读进内存。
 * 浏览器里 `FormData` 会自己拼好 multipart 并给出 content-length ——
 * 能白拿的就别手写。**但字段名必须对齐**（`UPLOAD_FIELD`），否则服务端
 * `upload.single('file')` 收到的就是空。
 *
 * ## 认证
 *
 * 同源 httpOnly cookie，浏览器自动带上。**不往 URL 塞 token**，
 * 也不设 `Authorization` —— 那是桌面壳的形态（它没有 cookie 罐）。
 */

import {
  DEFAULT_UPLOAD_POLICY,
  NAVIGATE_UPLOAD_PATH,
  UPLOAD_FIELD,
  advanceUploadProgress,
  beginUploadProgress,
  checkUploadCandidate,
  decodeUploadedDocument,
  describeUploadStatus,
} from '@crossdeck/core';
import type { UploadedDocument } from '@crossdeck/contract';
import type { UploadPolicy, UploadProgress } from '@crossdeck/core';

/** 失败发生在哪一层。UI 据此决定"再试一次"按钮要不要给。 */
export type WebUploadStage =
  /** 本地体检拦下 —— **一个字节都没发出去**。 */
  | 'rejected-local'
  /** 上游给了非 2xx。 */
  | 'http'
  /** 连不上 / 被中断。 */
  | 'network'
  /** 2xx 但响应体不是约定的形状。 */
  | 'bad-response';

export type WebUploadOutcome =
  | { readonly ok: true; readonly document: UploadedDocument }
  | {
      readonly ok: false;
      readonly stage: WebUploadStage;
      readonly message: string;
      readonly retryable: boolean;
    };

export interface WebUploadOptions {
  readonly file: File;
  /** 上游前缀。同源部署留空 → 打相对路径，cookie 自然带上。 */
  readonly baseUrl?: string;
  readonly policy?: UploadPolicy;
  readonly now?: () => number;
  readonly onProgress?: (progress: UploadProgress) => void;
  /** 仅在"有响应但解析不了"时给诊断用：拿到原始响应文本。 */
  readonly onRawResponse?: (text: string) => void;
}

export interface WebUploadHandle {
  readonly promise: Promise<WebUploadOutcome>;
  /** 真断连（`xhr.abort()`），不是"丢掉回调"。 */
  cancel(): void;
}

function endpointOf(baseUrl: string | undefined): string {
  const base = (baseUrl ?? '').replace(/\/+$/, '');
  // 注意这里**没有** `?token=`：浏览器的凭据是同源 cookie
  return `${base}${NAVIGATE_UPLOAD_PATH}`;
}

export function uploadDocumentViaXhr(opts: WebUploadOptions): WebUploadHandle {
  const policy = opts.policy ?? DEFAULT_UPLOAD_POLICY;
  const now = opts.now ?? (() => Date.now());

  // ① 本地体检先跑。服务端既没有体积限制也没有类型限制，
  //    "拦住"只能发生在这里 —— 让它发出去再回 413，是白烧用户的流量。
  const candidate = checkUploadCandidate({ fileName: opts.file.name, sizeBytes: opts.file.size }, policy);
  if (!candidate.ok) {
    return {
      promise: Promise.resolve({
        ok: false,
        stage: 'rejected-local',
        message: candidate.message,
        retryable: false,
      }),
      cancel: () => {
        /* 没发请求，没什么可取消的 */
      },
    };
  }

  const endpoint = endpointOf(opts.baseUrl);
  const xhr = new XMLHttpRequest();
  let settled = false;
  let progressState = beginUploadProgress(opts.file.size, now());

  const promise = new Promise<WebUploadOutcome>((resolve) => {
    const finish = (outcome: WebUploadOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    xhr.upload.onprogress = (event: ProgressEvent): void => {
      // 进度是**累计**字节；归一函数自己夹紧单调（回调可能乱序/重复）
      const advanced = advanceUploadProgress(progressState, event.loaded, now());
      progressState = advanced.state;
      opts.onProgress?.(advanced.progress);
    };

    xhr.onload = (): void => {
      if (xhr.status >= 200 && xhr.status < 300) {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(xhr.responseText);
        } catch {
          parsed = null;
        }
        opts.onRawResponse?.(xhr.responseText);
        const document = decodeUploadedDocument(parsed);
        if (document === null) {
          finish({
            ok: false,
            stage: 'bad-response',
            message: '上传成功但响应形状不对（缺 docId / filename / chunks）',
            retryable: false,
          });
          return;
        }
        finish({ ok: true, document });
        return;
      }
      const failure = describeUploadStatus(xhr.status);
      finish({ ok: false, stage: 'http', message: failure.message, retryable: failure.retryable });
    };

    xhr.onerror = (): void => {
      finish({
        ok: false,
        stage: 'network',
        message: `连不上上游 ${endpoint}（确认反代把 ${NAVIGATE_UPLOAD_PATH} 也代理到 navigate）`,
        retryable: true,
      });
    };

    xhr.onabort = (): void => {
      finish({ ok: false, stage: 'network', message: '上传已取消', retryable: true });
    };

    xhr.open('POST', endpoint);
    // multipart 的 content-type（含 boundary）由 FormData 生成，**不要**手设，
    // 手设会把 boundary 写死，服务端解析必然失败。
    const form = new FormData();
    form.append(UPLOAD_FIELD, opts.file, opts.file.name);
    xhr.send(form);
  });

  return {
    promise,
    cancel: () => {
      if (settled) return;
      xhr.abort();
    },
  };
}
