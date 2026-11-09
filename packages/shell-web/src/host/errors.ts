/**
 * 错误编码 —— 与主进程那一套**同一个形状**。
 *
 * 桌面壳里 `[CODE:DETAIL]` 前缀是被逼出来的：contextBridge 会把自定义属性丢掉，
 * 只剩 message 能过桥。Web 壳没有那道桥（同进程），但**消费方是同一份 UI** ——
 * `describeIpcError` 读的就是这个前缀。所以这里跟着编码，不是为了模仿，
 * 而是让同一段 UI 在两端拿到同样的 code / detail。
 */

import type { IpcErrorCode } from '@crossdeck/contract';

/** 抛一个带 `[CODE]` / `[CODE:DETAIL]` 前缀的错误。 */
export function fail(code: IpcErrorCode, message: string, detail?: string): never {
  const tag = detail === undefined ? code : `${code}:${detail}`;
  throw new Error(`[${tag}] ${message}`);
}

/** 把任意异常变成一句话（日志用）。 */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
