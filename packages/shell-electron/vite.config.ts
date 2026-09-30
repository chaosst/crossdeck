import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 渲染层构建配置。
 *
 * 注意 root 指向 src/renderer 而不是包根：
 * 这个包里有三个互不相干的运行环境（main / preload / renderer），
 * 只有 renderer 走 Vite。让 Vite 的 root 精确落在 renderer 目录上，
 * 才不会发生"Vite 顺手把 main 的代码也当成前端模块处理"这种事。
 *
 * dev 与 build 共用这一份配置 —— 两套配置最容易造成的 bug 是
 * "开发正常、打包白屏"，而那种问题往往要排查很久。
 */
export default defineConfig({
  root: join(here, 'src', 'renderer'),
  // 相对路径：产物要能从 app://crossdeck/index.html 直接加载
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: join(here, 'dist', 'renderer'),
    emptyOutDir: true,
    // 目标环境是确定的（Electron 自带的 Chromium），无需为老浏览器降级
    target: 'esnext',
    sourcemap: true,
    // ⚠️ 必须关掉 modulepreload polyfill：
    //    Vite 默认会往 HTML 里注入一段**行内脚本**来补 modulepreload，
    //    而生产 CSP 的 script-src 只有 'self' —— 行内脚本会被直接拦掉，页面白屏。
    //    Electron 的 Chromium 原生支持 modulepreload，本来也不需要这个 polyfill。
    modulePreload: { polyfill: false },
  },
});
