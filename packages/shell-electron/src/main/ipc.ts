import type { InvokeChannel, InvokeHandler } from '@crossdeck/contract';

/**
 * main 侧的 invoke 注册器。
 *
 * M0：先落到内存注册表，纯类型验证用 —— 因此无需 electron 依赖即可跑。
 * M1：把 set 换成 ipcMain.handle，并在 handler 外层统一包裹
 *     「错误序列化」（Electron 会把 Error 拍平成字符串，需要显式编码 code）。
 */

const registry = new Map<InvokeChannel, InvokeHandler<InvokeChannel>>();

export function defineInvoke<K extends InvokeChannel>(
  channel: K,
  handler: InvokeHandler<K>,
): void {
  // TODO(M1): ipcMain.handle(channel, (event, req) =>
  //   handler(req, {
  //     senderWindowId: event.sender.id,
  //     isAborted: (runId) => abortedRuns.has(runId),
  //   }),
  // );
  // 注册表内部是异构存储（每个通道的 req/res 各不相同），
  // 对外接口 defineInvoke 依然是按通道精确推导的。
  // 这行 cast 就是「擦除通道泛型」的唯一代价，刻意收敛在这里，
  // 不让它在调用侧泄漏成 any。
  registry.set(channel, handler as unknown as InvokeHandler<InvokeChannel>);
}

/** 已注册的通道列表（用于启动自检：期望的通道是否都挂上了）。 */
export function registeredChannels(): InvokeChannel[] {
  return [...registry.keys()];
}
