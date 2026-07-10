/**
 * E2E 测试 — 插件系统 (T-022)
 *
 * 测试范围:
 * - 打开插件管理窗口
 * - 空列表状态
 * - 安装插件（UI 表单 + API）
 * - 插件列表显示
 * - 启用/禁用插件
 * - 卸载插件
 * - IPC 操作
 * - 搜索功能
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

test.describe('插件系统 (T-022)', () => {

  test('打开插件管理窗口', async () => {
    testApp = await launchApp()
    const { chatWindow, app } = testApp

    // 通过 IPC 打开插件面板
    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.openPanel('plugins')
    })

    // 等待插件窗口出现
    const pluginsWindow = await waitForPluginsWindow(app)
    await pluginsWindow.waitForLoadState('domcontentloaded')
    await expect(pluginsWindow.locator('[data-testid="plugins-root"]')).toBeVisible({ timeout: 10000 })
  })

  test('空插件列表显示空状态', async () => {
    testApp = await launchApp()
    const { chatWindow, app } = testApp

    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.openPanel('plugins')
    })

    const pluginsWindow = await waitForPluginsWindow(app)
    await pluginsWindow.waitForLoadState('domcontentloaded')
    await expect(pluginsWindow.locator('[data-testid="plugins-root"]')).toBeVisible({ timeout: 10000 })

    // 等待加载完成
    await expect(pluginsWindow.locator('.plugins-content')).toBeVisible({ timeout: 10000 })

    // 验证空状态
    await expect(pluginsWindow.locator('[data-testid="empty-plugins"]')).toBeVisible()
  })

  test('安装插件表单 UI', async () => {
    testApp = await launchApp()
    const { chatWindow, app } = testApp

    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.openPanel('plugins')
    })

    const pluginsWindow = await waitForPluginsWindow(app)
    await pluginsWindow.waitForLoadState('domcontentloaded')
    await expect(pluginsWindow.locator('[data-testid="plugins-root"]')).toBeVisible({ timeout: 10000 })
    await expect(pluginsWindow.locator('.plugins-content')).toBeVisible({ timeout: 10000 })

    // 点击安装按钮，验证弹窗出现
    await pluginsWindow.locator('[data-testid="btn-install-plugin"]').click()
    await expect(pluginsWindow.locator('[data-testid="install-modal"]')).toBeVisible({ timeout: 5000 })

    // 验证表单字段存在
    await expect(pluginsWindow.locator('[data-testid="input-plugin-id"]')).toBeVisible()
    await expect(pluginsWindow.locator('[data-testid="input-plugin-name"]')).toBeVisible()
    await expect(pluginsWindow.locator('[data-testid="input-plugin-desc"]')).toBeVisible()
    await expect(pluginsWindow.locator('[data-testid="input-plugin-author"]')).toBeVisible()
    await expect(pluginsWindow.locator('[data-testid="btn-confirm-install"]')).toBeVisible()

    // 填写表单验证输入功能
    await pluginsWindow.locator('[data-testid="input-plugin-id"]').fill('form-test')
    await expect(pluginsWindow.locator('[data-testid="input-plugin-id"]')).toHaveValue('form-test')

    // 关闭弹窗
    await pluginsWindow.locator('.btn-cancel').click()
    await expect(pluginsWindow.locator('[data-testid="install-modal"]')).not.toBeVisible({ timeout: 5000 })
  })

  test('通过 API 安装插件后 UI 显示', async () => {
    testApp = await launchApp()
    const { chatWindow, app } = testApp

    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.openPanel('plugins')
    })

    const pluginsWindow = await waitForPluginsWindow(app)
    await pluginsWindow.waitForLoadState('domcontentloaded')
    await expect(pluginsWindow.locator('[data-testid="plugins-root"]')).toBeVisible({ timeout: 10000 })
    await expect(pluginsWindow.locator('.plugins-content')).toBeVisible({ timeout: 10000 })

    // 通过 API 安装插件
    const installResult = await pluginsWindow.evaluate(() => {
      return (window as any).pluginsAPI.install({
        id: 'ui-display-test',
        name: 'UI 显示测试插件',
        version: '1.0.0',
        description: '通过 API 安装用于 UI 显示测试',
        author: '测试者',
        entry: 'index.js',
        permissions: ['tool:register'],
        enabled: true,
        installedAt: Date.now()
      })
    })
    expect(installResult.success).toBeTruthy()

    // 刷新页面以加载新插件
    await pluginsWindow.reload()
    await pluginsWindow.waitForLoadState('domcontentloaded')
    await expect(pluginsWindow.locator('[data-testid="plugins-root"]')).toBeVisible({ timeout: 10000 })
    await expect(pluginsWindow.locator('.plugins-content')).toBeVisible({ timeout: 10000 })

    // 验证插件卡片出现
    await expect(pluginsWindow.locator('[data-testid="plugin-card"]')).toBeVisible({ timeout: 10000 })
    const card = pluginsWindow.locator('[data-testid="plugin-card"]')
    await expect(card).toContainText('UI 显示测试插件')
    await expect(card).toContainText('通过 API 安装用于 UI 显示测试')
  })

  test('禁用插件', async () => {
    testApp = await launchApp()
    const { chatWindow, app } = testApp

    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.openPanel('plugins')
    })

    const pluginsWindow = await waitForPluginsWindow(app)
    await pluginsWindow.waitForLoadState('domcontentloaded')
    await expect(pluginsWindow.locator('[data-testid="plugins-root"]')).toBeVisible({ timeout: 10000 })
    await expect(pluginsWindow.locator('.plugins-content')).toBeVisible({ timeout: 10000 })

    // 通过 API 安装插件
    await pluginsWindow.evaluate(() => {
      return (window as any).pluginsAPI.install({
        id: 'toggle-test',
        name: '切换测试插件',
        version: '1.0.0',
        description: '测试启用/禁用',
        author: '测试',
        entry: 'index.js',
        permissions: [],
        enabled: true,
        installedAt: Date.now()
      })
    })

    // 刷新页面
    await pluginsWindow.reload()
    await pluginsWindow.waitForLoadState('domcontentloaded')
    await expect(pluginsWindow.locator('.plugins-content')).toBeVisible({ timeout: 10000 })
    await expect(pluginsWindow.locator('[data-testid="plugin-card"]')).toBeVisible({ timeout: 10000 })

    // 点击禁用按钮
    await pluginsWindow.locator('[data-testid="btn-toggle-plugin"]').click()

    // 等待列表刷新
    await pluginsWindow.waitForTimeout(1000)

    // 验证插件卡片变为禁用状态
    const card = pluginsWindow.locator('[data-testid="plugin-card"]')
    await expect(card).toHaveClass(/inactive/)
  })

  test('卸载插件', async () => {
    testApp = await launchApp()
    const { chatWindow, app } = testApp

    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.openPanel('plugins')
    })

    const pluginsWindow = await waitForPluginsWindow(app)
    await pluginsWindow.waitForLoadState('domcontentloaded')
    await expect(pluginsWindow.locator('[data-testid="plugins-root"]')).toBeVisible({ timeout: 10000 })
    await expect(pluginsWindow.locator('.plugins-content')).toBeVisible({ timeout: 10000 })

    // 通过 API 安装插件
    await pluginsWindow.evaluate(() => {
      return (window as any).pluginsAPI.install({
        id: 'uninstall-test',
        name: '卸载测试插件',
        version: '1.0.0',
        description: '测试卸载功能',
        author: '测试',
        entry: 'index.js',
        permissions: [],
        enabled: true,
        installedAt: Date.now()
      })
    })

    // 刷新页面
    await pluginsWindow.reload()
    await pluginsWindow.waitForLoadState('domcontentloaded')
    await expect(pluginsWindow.locator('.plugins-content')).toBeVisible({ timeout: 10000 })
    await expect(pluginsWindow.locator('[data-testid="plugin-card"]')).toBeVisible({ timeout: 10000 })

    // 点击卸载按钮（需要处理 confirm 对话框）
    pluginsWindow.on('dialog', dialog => dialog.accept())
    await pluginsWindow.locator('[data-testid="btn-uninstall-plugin"]').click()

    // 等待列表刷新
    await pluginsWindow.waitForTimeout(1000)

    // 验证插件被移除（显示空状态）
    await expect(pluginsWindow.locator('[data-testid="empty-plugins"]')).toBeVisible({ timeout: 10000 })
  })

  test('IPC 插件列表操作', async () => {
    testApp = await launchApp()
    const { chatWindow, app } = testApp

    // 通过 IPC 打开插件窗口来获取 pluginsAPI
    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.openPanel('plugins')
    })

    const pluginsWindow = await waitForPluginsWindow(app)
    await pluginsWindow.waitForLoadState('domcontentloaded')
    await expect(pluginsWindow.locator('[data-testid="plugins-root"]')).toBeVisible({ timeout: 10000 })

    // 通过 pluginsAPI 安装插件
    const installResult = await pluginsWindow.evaluate(() => {
      return (window as any).pluginsAPI.install({
        id: 'ipc-test',
        name: 'IPC 测试插件',
        version: '1.0.0',
        description: '通过 IPC 安装的插件',
        author: '测试',
        entry: 'index.js',
        permissions: ['tool:register'],
        enabled: true,
        installedAt: Date.now()
      })
    })

    expect(installResult.success).toBeTruthy()

    // 通过 pluginsAPI 获取插件列表
    const list = await pluginsWindow.evaluate(() => {
      return (window as any).pluginsAPI.list()
    })

    expect(list.length).toBeGreaterThan(0)
    const found = list.find((p: any) => p.manifest.id === 'ipc-test')
    expect(found).toBeTruthy()
    expect(found.manifest.name).toBe('IPC 测试插件')

    // 通过 pluginsAPI 卸载
    const uninstallResult = await pluginsWindow.evaluate(() => {
      return (window as any).pluginsAPI.uninstall('ipc-test')
    })

    expect(uninstallResult.success).toBeTruthy()
  })

  test('统计栏显示正确', async () => {
    testApp = await launchApp()
    const { chatWindow, app } = testApp

    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.openPanel('plugins')
    })

    const pluginsWindow = await waitForPluginsWindow(app)
    await pluginsWindow.waitForLoadState('domcontentloaded')
    await expect(pluginsWindow.locator('[data-testid="plugins-root"]')).toBeVisible({ timeout: 10000 })
    await expect(pluginsWindow.locator('.plugins-content')).toBeVisible({ timeout: 10000 })

    // 验证统计栏存在
    await expect(pluginsWindow.locator('[data-testid="stats-bar"]')).toBeVisible()

    // 验证统计数值
    const statValues = pluginsWindow.locator('.stat-value')
    const count = await statValues.count()
    expect(count).toBeGreaterThanOrEqual(3) // 总计、活跃、停用
  })
})

/** 等待插件窗口出现 */
async function waitForPluginsWindow(app: any, timeout = 10000): Promise<any> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const win = app.windows().find((w: any) => w.url().includes('plugins'))
    if (win) return win
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error('Plugins window did not appear within timeout')
}
