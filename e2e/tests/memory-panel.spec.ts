/**
 * E2E 测试 — 记忆浏览面板 (T-010)
 *
 * 测试范围:
 * - 通过 IPC 打开记忆窗口
 * - 记忆窗口显示统计和空列表
 * - 手动添加记忆
 * - 搜索记忆
 * - 查看记忆详情
 * - 删除记忆
 * - 通过 IPC 直接操作记忆数据
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

test.describe('记忆浏览面板', () => {

  test('通过 IPC 打开记忆窗口', async () => {
    testApp = await launchApp()
    const { chatWindow, app } = testApp

    // 通过 chatAPI 打开记忆面板
    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.openPanel('memory')
    })

    // 等待记忆窗口出现
    const memoryWindow = await waitForMemoryWindow(app)
    await memoryWindow.waitForLoadState('domcontentloaded')

    // 验证记忆窗口内容
    await expect(memoryWindow.locator('[data-testid="memory-root"]')).toBeVisible({ timeout: 10000 })
  })

  test('记忆窗口显示统计栏和空列表', async () => {
    testApp = await launchApp()
    const { chatWindow, app } = testApp

    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.openPanel('memory')
    })

    const memoryWindow = await waitForMemoryWindow(app)
    await memoryWindow.waitForLoadState('domcontentloaded')
    await expect(memoryWindow.locator('[data-testid="memory-root"]')).toBeVisible({ timeout: 10000 })

    // 等待加载完成
    await expect(memoryWindow.locator('.memory-content')).toBeVisible({ timeout: 5000 })

    // 统计栏可见
    await expect(memoryWindow.locator('[data-testid="stats-bar"]')).toBeVisible()

    // 空状态显示
    await expect(memoryWindow.locator('[data-testid="empty-memories"]')).toBeVisible()
  })

  test('手动添加记忆', async () => {
    testApp = await launchApp()
    const { chatWindow, app } = testApp

    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.openPanel('memory')
    })

    const memoryWindow = await waitForMemoryWindow(app)
    await memoryWindow.waitForLoadState('domcontentloaded')
    await expect(memoryWindow.locator('.memory-content')).toBeVisible({ timeout: 5000 })

    // 点击添加记忆
    await memoryWindow.locator('[data-testid="btn-add-memory"]').click()

    // 等待弹窗出现
    await expect(memoryWindow.locator('[data-testid="memory-create-modal"]')).toBeVisible()

    // 填写记忆内容
    await memoryWindow.locator('[data-testid="input-memory-content"]').fill('用户喜欢用 Python 编写代码')
    await memoryWindow.locator('[data-testid="input-memory-type"]').selectOption('semantic')
    await memoryWindow.locator('[data-testid="input-memory-tags"]').fill('偏好, 编程')

    // 保存
    await memoryWindow.locator('[data-testid="btn-save-memory"]').click()

    // 弹窗关闭
    await expect(memoryWindow.locator('[data-testid="memory-create-modal"]')).not.toBeVisible()

    // 记忆应出现在列表中
    await expect(memoryWindow.locator('[data-testid="memory-list"]')).toBeVisible()
    await expect(memoryWindow.locator('.memory-card').first()).toBeVisible()

    // 成功提示
    await expect(memoryWindow.locator('[data-testid="success-msg"]')).toBeVisible()
  })

  test('查看记忆详情', async () => {
    testApp = await launchApp()
    const { chatWindow, app } = testApp

    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.openPanel('memory')
    })

    const memoryWindow = await waitForMemoryWindow(app)
    await memoryWindow.waitForLoadState('domcontentloaded')
    await expect(memoryWindow.locator('.memory-content')).toBeVisible({ timeout: 5000 })

    // 先添加一条记忆
    await memoryWindow.locator('[data-testid="btn-add-memory"]').click()
    await expect(memoryWindow.locator('[data-testid="memory-create-modal"]')).toBeVisible()
    await memoryWindow.locator('[data-testid="input-memory-content"]').fill('测试记忆详情内容')
    await memoryWindow.locator('[data-testid="btn-save-memory"]').click()
    await expect(memoryWindow.locator('[data-testid="memory-create-modal"]')).not.toBeVisible()

    // 等待列表刷新
    await expect(memoryWindow.locator('.memory-card').first()).toBeVisible()

    // 点击记忆卡片查看详情
    await memoryWindow.locator('.memory-card').first().click()

    // 详情弹窗出现
    await expect(memoryWindow.locator('[data-testid="memory-detail-modal"]')).toBeVisible()

    // 验证详情内容 — 使用 heading 精确定位标题
    await expect(memoryWindow.getByRole('heading', { name: '记忆详情' })).toBeVisible()
    await expect(memoryWindow.locator('.detail-text', { hasText: '测试记忆详情内容' })).toBeVisible()
  })

  test('删除记忆', async () => {
    testApp = await launchApp()
    const { chatWindow, app } = testApp

    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.openPanel('memory')
    })

    const memoryWindow = await waitForMemoryWindow(app)
    await memoryWindow.waitForLoadState('domcontentloaded')
    await expect(memoryWindow.locator('.memory-content')).toBeVisible({ timeout: 5000 })

    // 先添加一条记忆
    await memoryWindow.locator('[data-testid="btn-add-memory"]').click()
    await expect(memoryWindow.locator('[data-testid="memory-create-modal"]')).toBeVisible()
    await memoryWindow.locator('[data-testid="input-memory-content"]').fill('待删除的记忆')
    await memoryWindow.locator('[data-testid="btn-save-memory"]').click()
    await expect(memoryWindow.locator('[data-testid="memory-create-modal"]')).not.toBeVisible()
    await expect(memoryWindow.locator('.memory-card').first()).toBeVisible()

    // 点击删除按钮
    memoryWindow.on('dialog', dialog => dialog.accept())
    await memoryWindow.locator('.memory-card .btn-icon[title="删除"]').first().click()

    // 等待列表刷新 — 空状态出现
    await expect(memoryWindow.locator('[data-testid="empty-memories"]')).toBeVisible({ timeout: 5000 })

    // 成功提示
    await expect(memoryWindow.locator('[data-testid="success-msg"]')).toBeVisible()
  })

  test('通过 IPC 直接操作记忆数据', async () => {
    testApp = await launchApp()
    const { chatWindow, app } = testApp

    // 先发送一条消息以触发数据库初始化
    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.send('hello')
    })
    await chatWindow.waitForTimeout(3000)

    // 打开记忆窗口
    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.openPanel('memory')
    })

    const memoryWindow = await waitForMemoryWindow(app)
    await memoryWindow.waitForLoadState('domcontentloaded')

    // 验证 memoryAPI 可用
    const apiExists = await memoryWindow.evaluate(() => {
      return typeof (window as any).memoryAPI !== 'undefined'
    })
    expect(apiExists).toBe(true)

    // 通过 memoryAPI 添加记忆
    const createResult = await memoryWindow.evaluate(() => {
      return (window as any).memoryAPI.create({
        content: 'IPC直接添加的记忆内容',
        type: 'semantic',
        importance: 0.8,
        tags: ['test', 'ipc']
      })
    })
    expect(createResult.success).toBe(true)

    // 通过 memoryAPI 获取列表
    const list = await memoryWindow.evaluate(() => {
      return (window as any).memoryAPI.list({ limit: 100 })
    })
    expect(Array.isArray(list)).toBe(true)
    expect(list.length).toBeGreaterThan(0)

    // 通过 memoryAPI 获取统计
    const stats = await memoryWindow.evaluate(() => {
      return (window as any).memoryAPI.stats()
    })
    expect(stats.totalMemories).toBeGreaterThan(0)

    // 找到刚创建的记忆并删除
    const targetMemory = list.find((m: any) => m.content && m.content.includes('IPC直接添加'))
    if (targetMemory) {
      await memoryWindow.evaluate((id) => {
        return (window as any).memoryAPI.remove(id)
      }, targetMemory.id)

      // 验证删除后列表
      const listAfter = await memoryWindow.evaluate(() => {
        return (window as any).memoryAPI.list({ limit: 100 })
      })
      expect(listAfter.some((m: any) => m.id === targetMemory.id)).toBe(false)
    }
  })

  test('记忆列表类型筛选', async () => {
    testApp = await launchApp()
    const { chatWindow, app } = testApp

    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.openPanel('memory')
    })

    const memoryWindow = await waitForMemoryWindow(app)
    await memoryWindow.waitForLoadState('domcontentloaded')
    await expect(memoryWindow.locator('.memory-content')).toBeVisible({ timeout: 5000 })

    // 添加一条语义记忆
    await memoryWindow.locator('[data-testid="btn-add-memory"]').click()
    await expect(memoryWindow.locator('[data-testid="memory-create-modal"]')).toBeVisible()
    await memoryWindow.locator('[data-testid="input-memory-content"]').fill('语义记忆测试')
    await memoryWindow.locator('[data-testid="input-memory-type"]').selectOption('semantic')
    await memoryWindow.locator('[data-testid="btn-save-memory"]').click()
    await expect(memoryWindow.locator('[data-testid="memory-create-modal"]')).not.toBeVisible()

    // 验证有记忆显示
    await expect(memoryWindow.locator('.memory-card').first()).toBeVisible()

    // 验证筛选下拉框可用
    const filterSelect = memoryWindow.locator('[data-testid="filter-type"]')
    await expect(filterSelect).toBeVisible()

    // 切换到情景类型筛选
    await filterSelect.selectOption('episodic')
    // 等待视图更新
    await memoryWindow.waitForTimeout(500)

    // 切回全部
    await filterSelect.selectOption('all')
    await memoryWindow.waitForTimeout(500)

    // 应该能看到记忆卡片
    await expect(memoryWindow.locator('.memory-card').first()).toBeVisible()
  })
})

/** 等待记忆窗口出现 */
async function waitForMemoryWindow(app: any, timeout = 10000): Promise<any> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const win = app.windows().find((w: any) => w.url().includes('memory'))
    if (win) return win
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error('Memory window did not appear within timeout')
}
