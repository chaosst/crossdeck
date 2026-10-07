/**
 * 鸿蒙壳的能力端口 —— 与 shell-web / shell-electron 并排的第三份实现。
 *
 * 这里刻意**不做**「假装统一」：每一项能力都要么真的探测，要么如实报缺席。
 * 特别是 `window.multi` —— 它取决于设备形态（2in1 自由窗口 / 手机单窗口），
 * 所以必须真读 `deviceInfo.deviceType`，而不是写死一个常量。
 *
 * | 能力              | 鸿蒙壳                                        |
 * |------------------|----------------------------------------------|
 * | `fs.scope`       | ✅ @ohos.file.fs：应用沙箱 + 用户授权目录        |
 * | `window.multi`   | ⚠️ 仅 2in1 / tablet 具备；手机形态降级           |
 * | `shortcut.global`| ❌ 没有桌面级全局快捷键                          |
 * | `update.auto`    | ❌ 鸿蒙更新走应用市场（AppGallery），非应用内自更新 |
 * | `tray`           | ❌ 没有系统托盘概念                              |
 * | `notify.system`  | ✅ @ohos.notificationManager                   |
 */
import { deviceInfo } from '@kit.BasicServicesKit';
import type { Capability } from './contract/capability';

/** 与 contract 的 Capability 联合保持一致的一组常量，供 UI 逐项渲染。 */
export const ALL_CAPABILITIES: Capability[] = [
  'fs.scope',
  'window.multi',
  'shortcut.global',
  'update.auto',
  'tray',
  'notify.system',
];

/** 鸿蒙壳里的实现 / 缺口说明。刻意与 code 放在一起，避免 UI 与能力表走散。 */
export function capabilityNote(cap: Capability): string {
  if (cap === 'fs.scope') return '@ohos.file.fs（沙箱 + 用户授权目录）';
  if (cap === 'window.multi') return '仅 2in1/tablet 自由窗口；手机形态降级';
  if (cap === 'shortcut.global') return '鸿蒙没有桌面级全局快捷键';
  if (cap === 'update.auto') return '更新走应用市场，非应用内自更新';
  if (cap === 'tray') return '没有系统托盘概念';
  if (cap === 'notify.system') return '@ohos.notificationManager';
  return '';
}

/**
 * 真实探测（不是写死）。`deviceInfo.deviceType` 在模拟器上实测返回
 * `phone` / `2in1` / `tablet` / `foldable`，正是能力差异的判据。
 */
export function detectCapabilities(): Capability[] {
  const caps: Capability[] = [];

  // 沙箱内的文件读写是平台固有的 —— 真正的不确定性在「用户授权目录」那一侧，
  // 那需要 filePicker 交互，能力探测阶段只能声明"这条通路存在"。
  caps.push('fs.scope');

  // 自由窗口：只有 PC / 平板形态成立。手机模拟器上这里会**如实少一项**，
  // 于是 UI 也会少渲染"新建窗口" —— 这正是"能力探测优于平台判断"的现场。
  const kind: string = deviceInfo.deviceType;
  if (kind === '2in1' || kind === 'tablet') {
    caps.push('window.multi');
  }

  caps.push('notify.system');
  return caps;
}

/** 当前设备形态（诊断用，UI 上展示一行）。 */
export function deviceKind(): string {
  return deviceInfo.deviceType;
}
