import { resolve as Resolve } from 'node:path'
import { defineConfig as DefineConfig } from 'vite'
import React from '@vitejs/plugin-react'

export default DefineConfig({
  root: 'Source/Renderer',
  plugins: [React()],
  build: { outDir: Resolve('Output/Web'), emptyOutDir: true, rollupOptions: { input: Resolve('Source/Renderer/Index.html') } },
})
