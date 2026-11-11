import { defineConfig } from 'vite';

/**
 * 浏览器桩的构建配置 —— 与产品 bundle（vite.config.ts）分开。
 *
 * 产物是单个 IIFE（`dist-stub/ohos-stub.global.js`），由
 * `scripts/ohos-bundle-selfcheck.mjs` 经 CDP `Page.addScriptToEvaluateOnNewDocument`
 * 注入页面 —— 它必须在 index.html 的内联脚本之前就位，且不能有 ESM import。
 */
export default defineConfig({
  build: {
    outDir: 'dist-stub',
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: 'src-stub/ohosPortsStub.ts',
      name: '__crossdeckOhosStub',
      formats: ['iife'],
      fileName: () => 'ohos-stub.global.js',
    },
  },
});
