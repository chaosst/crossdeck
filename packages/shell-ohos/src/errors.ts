/**
 * 壳侧的错误出口 —— 把领域拒绝翻成 `[CODE:DETAIL] message` 信封。
 *
 * 与 `packages/shell-web/src/host/errors.ts` 同一份写法（远期可抽 packages/host）：
 * 端口层与通道层之间只传字符串，错误语义全靠信封原文携带，
 * UI 侧用 contract 的 `parseIpcError` 解回结构化的 code/detail。
 */

import { formatIpcError } from '@crossdeck/contract';
import type { IpcErrorCode } from '@crossdeck/contract';

export function fail(code: IpcErrorCode, message: string, detail?: string): never {
  throw new Error(formatIpcError(code, message, detail));
}

/** 浏览器/ArkWeb 抛的是 DOMException 或随手 new 的 Error；不归一就全落成 UNKNOWN。 */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
