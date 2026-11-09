import { assertNever, type AgentStreamEvent } from '@crossdeck/contract';
import { onAgentEvent, samplePerf, startStreamFpsProbe, stopStreamFpsProbe } from './api';
import { store } from './store';
import {
  streamFailed,
  streamFinished,
  streamStarted,
  streamTokenAppended,
} from './store/slices/stream';

/** 收尾时把实测帧率报上去 —— 0 的语义是"没测到"，不是"帧率 0"。 */
function reportStreamFps(): void {
  const fps = stopStreamFpsProbe();
  void samplePerf({ streamFps: fps }).catch(() => {
    /* 采样失败不影响对话 */
  });
}

/**
 * 把 agent 流接到 store 上，每个窗口只挂一次。
 *
 * 挂在窗口入口而不是聊天页：聊天页切走会被卸载，它持有的订阅随之摘掉，
 * 而流并不停 —— 那段到达的 token 就再没人写进 store，切回来正文缺一段。
 *
 * 返回退订函数。窗口级绑定在窗口存活期间不需要摘（监听器随上下文回收），
 * 之所以仍然返回它，是为了可测、也为了不留"只能挂不能摘"的接口。
 */
export function bindAgentStream(): () => void {
  const off = onAgentEvent((event: AgentStreamEvent) => {
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
        // 工具调用与 plan 不单独渲染：落库后由事件卡片统一展示
        break;
      case 'sources':
      case 'action':
        // 同理，来自 history 的事件卡片
        break;
      case 'done':
        store.dispatch(streamFinished(event.usage));
        reportStreamFps();
        break;
      case 'error':
        store.dispatch(streamFailed(`[${event.code}] ${event.message}`));
        reportStreamFps();
        break;
      default:
        // 不加 `as never`：它就是穷尽检查本身，转成 never 等于把检查关掉
        assertNever(event);
    }
  });
  return off;
}
