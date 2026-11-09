import { useDispatch, useSelector } from 'react-redux';
import type { AppDispatch, RootState } from './index';

/** 带类型的 store hooks（react-redux 9 官方 .withTypes() 写法）。 */
export const useAppDispatch = useDispatch.withTypes<AppDispatch>();
export const useAppSelector = useSelector.withTypes<RootState>();
