/**
 * 上传文档到 navigate。
 *
 * `fetch` 不带上传进度，所以 multipart 体由本模块手写：逐块读文件、逐块计数，
 * 顺便把「发出的文件字节 == stat 出来的大小」这条对账落实。
 */

import { open } from 'node:fs/promises';
import { AppError } from '@crossdeck/contract';
import type { UploadedDocument } from '@crossdeck/contract';
import {
  UPLOAD_FIELD,
  advanceUploadProgress,
  beginUploadProgress,
  decodeUploadedDocument,
  describeUploadStatus,
  uploadEndpoint,
  type UploadProgress,
  type UploadProgressState,
} from '@crossdeck/core';

/** 每次读盘的块大小：够大以摊薄 syscall，够小以让进度条动起来。 */
const CHUNK_SIZE = 64 * 1024;

const UPLOAD_TIMEOUT_MS = 120_000;
const RESPONSE_TIMEOUT_MS = 15_000;

export interface UploadInput {
  readonly baseUrl: string;
  readonly token: string;
  /** 原始文件名（UTF-8，不做二次编码 —— 服务端只做一次 Latin-1 → UTF-8 修复）。 */
  readonly fileName: string;
  /** 已过 scope 校验的绝对路径。 */
  readonly absolutePath: string;
  /** 调用方 stat 出来的大小，用于字节对账。 */
  readonly sizeBytes: number;
  readonly now?: () => number;
  readonly onProgress?: (progress: UploadProgress) => void;
  readonly signal?: AbortSignal;
}

/** multipart 里出现的文件名：引号与换行会把头部弄坏。 */
function escapeFileName(name: string): string {
  return name.replace(/["\r\n]/g, '_');
}

function makeBoundary(now: number): string {
  return `----crossdeck${now.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export interface MultipartHead {
  readonly boundary: string;
  readonly head: Buffer;
  readonly tail: Buffer;
  readonly contentLength: number;
}

/** 头尾字节可以精确算出来 —— 不用 len(request.body) 去猜。 */
export function buildMultipartFraming(fileName: string, sizeBytes: number, boundary: string): MultipartHead {
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${UPLOAD_FIELD}"; filename="${escapeFileName(fileName)}"\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n',
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return { boundary, head, tail, contentLength: head.length + sizeBytes + tail.length };
}

interface UploadResult {
  readonly document: UploadedDocument;
  /** 实际发出的**文件段**字节数（不含 multipart 头尾），与 `sizeBytes` 对账。 */
  readonly fileBytesSent: number;
  readonly progress: UploadProgress;
}

export async function uploadDocument(input: UploadInput): Promise<UploadResult> {
  const now = input.now ?? ((): number => Date.now());
  const handle = await open(input.absolutePath, 'r');
  // 声明的字节数必须与磁盘一致 —— 少传一段照样能拿到 200，只是索引里少了半篇文章。
  const actual = await handle.stat();
  if (actual.size !== input.sizeBytes) {
    await handle.close();
    throw new AppError(
      'INTERNAL',
      `文件大小与声明不符：磁盘 ${actual.size}B，声明 ${input.sizeBytes}B`,
      'SIZE_MISMATCH',
    );
  }
  const framing = buildMultipartFraming(input.fileName, input.sizeBytes, makeBoundary(now()));

  let state: UploadProgressState = beginUploadProgress(input.sizeBytes, now());
  let fileBytesSent = 0;
  let offset = 0;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(framing.head));
    },
    async pull(controller) {
      if (offset >= input.sizeBytes) {
        controller.enqueue(new Uint8Array(framing.tail));
        controller.close();
        return;
      }
      const length = Math.min(CHUNK_SIZE, input.sizeBytes - offset);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead <= 0) {
        // 文件在上传过程中被截短了：继续发只会得到一个有头无尾的 multipart
        controller.error(new AppError('INTERNAL', '文件在读取过程中变短了，上传已中止'));
        return;
      }
      offset += bytesRead;
      fileBytesSent += bytesRead;
      controller.enqueue(new Uint8Array(buffer.subarray(0, bytesRead)));

      const step = advanceUploadProgress(state, fileBytesSent, now());
      state = step.state;
      input.onProgress?.(step.progress);
    },
    async cancel(reason) {
      await handle.close();
      throw reason;
    },
  });

  const timeout = AbortSignal.timeout(UPLOAD_TIMEOUT_MS);
  const signals = input.signal === undefined ? [timeout] : [timeout, input.signal];

  let response: Response;
  try {
    response = await fetch(uploadEndpoint(input.baseUrl, input.token), {
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${framing.boundary}`,
        // 显式给出长度：流式请求体没有它，服务端只能等到连接关闭才敢说"收完了"
        'content-length': String(framing.contentLength),
      },
      body,
      // 流式请求体在 undici 里必须显式声明半双工
      duplex: 'half',
      signal: AbortSignal.any(signals),
    } as RequestInit & { duplex: 'half' });
  } catch (err) {
    await handle.close();
    throw new AppError('UPSTREAM', describeNetworkError(err, UPLOAD_TIMEOUT_MS));
  }

  const text = await readBodyText(response, signals);
  await handle.close();

  if (!response.ok) {
    const failure = describeUploadStatus(response.status);
    const detail =
      failure.reason === 'unparsable'
        ? 'UNPARSABLE'
        : failure.reason === 'forbidden'
          ? 'ROLE'
          : failure.reason === 'unauthorized'
            ? 'AUTH_EXPIRED'
            : failure.reason === 'too-large'
              ? 'TOO_LARGE'
              : 'HTTP';
    throw new AppError(response.status === 422 || response.status === 413 ? 'BAD_REQUEST' : response.status === 401 || response.status === 403 ? 'FORBIDDEN' : 'UPSTREAM', failure.message, detail);
  }

  const parsed = parseJson(text);
  const document = decodeUploadedDocument(parsed);
  if (document === null) {
    throw new AppError('UPSTREAM', '上传响应不符合契约（缺 docId / filename / chunks）', 'SHAPE');
  }

  // 对账：发出去的文件段字节必须与 stat 一致。
  // 只看"请求成功"是不够的 —— 少发一段同样会得到 200，只是索引里少了半篇文章。
  if (fileBytesSent !== input.sizeBytes) {
    throw new AppError(
      'INTERNAL',
      `字节对账不平：stat ${input.sizeBytes}B，实际发出 ${fileBytesSent}B`,
      'BYTES_MISMATCH',
    );
  }

  return {
    document,
    fileBytesSent,
    progress: advanceUploadProgress(state, input.sizeBytes, now()).progress,
  };
}

async function readBodyText(response: Response, signals: readonly AbortSignal[]): Promise<string> {
  try {
    const textSignal = AbortSignal.any([AbortSignal.timeout(RESPONSE_TIMEOUT_MS), ...signals]);
    return await response.text();
  } catch {
    return '';
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function describeNetworkError(err: unknown, timeoutMs: number): string {
  const name = err instanceof Error ? err.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return `上传超时（${Math.round(timeoutMs / 1000)}s 内没传完）`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return `无法连接上游：${message}`;
}
