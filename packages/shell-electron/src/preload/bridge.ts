import type { BridgeApi, InvokeArgs, InvokeChannel } from '@crossdeck/contract';

/**
 * preload 侧的桥实现。
 *
 * 这是 renderer 唯一能触达 main 的入口 —— 暴露面必须最小。
 * M1 起用 contextBridge.exposeInMainWorld('bridge', api) 挂上，
 * 并确保 sandbox: true + contextIsolation: true 下依然可用。
 */
export function defineBridge(): BridgeApi {
  return {
    invoke<K extends InvokeChannel>(channel: K, ..._args: InvokeArgs<K>) {
      // TODO(M1): return ipcRenderer.invoke(channel, args[0])
      throw new Error(`TODO(M1): wire to ipcRenderer.invoke — channel=${String(channel)}`);
    },

    onStream(_handler) {
      // TODO(M1): ipcRenderer.on(IPC.agentStream, (_e, payload) => handler(payload)); 返回取消订阅
      return () => {};
    },
  };
}
