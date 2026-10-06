import { defineConfig } from 'vite';

/**
 * Web 壳的构建配置。
 *
 * 与 Electron 壳的 renderer 配置最关键的区别：**这里没有 `modulePreload` 那段开关**。
 * 那边必须关掉 polyfill，因为生产 CSP 的 `script-src` 只有 `'self'`，
 * Vite 注入的行内脚本会被拦掉。Web 壳没有那条 CSP 约束 ——
 * 差异来自真实需求，不是抄漏了一行。
 *
 * 另外这里**没有** `node:path` / `node:url` 之类的导入。
 * Electron 壳的 vite.config.ts 需要它们来算目录，Web 壳不需要 ——
 * 这份配置本身也在 `types: []` 的约束下，写不出来。
 */
export default defineConfig({
  base: './',
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
