/**
 * @crossdeck/core —— 平台无关的 Agent 内核。
 *
 * M0 阶段：只落地 CapabilityPort 契约。
 * M1 起：从 navigate 抽取 session / agent / events 三个模块（见方案 §8）。
 */

export * from './ports.js';
