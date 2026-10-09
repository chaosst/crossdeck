/**
 * @crossdeck/core —— 平台无关的 Agent 内核。
 *
 * 模块：
 *   ports     平台能力契约
 *   session   SessionStore（时钟与 id 均注入）
 *   fs        WorkspaceStore / PathGuard / resolveInWorkspace
 *   events    StreamBus（事件分发与退订）
 *   agent     AgentRuntime / BackpressurePump / ModelPort / 工具链路
 *   net       SseParser、navigate 帧映射、navigateStream（壳无关状态机）、ChatClient
 *   update    版本比较 / 进度 / feed
 *
 * 两条铁律：
 *   ① **不得** import 任何平台 API（electron / node:* / @ohos.*），由 `pnpm verify:core-purity` 强制。
 *   ② 对 contract 只做 `import type`、**零运行时依赖** —— 让 core 的产物能被裸 Node
 *      直接加载做单测（`pnpm verify:core-scope`），且 contract/core 可被 ArkTS 直接消费。
 */

export * from './ports.js';
export * from './errorMessage.js';
export * from './session/store.js';
export * from './fs/posixPath.js';
export * from './fs/workspaceStore.js';
export * from './fs/pathGuard.js';
export * from './fs/resolveInWorkspace.js';
export * from './net/sse.js';
export * from './net/navigate.js';
export * from './net/navigateStream.js';
export * from './net/navigateAuth.js';
export * from './net/chatClient.js';
export * from './events/streamBus.js';
export * from './agent/deps.js';
export * from './agent/backpressure.js';
export * from './agent/tools.js';
export * from './agent/model.js';
export * from './agent/runtime.js';
export * from './update/version.js';
export * from './update/progress.js';
export * from './update/feed.js';
