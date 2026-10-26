import { Box, Text, Static } from "../ui/primitives";
import { legacy_connect as connect } from 'react-redux';
import { Send } from "lucide-react";
import { Component, type ReactNode } from "react";
import { AgentLabel, MessageItem, type OutputMessage } from "./output";
import { MarkdownView } from "./markdown-view";
import { createSession, onAgentEvent, startAgentRun } from "../api";
import { assertNever, type AgentStreamEvent } from "@crossdeck/contract";
import { store, type RootState } from "../store";
import { logger } from "../utils/logger";
import { sessionActivated } from "../store/slices/sessions";
import { streamFailed, streamFinished, streamStarted, streamTokenAppended } from "../store/slices/stream";

const TAG = 'ResumeChat'

interface MyComponentProps {
  className: string,
  streamText: string,
  running: boolean,
  pause: boolean
}

interface MyComponentState {
  inputStr: string,
  staticMessages: OutputMessage[]
  dynamicMessages: OutputMessage[]
}

class ResumeChat extends Component<MyComponentProps, MyComponentState> {
  agentName = "Navigate"
  runId: string | null = null
  private unsubscribe: (() => void) | null = null

  constructor(props: MyComponentProps) {
    super(props)

    this.state = {
      inputStr: "",
      staticMessages: [],
      dynamicMessages: []
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
          break;
        case 'token':
          store.dispatch(streamTokenAppended(event.text));
          break;
        case 'tool':
        case 'tool_end':
        case 'plan':
        case 'sources':
        case 'action':
          // 先忽略；工具/引用/动作卡片的渲染随会话面板一起做
          break;
        case 'done':
          store.dispatch(streamFinished(event.usage));
          break;
        case 'error':
          store.dispatch(streamFailed(`[${event.code}] ${event.message}`));
          break;
        default:
          // 不加 `as never`：它就是穷尽检查本身，转成 never 等于把检查关掉
          assertNever(event);
      }
    });
  }

  override componentWillUnmount(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private sendHandler = async() => {
    try {
      if (!this.state.inputStr) {
        return ;
      }
      const storeState = store.getState()
      let sessionId = storeState.sessions.activeId;
      if (!sessionId) {
        const created = await createSession('简历问答');
        store.dispatch(sessionActivated(created.id))
        sessionId = created.id;
      }
      const historys: OutputMessage[] = [ ...this.state.staticMessages]
      // 旧信息入栈StaticMessages
      if (this.props.streamText) {
        historys.push({
          role: "assistant",
          content: this.props.streamText,
          timestamp: new Date()
        })
      }
      // 用户提问入栈StaticMessages
      historys.push({
        role: "user",
        content: this.state.inputStr,
        timestamp: new Date()
      })
      this.setStateHandler("staticMessages", historys)

      const { runId } = await startAgentRun(sessionId, this.state.inputStr);
      this.setStateHandler("inputStr", "")
      this.runId = runId
    } catch (err) {
      const error = err instanceof Error ? err.message : JSON.stringify(err)
      logger.error(TAG, `sendHandler error with: ${error}`)
    }
  }

  setInputStr(value: string) {
    this.setStateHandler("inputStr", value)
  }
  
  override render(): ReactNode {
    const defaultClass = 'flex flex-col h-full py-4'
    const combinedClassName = `${defaultClass} ${this.props.className}`.trim()
    return (
      <div className={combinedClassName}>
        <Box flexDirection="column" className="flex-1 overflow-auto px-6">
          <Static items={this.state.staticMessages}>
            {(msg: OutputMessage, i: number) => (
              <MessageItem key={i} msg={msg} agentName={this.agentName} />
            )}
          </Static>

          <Box flexDirection="column" paddingX={1}>
            {/* 当轮卡片（dynamic）：回合收尾时整体落入 <Static>，中途不插队。
                plan 卡多给 2 行正文预算（goal + 步骤状态比普通卡需要更多行，
                且 computeDynamicBudget 的槽位口径就是 cardBodyRows+2，不破坏帧高预算） */}
            {this.state.dynamicMessages.map((msg, i) => (
              <MessageItem
                key={`dyn-${i}`}
                msg={msg}
                agentName={this.agentName}
                columns={20}
              />
            ))}

            {/* Streaming text (dynamic)：markdown 渲染 + 按行预算裁尾部。
                固定 height：流式时每帧文字增减不再推挤下方（思考指示/输入框不再上下震动）；
                maxRows 是渲染后的块级行数硬保证（markdown 会扩展，tailByRows 只钳源文本）。 */}
            {this.props.running || this.props.streamText ? (
              <Box flexDirection="column" marginBottom={1}>
                <AgentLabel agentName={this.agentName} />
                <Box paddingLeft={2}>
                  <MarkdownView
                    text={this.props.streamText}
                  />
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
    pause: state.stream.paused
  };
};

export default connect(mapStateToProps)(ResumeChat)