import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import App from './App';
import Login from './pages/Login';
import { store } from './store';
import './styles.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root 不存在 —— index.html 与入口脚本不匹配');
}

// 入口分流：#/login → 登录界面，其余走 App。Provider 必须在分流点之上。
const route = window.location.hash.replace(/^#\/?/, '');

createRoot(container).render(
  <StrictMode>
    <Provider store={store}>{route === 'login' ? <Login /> : <App />}</Provider>
  </StrictMode>,
);
