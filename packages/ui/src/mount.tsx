import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import type { BridgeApi } from '@crossdeck/contract';
import App from './App';
import Login from './pages/Login';
import { store } from './store';
import { bindAgentStream } from './streamBinding';
import './styles.css';
import { getNavigateStatus } from './api';
import { setBridge } from './bridge';

/** 启动参数 —— 三端唯一的差异就在这里：交给 UI 的是哪一份桥。 */
export interface MountOptions {
  readonly bridge: BridgeApi;
}

/** 当前路由 = hash 去掉前导 `#/`；空串与 `main` 等价（走 App）。 */
function routeFromHash(): string {
  return window.location.hash.replace(/^#\/?/, '');
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

/**
 * 把这一份 UI 挂到 `#root` 上。
 *
 * 顺序是承重的：先注入桥再取状态 —— `getNavigateStatus` 本身就要过桥；
 * 刷新 hash 必须在渲染前，否则第一帧会先画出 App 再跳登录页。
 */
export async function mountApp(options: MountOptions): Promise<void> {
  const container = document.getElementById('root');
  if (!container) {
    throw new Error('#root 不存在 —— index.html 与入口脚本不匹配');
  }

  setBridge(options.bridge);

  const status = await getNavigateStatus();
  if (!status.login.hasToken) {
    window.location.hash = '#/login';
  }

  /**
   * agent 流在这里接一次，不在聊天页里接 —— 聊天页切页签会被卸载，
   * 它持有的订阅也会随之摘掉，流式中途切走再回来正文就缺一段。
   * 订阅只与窗口同寿，所以这里刻意不保留退订句柄。
   */
  bindAgentStream();

  createRoot(container).render(
    <StrictMode>
      <Provider store={store}>
        <Root />
      </Provider>
    </StrictMode>,
  );
}
