import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import pkg from './package.json' with { type: 'json' };

/**
 * Web 壳的构建配置。
 *
 * 与 Electron 壳的 renderer 配置差别只有一处，来自真实需求：
 * **这里没有 `modulePreload` 那个开关**。桌面壳必须关掉 polyfill，因为生产 CSP 的
 * `script-src` 只有 `'self'`，Vite 注入的行内脚本会被拦掉；浏览器里没有那条 CSP。
 *
 * 界面本体在 `@crossdeck/ui`（三端共用），这里不做任何 UI 相关的路径约定 ——
 * 入口是 `index.html`，它只认 `src/main.ts`。
 *
 * 另外这里**没有** `node:path` / `node:url` 之类的导入：Electron 壳需要它们算目录，
 * Web 壳不需要 —— 这份配置本身也在 `types: []` 的约束下。
 */
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  /**
   * 版本号从 package.json 读，构建期烧进产物 —— 页面上那个 `v…` 必须与包一致，
   * 不能是另一处手写的字面量（那种副本迟早会漂移）。
   */
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: 'dist/site',
    emptyOutDir: true,
    // 目标环境明确（现代浏览器），不为老浏览器降级
    target: 'esnext',
    sourcemap: true,
  },
  server: { port: 5199, strictPort: true },
  preview: { port: 4173, strictPort: true },
});
