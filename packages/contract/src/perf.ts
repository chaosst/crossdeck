/**
 * 性能快照 —— M6-1 的量化口径。
 *
 * ## 为什么把「怎么测」写进契约层
 *
 * 性能数字最容易变成一团含糊：「冷启动 800ms」到底是进程起跑算起，
 * 还是窗口出现算起？不写清楚，同一个人隔一周测出两个数都不知道为什么。
 * 所以字段注释里写死了**测量起点与终点**，而不是留一句"启动耗时"。
 *
 * ## 哪些字段来自哪一侧
 *
 * 三个字段只有壳能测（内存、渲染进程、帧率），一个字段只有 main 能测（起跑时刻），
 * 所以采集必然是**两侧汇聚**：
 *
 *   · main 侧：模块加载即记 `bootAt`（越早越接近真实启动）
 *   · 渲染层：首帧可交互时上报一次（`firstPaint`），流式结束时上报帧率（`streamFps`）
 *   · `perf:sample` 每次调用都把两侧最新值汇成一个快照返回
 *
 * 时钟统一用 main 的 `Date.now()` —— 渲染层的 `performance.now()` 是另一个原点，
 * 混用会得到一个看着合理、实际无意义的差值。
 */

export interface PerfSnapshot {
  /**
   * 进程起跑 → 渲染层首帧可交互（ms）。
   *
   * 起点是 main 模块加载那一刻，终点由渲染层在首帧后主动上报
   * （不是 main 猜的 "did-finish-load"，那个时机早于 React 挂载完）。
   */
  readonly coldStartMs: number;
  /** `process.memoryUsage().rss`（字节）。 */
  readonly mainRssBytes: number;
  /**
   * 渲染进程的 `webContents.getProcessMemoryInfo().private`（字节）。
   *
   * 取 `private` 而不是 `residentSet`：后者含共享库，多开几个窗口会互相叠加，
   * 拿它做基线会得到"窗口越多越吃内存"的假象。
   */
  readonly rendererRssBytes: number;
  /**
   * 流式期间的实测帧率，由渲染层用 `requestAnimationFrame` 测（**没测过为 0**）。
   *
   * 为什么不在 main 侧算：main 只能数"推了多少次"，那是吞吐不是帧率 ——
   * 推得再多、渲染层掉帧，用户体验依然是卡的。0 表示"还没跑过流式"，
   * 不要把它当成"帧率是 0"。
   */
  readonly streamFps: number;
}

/** 渲染层向 main 上报采样的入口。全部可选 —— 只报自己刚测到的那一项。 */
export interface PerfSampleInput {
  /** 首帧可交互时置 true，让 main 结算冷启动耗时 */
  readonly firstPaint?: boolean;
  /** 流式结束后给出实测帧率 */
  readonly streamFps?: number;
}

/** 计划里的目标值 —— 与 docs/perf.md 的表格同源，改一处即可。 */
export const PERF_TARGETS = {
  coldStartMs: 1200,
  mainRssBytes: 150 * 1024 * 1024,
  rendererRssBytes: 250 * 1024 * 1024,
  streamTtftMs: 300,
  streamFps: 55,
  installerBytes: 100 * 1024 * 1024,
} as const;

export type PerfMetric = keyof typeof PERF_TARGETS;

/**
 * 达标判定。**不达标不是错误** —— 它是一条要如实写进报告、并附上改进项的事实。
 * 所以返回的是 `boolean` 而不是抛错。
 */
export function meetsTarget(metric: PerfMetric, actual: number, target: number = PERF_TARGETS[metric]): boolean {
  // 帧率越高越好，其余越低越好 —— 这一个方向差异值得显式写出来
  return metric === 'streamFps' ? actual >= target : actual <= target;
}

/** 字节数的可读化，报告与 UI 共用一份口径。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
}
