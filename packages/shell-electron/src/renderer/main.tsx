import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

/**
 * 渲染层入口。
 *
 * StrictMode 开着是刻意的：它在开发模式下会**故意重复执行** effect
 * （挂载 → 卸载 → 再挂载）。这是检验 onStream 退订逻辑是否正确的免费测试 ——
 * 如果 preload 的 onStream 没有返回可用的取消函数，
 * StrictMode 下就会看到「一条流被渲染两次」。生产构建不会双跑。
 */

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root 不存在 —— index.html 与入口脚本不匹配');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
