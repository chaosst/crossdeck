/**
 * 轻量 markdown 解析（纯函数、零依赖）。
 *
 * 只覆盖 LLM 回答里**真正高频**的语法：标题、段落、有序/无序列表、引用、围栏代码块、
 * 表格、分隔线，行内 bold / italic / strike / 行内代码 / 链接。
 *
 * 两条硬约束：
 *
 * 1. **必须容忍"半截输入"**。流式输出每 50ms 重解析一次，此刻文本可能正停在
 *    ` ```ts ` 后面、或 `**加粗` 只写了一半。所以：
 *    - 围栏没闭合 → 当成「正在流式的代码块」（`closed: false`），不能把 ` ``` ` 漏成正文；
 *    - 行内标记没闭合 → 原样当字面量，不能吞字符（否则流式过程中文字会"跳"）。
 * 2. **渲染行数要与源行数基本一致**。动态区是按行数发预算的（见 `layout.ts`），
 *    解析器不能把一个源码行膨胀成多行——例如表格不额外插分隔行，围栏的收尾行直接吃掉。
 */
import { textWidth, truncateToWidth } from "./layout.js";

/** 行内片段 */
export type MdInline =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "strike"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };

/** 块级片段 */
export type MdBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: MdListItem[] }
  | { kind: "quote"; text: string }
  | { kind: "code"; lang: string; lines: string[]; closed: boolean }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "rule" }
  | { kind: "blank" };

export interface MdListItem {
  text: string;
  /** 缩进层级（0 起，最多 3），用于嵌套列表 */
  depth: number;
}

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const FENCE_END_RE = /^\s{0,3}(`{3,}|~{3,})\s*$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE_RE = /^\s{0,3}>\s?/;
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
/** 表格分隔行：|---|:--:|---| */
const TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

const ESCAPABLE = "\\`*_~{}[]()#+-.!>|~";

/** 行内解析：不支持嵌套（`**粗 `代码`**` 里的代码会当字面量），够用且不会误吞字符 */
export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = [];
  let buf = "";
  const flush = (): void => {
    if (buf) {
      out.push({ kind: "text", text: buf });
      buf = "";
    }
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    // 转义：\* \` \[ ...
    if (ch === "\\" && i + 1 < text.length && ESCAPABLE.includes(text[i + 1] as string)) {
      buf += text[i + 1];
      i += 2;
      continue;
    }

    // 行内代码 `x`
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ kind: "code", text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }

    // **bold** / *italic*
    if (ch === "*") {
      const double = text.startsWith("**", i);
      const marker = double ? "**" : "*";
      const end = text.indexOf(marker, i + marker.length);
      if (end > i + marker.length) {
        flush();
        out.push({ kind: double ? "bold" : "italic", text: text.slice(i + marker.length, end) });
        i = end + marker.length;
        continue;
      }
      buf += marker;
      i += marker.length;
      continue;
    }

    // ~~strike~~
    if (ch === "~" && text.startsWith("~~", i)) {
      const end = text.indexOf("~~", i + 2);
      if (end > i + 2) {
        flush();
        out.push({ kind: "strike", text: text.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
      buf += "~~";
      i += 2;
      continue;
    }

    // [text](href "title")
    if (ch === "[") {
      const m = /^\[([^\]\n]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/.exec(text.slice(i));
      const label = m?.[1] ?? "";
      const href = m?.[2] ?? "";
      if (m && label && href) {
        flush();
        out.push({ kind: "link", text: label, href });
        i += m[0].length;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }

    buf += ch;
    i++;
  }

  flush();
  return out;
}

/** 切分表格行；支持 `\|` 转义 */
export function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s
    .replace(/\\\|/g, "\u0000")
    .split("|")
    .map((cell) => cell.replace(/\u0000/g, "|").trim());
}

/** 该行是否是「块级起始」（段落收集时要停下） */
function isBlockStart(lines: string[], i: number): boolean {
  const line = lines[i] ?? "";
  if (line.trim() === "") return true;
  if (FENCE_RE.test(line)) return true;
  if (HEADING_RE.test(line)) return true;
  if (RULE_RE.test(line)) return true;
  if (QUOTE_RE.test(line)) return true;
  if (LIST_RE.test(line)) return true;
  return isTableStart(lines, i);
}

/** 当前行 + 下一行是否构成 GFM 表格（表头 + 分隔行，且至少 2 列） */
export function isTableStart(lines: string[], i: number): boolean {
  const head = lines[i];
  const sep = lines[i + 1];
  // 越界即非表格（原来是 `i + 1 >= lines.length` 早退，语义等价）
  if (head === undefined || sep === undefined) return false;
  if (!head.includes("|")) return false;
  if (!TABLE_SEP_RE.test(sep)) return false;
  return splitTableRow(head).length >= 2;
}

/** markdown 文本 → 块序列。容忍半截输入（未闭合围栏 → code 块，`closed: false`） */
export function parseBlocks(text: string): MdBlock[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    // ---- 围栏代码块 ----
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const char = fence[1]?.[0] ?? "";
      const lang = fence[2] ?? "";
      const body: string[] = [];
      let closed = false;
      i++;
      while (i < lines.length) {
        const cur = lines[i] ?? "";
        const end = FENCE_END_RE.exec(cur);
        if (end && end[1]?.[0] === char) {
          closed = true;
          i++;
          break;
        }
        body.push(cur);
        i++;
      }
      blocks.push({ kind: "code", lang, lines: body, closed });
      continue;
    }

    // ---- 空行 ----
    if (line.trim() === "") {
      blocks.push({ kind: "blank" });
      i++;
      continue;
    }

    // ---- 标题 ----
    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: (heading[1] ?? "").length,
        text: heading[2] ?? "",
      });
      i++;
      continue;
    }

    // ---- 分隔线 ----
    if (RULE_RE.test(line)) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }

    // ---- 引用 ----
    if (QUOTE_RE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i] ?? "")) {
        body.push((lines[i] ?? "").replace(QUOTE_RE, ""));
        i++;
      }
      blocks.push({ kind: "quote", text: body.join("\n") });
      continue;
    }

    // ---- 表格 ----
    if (isTableStart(lines, i)) {
      const header = splitTableRow(lines[i] ?? "");
      i += 2; // 跳过分隔行
      const rows: string[][] = [];
      while (i < lines.length) {
        const cur = lines[i] ?? "";
        if (cur.trim() === "" || !cur.includes("|")) break;
        rows.push(splitTableRow(cur));
        i++;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    // ---- 列表 ----
    const first = LIST_RE.exec(line);
    if (first) {
      const marker = first[2] ?? "";
      const ordered = /\d/.test(marker);
      const items: MdListItem[] = [];
      const start = ordered ? Number.parseInt(marker, 10) : 1;
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i] ?? "");
        if (!m) break;
        // 标记类型变了（有序 ↔ 无序）就收尾，让下一个循环另起一个块。
        // 否则「1. 一 / 2. 二 /  - 甲」里的 `- 甲` 会被续编成 `3.`（实测踩到过）。
        if (/\d/.test(m[2] ?? "") !== ordered) break;
        items.push({
          text: m[3] ?? "",
          depth: Math.min(3, Math.floor((m[1] ?? "").replace(/\t/g, "  ").length / 2)),
        });
        i++;
      }
      blocks.push({ kind: "list", ordered, start, items });
      continue;
    }

    // ---- 段落 ----
    const para: string[] = [];
    while (i < lines.length && !isBlockStart(lines, i)) {
      para.push(lines[i] ?? "");
      i++;
    }
    if (para.length === 0) {
      // 理论不可达（上面每个分支都已覆盖）；兜底吃掉一行，避免死循环
      para.push(line);
      i++;
    }
    blocks.push({ kind: "paragraph", text: para.join("\n") });
  }

  return blocks;
}

/** 单元格按显示宽度补齐 / 超宽截断（复用 layout 的头部硬截，保证宽度精确） */
function padCell(cell: string, width: number): string {
  const fitted = truncateToWidth(cell, width);
  return fitted + " ".repeat(Math.max(0, width - textWidth(fitted)));
}

/**
 * 表格 → 等宽文本行（表头在前）。
 *
 * 宽度自适应：总宽超预算时逐列削最宽的那列（每列至少 2 列宽），保证**任何一行都不会折行**
 * ——一折行就多占行，动态区行预算就废了。
 */
export function renderTableBlock(header: string[], rows: string[][], maxWidth: number): string[] {
  const colCount = Math.max(header.length, ...rows.map((r) => r.length), 0);
  if (colCount === 0) return [];

  const SEP = " │ ";
  const cells = [header, ...rows].map((row) =>
    Array.from({ length: colCount }, (_, c) => row[c] ?? ""),
  );
  const widths = Array.from({ length: colCount }, (_, c) =>
    Math.max(2, ...cells.map((row) => textWidth(row[c] ?? ""))),
  );

  if (maxWidth > 0) {
    let total = widths.reduce((a, b) => a + b, 0) + SEP.length * (colCount - 1);
    while (total > maxWidth) {
      let widest = 0;
      for (let c = 1; c < colCount; c++) {
        if ((widths[c] ?? 0) > (widths[widest] ?? 0)) widest = c;
      }
      if ((widths[widest] ?? 0) <= 2) break;
      widths[widest] = (widths[widest] ?? 0) - 1;
      total -= 1;
    }
  }

  const lines = cells.map((row) => row.map((cell, c) => padCell(cell, widths[c] ?? 0)).join(SEP));
  // 兜底：列数太多时（每列已到 2 列下限仍放不下）整行硬截。
  // 折行会多占行、把动态区行预算算漏，宁可少显几个字。
  return maxWidth > 0 ? lines.map((line) => truncateToWidth(line, maxWidth)) : lines;
}

/**
 * 代码块按行裁剪（**保留头部**，`…` 标记在尾部）。
 * 返回的 `lines` 已经是最终要渲染的行；`dropped` 供渲染层写省略提示。
 */
export function clipCodeLines(lines: string[], maxRows: number): { lines: string[]; dropped: number } {
  const rows = Math.max(1, Math.floor(maxRows));
  if (lines.length <= rows) return { lines, dropped: 0 };
  const kept = lines.slice(0, Math.max(1, rows - 1));
  return { lines: kept, dropped: lines.length - kept.length };
}
