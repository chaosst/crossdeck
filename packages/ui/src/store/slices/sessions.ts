import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { SessionMeta } from '@crossdeck/contract';

export interface SessionsState {
  items: SessionMeta[];
  /** null = 还没有激活的会话（列表非空但一项没选是合法状态）。 */
  activeId: string | null;
}

const initialState: SessionsState = {
  items: [],
  activeId: null,
};

const sessionsSlice = createSlice({
  name: 'sessions',
  initialState,
  reducers: {
    /** 启动时 listSessions() 回来后整表替换。 */
    sessionsReplaced(state, action: PayloadAction<SessionMeta[]>) {
      state.items = action.payload;
    },

    /** 新会话插到队首（最新的在最上面）。 */
    sessionPrepended(state, action: PayloadAction<SessionMeta>) {
      state.items.unshift(action.payload);
    },

    /** 删除 + 激活项修正一次做完（删的正好是激活项才清空）。 */
    sessionRemoved(state, action: PayloadAction<string>) {
      state.items = state.items.filter((s) => s.id !== action.payload);
      if (state.activeId === action.payload) state.activeId = null;
    },

    sessionActivated(state, action: PayloadAction<string | null>) {
      state.activeId = action.payload;
    },
  },
});

export const { sessionsReplaced, sessionPrepended, sessionRemoved, sessionActivated } =
  sessionsSlice.actions;

export default sessionsSlice.reducer;
