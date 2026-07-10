/**
 * E2E 测试 — 暗色主题 (T-018)
 *
 * 测试范围:
 * - 主题配置可通过 IPC 读取
 * - 主题切换通过 IPC 生效
 * - 设置面板显示主题切换 UI
 * - 切换暗色主题后 CSS 类正确应用
 * - 主题变化通知所有窗口
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

test.describe('暗色主题 (T-018)', () => {

  test('默认主题模式可通过 IPC 读取', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    // 读取主题配置
    const theme = await chatWindow.evaluate(() => {
      return (window as any).chatAPI.getTheme()
    })

    // 默认应该是 system 模式
    expect(theme.mode).toBe('system')
    expect(theme.effective).toBeDefined()
    expect(['light', 'dark']).toContain(theme.effective)
  })

  test('切换到暗色主题后 CSS 类正确应用', async () => {
    test.setTimeout(60000)
    testApp = await launchApp()
    const { chatWindow } = testApp

    // 切换到暗色主题
    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.setTheme('dark')
    })

    await chatWindow.waitForTimeout(1000)

    // 验证 chat-root 有 theme-dark 类
    const themeClass = await chatWindow.locator('[data-testid="chat-root"]').getAttribute('class')
    expect(themeClass).toContain('theme-dark')
  })

  test('切换到亮色主题后 CSS 类正确应用', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    // 切换到亮色主题
    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.setTheme('light')
    })

    await chatWindow.waitForTimeout(500)

    // 验证 chat-root 有 theme-light 类
    const themeClass = await chatWindow.locator('[data-testid="chat-root"]').getAttribute('class')
    expect(themeClass).toContain('theme-light')
  })

  test('切换回系统主题', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    // 先切换到暗色
    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.setTheme('dark')
    })
    await chatWindow.waitForTimeout(300)

    // 再切换回系统
    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.setTheme('system')
    })
    await chatWindow.waitForTimeout(500)

    // 验证主题类是 light 或 dark（取决于系统）
    const themeClass = await chatWindow.locator('[data-testid="chat-root"]').getAttribute('class')
    expect(themeClass).toMatch(/theme-(light|dark)/)
  })

  test('设置面板显示主题切换 UI', async () => {
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

    // 验证主题配置区域存在
    await expect(settingsWindow.locator('[data-testid="theme-section"]')).toBeVisible()

    // 验证三个主题选项按钮存在
    await expect(settingsWindow.locator('[data-testid="theme-btn-system"]')).toBeVisible()
    await expect(settingsWindow.locator('[data-testid="theme-btn-light"]')).toBeVisible()
    await expect(settingsWindow.locator('[data-testid="theme-btn-dark"]')).toBeVisible()
  })

  test('在设置面板中切换主题', async () => {
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

    // 点击暗色主题按钮
    await settingsWindow.locator('[data-testid="theme-btn-dark"]').click()
    await settingsWindow.waitForTimeout(500)

    // 验证设置面板有暗色主题类
    const rootClass = await settingsWindow.locator('[data-testid="settings-root"]').getAttribute('class')
    expect(rootClass).toContain('theme-dark')

    // 验证暗色按钮是激活状态
    await expect(settingsWindow.locator('[data-testid="theme-btn-dark"]')).toHaveClass(/active/)

    // 验证聊天窗口也同步了主题
    const chatClass = await chatWindow.locator('[data-testid="chat-root"]').getAttribute('class')
    expect(chatClass).toContain('theme-dark')
  })

  test('主题变化通知宠物窗口', async () => {
    testApp = await launchApp()
    const { petWindow, chatWindow } = testApp

    // 切换到暗色
    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.setTheme('dark')
    })

    await petWindow.waitForTimeout(500)

    // 验证宠物窗口有暗色主题类
    const petClass = await petWindow.locator('[data-testid="pet-root"]').getAttribute('class')
    expect(petClass).toContain('theme-dark')
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
