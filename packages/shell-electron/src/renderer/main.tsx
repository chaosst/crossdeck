import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import App from './App';
import Login from './pages/Login';
import { store } from './store';
import './styles.css';
import { getNavigateStatus } from './api';

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root 不存在 —— index.html 与入口脚本不匹配');
}

/** 当前路由 = hash 去掉前导 `#/`；空串与 `main` 等价（走 App）。 */
function routeFromHash(): string {
  return window.location.hash.replace(/^#\/?/, '');
}

const status = await getNavigateStatus();
if (!status.login.hasToken) {
  window.location.hash = '#/login';
}

/**
 * 入口分流：#/login → 登录界面，其余走 App。Provider 必须在分流点之上。
 *
 * route 必须随 hash 变化重算：登录页成功后改 hash 就是靠这里的 hashchange
 * 回到 App 的。只在模块顶层算一次的话，改 hash 不会触发任何重新渲染。
 */
function Root() {
  const [route, setRoute] = useState(routeFromHash);

  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return route === 'login' ? <Login /> : <App />;
}

createRoot(container).render(
  <StrictMode>
    <Provider store={store}>
      <Root />
    </Provider>
  </StrictMode>,
);
