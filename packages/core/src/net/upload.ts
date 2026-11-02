/**
 * 上传：本地体检、进度归一、失败话术。
 *
 * 服务端既没有体积限制也没有类型限制，所以"拦住"只能发生在客户端。
 */

import type { UploadedDocument, UploadProgress } from '@crossdeck/contract';

export type { UploadProgress };

/** multipart 字段名，与服务端 `upload.single('file')` 对齐。 */
export const UPLOAD_FIELD = 'file';

export const NAVIGATE_UPLOAD_PATH = '/api/upload';

export interface UploadPolicy {
  readonly maxBytes: number;
  readonly allowedExt: readonly string[];
}

export const DEFAULT_UPLOAD_POLICY: UploadPolicy = {
  maxBytes: 20 * 1024 * 1024,
  allowedExt: ['pdf', 'docx', 'doc', 'md', 'txt'],
};

export type UploadRejectionReason = 'empty-file' | 'too-large' | 'bad-extension';

export type UploadCheck =
  | { readonly ok: true; readonly ext: string }
  | { readonly ok: false; readonly reason: UploadRejectionReason; readonly message: string };

/** 小写扩展名，不含点；没有扩展名时返回空串。 */
export function extensionOf(fileName: string): string {
  const slash = Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\'));
  const base = slash >= 0 ? fileName.slice(slash + 1) : fileName;
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** 发请求之前的体检 —— 这里判失败就不该打上游。 */
export function checkUploadCandidate(
  candidate: { readonly fileName: string; readonly sizeBytes: number },
  policy: UploadPolicy = DEFAULT_UPLOAD_POLICY,
): UploadCheck {
  const ext = extensionOf(candidate.fileName);
  if (candidate.sizeBytes <= 0) {
    return { ok: false, reason: 'empty-file', message: '这个文件是空的，没有内容可以上传' };
  }
  if (candidate.sizeBytes > policy.maxBytes) {
    return {
      ok: false,
      reason: 'too-large',
      message: `文件 ${megabytes(candidate.sizeBytes)} 超过上限 ${megabytes(policy.maxBytes)}`,
    };
  }
  if (!policy.allowedExt.includes(ext)) {
    return {
      ok: false,
      reason: 'bad-extension',
      message: `不支持 .${ext === '' ? '（无扩展名）' : ext}，只接受 ${policy.allowedExt.join(' / ')}`,
    };
  }
  return { ok: true, ext };
}

export interface UploadProgressState {
  readonly sentBytes: number;
  readonly totalBytes: number;
  readonly startedAt: number;
}

/** 速率至少要有这么多毫秒的样本才敢算。 */
export const UPLOAD_RATE_MIN_SAMPLE_MS = 300;

export function beginUploadProgress(totalBytes: number, now: number): UploadProgressState {
  return { sentBytes: 0, totalBytes: Math.max(0, totalBytes), startedAt: now };
}

function ratioOf(sent: number, total: number): number {
  if (total <= 0) return 1;
  const raw = sent / total;
  return raw < 0 ? 0 : raw > 1 ? 1 : raw;
}

export function readUploadProgress(state: UploadProgressState, now: number): UploadProgress {
  const elapsedMs = now - state.startedAt;
  const done = state.sentBytes >= state.totalBytes;
  if (done) {
    return {
      sentBytes: state.sentBytes,
      totalBytes: state.totalBytes,
      ratio: 1,
      bytesPerSec: elapsedMs > 0 ? Math.round((state.sentBytes * 1000) / elapsedMs) : null,
      etaSec: 0,
    };
  }
  const enough = elapsedMs >= UPLOAD_RATE_MIN_SAMPLE_MS && state.sentBytes > 0;
  const bytesPerSec = enough ? Math.round((state.sentBytes * 1000) / elapsedMs) : null;
  const etaSec =
    bytesPerSec !== null && bytesPerSec > 0
      ? Math.max(0, Math.round((state.totalBytes - state.sentBytes) / bytesPerSec))
      : null;
  return {
    sentBytes: state.sentBytes,
    totalBytes: state.totalBytes,
    ratio: ratioOf(state.sentBytes, state.totalBytes),
    bytesPerSec,
    etaSec,
  };
}

/**
 * 按**累计**字节推进。
 *
 * 三端的回调都可能乱序 / 重复 / 跳号，所以下一帧只认 `max(上次, 本次)` ——
 * 进度条倒退是最刺眼的 UI bug。
 */
export function advanceUploadProgress(
  state: UploadProgressState,
  cumulativeSentBytes: number,
  now: number,
): { readonly state: UploadProgressState; readonly progress: UploadProgress } {
  const reported = Number.isFinite(cumulativeSentBytes) ? cumulativeSentBytes : 0;
  const sentBytes = Math.max(state.sentBytes, Math.min(reported, state.totalBytes));
  const next: UploadProgressState = { ...state, sentBytes };
  return { state: next, progress: readUploadProgress(next, now) };
}

export type UploadFailureReason =
  | 'unauthorized'
  | 'forbidden'
  | 'unparsable'
  | 'too-large'
  | 'upstream';

export interface UploadFailure {
  readonly reason: UploadFailureReason;
  /** 只有上游那一类值得再点一次。 */
  readonly retryable: boolean;
  readonly message: string;
}

/** 把 HTTP 状态翻译成对用户有用的话 —— 都说成"上传失败"等于什么都没说。 */
export function describeUploadStatus(status: number): UploadFailure {
  if (status === 401) {
    return { reason: 'unauthorized', retryable: false, message: '登录已失效，请重新登录后再上传' };
  }
  if (status === 403) {
    return {
      reason: 'forbidden',
      retryable: false,
      message: '当前身份没有上传权限 —— 上传只对登录账号开放，体验账号不行',
    };
  }
  if (status === 422) {
    return {
      reason: 'unparsable',
      retryable: false,
      message: '服务器解析不出这个文件的内容 —— 可能是不支持的格式或扫描件，换个文件再试',
    };
  }
  if (status === 413) {
    return { reason: 'too-large', retryable: false, message: '文件太大，服务器拒收' };
  }
  return { reason: 'upstream', retryable: true, message: `上传失败：上游返回 ${status}` };
}

/** 校验响应形状；形状不对时返回 `null`，由调用方当成失败处理。 */
export function decodeUploadedDocument(raw: unknown): UploadedDocument | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.docId !== 'string' || value.docId === '') return null;
  if (typeof value.filename !== 'string') return null;
  if (typeof value.chunks !== 'number' || !Number.isFinite(value.chunks)) return null;
  return { docId: value.docId, filename: value.filename, chunks: value.chunks };
}

/** 上传地址。桌面壳没有 cookie，认证只能走 `?token=`。 */
export function uploadEndpoint(baseUrl: string, token: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return `${trimmed}${NAVIGATE_UPLOAD_PATH}?token=${encodeURIComponent(token)}`;
}
