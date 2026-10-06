/**
 * 自动更新的载荷定义 —— main → renderer 的进度、以及检查结果。
 *
 * 为什么这里**不新增 Port**：
 *   自动更新是纯平台能力（只有 Electron 有 electron-updater，Web 没有，
 *   鸿蒙要走 AppGallery 那一套）。core 不需要知道它怎么实现 ——
 *   core 只靠 `capabilities.has('update.auto')` 决定要不要渲染更新入口。
 *   为三端不可能统一的能力硬造抽象，只会得到一个谁都不像的接口。
 *
 * 为什么 `UpdateStatus` 是**判别联合**而不是 `{ stage; info?; percent?; message? }`：
 *   松散的形状让「永远转圈」在类型上**完全合法** ——
 *   一个只带 `stage: 'downloading'` 却没有 percent 的状态照样能编译通过，
 *   于是一个没有进度、也没有失败的原因的按钮就这样进了生产。
 *   写成联合之后：
 *     · `available` / `ready` 必须带 info（UI 要显示"新版本 x.y.z 可用"）
 *     · `downloading` 必须带 percent（否则进度条没有可渲染的数字）
 *     · `error` 必须带 message（无签名环境下 electron-updater 会静默降级，
 *       这里就是那个"必须如实说出来"的出口）
 *   这是本仓库对 stream.ts 的同一套处理：让非法状态写不出来，而不是靠自觉。
 */

/** 更新流程所处的阶段。取 `UpdateStatus['stage']`，不另立一份定义 —— 避免两处走散。 */
export type UpdateStage = UpdateStatus['stage'];

export interface UpdateInfo {
  /** 归一化后的版本号（不带 `v`，形如 `1.10.0`） */
  version: string;
  /** release notes；feed 没给就省略 */
  notes?: string;
  /** 发布时间戳（ms）；feed 没给就省略 */
  releasedAt?: number;
}

export type UpdateStatus =
  | { stage: 'idle' }
  /** 正在问 feed。UI 可以把按钮置灰，但**必须**能从这个阶段离开。 */
  | { stage: 'checking' }
  | { stage: 'available'; info: UpdateInfo }
  /** percent 是 0–100 的整数，由 core 的进度追踪器保证单调不回退 */
  | { stage: 'downloading'; info: UpdateInfo; percent: number }
  /** 已下载完，等重启安装 */
  | { stage: 'ready'; info: UpdateInfo }
  /**
   * 失败。**必须**带一句人话 message。
   *
   * `retryable` 用来区分两类失败，UI 据此决定给不给「重试」按钮：
   *   · true  —— 网络抖动、feed 暂时不可达：重试有意义
   *   · false —— 无签名证书、平台不支持：重试一万次还是同一个结果
   */
  | { stage: 'error'; message: string; retryable: boolean };

/** 终态：不会再自行变化，UI 到此可以停止转圈。 */
export function isTerminalStage(stage: UpdateStage): boolean {
  return stage === 'idle' || stage === 'ready' || stage === 'error';
}
