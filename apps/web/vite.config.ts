import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// 开发时 Vite 在 5173，/api 代理到 surface-web 插件；正式用 build 产物由插件直接服务
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3939', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
