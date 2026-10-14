import React from "react";
import { Box, Text } from "../ui/primitives";
import { color } from "../theme";
import {
  clipCodeLines,
  parseBlocks,
  parseInline,
  renderTableBlock,
  type MdBlock,
  type MdInline,
} from "./markdown.js";
import { visualRows } from "./layout";

export interface MarkdownViewProps {
  text: string;
  /** 可用列数（表格裁剪 / 分隔线长度）。缺省 80 */
  columns?: number;
  /** 代码块最多渲染多少行（超出写省略提示）。缺省 40 */
  maxCodeRows?: number;
  /** 正文颜色 */
  color?: string;
  /**
   * 渲染行数硬上限（行）：只保留尾部放得下的块，被裁部分在头部给一行省略标记。
   * 流式预览专用——上游 tailByRows 只钳**源文本**行数，markdown 渲染会扩展
   * （代码块 +头尾/margin、块间空行），不设上限帧高会顶破动态区预算。
   */
  maxRows?: number;
}

const INK = color.ink;
const ACCENT = color.brand;
const CODE = color.inkBody;
const INLINE_CODE = color.brandDeep;
const MUTED = color.muted;

/** 行内片段 → 文本（嵌套 <Text>；未闭合标记在解析层已退化为字面量） */
function Inline({ parts }: { parts: MdInline[] }): React.ReactElement {
  return (
    <>
      {parts.map((p, i) => {
        switch (p.kind) {
          case "code":
            return (
              <Text key={i} color={INLINE_CODE}>
                {p.text}
              </Text>
            );
          case "bold":
            return (
              <Text key={i} bold>
                {p.text}
              </Text>
            );
          case "italic":
            return (
              <Text key={i} italic>
                {p.text}
              </Text>
            );
          case "strike":
            return (
              <Text key={i} strikethrough>
                {p.text}
              </Text>
            );
          case "link":
            return (
              <Text key={i} underline color={ACCENT}>
                {p.text}
                <Text dimColor>{` (${p.href})`}</Text>
              </Text>
            );
          default:
            return <Text key={i}>{p.text}</Text>;
        }
      })}
    </>
  );
}

/** 围栏代码块：`┌ lang` 头 + `│ ` 排水沟；正文按行裁剪，不在动态区里爆帧 */
function CodeBlock({
  lang,
  lines,
  closed,
  maxCodeRows,
}: {
  lang: string;
  lines: string[];
  closed: boolean;
  maxCodeRows: number;
}): React.ReactElement {
  const { lines: kept, dropped } = clipCodeLines(lines, maxCodeRows);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text dimColor>{`┌ ${lang || "code"}${closed ? "" : " ⋯"}`}</Text>
      {kept.map((line, i) => (
        <Text key={i} color={CODE}>
          {`│ ${line}`}
        </Text>
      ))}
      {dropped > 0 ? (
        <Text dimColor>{`└ ⋯ 省略 ${dropped} 行（共 ${lines.length} 行）`}</Text>
      ) : (
        <Text dimColor>{"└"}</Text>
      )}
    </Box>
  );
}

/** 表格：预渲染成等宽文本行（已保证不折行），表头高亮 */
function TableBlock({
  header,
  rows,
  columns,
}: {
  header: string[];
  rows: string[][];
  columns: number;
}): React.ReactElement {
  const lines = renderTableBlock(header, rows, columns);
  return (
    <Box flexDirection="column" marginBottom={1}>
      {lines.map((line, i) => (
        <Text key={i} bold={i === 0} color={i === 0 ? ACCENT : MUTED}>
          {line}
        </Text>
      ))}
    </Box>
  );
}

function Block({
  block,
  columns,
  maxCodeRows,
  color,
}: {
  block: MdBlock;
  columns: number;
  maxCodeRows: number;
  color: string;
}): React.ReactElement | null {
  switch (block.kind) {
    case "blank":
      // 保留源文本的空行（间距跟随作者意图，同时计入行预算）
      return <Text> </Text>;

    case "heading": {
      const level = block.level;
      const headingColor = level === 1 ? ACCENT : level === 2 ? INK : MUTED;
      return (
        <Text bold color={headingColor}>
          {`${"#".repeat(Math.min(level, 3))} `}
          <Inline parts={parseInline(block.text)} />
        </Text>
      );
    }

    case "paragraph":
      return (
        <Text color={color}>
          <Inline parts={parseInline(block.text)} />
        </Text>
      );

    case "list":
      return (
        <Box flexDirection="column">
          {block.items.map((item, i) => (
            <Text key={i} color={color}>
              <Text dimColor>
                {`${"  ".repeat(item.depth)}${block.ordered ? `${block.start + i}. ` : "• "}`}
              </Text>
              <Inline parts={parseInline(item.text)} />
            </Text>
          ))}
        </Box>
      );

    case "quote":
      return (
        <Box flexDirection="column">
          {block.text.split("\n").map((line, i) => (
            <Text key={i} italic color={MUTED}>
              {"▌ "}
              <Inline parts={parseInline(line)} />
            </Text>
          ))}
        </Box>
      );

    case "code":
      return (
        <CodeBlock
          lang={block.lang}
          lines={block.lines}
          closed={block.closed}
          maxCodeRows={maxCodeRows}
        />
      );

    case "table":
      return <TableBlock header={block.header} rows={block.rows} columns={columns} />;

    case "rule":
      return (
        <Text dimColor>{"─".repeat(Math.max(8, Math.min(40, columns)))}</Text>
      );

    default:
      return null;
  }
}

/**
 * 估算单个块渲染后的行数。**宁高不低**：多估只会提前裁剪，少估会爆帧。
 * 与 Block 渲染一一对应（标题/列表/引用带前缀，代码块 +头尾+margin+余量）。
 */
export function estimateBlockRows(block: MdBlock, columns: number, codeCap: number): number {
  switch (block.kind) {
    case "blank":
    case "rule":
      return 1;
    case "heading":
      return visualRows(`${"#".repeat(Math.min(block.level, 3))} ${block.text}`, columns);
    case "paragraph":
      return visualRows(block.text, columns);
    case "list":
      return block.items.reduce((n, it) => n + visualRows(`${"  ".repeat(it.depth)}• ${it.text}`, columns), 0);
    case "quote":
      return block.text.split("\n").reduce((n, line) => n + visualRows(`▌ ${line}`, columns), 0);
    case "code":
      // 头 1 + 正文 ≤codeCap + 尾/省略标记 1 + margin 1
      return Math.min(block.lines.length, Math.max(1, codeCap)) + 3;
    case "table":
      // 表头 1 + 行 + margin 1 + 余量 1
      return block.rows.length + 3;
    default:
      return 1;
  }
}

export interface KeepTailResult {
  blocks: MdBlock[];
  /** 被裁掉的块数；-1 = 保底只留末块、不渲染头部标记 */
  dropped: number;
}

/**
 * 从尾部往前挑能放进 maxRows 的块（流式预览只关心最新内容）。
 * 预留 1 行给头部省略标记；连单个末块都放不进 maxRows-1 时，
 * 保底留最后一块且不渲染标记（上游 tailByRows 已把源文本钳在预算内）。
 */
export function keepTailBlocks(
  blocks: MdBlock[],
  maxRows: number,
  columns: number,
  codeCap: number,
): KeepTailResult {
  const select = (budget: number): number => {
    let used = 0;
    let i = blocks.length;
    while (i > 0) {
      const r = estimateBlockRows(blocks[i - 1] as MdBlock, columns, codeCap);
      if (used + r > budget) break;
      used += r;
      i--;
    }
    return i;
  };

  if (maxRows <= 0 || blocks.length === 0) return { blocks, dropped: 0 };
  if (select(maxRows) === 0) return { blocks, dropped: 0 };

  const idxWithNote = select(maxRows - 1);
  if (idxWithNote < blocks.length) return { blocks: blocks.slice(idxWithNote), dropped: idxWithNote };
  return { blocks: blocks.slice(-1), dropped: -1 };
}

/**
 * markdown 文本 → 渲染。
 *
 * 用在两处：`<Static>` 里的最终回答（全量渲染），以及动态区的流式预览
 * （调用方先用 `tailByRows` 把源文本裁到行预算内，再交给这里；
 * 传 `maxRows` 时再按渲染后的块级行数做第二道硬保证）。
 */
export function MarkdownView({
  text,
  columns = 80,
  maxCodeRows = 40,
  color = INK,
  maxRows,
}: MarkdownViewProps): React.ReactElement {
  const parsed = parseBlocks(text);
  const width = Math.max(20, columns);
  // 代码块行数上限与 maxRows 联动：单块估算（cap+3）不得超 maxRows-1
  const codeCap = maxRows ? Math.max(1, Math.min(maxCodeRows, maxRows - 4)) : maxCodeRows;
  const kept = maxRows ? keepTailBlocks(parsed, maxRows, width, codeCap) : { blocks: parsed, dropped: 0 };
  const headNote = kept.dropped > 0 ? `⋯ 前面已省略 ${kept.dropped} 块` : null;
  return (
    <Box flexDirection="column">
      {headNote ? <Text dimColor>{headNote}</Text> : null}
      {kept.blocks.map((block, i) => (
        <Block key={i} block={block} columns={width} maxCodeRows={codeCap} color={color} />
      ))}
    </Box>
  );
}
