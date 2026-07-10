/**
 * E2E 测试 — 快捷键系统 (T-016)
 *
 * 测试范围:
 * - 快捷键配置可通过 IPC 读取
 * - 快捷键配置可通过 IPC 保存
 * - 默认快捷键值正确
 * - 设置面板显示快捷键配置区域
 * - 快捷键录制功能
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

test.describe('快捷键系统 (T-016)', () => {

  test('默认快捷键配置可通过 IPC 读取', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    // 读取快捷键配置
    const shortcuts = await chatWindow.evaluate(() => {
      return (window as any).chatAPI.getShortcuts?.() ||
             (window as any).settingsAPI?.getShortcuts?.()
    })

    // 如果 chatAPI 没有暴露 getShortcuts，通过 settingsAPI 测试
    if (!shortcuts) {
      // 打开设置面板
      await chatWindow.evaluate(() => {
        return (window as any).chatAPI.openPanel('settings')
      })

      const settingsWindow = await waitForSettingsWindow(testApp!.app)
      await settingsWindow.waitForLoadState('domcontentloaded')
      await expect(settingsWindow.locator('[data-testid="settings-root"]')).toBeVisible({ timeout: 10000 })

      const settingsShortcuts = await settingsWindow.evaluate(() => {
        return (window as any).settingsAPI.getShortcuts()
      })

      // 验证默认值
      expect(settingsShortcuts.toggleChat).toBe('CommandOrControl+Shift+Z')
      expect(settingsShortcuts.newSession).toBe('CommandOrControl+Shift+N')
      expect(settingsShortcuts.togglePet).toBe('CommandOrControl+Shift+P')
    } else {
      expect(shortcuts.toggleChat).toBe('CommandOrControl+Shift+Z')
      expect(shortcuts.newSession).toBe('CommandOrControl+Shift+N')
    }
  })

  test('快捷键配置可通过 IPC 保存和读取', async () => {
    test.setTimeout(60000)
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

    // 保存自定义快捷键
    const customShortcuts = {
      toggleChat: 'CommandOrControl+Shift+A',
      newSession: 'CommandOrControl+Shift+B',
      togglePet: 'CommandOrControl+Shift+C'
    }

    await settingsWindow.evaluate(async (shortcuts) => {
      await (window as any).settingsAPI.setShortcuts(shortcuts)
    }, customShortcuts)

    // 重新读取验证
    const saved = await settingsWindow.evaluate(() => {
      return (window as any).settingsAPI.getShortcuts()
    })

    expect(saved.toggleChat).toBe('CommandOrControl+Shift+A')
    expect(saved.newSession).toBe('CommandOrControl+Shift+B')
    expect(saved.togglePet).toBe('CommandOrControl+Shift+C')
  })

  test('设置面板显示快捷键配置区域', async () => {
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

    // 验证快捷键配置区域存在
    await expect(settingsWindow.locator('[data-testid="shortcuts-section"]')).toBeVisible()

    // 验证快捷键值显示
    await expect(settingsWindow.locator('[data-testid="shortcut-value"]').first()).toBeVisible()
  })

  test('快捷键录制功能', async () => {
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

    // 点击第一个快捷键输入框开始录制
    const firstShortcutInput = settingsWindow.locator('.shortcut-input-wrapper').first()
    await firstShortcutInput.click()

    // 验证录制状态显示
    await expect(settingsWindow.locator('.shortcut-recording')).toBeVisible()

    // 按下快捷键
    await settingsWindow.keyboard.press('Control+Shift+X')

    // 验证录制结束，新值显示
    await expect(settingsWindow.locator('.shortcut-recording')).not.toBeVisible()

    // 验证快捷键值更新
    const shortcutValue = await settingsWindow.locator('[data-testid="shortcut-value"]').first().textContent()
    expect(shortcutValue).toContain('CommandOrControl')
    expect(shortcutValue).toContain('Shift')
    expect(shortcutValue).toContain('X')
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
