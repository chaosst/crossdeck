import type { BridgeApi } from '@crossdeck/contract';

/**
 * window.bridge 的全局声明 —— 全项目**唯一**一处。
 *
 * 放在 .d.ts 而不是 api.ts 里，是为了让 api.ts 保持"纯消费方"：
 * 它只演示怎么用，不负责声明桥长什么样。
 * 两侧共用同一份 BridgeApi，所以 renderer 写错方法名 / 参数 → 编译期报错。
 */

declare global {
  interface Window {
    /** preload 通过 contextBridge 暴露的唯一入口（main 侧暴露面白名单） */
    readonly bridge: BridgeApi;
  }
}

export {};
