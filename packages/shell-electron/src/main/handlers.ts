import { IPC } from '@crossdeck/contract';
import { defineInvoke, registeredChannels } from './ipc.js';

/**
 * main 侧 handler 注册。
 *
 * M0 只注册 2 个通道作为**类型对齐样本**：
 *   改错通道名、改错 req 形状、改错返回类型 —— 三种都会在这里编译报错。
 * M1 起补齐全部通道，并接上真实的 core / 系统能力实现。
 */
export function registerHandlers(): number {
  defineInvoke(IPC.systemInfo, async () => {
    // TODO(M1): 从 app.getVersion() / process.platform / 能力探测表读取
    return {
      platform: 'electron' as const,
      appVersion: '0.0.0',
      osVersion: 'unknown',
      locale: 'zh-CN',
      capabilities: ['fs.scope', 'window.multi', 'tray', 'notify.system'] as const,
    };
  });

  defineInvoke(IPC.sessionList, async () => {
    // TODO(M1): 交给 core 的 SessionStore
    return [];
  });

  return registeredChannels().length;
}
