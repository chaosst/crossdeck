/**
 * @crossdeck/ui —— 三端共用的渲染层。
 *
 * 对外只有一个入口：`mountApp({ bridge })`。谁提供桥，就决定这份 UI 跑在哪。
 */

export { mountApp } from './mount';
export type { MountOptions } from './mount';
export { runUiProbe, probeUiHarness } from './selfcheck/probeUi';
export type { UiCheck, UiFixture, ProbeUiDeps } from './selfcheck/probeUi';
