import { configureStore } from '@reduxjs/toolkit';
import sessions from './slices/sessions';
import stream from './slices/stream';

/** 渲染层唯一的 store，只放客户端 UI 状态。 */
export const store = configureStore({
  reducer: {
    sessions,
    stream,
  },
});

// 从 store 推导类型，不要手写 RootState。
export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
