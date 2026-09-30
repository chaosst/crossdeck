/**
 * 平台与能力词汇表 —— 跨包共享的**唯一**定义处。
 *
 * 为什么放在 contract 而不是 core：
 *   core 的 CapabilityPort 需要它们，contract 的 SystemInfo 也需要它们。
 *   若定义在 core，contract 就得反向依赖 core，层次颠倒。
 *   放在最底层的 contract，两边都向下依赖，方向干净。
 */

/**
 * 运行平台标识。
 *
 * ⚠️ core 层**不得**用平台名做功能分支（如 `if (platform === 'electron')`），
 * 只允许用于日志与诊断。功能差异一律走 `capabilities` 能力探测。
 */
export type Platform = 'web' | 'electron' | 'ohos';

/**
 * 原子能力标识。
 *
 * core 用 `env.capabilities.has('shortcut.global')` 决定是否渲染对应 UI，
 * 而不是到处写 `platform === 'electron'`。这是「能力探测优于平台判断」的标准做法。
 */
export type Capability =
  | 'fs.scope'
  | 'window.multi'
  | 'shortcut.global'
  | 'update.auto'
  | 'tray'
  | 'notify.system';

/** 窗口种类。各壳自行映射到本平台的窗口概念（BrowserWindow / 子窗口 / window.open）。 */
export type WindowKind = 'main' | 'session' | 'settings' | 'inspector';
