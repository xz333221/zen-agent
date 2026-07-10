/**
 * E2E 测试 — 离线模式 / Ollama (T-024)
 *
 * 测试范围:
 * - 设置面板显示 Ollama 区域
 * - Ollama 状态显示
 * - 离线模式启用/禁用
 * - 模型下载 UI
 * - 推荐模型列表
 * - IPC 状态查询
 * - IPC 启用/禁用操作
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

/** 等待设置窗口内容加载完成（Ollama 状态检查可能需要几秒） */
async function waitForSettingsContent(settingsWindow: any): Promise<void> {
  await settingsWindow.waitForLoadState('domcontentloaded')
  await expect(settingsWindow.locator('[data-testid="settings-root"]')).toBeVisible({ timeout: 10000 })
  // Ollama 状态检查有 3 秒超时，加上其他 IPC 调用，总共可能需要 10 秒
  await expect(settingsWindow.locator('.settings-content')).toBeVisible({ timeout: 15000 })
}

test.describe('离线模式 / Ollama (T-024)', () => {

  test('设置面板显示 Ollama 区域', async () => {
    testApp = await launchApp()
    const { chatWindow, app } = testApp

    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.openPanel('settings')
    })

    const settingsWindow = await waitForSettingsWindow(app)
    await waitForSettingsContent(settingsWindow)

    // 验证 Ollama 区域存在
    await expect(settingsWindow.locator('[data-testid="ollama-section"]')).toBeVisible()
  })

  test('Ollama 状态显示', async () => {
    testApp = await launchApp()
    const { chatWindow, app } = testApp

    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.openPanel('settings')
    })

    const settingsWindow = await waitForSettingsWindow(app)
    await waitForSettingsContent(settingsWindow)

    // 验证状态显示（在线或离线）
    const statusText = await settingsWindow.locator('[data-testid="ollama-section"]').textContent()
    // 在 E2E 测试环境中 Ollama 通常不在线
    expect(statusText).toMatch(/在线|离线/)
  })

  test('离线模式启用/禁用切换', async () => {
    testApp = await launchApp()
    const { chatWindow, app } = testApp

    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.openPanel('settings')
    })

    const settingsWindow = await waitForSettingsWindow(app)
    await waitForSettingsContent(settingsWindow)

    // 验证离线模式切换按钮存在
    const toggleBtn = settingsWindow.locator('[data-testid="btn-toggle-offline"]')
    await expect(toggleBtn).toBeVisible()

    // 点击切换
    const initialText = await toggleBtn.textContent()
    await toggleBtn.click()
    await settingsWindow.waitForTimeout(500)

    // 验证状态变化
    const newText = await toggleBtn.textContent()
    expect(newText).not.toBe(initialText)
  })

  test('刷新 Ollama 状态', async () => {
    testApp = await launchApp()
    const { chatWindow, app } = testApp

    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.openPanel('settings')
    })

    const settingsWindow = await waitForSettingsWindow(app)
    await waitForSettingsContent(settingsWindow)

    // 验证刷新按钮存在
    const refreshBtn = settingsWindow.locator('[data-testid="btn-refresh-ollama"]')
    await expect(refreshBtn).toBeVisible()

    // 点击刷新
    await refreshBtn.click()
    await settingsWindow.waitForTimeout(1000)
  })

  test('模型下载 UI 存在', async () => {
    testApp = await launchApp()
    const { chatWindow, app } = testApp

    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.openPanel('settings')
    })

    const settingsWindow = await waitForSettingsWindow(app)
    await waitForSettingsContent(settingsWindow)

    // 验证模型下载输入框存在
    await expect(settingsWindow.locator('[data-testid="input-pull-model"]')).toBeVisible()

    // 验证下载按钮存在
    await expect(settingsWindow.locator('[data-testid="btn-pull-model"]')).toBeVisible()
  })

  test('推荐模型列表显示', async () => {
    testApp = await launchApp()
    const { chatWindow, app } = testApp

    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.openPanel('settings')
    })

    const settingsWindow = await waitForSettingsWindow(app)
    await waitForSettingsContent(settingsWindow)

    // 验证推荐模型按钮存在
    const recommendedBtns = settingsWindow.locator('.recommended-model-btn')
    const count = await recommendedBtns.count()
    expect(count).toBeGreaterThanOrEqual(3)

    // 验证包含已知的推荐模型名称
    const text = await settingsWindow.locator('[data-testid="ollama-section"]').textContent()
    expect(text).toContain('llama3.2')
  })

  test('IPC 获取 Ollama 状态', async () => {
    testApp = await launchApp()
    const { chatWindow, app } = testApp

    // 打开设置窗口来获取 settingsAPI
    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.openPanel('settings')
    })

    const settingsWindow = await waitForSettingsWindow(app)
    await settingsWindow.waitForLoadState('domcontentloaded')
    await expect(settingsWindow.locator('[data-testid="settings-root"]')).toBeVisible({ timeout: 10000 })

    const status = await settingsWindow.evaluate(() => {
      return (window as any).settingsAPI.getOllamaStatus()
    })

    // 验证状态结构
    expect(status).toHaveProperty('online')
    expect(status).toHaveProperty('host')
    expect(status).toHaveProperty('offlineMode')
    expect(status).toHaveProperty('models')
    expect(typeof status.online).toBe('boolean')
    expect(typeof status.host).toBe('string')
    expect(typeof status.offlineMode).toBe('boolean')
    expect(Array.isArray(status.models)).toBe(true)
  })

  test('IPC 启用/禁用离线模式', async () => {
    testApp = await launchApp()
    const { chatWindow, app } = testApp

    // 打开设置窗口来获取 settingsAPI
    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.openPanel('settings')
    })

    const settingsWindow = await waitForSettingsWindow(app)
    await settingsWindow.waitForLoadState('domcontentloaded')
    await expect(settingsWindow.locator('[data-testid="settings-root"]')).toBeVisible({ timeout: 10000 })

    // 启用离线模式
    const enableResult = await settingsWindow.evaluate(() => {
      return (window as any).settingsAPI.setOllamaEnabled(true)
    })
    expect(enableResult.success).toBeTruthy()

    // 验证已启用
    const status = await settingsWindow.evaluate(() => {
      return (window as any).settingsAPI.getOllamaStatus()
    })
    expect(status.offlineMode).toBe(true)

    // 禁用离线模式
    const disableResult = await settingsWindow.evaluate(() => {
      return (window as any).settingsAPI.setOllamaEnabled(false)
    })
    expect(disableResult.success).toBeTruthy()

    // 验证已禁用
    const status2 = await settingsWindow.evaluate(() => {
      return (window as any).settingsAPI.getOllamaStatus()
    })
    expect(status2.offlineMode).toBe(false)
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
