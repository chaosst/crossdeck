import { Box, Text } from "../ui/primitives";
import { color } from "../theme";
import { MarkdownView } from "./markdown-view";
import { approxColumns, tailByRows } from "./layout";

export interface OutputMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  name?: string;
  timestamp: Date;
  running?: boolean;
  expanded?: boolean;
  /** 稳定卡片 key：同名卡片原地更新用（如 delegate 事件卡），不参与渲染 */
  key?: string;
  /** 合并/折叠计数（×N 连续工具调用、折叠卡累计），供 turn-cards 逻辑读写 */
  callCount?: number;
  /** PTC 变体：携带结构化数据，MessageItem 据此渲染专用卡片 */
  ptc?:
    | { kind: "program"; data: PtcProgramView }
    | { kind: "dispatch"; data: PtcDispatchView };
}

/** PTC run_code 程序卡片数据 */
export interface PtcProgramView {
  code: string;          // 程序源码
  description: string;   // 意图说明
  errorKind?: string;    // run_code 失败类别徽章（exception/timeout/...）
}

/** PTC 程序内子调用数据 */
export interface PtcDispatchView {
  tool: string;
  input: unknown;
  output: unknown;
  isError: boolean;
}

/** 值 → 预览字符串（截断） */
function preview(v: unknown, max: number): string {
  if (v === undefined) return "undefined";
  if (typeof v === "string") return v.length > max ? v.slice(0, max) + "..." : v;
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s.length > max ? s.slice(0, max) + "..." : s;
  } catch {
    return String(v);
  }
}

/** PTC 程序内子调用条目 */
function PtcDispatchItem({ data }: { data: PtcDispatchView }) {
  return (
    <Box flexDirection="column" marginBottom={1} paddingLeft={4}>
      <Text color={data.isError ? color.danger : color.muted}>
        {data.isError ? "❌" : "⚡"} tools[{`"${data.tool}"`}]({preview(data.input, 120)})
      </Text>
      <Text color={color.muted}>{"→ "}{preview(data.output, 200)}</Text>
    </Box>
  );
}

/** "Navigate:" 头。静态消息与流式预览共用同一个组件——回合收尾时视觉不跳。 */
export function AgentLabel({ agentName = "Agent" }: { agentName?: string }) {
  return (
    <Text bold color={color.brand} className="py-2">
      {agentName}:
    </Text>
  );
}

/**
 * running 卡片的正文（工具入参 / 观测）。
 *
 * 动态区里必须按**行预算**裁：plan 模式 `Promise.all` 会同时挂多张 running 卡片，
 * 每张塞 500 字符的话渲染行数超过可用高度 → 行预算失效（见 layout.ts）。
 * 历史区（<Static>）没有帧高约束，沿用 500 字符上限即可。
 */
function toolBodyText(content: string, bodyRows?: number, columns?: number): string {
  if (bodyRows && bodyRows > 0 && columns && columns > 0) {
    return tailByRows(content, { rows: bodyRows, columns });
  }
  return content.length > 500 ? content.slice(0, 500) + "..." : content;
}

interface MessageItemProps {
  msg: OutputMessage;
  agentName?: string;
  /** 动态区用：卡片正文最多几行（<Static> 不传，历史记录不裁） */
  bodyRows?: number;
  /** 动态区用：列数（配合 bodyRows 折行估算） */
  columns?: number;
}

/**
 * Renders a single message.
 *
 * Used in two places:
 * 1. Inside <Static> — for finalized messages (written to terminal once,
 *    no longer cleared/rewritten).
 * 2. In the dynamic area — for running tool calls (re-rendered on each
 *    render cycle).
 *
 * The `running` flag controls presentation:
 * - running=true  → shows full content (truncated to 500 chars), with ▼
 * - running=false → shows first line only (truncated to 80 chars), with ▶
 */
export function MessageItem({ msg, agentName = "Agent", bodyRows, columns }: MessageItemProps) {
  const cols = columns ?? approxColumns();

  switch (msg.role) {
    case "user":
      return (
        <Box flexDirection="row" marginBottom={1} className="w-full flex justify-end">
          <Text color={color.ink} backgroundColor={color.line} className="p-2 rounded-xl rounded-br-none">
            {msg.content} 
          </Text>
        </Box>
      );

    case "tool": {
      if (msg.ptc?.kind === "dispatch") {
        return <PtcDispatchItem data={msg.ptc.data} />;
      }

      const detail = msg.expanded
        ? msg.content
        : msg.content.split("\n")[0]?.slice(0, 80);
      return (
        <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
          <Text color={color.muted}>
            {msg.running ? "  ▼" : msg.expanded ? "  ▼" : "  ▶"} ⚡{" "}
            {msg.name || "tool"}
          </Text>
          {msg.running || msg.expanded ? (
            <Text color={color.muted}>{toolBodyText(msg.content, bodyRows, cols)}</Text>
          ) : (
            <Text color={color.muted}>{detail}</Text>
          )}
        </Box>
      );
    }

    case "system": {
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={color.amber}>  {msg.content}</Text>
        </Box>
      );
    }

    default:
      // 最终回答：走 markdown 渲染（标题 / 列表 / 表格 / 代码块 / 行内样式），
      // 不再直接把 markdown 源码糊在屏幕上。
      return (
        <Box flexDirection="column" marginBottom={1}>
          <AgentLabel agentName={agentName} />
          <Box paddingLeft={2}>
            <MarkdownView text={msg.content} columns={Math.max(20, cols - 2)} />
          </Box>
        </Box>
      );
  }
}
