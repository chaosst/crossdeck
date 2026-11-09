import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { Usage } from '@crossdeck/contract';
import { sessionActivated } from './sessions';

/** 流式阶段。落在本组件 DOM 的 data-stage 上，供 selfcheck 断言。 */
export type StreamStage = 'idle' | 'streaming' | 'done' | 'error';

export interface StreamState {
  /**
   * 这一轮属于哪个会话。`null` = 不知道（外部直连 `agent:run`，没走 invoke 回执）。
   *
   * 存在的唯一理由：切会话时能判断「面板上这行字是不是上一个会话的」——
   * 没有它就只能整块清掉，或者干脆让旧流画到新会话里。
   */
  sessionId: string | null;
  /** 累计输出文本，增量追加。 */
  text: string;
  /** 正在跑的 run；null = 没有。 */
  runId: string | null;
  usage: Usage | null;
  stage: StreamStage;
  /** 背压暂停（pause 期间 run 仍在，只是零推送）。 */
  paused: boolean;
  /** 流式失败原因，格式 [CODE] message。 */
  error: string | null;
}

const initialState: StreamState = {
  sessionId: null,
  text: '',
  runId: null,
  usage: null,
  stage: 'idle',
  paused: false,
  error: null,
};

const streamSlice = createSlice({
  name: 'stream',
  initialState,
  reducers: {
    /** 上游 start 事件：清掉上一轮残留，进入 streaming。 */
    streamStarted(state, action: PayloadAction<{ runId: string }>) {
      state.text = '';
      state.usage = null;
      state.error = null;
      state.paused = false;
      state.runId = action.payload.runId;
      state.stage = 'streaming';
    },

    streamTokenAppended(state, action: PayloadAction<string>) {
      state.text += action.payload;
    },

    /** 正常终态，usage 由 done 事件带入。 */
    streamFinished(state, action: PayloadAction<Usage>) {
      state.runId = null;
      state.paused = false;
      state.usage = action.payload;
      state.stage = 'done';
    },

    streamFailed(state, action: PayloadAction<string>) {
      state.runId = null;
      state.paused = false;
      state.error = action.payload;
      state.stage = 'error';
    },

    /** invoke 回执到达，流还没开始 —— stage 留在 idle。顺带记下这轮属于哪个会话。 */
    runAccepted(state, action: PayloadAction<{ runId: string; sessionId: string }>) {
      state.runId = action.payload.runId;
      state.sessionId = action.payload.sessionId;
    },

    pausedSet(state, action: PayloadAction<boolean>) {
      state.paused = action.payload;
    },

    /** 新建会话时清回初始态（含 stage 回 idle）。 */
    streamReset() {
      return { ...initialState };
    },
  },

  /**
   * 切到**别的**会话时，这一轮的正文必须一起清掉。
   *
   * 不清的后果：A 会话流式中途去列表点开 B，B 的聊天面板里会长出 A 的正文 ——
   * 而且（自流式订阅上移到窗口之后）它还在继续长。
   * 清的前提是**知道**这轮属于谁：`sessionId === null` 表示不知道（外部直连
   * `agent:run` 的场景），这时保持宽松，清了反而会误伤。
   */
  extraReducers: (builder) => {
    builder.addCase(sessionActivated, (state, action) => {
      if (state.sessionId !== null && state.sessionId !== action.payload) {
        return { ...initialState };
      }
      return state;
    });
  },
});

export const {
  streamStarted,
  streamTokenAppended,
  streamFinished,
  streamFailed,
  runAccepted,
  pausedSet,
  streamReset,
} = streamSlice.actions;

export default streamSlice.reducer;
