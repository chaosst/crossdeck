/**
 * 会话变更的广播口。
 *
 * 推给**所有**窗口（不只发起者）：窗口 B 也在看同一个会话，它得知道有变化。
 * 只报「哪个会话动了」，重拉由渲染层自己决定 —— 推送里塞全量数据会变成第二条数据源。
 */

import { webContents } from 'electron';
import { IPC } from '@crossdeck/contract';
import type { SessionChange } from '@crossdeck/contract';

export function broadcastSessionChange(change: SessionChange): void {
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue;
    // 只发给真正的窗口：devtools / 隐藏的 webview 不需要这份数据。
    if (wc.getType() !== 'window') continue;
    wc.send(IPC.sessionChanged, change);
  }
}
