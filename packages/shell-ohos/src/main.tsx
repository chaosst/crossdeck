/**
 * 渲染入口 —— UI 全在 `@crossdeck/ui`，这里只做一件事：把端口桥交出去。
 *
 * 想改界面别在这里改：这一份就是三端共用的那一份。
 *
 * ⚠️ **不要 await 端口**。`mountApp` 自己会 `await getNavigateStatus()`，
 *    而 `call()` 在端口到达前排队 —— 等两遍只是多写一次等待，不会更快。
 */

import { mountApp } from '@crossdeck/ui';
import { createBridge } from './bridge';
import { createRpc } from './rpc';
import { runOhosSelfCheck } from './selfcheck';

const rpc = createRpc();
void mountApp({ bridge: createBridge({ rpc, appVersion: __APP_VERSION__ }) });

if (new URLSearchParams(location.search).has('selfcheck')) {
  void runOhosSelfCheck(rpc);
}
