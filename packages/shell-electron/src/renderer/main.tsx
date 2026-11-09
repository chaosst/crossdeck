/**
 * 渲染进程入口 —— UI 全在 `@crossdeck/ui`，这里只做一件事：把 preload 的桥交出去。
 *
 * 想改界面别在这里改：这一份就是三端共用的那一份。
 */
import { mountApp } from '@crossdeck/ui';

void mountApp({ bridge: window.bridge });
