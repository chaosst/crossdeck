import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  base: '/',                    // 自建 origin 下绝对路径可用（onInterceptRequest 按 origin 前缀切）
  build: { outDir: 'entry/src/main/resources/rawfile/app', emptyOutDir: true },
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify('1.0.0'),
  },
})
