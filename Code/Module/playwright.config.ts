import { defineConfig as DefineConfig } from '@playwright/test'

// Each test uses an isolated Edge context and temporary project files.
export default DefineConfig({
  testDir: './E2E',
  testMatch: '**/*E2E.ts',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  use: {
    browserName: 'chromium', channel: 'msedge', viewport: { width: 1360, height: 900 },
    screenshot: 'only-on-failure', trace: 'retain-on-failure',
  },
  reporter: [[process.env.CI ? 'github' : 'list'], ['html', { open: 'never', outputFolder: 'Runtime/PlaywrightReport' }]],
  outputDir: 'Runtime/TestResults',
})
