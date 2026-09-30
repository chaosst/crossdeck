/**
 * @crossdeck/core —— 平台无关的 Agent 内核。
 *
 * M0 阶段：只落地 CapabilityPort 契约。
 * M1 阶段：补上 SessionStore（首个真实模块）+ 从 navigate 抽取 agent / events。
 *
 * 铁律：本包**不得** import 任何平台 API（electron / node:* / @ohos.*）。
 * 由 `pnpm verify:core-purity` 强制检查，见 scripts/verify-core-purity.mjs。
 */

export * from './ports.js';
export * from './session/store.js';
