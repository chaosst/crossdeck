/**
 * 性能采样 —— Web 壳这一份。
 *
 * 浏览器能诚实回答的只有两件：首帧时刻（渲染层自己报上来）与流式帧率（rAF 实测）。
 * 进程 RSS 在页面里根本拿不到 —— `performance.memory` 是 Chromium 私有的 **JS 堆**，
 * 既不是私有内存也不是全部占用，拿它填 `rendererRssBytes` 是给一个看着正常的假数字。
 * 所以两项内存**如实报 0**：语义与 `streamFps === 0` 一致 —— 「没测到」，不是「占了 0」。
 */

import type { PerfSampleInput, PerfSnapshot } from '@crossdeck/contract';

/** 起跑时刻：模块加载那一刻。用 `Date.now()` —— 渲染层上报的是挂钟事件，两侧必须同一原点。 */
const BOOT_AT = Date.now();

let firstPaintAt = 0;
let lastStreamFps = 0;

export function notePerfSample(input: PerfSampleInput): void {
  // 首帧只记第一次 —— HMR 重挂会再报一次，覆盖它就把"冷启动"变成了"最后一次刷新"
  if (input.firstPaint === true && firstPaintAt === 0) firstPaintAt = Date.now();

  if (typeof input.streamFps === 'number' && Number.isFinite(input.streamFps) && input.streamFps >= 0) {
    lastStreamFps = input.streamFps;
  }
}

export function readPerfSnapshot(): PerfSnapshot {
  return {
    coldStartMs: firstPaintAt === 0 ? 0 : firstPaintAt - BOOT_AT,
    mainRssBytes: 0,
    rendererRssBytes: 0,
    streamFps: lastStreamFps,
  };
}
