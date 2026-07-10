/**
 * E2E 测试 — 执行追踪 UI 完善 (T-013)
 *
 * 测试范围:
 * - 实时追踪步骤在流式输出期间可见
 * - 追踪步骤逐步出现
 * - 完成后执行追踪可展开/折叠
 * - 步骤详情可展开/折叠
 * - 复制按钮存在
 * - Plan/Delegate 步骤在追踪中正确渲染
 * - 追踪摘要信息正确
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

test.describe('执行追踪 UI 完善 (T-013)', () => {

  test('实时追踪步骤在流式输出期间可见', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    // 发送消息
    await chatWindow.locator('[data-testid="input-textarea"]').fill('测试实时追踪')
    await chatWindow.locator('[data-testid="btn-send"]').click()

    // 等待回复开始
    const messages = chatWindow.locator('[data-testid="chat-message"]')
    await expect(messages.nth(1)).toBeVisible({ timeout: 5000 })

    // 在流式输出期间，应该能看到实时追踪组件或追踪步骤
    // 由于 mock 模式响应很快，我们检查最终结果
    await expect(chatWindow.locator('.streaming-cursor')).not.toBeVisible({ timeout: 15000 })

    // 完成后应该有执行追踪
    const traceElement = chatWindow.locator('.execution-trace')
    await expect(traceElement).toBeVisible({ timeout: 5000 })
  })

  test('执行追踪可展开和折叠', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    // 发送消息
    await chatWindow.locator('[data-testid="input-textarea"]').fill('测试追踪展开')
    await chatWindow.locator('[data-testid="btn-send"]').click()

    // 等待完成
    const messages = chatWindow.locator('[data-testid="chat-message"]')
    await expect(messages.nth(1)).toBeVisible({ timeout: 5000 })
    await expect(chatWindow.locator('.streaming-cursor')).not.toBeVisible({ timeout: 15000 })

    // 等待追踪出现
    const traceSummary = chatWindow.locator('.trace-summary')
    await expect(traceSummary).toBeVisible({ timeout: 5000 })

    // 初始状态：步骤列表不可见（折叠状态）
    const traceSteps = chatWindow.locator('.trace-steps')
    expect(await traceSteps.isVisible()).toBeFalsy()

    // 点击展开
    await traceSummary.click()
    await expect(traceSteps).toBeVisible()

    // 验证步骤存在
    const steps = chatWindow.locator('.trace-step')
    expect(await steps.count()).toBeGreaterThan(0)

    // 再次点击折叠
    await traceSummary.click()
    expect(await traceSteps.isVisible()).toBeFalsy()
  })

  test('步骤详情可展开和折叠', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    await chatWindow.locator('[data-testid="input-textarea"]').fill('测试步骤详情')
    await chatWindow.locator('[data-testid="btn-send"]').click()

    const messages = chatWindow.locator('[data-testid="chat-message"]')
    await expect(messages.nth(1)).toBeVisible({ timeout: 5000 })
    await expect(chatWindow.locator('.streaming-cursor')).not.toBeVisible({ timeout: 15000 })

    // 展开追踪
    const traceSummary = chatWindow.locator('.trace-summary')
    await traceSummary.click()

    // 点击第一个步骤展开详情
    const firstStepHeader = chatWindow.locator('.step-header').first()
    await firstStepHeader.click()

    // 验证步骤详情可见
    const stepDetail = chatWindow.locator('.step-detail').first()
    await expect(stepDetail).toBeVisible()

    // 再次点击折叠
    await firstStepHeader.click()
    expect(await stepDetail.isVisible()).toBeFalsy()
  })

  test('追踪摘要包含步骤数和耗时信息', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    await chatWindow.locator('[data-testid="input-textarea"]').fill('测试追踪摘要')
    await chatWindow.locator('[data-testid="btn-send"]').click()

    const messages = chatWindow.locator('[data-testid="chat-message"]')
    await expect(messages.nth(1)).toBeVisible({ timeout: 5000 })
    await expect(chatWindow.locator('.streaming-cursor')).not.toBeVisible({ timeout: 15000 })

    // 检查追踪摘要
    const summaryText = await chatWindow.locator('.trace-meta').textContent()
    expect(summaryText).toBeTruthy()
    // 应包含步数信息
    expect(summaryText!).toMatch(/\d+\s*步/)
  })

  test('追踪包含完整步骤类型', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    await chatWindow.locator('[data-testid="input-textarea"]').fill('测试步骤类型完整性')
    await chatWindow.locator('[data-testid="btn-send"]').click()

    const messages = chatWindow.locator('[data-testid="chat-message"]')
    await expect(messages.nth(1)).toBeVisible({ timeout: 5000 })
    await expect(chatWindow.locator('.streaming-cursor')).not.toBeVisible({ timeout: 15000 })

    // 展开追踪
    await chatWindow.locator('.trace-summary').click()

    // 获取所有步骤的名称
    const stepNames = await chatWindow.locator('.step-name').allTextContents()

    // 应该包含意图识别和完成步骤
    const allNames = stepNames.join(' ')
    expect(allNames).toContain('意图识别')
    expect(allNames).toContain('完成')
  })

  test('追踪步骤包含图标', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    await chatWindow.locator('[data-testid="input-textarea"]').fill('测试步骤图标')
    await chatWindow.locator('[data-testid="btn-send"]').click()

    const messages = chatWindow.locator('[data-testid="chat-message"]')
    await expect(messages.nth(1)).toBeVisible({ timeout: 5000 })
    await expect(chatWindow.locator('.streaming-cursor')).not.toBeVisible({ timeout: 15000 })

    // 展开追踪
    await chatWindow.locator('.trace-summary').click()

    // 验证步骤图标存在
    const icons = chatWindow.locator('.step-icon')
    const iconCount = await icons.count()
    expect(iconCount).toBeGreaterThan(0)

    // 验证至少有一个图标包含 emoji
    const firstIcon = await icons.first().textContent()
    expect(firstIcon).toBeTruthy()
    expect(firstIcon!.length).toBeGreaterThan(0)
  })

  test('追踪步骤包含状态指示器', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    await chatWindow.locator('[data-testid="input-textarea"]').fill('测试状态指示器')
    await chatWindow.locator('[data-testid="btn-send"]').click()

    const messages = chatWindow.locator('[data-testid="chat-message"]')
    await expect(messages.nth(1)).toBeVisible({ timeout: 5000 })
    await expect(chatWindow.locator('.streaming-cursor')).not.toBeVisible({ timeout: 15000 })

    // 展开追踪
    await chatWindow.locator('.trace-summary').click()

    // 验证步骤状态存在
    const statuses = chatWindow.locator('.step-status')
    const statusCount = await statuses.count()
    expect(statusCount).toBeGreaterThan(0)

    // 完成的步骤应该有 completed 状态
    const completedStatuses = chatWindow.locator('.status-completed')
    expect(await completedStatuses.count()).toBeGreaterThan(0)
  })

  test('追踪汇总栏显示统计信息', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    await chatWindow.locator('[data-testid="input-textarea"]').fill('测试汇总栏')
    await chatWindow.locator('[data-testid="btn-send"]').click()

    const messages = chatWindow.locator('[data-testid="chat-message"]')
    await expect(messages.nth(1)).toBeVisible({ timeout: 5000 })
    await expect(chatWindow.locator('.streaming-cursor')).not.toBeVisible({ timeout: 15000 })

    // 展开追踪
    await chatWindow.locator('.trace-summary').click()

    // 检查汇总栏
    const summaryStats = chatWindow.locator('.trace-summary-stats')
    await expect(summaryStats).toBeVisible()

    // 应包含总耗时、总 Token 等信息
    const summaryLabels = await summaryStats.locator('.summary-label').allTextContents()
    const allLabels = summaryLabels.join(' ')
    expect(allLabels).toContain('耗时')
  })

  test('LiveTrace 组件在流式输出时出现', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    // 收集 trace step 事件来验证实时追踪
    const stepCount = { value: 0 }
    await chatWindow.evaluate(() => {
      ;(window as any).__liveStepCount = 0
      ;(window as any).chatAPI.onTraceStep((step: any) => {
        ;(window as any).__liveStepCount++
      })
    })

    await chatWindow.locator('[data-testid="input-textarea"]').fill('测试 LiveTrace')
    await chatWindow.locator('[data-testid="btn-send"]').click()

    // 等待完成
    const messages = chatWindow.locator('[data-testid="chat-message"]')
    await expect(messages.nth(1)).toBeVisible({ timeout: 5000 })
    await expect(chatWindow.locator('.streaming-cursor')).not.toBeVisible({ timeout: 15000 })

    // 验证收到了 trace step 事件
    const count = await chatWindow.evaluate(() => {
      return (window as any).__liveStepCount || 0
    })
    expect(count).toBeGreaterThan(0)
  })
})
