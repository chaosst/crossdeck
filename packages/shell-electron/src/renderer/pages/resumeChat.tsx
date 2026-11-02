import { Box, Text, Static } from "../ui/primitives";
import { legacy_connect as connect } from 'react-redux';
import { Send } from "lucide-react";
import { Component, type ReactNode } from "react";
import { AgentLabel, MessageItem, type OutputMessage } from "./output";
import { MarkdownView } from "./markdown-view";
import {
  createSession,
  listSessionMessages,
  onAgentEvent,
  onSessionChanged,
  openAction,
  samplePerf,
  startAgentRun,
  startStreamFpsProbe,
  stopStreamFpsProbe,
} from "../api";
import { assertNever, type AgentStreamEvent, type SessionChange } from "@crossdeck/contract";
import type { SessionMessageDetail } from "@crossdeck/contract";
import { store, type RootState } from "../store";
import { logger } from "../utils/logger";
import { sessionActivated } from "../store/slices/sessions";
import {
  streamFailed,
  streamFinished,
  streamStarted,
  streamTokenAppended,
  type StreamStage,
} from "../store/slices/stream";

const TAG = 'ResumeChat'

interface MyComponentProps {
  className: string,
  streamText: string,
  running: boolean,
  pause: boolean,
  stage: StreamStage
}

interface MyComponentState {
  inputStr: string,
  /** 库里读回来的消息（含事件）。真源在端侧 SQL，不在组件 state。 */
  history: SessionMessageDetail[],
  loadError: string | null
}

class ResumeChat extends Component<MyComponentProps, MyComponentState> {
  agentName = "Navigate"
  runId: string | null = null
  private unsubscribe: (() => void) | null = null
  private unsubscribeSession: (() => void) | null = null

  constructor(props: MyComponentProps) {
    super(props)

    this.state = {
      inputStr: "",
      history: [],
      loadError: null
    }
  }

  setStateHandler(key: keyof MyComponentState, value: any) {
    this.setState(() => ({
      [key]: value
    } as MyComponentState))
  }

  // 订阅只能挂一次：放 componentDidUpdate 会随每次渲染累积监听器，同一 token 被追加 N 次。
  override componentDidMount(): void {
    this.unsubscribe = onAgentEvent((event: AgentStreamEvent) => {
      switch (event.type) {
        case 'start':
          // 一次 dispatch 把 text/usage/paused/runId/stage 挪到「正在流式」的合法组合。
          store.dispatch(streamStarted({ runId: event.runId }));
          startStreamFpsProbe();
          break;
        case 'token':
          store.dispatch(streamTokenAppended(event.text));
          break;
        case 'tool':
        case 'tool_end':
        case 'plan':
          // 工具调用与 plan 不单独渲染：落库后由事件卡片统一展示（见 renderHistory）
          break;
        case 'sources':
        case 'action':
          // 同理，来自 history 的事件卡片
          break;
        case 'done':
          store.dispatch(streamFinished(event.usage));
          this.reportStreamFps();
          break;
        case 'error':
          store.dispatch(streamFailed(`[${event.code}] ${event.message}`));
          this.reportStreamFps();
          break;
        default:
          // 不加 `as never`：它就是穷尽检查本身，转成 never 等于把检查关掉
          assertNever(event);
      }
    });

    this.unsubscribeSession = onSessionChanged((change: SessionChange) => {
      this.onSessionChange(change);
    });

    void this.reloadHistory();
  }

  override componentWillUnmount(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeSession?.();
    this.unsubscribeSession = null;
  }

  /** 收尾时把实测帧率上报给主进程 —— 0 表示"没测到"，不要说成"帧率 0"。 */
  private reportStreamFps(): void {
    const fps = stopStreamFpsProbe();
    void samplePerf({ streamFps: fps }).catch(() => {
      /* 采样失败不影响对话 */
    });
  }

  /** 别的窗口 / 登录切换都可能改库，这里只负责「要不要重拉」。 */
  private onSessionChange(change: SessionChange): void {
    const activeId = store.getState().sessions.activeId;
    if (change.reason === 'switched') {
      this.setStateHandler("history", []);
      void this.reloadHistory();
      return;
    }
    if (change.sessionId !== activeId) return;
    if (change.reason === 'deleted') {
      this.setStateHandler("history", []);
      return;
    }
    // 流式期间不重拉：当前轮由 streamText 渲染，重拉会让正文闪一下再回来。
    if (this.props.running) return;
    void this.reloadHistory();
  }

  private async reloadHistory(): Promise<void> {
    const activeId = store.getState().sessions.activeId;
    if (!activeId) {
      this.setStateHandler("history", []);
      return;
    }
    try {
      const messages = await listSessionMessages(activeId);
      this.setStateHandler("history", messages);
      this.setStateHandler("loadError", null);
    } catch (err) {
      const text = err instanceof Error ? err.message : JSON.stringify(err);
      this.setStateHandler("loadError", text);
      logger.error(TAG, `reloadHistory error: ${text}`);
    }
  }

  private sendHandler = async () => {
    try {
      const input = this.state.inputStr.trim();
      if (!input) {
        return;
      }
      let sessionId = store.getState().sessions.activeId;
      if (!sessionId) {
        const created = await createSession('简历问答');
        store.dispatch(sessionActivated(created.id));
        sessionId = created.id;
      }
      this.setStateHandler("inputStr", "");
      const { runId } = await startAgentRun(sessionId, input);
      this.runId = runId;
      // 用户消息与助理占位在主进程里已经落库，重拉一次就到位（不再本地拼历史）。
      await this.reloadHistory();
    } catch (err) {
      const error = err instanceof Error ? err.message : JSON.stringify(err);
      logger.error(TAG, `sendHandler error with: ${error}`);
    }
  }

  setInputStr(value: string) {
    this.setStateHandler("inputStr", value)
  }

  /** 一条落库消息 + 它的事件卡片。 */
  private renderStoredMessage(msg: SessionMessageDetail, key: string): ReactNode {
    // 当前轮的助理消息正由 streamText 渲染，别渲染两遍。
    if (this.props.running && msg.status === 'streaming') return null;

    return (
      <Box key={key} flexDirection="column">
        {msg.status === 'streaming' ? (
          <Text dimColor>[上次未正常结束，以下是已收到的内容]</Text>
        ) : null}
        <MessageItem
          msg={{
            role: msg.role,
            content: msg.content,
            timestamp: new Date(msg.createdAt),
          }}
          agentName={this.agentName}
        />
        {msg.events.map((event) => this.renderEvent(event, `${key}-${event.eventId}`))}
      </Box>
    );
  }

  private renderEvent(
    event: SessionMessageDetail['events'][number],
    key: string,
  ): ReactNode {
    switch (event.kind) {
      case 'tool':
        return (
          <Box key={key} paddingLeft={2}>
            <Text dimColor>
              {`${event.ok ? '✓' : '✗'} ${event.name}`}
              {event.resultPreview ? ` · ${event.resultPreview}` : ''}
            </Text>
          </Box>
        );
      case 'sources':
        return (
          <Box key={key} paddingLeft={2}>
            <Text dimColor>{`来源：${event.sources.join(' · ')}`}</Text>
          </Box>
        );
      case 'action':
        return (
          <Box key={key} paddingLeft={2}>
            <button
              type="button"
              className="text-left underline text-sm"
              onClick={() => {
                void openAction(event.url).catch((err: unknown) => {
                  logger.error(TAG, `openAction error: ${err instanceof Error ? err.message : String(err)}`);
                });
              }}
            >
              {event.label}
            </button>
          </Box>
        );
      default:
        // 事件词表加成员时这里必须编译失败
        return assertNever(event);
    }
  }

  override render(): ReactNode {
    const defaultClass = 'flex flex-col h-full py-4'
    const combinedClassName = `${defaultClass} ${this.props.className}`.trim()
    return (
      <div className={combinedClassName}>
        {/* 自检锚点：把 store 里的阶段与正文长度画进 DOM，好让"主进程状态 / 订阅到的事件 /
            界面呈现"三处能逐一对上。hidden 只影响显示，不影响属性读取。 */}
        <div data-testid="stream-stage" data-stage={this.props.stage} hidden />
        <span data-testid="stream-text" data-len={String(this.props.streamText.length)} hidden />
        <Box flexDirection="column" className="flex-1 overflow-auto px-6">
          <Static items={this.state.history}>
            {(msg: SessionMessageDetail) => this.renderStoredMessage(msg, msg.messageId)}
          </Static>

          {this.state.loadError === null ? null : (
            <Box paddingX={1} marginBottom={1}>
              <Text dimColor>{`会话历史读取失败：${this.state.loadError}`}</Text>
            </Box>
          )}

          <Box flexDirection="column" paddingX={1}>
            {/* 流式正文：只在跑的时候渲染，跑完由 history 接管（否则会重复一份） */}
            {this.props.running ? (
              <Box flexDirection="column" marginBottom={1}>
                <AgentLabel agentName={this.agentName} />
                <Box paddingLeft={2}>
                  <MarkdownView text={this.props.streamText} />
                </Box>
              </Box>
            ) : null}
          </Box>
        </Box>
        <div className="px-6 pt-1">
          <div className="bg-stone-100 h-30 rounded-xl pt-3 px-4 flex flex-col">
            <textarea className="flex-1 outline-0 w-full" style={{resize: "none"}} placeholder="请输入简历相关的问题" onInput={e=>this.setInputStr(e.currentTarget.value)}></textarea>
            <div className="flex justify-end py-2">
              <Send onClick={this.sendHandler} className="text-stone-700 cursor-pointer"></Send>
            </div>
          </div>
        </div>
      </div>
    )
  }
}

// 定义 mapStateToProps，用于将 Redux state 中的值映射到组件 props 上
const mapStateToProps = (state: RootState) => {
  return {
    streamText: state.stream.text,
    running: state.stream.stage === 'streaming',
    pause: state.stream.paused,
    stage: state.stream.stage
  };
};

export default connect(mapStateToProps)(ResumeChat)
