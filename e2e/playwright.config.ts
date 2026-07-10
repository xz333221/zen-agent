import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,          // Electron 应用测试不能并行
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,                    // 单线程，Electron 单实例
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'e2e/report' }]
  ],
  timeout: 60000,               // 每个测试 60s 超时
  expect: { timeout: 10000 },
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  }
})
