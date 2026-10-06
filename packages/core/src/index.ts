/**
 * @crossdeck/core —— 平台无关的 Agent 内核。
 *
 * 已落地：
 *   M0 — CapabilityPort 契约（ports.ts）
 *   M1 — SessionStore（首个真实模块，时钟与 id 均注入）
 *   M4 — fs/：WorkspaceStore（授权表 + 归属判定）与 PathGuard（scope 校验）
 *
 * 仍未落地：从 navigate 抽取 agent / events（M4.5）。
 *
 * 铁律：本包**不得** import 任何平台 API（electron / node:* / @ohos.*）。
 * 由 `pnpm verify:core-purity` 强制检查，见 scripts/verify-core-purity.mjs。
 *
 * 另一条同样重要的约束：core 对 contract 只做 `import type`，
 * **零运行时依赖** —— 这让 core 的产物能被裸 Node 直接加载做单测
 * （见 scripts/verify-core-scope.mjs，不需要任何 TS 运行时）。
 */

export * from './ports.js';
export * from './session/store.js';
export * from './fs/posixPath.js';
export * from './fs/workspaceStore.js';
export * from './fs/pathGuard.js';
