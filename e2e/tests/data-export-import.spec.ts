/**
 * E2E 测试 — 数据导出/导入 (T-023)
 *
 * 测试范围:
 * - 设置面板显示导出/导入区域
 * - 导出格式选择
 * - 导出范围选择
 * - 导出按钮存在
 * - 导入按钮存在
 * - chatAPI 暴露导出/导入方法
 */
import { test, expect } from '@playwright/test'
import { launchApp, closeApp, type TestApp } from '../helpers/electron'

let testApp: TestApp | null = null

test.afterEach(async () => {
  if (testApp) {
    await closeApp(testApp.app)
    testApp = null
  }
})

test.describe('数据导出/导入 (T-023)', () => {

  test('设置面板显示数据导出/导入区域', async () => {
    testApp = await launchApp()
    const { chatWindow, app } = testApp

    // 打开设置面板
    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.openPanel('settings')
    })

    const settingsWindow = await waitForSettingsWindow(app)
    await settingsWindow.waitForLoadState('domcontentloaded')
    await expect(settingsWindow.locator('[data-testid="settings-root"]')).toBeVisible({ timeout: 10000 })
    await expect(settingsWindow.locator('.settings-content')).toBeVisible({ timeout: 5000 })

    // 验证数据导出/导入区域存在
    await expect(settingsWindow.locator('[data-testid="data-section"]')).toBeVisible()
  })

  test('导出格式选择器', async () => {
    testApp = await launchApp()
    const { chatWindow, app } = testApp

    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.openPanel('settings')
    })

    const settingsWindow = await waitForSettingsWindow(app)
    await settingsWindow.waitForLoadState('domcontentloaded')
    await expect(settingsWindow.locator('[data-testid="settings-root"]')).toBeVisible({ timeout: 10000 })
    await expect(settingsWindow.locator('.settings-content')).toBeVisible({ timeout: 5000 })

    // 验证格式选择器存在
    const formatSelect = settingsWindow.locator('[data-testid="select-export-format"]')
    await expect(formatSelect).toBeVisible()

    // 验证默认值为 json
    await expect(formatSelect).toHaveValue('json')

    // 切换到 markdown
    await formatSelect.selectOption('markdown')
    await expect(formatSelect).toHaveValue('markdown')
  })

  test('导出范围选择器', async () => {
    testApp = await launchApp()
    const { chatWindow, app } = testApp

    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.openPanel('settings')
    })

    const settingsWindow = await waitForSettingsWindow(app)
    await settingsWindow.waitForLoadState('domcontentloaded')
    await expect(settingsWindow.locator('[data-testid="settings-root"]')).toBeVisible({ timeout: 10000 })
    await expect(settingsWindow.locator('.settings-content')).toBeVisible({ timeout: 5000 })

    // 验证范围选择器存在
    const scopeSelect = settingsWindow.locator('[data-testid="select-export-scope"]')
    await expect(scopeSelect).toBeVisible()

    // 验证默认值为 all
    await expect(scopeSelect).toHaveValue('all')

    // 切换到 sessions
    await scopeSelect.selectOption('sessions')
    await expect(scopeSelect).toHaveValue('sessions')
  })

  test('导出和导入按钮存在', async () => {
    testApp = await launchApp()
    const { chatWindow, app } = testApp

    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.openPanel('settings')
    })

    const settingsWindow = await waitForSettingsWindow(app)
    await settingsWindow.waitForLoadState('domcontentloaded')
    await expect(settingsWindow.locator('[data-testid="settings-root"]')).toBeVisible({ timeout: 10000 })
    await expect(settingsWindow.locator('.settings-content')).toBeVisible({ timeout: 5000 })

    // 验证导出按钮存在
    await expect(settingsWindow.locator('[data-testid="btn-export"]')).toBeVisible()

    // 验证导入按钮存在
    await expect(settingsWindow.locator('[data-testid="btn-import"]')).toBeVisible()
  })

  test('chatAPI 暴露导出/导入方法', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    // 验证 chatAPI 暴露了导出/导入方法
    const hasMethods = await chatWindow.evaluate(() => {
      const api = (window as any).chatAPI
      return {
        hasExportData: typeof api.exportData === 'function',
        hasImportData: typeof api.importData === 'function',
        hasExportSessions: typeof api.exportSessions === 'function'
      }
    })

    expect(hasMethods.hasExportData).toBe(true)
    expect(hasMethods.hasImportData).toBe(true)
    expect(hasMethods.hasExportSessions).toBe(true)
  })

  test('settingsAPI 暴露导出/导入方法', async () => {
    testApp = await launchApp()
    const { chatWindow, app } = testApp

    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.openPanel('settings')
    })

    const settingsWindow = await waitForSettingsWindow(app)
    await settingsWindow.waitForLoadState('domcontentloaded')
    await expect(settingsWindow.locator('[data-testid="settings-root"]')).toBeVisible({ timeout: 10000 })

    const hasMethods = await settingsWindow.evaluate(() => {
      const api = (window as any).settingsAPI
      return {
        hasExportData: typeof api.exportData === 'function',
        hasImportData: typeof api.importData === 'function'
      }
    })

    expect(hasMethods.hasExportData).toBe(true)
    expect(hasMethods.hasImportData).toBe(true)
  })
})

/** 等待设置窗口出现 */
async function waitForSettingsWindow(app: any, timeout = 10000): Promise<any> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const win = app.windows().find((w: any) => w.url().includes('settings'))
    if (win) return win
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error('Settings window did not appear within timeout')
}
