import type { BridgeApi } from '@crossdeck/contract';

/**
 * 平台桥的注入点。
 *
 * 渲染层不认识 `window.bridge`、也不认识 IPC —— 它只认识 `BridgeApi`。
 * 谁把桥放进来，决定了这一份 UI 跑在哪个壳里。
 */
let current: BridgeApi | null = null;

export function setBridge(bridge: BridgeApi): void {
  current = bridge;
}

/** 取桥。未注入即调用属于装配错误，直接抛 —— 静默降级会变成"点了没反应"。 */
export function requireBridge(): BridgeApi {
  if (current === null) {
    throw new Error('bridge 尚未注入 —— 必须先经 mountApp({ bridge }) 启动');
  }
  return current;
}
