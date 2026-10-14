/**
 * 行预算与显示宽度工具（纯函数、零依赖，不碰 DOM / React）。
 *
 * 用途：流式预览与工具卡片按「行」而非字符数裁剪；中文 / emoji 按显示列宽折算。
 */

/** East Asian Wide / Fullwidth 码点区间（占 2 列） */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK 部首 / 标点
  [0x3041, 0x33ff], // 假名 / 注音 / CJK 兼容
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 基本区
  [0xa000, 0xa4cf], // 彝文
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3], // 谚文音节
  [0xf900, 0xfaff], // CJK 兼容表意
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60], // 全角字符
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], // emoji
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd], // CJK 扩展 B 及以上
];

/** 零宽码点（组合符 / 变体选择符 / 零宽连接符 / 方向标记） */
const ZERO_RANGES: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f],
  [0x200b, 0x200f],
  [0xfe00, 0xfe0f],
];

/** 单个码点的显示列宽：0=组合符或变体选择符，2=东亚宽 / 全角 / emoji，其余 1 */
export function charWidth(codePoint: number): number {
  for (const [lo, hi] of ZERO_RANGES) if (codePoint >= lo && codePoint <= hi) return 0;
  for (const [lo, hi] of WIDE_RANGES) if (codePoint >= lo && codePoint <= hi) return 2;
  return 1;
}

/** 字符串的显示宽度（控制字符不计宽） */
export function textWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x20 || cp === 0x7f) continue;
    width += charWidth(cp);
  }
  return width;
}

/** 文本占用多少个行（按 columns 折行；空串 0 行，空行占 1 行） */
export function visualRows(text: string, columns: number): number {
  if (!text) return 0;
  const cols = columns > 0 ? Math.floor(columns) : 80;
  let rows = 0;
  for (const line of text.split("\n")) {
    rows += Math.max(1, Math.ceil(textWidth(line) / cols));
  }
  return rows;
}

/**
 * 单行超长时按显示列宽从**行首**切掉，保留尾部（绝不切出半截宽字符）。
 * 返回值以 `…` 开头标记被切过；maxWidth <= 1 时只返回 `…`。
 */
export function tailByWidth(line: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (textWidth(line) <= maxWidth) return line;
  const chars = Array.from(line);
  let width = 0;
  let i = chars.length;
  while (i > 0) {
    const w = charWidth(chars[i - 1]?.codePointAt(0) ?? 0);
    // 留 1 列给省略号
    if (width + w > maxWidth - 1) break;
    width += w;
    i--;
  }
  return "…" + chars.slice(i).join("");
}

/**
 * 单行硬截：保留**行首** + `…`，保证结果不超过 maxWidth 显示列。
 * （`tailByWidth` 是保尾部，这个是保头部——表格单元格、省略标记用它。）
 */
export function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 1) return "…".slice(0, Math.max(0, maxWidth));
  if (textWidth(text) <= maxWidth) return text;
  let out = "";
  let used = 0;
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0) ?? 0);
    if (used + w > maxWidth - 1) break;
    out += ch;
    used += w;
  }
  return out + "…";
}

/** 被裁掉的部分 */
export interface TailClipDrop {
  /** 整行被裁掉的行数（逻辑行） */
  lines: number;
  /** 被裁掉的字符数（含"单行硬切"时切掉的字符） */
  chars: number;
}

export interface TailClipOptions {
  /** 行预算（行数） */
  rows: number;
  /** 列数；给了才按折行计算，缺省按逻辑行计（每行 1 行） */
  columns?: number;
  /**
   * 省略标记文案。一旦发生裁剪**必然**插一行标记，
   * 所以实现必须返回非空字符串（想换措辞就换，别返回空串——否则行预算会算错）。
   */
  marker?: (drop: TailClipDrop) => string;
}

const DEFAULT_MARKER = (drop: TailClipDrop): string =>
  drop.lines > 0 ? `⋯ 已省略前 ${drop.lines} 行` : `⋯ 行首已省略 ${drop.chars} 字符`;

/**
 * 按行预算保留文本尾部（长行先按显示列宽折行再计数）。
 *
 * 不变式（有单测锁）：返回文本的 `visualRows` 不超过 `rows`（`rows ≥ 2` 时成立）。
 */
export function tailByRows(text: string, opts: TailClipOptions): string {
  if (!text) return "";
  const rows = Math.max(1, Math.floor(opts.rows));
  const cols = opts.columns && opts.columns > 0 ? Math.floor(opts.columns) : 0;
  const lineRows = (line: string): number =>
    cols > 0 ? Math.max(1, Math.ceil(textWidth(line) / cols)) : 1;

  const lines = text.split("\n");
  let total = 0;
  for (const line of lines) total += lineRows(line);
  if (total <= rows) return text;

  const marker = opts.marker ?? DEFAULT_MARKER;
  // 标记行固定占 1 行，先从预算里扣掉。窄容器里标记文案本身可能超宽 → 硬截，
  // 否则它折成两行就把预算顶破了（不变式在窄容器上就废了）。
  const markerLine = (drop: TailClipDrop): string => {
    const text = marker(drop);
    return cols > 0 ? truncateToWidth(text, cols) : text;
  };
  const budget = Math.max(1, rows - 1);

  let used = 0;
  let i = lines.length;
  while (i > 0) {
    const r = lineRows(lines[i - 1] as string);
    if (used + r > budget) break;
    used += r;
    i--;
  }

  if (i === lines.length) {
    // 连最后一行自己都超预算 → 只能按列宽硬切尾部
    const last = lines[lines.length - 1] ?? "";
    const kept = tailByWidth(last, cols > 0 ? cols * budget : Math.max(1, budget));
    const keptChars = kept.startsWith("…") ? kept.length - 1 : kept.length;
    const dropped: TailClipDrop = { lines: 0, chars: Math.max(0, last.length - keptChars) };
    return `${markerLine(dropped)}\n${kept}`;
  }

  const dropped: TailClipDrop = {
    lines: i,
    chars: lines.slice(0, i).reduce((n, l) => n + l.length + 1, 0),
  };
  return `${markerLine(dropped)}\n${lines.slice(i).join("\n")}`;
}

/** 动态区固定开销（不参与分配）：预览标题 1 + 预览下边距 1 + 思考指示 1 + 状态行 1 + 输入框 3 = 7。 */
export const CHROME_ROWS = 7;

export interface DynamicBudget {
  /** 当轮卡片 + 流式预览总共可用的行数 */
  total: number;
  /** dynamic 区最多同时挂几张当轮卡片（超出部分提前落 <Static>） */
  cardsLimit: number;
  /** 单张工具卡片正文最多渲染几行 */
  cardBodyRows: number;
  /** 流式预览正文最多渲染几行 */
  previewRows: number;
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * 按可用行数分配动态区预算（口径：卡片数 ×(正文+标题+下边距) + 预览 ≤ total）。
 * `rows` 已按固定帧高 24 收紧，等宽字体下行高与行数成比例，可直接沿用。
 */
export function computeDynamicBudget(): DynamicBudget {
  const rows = 24;
  const total = Math.max(8, rows - CHROME_ROWS);

  const cardsLimit = clampInt(Math.floor(total / 6), 1, 6);
  const cardBodyRows = clampInt(Math.floor(total / 12), 2, 4);
  const previewRows = Math.max(2, total - cardsLimit * (cardBodyRows + 2));

  return { total, cardsLimit, cardBodyRows, previewRows };
}

/** 视图内可容纳的近似列数：按容器宽度与等宽字体单字宽（8px）折算，未知时回落 80。 */
export function approxColumns(containerPx?: number): number {
  const width = containerPx ?? (typeof window === 'undefined' ? 0 : window.innerWidth);
  const cols = Math.floor(width / 8);
  return cols > 0 ? cols : 80;
}
