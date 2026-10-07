/**
 * @crossdeck/core —— 平台无关的 Agent 内核。
 *
 * 已落地：
 *   M0   — CapabilityPort 契约（ports.ts）
 *   M1   — SessionStore（首个真实模块，时钟与 id 均注入）
 *   M4   — fs/：WorkspaceStore（授权表 + 归属判定）与 PathGuard（scope 校验）
 *   M4.5 — events/：StreamBus（事件分发与退订）
 *          agent/：AgentRuntime（run 生命周期 + 工具链路）
 *                  BackpressurePump（产字↔推字解耦、帧对齐、合并中间态）
 *   nav  — net/：SseParser（SSE 文本帧解析）
 *                navigate.ts（navigate 上游帧 → 语义动作映射）
 *          —— 上游只有一份解析与映射，三端共用；IO 才是一端一份。
 *
 * 铁律：本包**不得** import 任何平台 API（electron / node:* / @ohos.*）。
 * 由 `pnpm verify:core-purity` 强制检查，见 scripts/verify-core-purity.mjs。
 *
 * 另一条同样重要的约束：core 对 contract 只做 `import type`，
 * **零运行时依赖** —— 这让 core 的产物能被裸 Node 直接加载做单测
 * （见 scripts/verify-core-scope.mjs 与 verify-core-agent.mjs，
 * 不需要任何 TS 运行时，也**不需要任何真实定时器**）。
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
export * from './events/streamBus.js';
export * from './agent/deps.js';
export * from './agent/backpressure.js';
export * from './agent/tools.js';
export * from './agent/model.js';
export * from './agent/runtime.js';
export * from './update/version.js';
export * from './update/progress.js';
export * from './update/feed.js';
