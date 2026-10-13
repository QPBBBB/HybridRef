import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()], build: { rollupOptions: { input: resolve('src/main/index.ts') } } },
  preload: { plugins: [externalizeDepsPlugin()], build: { rollupOptions: { input: resolve('src/preload/index.ts') } } },
  renderer: {
    root: 'src/renderer',
    plugins: [react(), {
      name: 'development-refresh-csp',
      // React's development refresh preamble is inline; production stays strict.
      transformIndexHtml(html, context) {
        return context.server ? html.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';") : html
      },
    }],
    server: { fs: { allow: [resolve('..')] } },
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } },
  },
})
