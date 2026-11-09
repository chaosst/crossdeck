import type { BridgeApi } from '@crossdeck/contract';

/**
 * window.bridge 的全局声明 —— 只在 Electron 壳里成立。
 *
 * UI 自己不声明它：`@crossdeck/ui` 只认注入进来的 `BridgeApi`，不知道宿主
 * 是 preload 还是 ArkWeb。这个 .d.ts 描述的是**这个壳**往 window 上放了什么。
 */

declare global {
  interface Window {
    /** preload 通过 contextBridge 暴露的唯一入口（main 侧暴露面白名单） */
    readonly bridge: BridgeApi;
  }
}

export {};
