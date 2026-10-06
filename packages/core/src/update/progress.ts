import { parseVersion } from './version.js';

/**
 * 下载进度的规范化 —— 又一个「错了也不抛异常」的地方。
 *
 * electron-updater 把 `download-progress` 的原始事件直接抛给调用方：
 *   · percent 是浮点（43.2142…），偶尔会因为 chunk 重试而**回退**
 *   · 换版本重新下载时，新版本会从 0 开始，但旧事件可能还在路上
 *   · 二进制包体积异常时会给到 >100 的值
 * 这三种情况都不抛错，只会表现为「进度条往回跳」「切了新版本还停在 87%」——
 * 用户说不清哪里不对，只会觉得这个软件不靠谱。
 *
 * 所以把它写成 core 里的一段纯函数：给定上一个状态和一个原始输入，
 * 返回下一个状态。没有 electron、没有计时器，可以被完全确定地验证。
 *
 * 刻意**不**做成类：状态是数据，调用方自己持有 —— 这样它天然可以被快照、
 * 被序列化进事件载荷，也不会在模块级藏一份跨窗口共享的可变状态。
 */

export interface ProgressState {
  /** 当前正在下载的版本（归一化后）。null 表示还没开始。 */
  readonly version: string | null;
  /** 0–100 的整数。单调不减（同一版本内）。 */
  readonly percent: number;
  /**
   * 被规范化掉的异常输入次数。
   *
   * target 是 0。非 0 说明上游给的进度数字不可信 —— 这是**观测指标**，
   * 不该让用户看见，但值得出现在日志/自检里：
   * 一个恒为 0 的计数器和一个偶尔跳动的计数器，含义完全不同。
   */
  readonly anomalies: number;
}

export const INITIAL_PROGRESS: ProgressState = { version: null, percent: 0, anomalies: 0 };

/** 版本号可能带 `v` 前缀或空格，先归一到同一把尺子上再比对。 */
function identity(version: string): string {
  return parseVersion(version)?.normalized ?? version.trim();
}

/**
 * 把一次原始进度事件折进状态。
 *
 * @param prev  上一次的状态（首帧传 INITIAL_PROGRESS）
 * @param input 上游给的版本号与百分比（可以是任何东西，包括 NaN / 负数 / 120）
 */
export function nextProgress(
  prev: ProgressState,
  input: { readonly version: string; readonly percent: number },
): ProgressState {
  const version = identity(input.version);

  // ── 换版本：进度必须归零重来 ──────────────────────────
  // 不归零的话，切到新版本后进度条会从上一个版本的 87% 接着走，
  // 然后停在 99% 不动 —— 因为新版本只发到 30% 就被 max() 顶回去了。
  // 注意 anomalies 是**会话级**计数，不随换版本清零：它是"上游可不可信"的
  // 观测，而不是"这一轮下载干不干净"的观测。
  const switched = version !== prev.version;
  const floor = switched ? 0 : prev.percent;
  const raw = input.percent;

  // 非有限值（NaN / Infinity / undefined 混进来）绝不能进状态：
  // 会让后续 max() 的结果永远是 NaN，进度条从此再不更新。
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return { version, percent: floor, anomalies: prev.anomalies + 1 };
  }

  // 越界：上游在说谎（或包体积算错了）。夹进区间，但记一笔。
  if (raw < 0 || raw > 100) {
    const clamped = Math.min(100, Math.max(0, Math.floor(raw)));
    return { version, percent: Math.max(floor, clamped), anomalies: prev.anomalies + 1 };
  }

  const clamped = Math.floor(raw);

  // 回退（chunk 重试会让 percent 往回走）：保留更大的那个，不跟着跳。
  if (clamped < floor) {
    return { version, percent: floor, anomalies: prev.anomalies + 1 };
  }

  return { version, percent: clamped, anomalies: prev.anomalies };
}

/** 进度是否已到 100（用于决定是否该切到 'ready'）。 */
export function isProgressComplete(state: ProgressState): boolean {
  return state.percent >= 100;
}
