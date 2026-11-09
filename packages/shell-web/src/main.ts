/**
 * Web 壳的启动入口。
 *
 * 桌面壳把这件事拆成两个文件（`main/index.ts` 主进程 + `renderer/main.tsx` 渲染层），
 * 浏览器里只有一条线程，所以这里是那两段的合体：
 *
 *   ① 建页内主进程（`host/`）—— 端口、仓储作用域、agent、navigate、bridge
 *   ② 把**同一份界面**挂到 `#root` —— 与 Electron 壳调用的是同一个 `mountApp`
 *
 * 顺序是承重的：UI 一挂载就会问 `navigate:status`（登录闸门），bridge 必须已经就绪。
 *
 * `?selfcheck=1` 的最后一段（⑤）会去点真实界面 —— 所以自检必须在挂载**之后**跑。
 */

import { mountApp } from '@crossdeck/ui';
import { createWebHost } from './host/index.js';
import { runWebSelfCheck } from './selfcheck.js';

const host = await createWebHost();
await mountApp({ bridge: host.bridge });

if (new URLSearchParams(location.search).has('selfcheck')) {
  await runSelfCheck();
}

/**
 * 自检模式。
 *
 * 浏览器里没有"进程退出码"，判定走两路：
 *   · 控制台哨兵 `[selfcheck] DONE ok=… code=…`，由 `scripts/web-selfcheck.mjs`
 *     通过 CDP 收走并**以它为准**决定退出码（与 Electron 壳同一套思路：
 *     校验链不挂在"进程能不能退出"上）
 *   · 报告 JSON 写进 DOM，人肉核对时不用打开 DevTools
 */
async function runSelfCheck(): Promise<void> {
  const banner = document.createElement('div');
  banner.id = 'selfcheck-banner';
  banner.style.cssText =
    'position:fixed;left:10px;bottom:10px;z-index:9999;max-width:min(720px,90vw);' +
    'padding:8px 12px;border-radius:8px;font:12.5px/1.5 ui-sans-serif,system-ui,Segoe UI,sans-serif;' +
    'border:1px solid #d9d5cc;background:#fffdf8;color:#5c5750;box-shadow:0 2px 10px rgba(28,27,25,.08);white-space:pre-wrap';

  const reportBox = document.createElement('pre');
  reportBox.id = 'selfcheck-report';
  reportBox.style.display = 'none';

  banner.textContent = '自检运行中…';
  document.body.append(banner, reportBox);

  try {
    const report = await runWebSelfCheck();
    reportBox.textContent = JSON.stringify(report, null, 2);

    const assertions = Object.keys(report.probe).length;
    banner.textContent = report.ok
      ? `✅ Web 壳自检通过 · ${assertions} 项断言 · ${report.coreBindingsImported.length} 个 core 绑定取自同一份产物`
      : `❌ Web 壳自检失败 · ${report.failures.length} 项：${report.failures.join(' / ')}`;
    banner.style.color = report.ok ? '#1f6b3a' : '#a33a2c';
    banner.style.borderColor = report.ok ? '#bcd9c6' : '#e3b6ad';

    console.log(`[selfcheck] DONE ok=${report.ok} code=${report.ok ? 0 : 1}`);
    if (!report.ok) console.log(`[selfcheck] 失败项：${report.failures.join(' | ')}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reportBox.textContent = JSON.stringify({ ok: false, thrown: message }, null, 2);
    banner.textContent = `❌ 自检自身抛错：${message}`;
    banner.style.color = '#a33a2c';
    banner.style.borderColor = '#e3b6ad';
    console.log('[selfcheck] DONE ok=false code=1');
    console.error(err);
  }
}
