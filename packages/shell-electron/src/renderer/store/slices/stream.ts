import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { Usage } from '@crossdeck/contract';

/** 流式阶段。落在本组件 DOM 的 data-stage 上，供 selfcheck 断言。 */
export type StreamStage = 'idle' | 'streaming' | 'done' | 'error';

export interface StreamState {
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

    /** invoke 回执到达，流还没开始 —— stage 留在 idle。 */
    runAccepted(state, action: PayloadAction<string>) {
      state.runId = action.payload;
    },

    pausedSet(state, action: PayloadAction<boolean>) {
      state.paused = action.payload;
    },

    /** 新建会话时清回初始态（含 stage 回 idle）。 */
    streamReset() {
      return { ...initialState };
    },
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
