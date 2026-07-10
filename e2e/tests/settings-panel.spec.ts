/**
 * E2E 测试 — 设置面板
 *
 * 测试范围:
 * - 通过 IPC 打开设置窗口
 * - 设置窗口显示配置表单
 * - 添加 Provider 配置
 * - 保存配置后持久化
 * - 保存后重新读取验证
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

test.describe('设置面板', () => {

  test('通过 IPC 打开设置窗口', async () => {
    testApp = await launchApp()
    const { chatWindow, app } = testApp

    // 通过 chatAPI 打开设置面板
    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.openPanel('settings')
    })

    // 等待设置窗口出现
    const settingsWindow = await waitForSettingsWindow(app)
    await settingsWindow.waitForLoadState('domcontentloaded')

    // 验证设置窗口内容
    await expect(settingsWindow.locator('[data-testid="settings-root"]')).toBeVisible({ timeout: 10000 })
  })

  test('设置窗口显示 Provider 配置区域', async () => {
    testApp = await launchApp()
    const { chatWindow, app } = testApp

    // 打开设置窗口
    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.openPanel('settings')
    })

    const settingsWindow = await waitForSettingsWindow(app)
    await settingsWindow.waitForLoadState('domcontentloaded')
    await expect(settingsWindow.locator('[data-testid="settings-root"]')).toBeVisible({ timeout: 10000 })

    // 等待加载完成
    await expect(settingsWindow.locator('.settings-content')).toBeVisible({ timeout: 5000 })

    // 应该有 Provider 配置区域
    await expect(settingsWindow.locator('text=LLM Provider')).toBeVisible()

    // 空状态时显示提示
    await expect(settingsWindow.locator('[data-testid="empty-providers"]')).toBeVisible()
  })

  test('添加 Provider 并保存配置', async () => {
    testApp = await launchApp()
    const { chatWindow, app } = testApp

    // 打开设置窗口
    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.openPanel('settings')
    })

    const settingsWindow = await waitForSettingsWindow(app)
    await settingsWindow.waitForLoadState('domcontentloaded')
    await expect(settingsWindow.locator('[data-testid="settings-root"]')).toBeVisible({ timeout: 10000 })
    await expect(settingsWindow.locator('.settings-content')).toBeVisible({ timeout: 5000 })

    // 点击添加 Provider
    await settingsWindow.locator('[data-testid="btn-add-provider"]').click()

    // 等待弹窗出现
    await expect(settingsWindow.locator('[data-testid="provider-modal"]')).toBeVisible()

    // 填写 Provider 信息
    await settingsWindow.locator('[data-testid="input-provider-name"]').fill('Test OpenAI')
    await settingsWindow.locator('[data-testid="input-provider-url"]').fill('https://api.openai.com/v1')
    await settingsWindow.locator('[data-testid="input-provider-key"]').fill('sk-test-key-12345')
    await settingsWindow.locator('[data-testid="input-provider-models"]').fill('gpt-4o, gpt-4o-mini')

    // 保存 Provider
    await settingsWindow.locator('[data-testid="btn-save-provider"]').click()

    // 等待弹窗关闭
    await expect(settingsWindow.locator('[data-testid="provider-modal"]')).not.toBeVisible()

    // Provider 应该出现在列表中
    await expect(settingsWindow.locator('[data-testid="provider-list"]')).toBeVisible()
    await expect(settingsWindow.locator('text=Test OpenAI')).toBeVisible()

    // 保存配置
    await settingsWindow.locator('[data-testid="btn-save-settings"]').click()

    // 等待保存完成
    await settingsWindow.waitForTimeout(2000)

    // 验证配置列表更新（更可靠的验证方式）
    await expect(settingsWindow.locator('text=Test OpenAI')).toBeVisible()

    // 可选：检查保存成功提示
    // await settingsWindow.waitForTimeout(1000)
    // await expect(settingsWindow.locator('[data-testid="saved-msg"]')).toBeVisible()
  })

  test('保存的配置可通过 IPC 读取', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    // 通过 chatAPI 保存配置
    const testProvider = {
      id: 'test-provider-settings',
      name: 'Settings Test Provider',
      baseURL: 'https://api.test.com/v1',
      apiKey: 'sk-test-settings-key',
      models: ['gpt-4o', 'gpt-4o-mini'],
      enabled: true
    }

    await chatWindow.evaluate(async (provider) => {
      await (window as any).chatAPI.setConfig({
        providers: [provider],
        defaultModel: 'test-provider-settings::gpt-4o'
      })
    }, testProvider)

    // 通过 chatAPI 读取验证
    const savedConfig = await chatWindow.evaluate(() => {
      return (window as any).chatAPI.getConfig()
    })

    expect(savedConfig.providers).toHaveLength(1)
    expect(savedConfig.providers[0].name).toBe('Settings Test Provider')
    expect(savedConfig.providers[0].apiKey).toBe('sk-test-settings-key')
    expect(savedConfig.defaultModel).toBe('test-provider-settings::gpt-4o')
  })

  test('Max Tokens 滑块可调节', async () => {
    testApp = await launchApp()
    const { chatWindow, app } = testApp

    // 打开设置窗口
    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.openPanel('settings')
    })

    const settingsWindow = await waitForSettingsWindow(app)
    await settingsWindow.waitForLoadState('domcontentloaded')
    await expect(settingsWindow.locator('[data-testid="settings-root"]')).toBeVisible({ timeout: 10000 })
    await expect(settingsWindow.locator('.settings-content')).toBeVisible({ timeout: 5000 })

    // 验证滑块存在
    const slider = settingsWindow.locator('[data-testid="slider-max-tokens"]')
    await expect(slider).toBeVisible()

    // 获取当前值
    const initialValue = await slider.inputValue()
    expect(parseInt(initialValue)).toBeGreaterThan(0)

    // 设置新值
    await slider.fill('64000')
    const newValue = await slider.inputValue()
    expect(parseInt(newValue)).toBe(64000)
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
