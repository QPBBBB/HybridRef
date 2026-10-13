import { defineConfig as DefineConfig } from '@playwright/test'

/**
 * Exercise the application in real Microsoft Edge, with isolated browser
 * contexts and temporary project files. No Electron runtime is used.
 */
export default DefineConfig({
  testDir: './E2E',
  testMatch: '**/*E2E.ts',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  use: { browserName: 'chromium', channel: 'msedge', viewport: { width: 1360, height: 900 } },
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  outputDir: 'test-results',
})
