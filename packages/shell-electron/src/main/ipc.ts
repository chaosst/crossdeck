import { ipcMain } from 'electron';
import { toSerializedError } from '@crossdeck/contract';
import type {
  HandlerCtx,
  InvokeChannel,
  InvokeHandler,
  IpcEnvelope,
} from '@crossdeck/contract';

/**
 * main 侧的 invoke 注册器 —— ipcMain.handle 的类型安全包装。
 *
 * M0 时这里是一个内存 Map（为了在没有 electron 依赖时也能做类型验证）。
 * M1 换成真实的 ipcMain.handle，并补上三件 M0 故意没做的事：
 *
 *   1. **错误信封**：Electron 会把手抛的 Error 拍平成字符串，自定义属性（如 code）全丢。
 *      所以统一返回 `{ ok, value } | { ok, error }`，由 preload 解包还原成 AppError。
 *   2. **重复注册保护**：同一个通道注册两次会让后注册的静默覆盖前者，
 *      是那种上线后才发现的 bug，直接在启动期抛出来。
 *   3. **中断状态**：isAborted 由 main 侧持有，供长耗时的流式 handler 中途退出。
 */

/** 已被中断的 run。刻意不清理大对象 —— 只存 id 字符串，进程内量级可忽略。 */
const abortedRuns = new Set<string>();
const registered = new Set<InvokeChannel>();

/** 供 agentAbort 使用：先登记中断，再让 handler 自己观察退出。 */
export function markRunAborted(runId: string): void {
  abortedRuns.add(runId);
}

export function isRunAborted(runId: string): boolean {
  return abortedRuns.has(runId);
}

export function defineInvoke<K extends InvokeChannel>(
  channel: K,
  handler: InvokeHandler<K>,
): void {
  if (registered.has(channel)) {
    throw new Error(`IPC 通道重复注册：${channel}（后者会静默覆盖前者，必须在启动期拦住）`);
  }
  registered.add(channel);

  ipcMain.handle(channel, async (event, req): Promise<IpcEnvelope<unknown>> => {
    const ctx: HandlerCtx = {
      senderWindowId: event.sender.id,
      isAborted: isRunAborted,
    };

    try {
      // 异构注册表：handler 的 req/res 各不相同，ipcMain 只给 any。
      // 这个 cast 是「擦除通道泛型」的唯一代价，刻意收敛在这一行，
      // 不让它在调用侧泄漏成 any。
      const value = await handler(req as never, ctx);
      return { ok: true, value };
    } catch (err) {
      return { ok: false, error: toSerializedError(err) };
    }
  });
}

/** 已注册的通道列表（启动自检用：期望的通道是否都挂上了）。 */
export function registeredChannels(): InvokeChannel[] {
  return [...registered];
}
