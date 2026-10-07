/**
 * 性能采样（M6-1）—— 两侧汇聚，口径见 `contract/src/perf.ts`。
 *
 * 这个模块刻意很小，它只做三件事：
 *   1. 记下 main 的起跑时刻（模块顶层，越早越准）
 *   2. 收渲染层上报的两个数（首帧、帧率）—— 那两项 main 测不到
 *   3. 被问到时把两侧最新值汇成一个快照
 *
 * 没有采样循环、没有后台定时器：性能数字只有在**被问的那一刻**才有意义，
 * 常驻采样会自己变成一个性能问题（而且会让"冷启动"这个数字失真）。
 */
import { app, webContents } from 'electron';
import type { PerfSampleInput, PerfSnapshot } from '@crossdeck/contract';

/**
 * 起跑时刻。
 *
 * 放在模块顶层执行 —— main 的入口一 import 就到了这里，比 `app.whenReady()`
 * 早了整个 Electron 引导阶段，那正是用户真正等待的那段时间。
 * 用 `Date.now()` 而不是 `performance.now()`：渲染层上报的是挂钟事件，
 * 两侧必须同一原点（见契约层的注释）。
 */
const BOOT_AT = Date.now();

let firstPaintAt = 0;
let lastStreamFps = 0;

/** 记账渲染层刚报上来的采样点。 */
export function notePerfSample(input: PerfSampleInput): void {
  // 首帧只记第一次 —— 窗口重建、HMR 重挂都会再报一次，
  // 覆盖它会让"冷启动"变成"最后一次刷新耗时"。
  if (input.firstPaint === true && firstPaintAt === 0) {
    firstPaintAt = Date.now();
  }
  // 非有限值（NaN / Infinity）挡在状态外：它们一旦进来，报告里会出现
  // "帧率 NaN"这种没法判定达标与否的东西，而源头早就无迹可寻了。
  if (typeof input.streamFps === 'number' && Number.isFinite(input.streamFps) && input.streamFps >= 0) {
    lastStreamFps = input.streamFps;
  }
}

/**
 * 读当前快照。
 *
 * @param senderWindowId 发起调用的窗口 —— 渲染进程内存必须问那个具体的
 *   webContents：多窗口下问"当前窗口"是个必然出错的隐式上下文（同 M4 的
 *   `workspaceId` 那条判断）。
 */
export function readPerfSnapshot(senderWindowId: number): PerfSnapshot {
  let rendererRssBytes = 0;
  const wc = webContents.fromId(senderWindowId);
  if (wc !== undefined && !wc.isDestroyed()) {
    // ⚠️ Electron 44 **没有** `webContents.getProcessMemoryInfo()`（早期版本有，已移除）。
    //    现在只能走 `app.getAppMetrics()` 枚举全部进程，再按 **pid** 挑出这个窗口的
    //    渲染进程 —— 不能按 `type === 'Tab'` 挑：多窗口时会有好几个 Tab。
    //    `getOSProcessId()` 是渲染进程的真实 pid，这是唯一可靠的对应关系。
    const pid = wc.getOSProcessId();
    const metric = app.getAppMetrics().find((m) => m.pid === pid);
    if (metric !== undefined) {
      // `privateBytes`（不与其他进程共享的部分）最能代表"这个进程自己占了多少"，
      // 但它标了 `@platform win32` —— 别的平台拿不到就退到 workingSetSize。
      // ⚠️ Electron 的结构体里这两个字段的单位是 **KB**，而这个数量级一旦搞错
      //    会得到"渲染进程占 80KB"这种荒谬但看着正常的数字，所以显式乘回去。
      const kb = metric.memory.privateBytes ?? metric.memory.workingSetSize;
      rendererRssBytes = kb * 1024;
    }
  }

  return {
    coldStartMs: firstPaintAt === 0 ? 0 : firstPaintAt - BOOT_AT,
    mainRssBytes: process.memoryUsage().rss,
    rendererRssBytes,
    streamFps: lastStreamFps,
  };
}

/**
 * 自检专用：把两个"只记第一次"的采样点复位。
 *
 * 没有它，自检在同一个进程里跑第二遍时会复用上一遍的首帧时刻 ——
 * 第二次的"冷启动"读数会变成一次莫名其妙的小数字，而且**不会报错**。
 */
export function resetPerfForSelfCheck(): void {
  firstPaintAt = 0;
  lastStreamFps = 0;
}

/** 诊断用：main 的起跑时刻。 */
export function perfBootAt(): number {
  return BOOT_AT;
}
