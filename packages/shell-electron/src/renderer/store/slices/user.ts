import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export interface UserState {
  userId: string | null;
}

const initialState: UserState = {
  userId: null
};

const userSlice = createSlice({
  name: 'user',
  initialState,
  reducers: {
    setUserId(state, action: PayloadAction<string | null>) {
      state.userId = action.payload;
    },
  },
});

export const { setUserId } =
userSlice.actions;

export default userSlice.reducer;
