/**
 * 会话变更的广播口。
 *
 * 推给**所有**窗口（不只发起者）：窗口 B 也在看同一个会话，它得知道有变化。
 * 只报「哪个会话动了」，重拉由渲染层自己决定 —— 推送里塞全量数据会变成第二条数据源。
 */

import { webContents } from 'electron';
import { IPC } from '@crossdeck/contract';
import type { SessionChange } from '@crossdeck/contract';

/**
 * 自检专用：把广播收窄成"只推某个窗口"。
 *
 * 存在的唯一理由是 T7 那条反向实验 —— 「漏推 B 时 B 确实看不到」必须能被跑出来，
 * 否则"推给所有窗口"这条断言对"只推发起者"的实现没有任何鉴别力。
 * 它是进程内的临时开关，不落盘、不影响正常路径（默认 `null` = 全量广播）。
 */
let narrowToWindowId: number | null = null;

export function setSessionBroadcastScopeForSelfCheck(onlyWindowId: number | null): void {
  narrowToWindowId = onlyWindowId;
}

export function broadcastSessionChange(change: SessionChange): void {
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue;
    // 只发给真正的窗口：devtools / 隐藏的 webview 不需要这份数据。
    if (wc.getType() !== 'window') continue;
    if (narrowToWindowId !== null && wc.id !== narrowToWindowId) continue;
    wc.send(IPC.sessionChanged, change);
  }
}
