import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { encodeBridgeError, isIpcEnvelope } from '@crossdeck/contract';
import type {
  BridgeApi,
  InvokeArgs,
  InvokeChannel,
  IpcInvokeMap,
  PushChannel,
  PushPayload,
} from '@crossdeck/contract';

/**
 * preload —— renderer 唯一能触达 main 的入口，暴露面必须最小。
 *
 * 四件事：
 *   1. **白名单**：只暴露 invoke + on 两个方法，不暴露 ipcRenderer 本体。
 *      （把 ipcRenderer 整个丢给渲染层等于把整张通道表都开放了，
 *        包括任何将来新增的危险通道。）
 *      两个方法都是泛型的，所以白名单长度**不随通道数量增长** ——
 *      推送通道的合法取值由 contract 的 IpcPushMap 收口。
 *   2. **解信封**：main 返回的是 `{ ok, value } | { ok, error }`，
 *      这里还原成「成功返回值 / 失败抛错」，让调用侧保持 Promise<res> 的直觉。
 *   3. **错误码再编码**：见下方 encodeBridgeError 的注释 ——
 *      contextBridge 只搬运 message，不搬运自定义属性，所以 code 必须写进 message。
 *   4. **冻结导出对象**：防止渲染层替换 window.bridge.invoke 造成"看起来在调用、
 *      实际走了别的东西"的调试陷阱。
 *
 * ⚠️ 这个文件必须打成 **CJS**：`sandbox: true` 下 Electron 不支持 ESM preload。
 *    打包见 scripts/build.mjs（esbuild，format=cjs，outfile=bridge.cjs）。
 */

async function invoke<K extends InvokeChannel>(
  channel: K,
  ...args: InvokeArgs<K>
): Promise<IpcInvokeMap[K]['res']> {
  const raw: unknown = await ipcRenderer.invoke(channel, args[0]);

  if (!isIpcEnvelope(raw)) {
    // 走到这里说明 main 的返回形状被破坏了（中间层改写 / 版本错配）。
    // 宁可在这里大声失败，也不要把它当成功值往上传。
    throw encodeBridgeError(raw);
  }
  if (!raw.ok) {
    throw encodeBridgeError(raw.error);
  }
  return raw.value as IpcInvokeMap[K]['res'];
}

function on<K extends PushChannel>(
  channel: K,
  handler: (payload: PushPayload<K>) => void,
): () => void {
  const listener = (_event: IpcRendererEvent, payload: unknown): void => {
    // 载荷类型由 IpcPushMap 决定；main 侧就是按同一份类型推的，
    // 这里不再做运行时校验 —— 校验的是"通道名合法"，那是编译期的事。
    handler(payload as PushPayload<K>);
  };

  ipcRenderer.on(channel, listener);

  // 必须返回取消订阅：renderer 里 React 组件卸载时若不摘监听，
  // 每次挂载都会多一个监听器，表现为「同一条流被渲染 N 次」——
  // 这是流式 UI 最典型的泄漏形态。
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: BridgeApi = Object.freeze({ invoke, on });

contextBridge.exposeInMainWorld('bridge', api);
