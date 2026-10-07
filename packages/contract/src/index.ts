/**
 * @crossdeck/contract —— 共享类型契约。
 *
 * 这个包**只有类型 + 常量 + 极少量纯函数**，零运行时依赖，
 * 不得 import 任何平台 API（electron / node:* / @ohos.*）。
 * 它是 main / preload / renderer 三处唯一的共同祖先，
 * 也是「一套 core 多端壳」的编译期保证。
 */

export * from './capability.js';
export * from './ipc.js';
export * from './entities.js';
export * from './stream.js';
export * from './invoke-map.js';
export * from './push-map.js';
export * from './types.js';
export * from './workspace.js';
export * from './update.js';
export * from './perf.js';
export * from './error.js';
