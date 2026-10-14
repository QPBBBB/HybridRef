import { resolve as Resolve } from 'node:path'
import { defineConfig as DefineConfig } from 'vite'

export default DefineConfig({
  root: 'Source/Renderer',
  esbuild: { jsx: 'automatic' },
  build: { outDir: Resolve('Output/Web'), emptyOutDir: true, rollupOptions: { input: Resolve('Source/Renderer/Index.html') } },
})
