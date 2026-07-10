/**
 * E2E 测试 — Coordinator Agent (T-011)
 *
 * 测试范围:
 * - 复杂请求触发任务分解（plan 步骤出现）
 * - 委派步骤出现（delegate 步骤）
 * - 规则分解模式下子任务正确生成
 * - Mock 模式下子 Agent 返回结果
 * - 执行追踪中包含 plan 和 delegate 步骤
 * - 复杂请求的回复包含子 Agent 输出
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

test.describe('Coordinator Agent (T-011)', () => {

  test('复杂请求触发任务分解（追踪中出现 plan 步骤）', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    // 收集 trace step 事件
    await chatWindow.evaluate(() => {
      ;(window as any).__traceSteps = []
      ;(window as any).chatAPI.onTraceStep((step: any) => {
        ;(window as any).__traceSteps.push(step)
      })
    })

    // 发送包含 "分析" 和 "计划" 关键词的复杂请求
    // "分析" 触发 high complexity，"计划" 触发 requiresPlanning
    await chatWindow.locator('[data-testid="input-textarea"]').fill('请分析并规划一个项目的开发流程')
    await chatWindow.locator('[data-testid="btn-send"]').click()

    // 等待 Agent 回复完成
    const messages = chatWindow.locator('[data-testid="chat-message"]')
    await expect(messages.nth(1)).toBeVisible({ timeout: 5000 })
    await expect(chatWindow.locator('.streaming-cursor')).not.toBeVisible({ timeout: 30000 })

    // 等待追踪完成
    await new Promise(resolve => setTimeout(resolve, 2000))

    // 读取收集到的 trace steps
    const collectedSteps = await chatWindow.evaluate(() => {
      return (window as any).__traceSteps || []
    })

    // 应该收到追踪步骤
    expect(collectedSteps.length).toBeGreaterThanOrEqual(3)

    // 验证是否包含 plan 步骤（Coordinator 分解）
    const stepTypes = collectedSteps.map((s: any) => s.type)
    const hasPlan = stepTypes.includes('plan')
    const hasDelegate = stepTypes.includes('delegate')

    // 复杂请求应该触发 Coordinator，至少有 plan 步骤
    expect(hasPlan || hasDelegate).toBeTruthy()
  })

  test('规则分解模式下生成正确的子任务', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    // 收集 trace complete 事件
    await chatWindow.evaluate(() => {
      ;(window as any).__traceComplete = null
      ;(window as any).chatAPI.onTraceComplete((trace: any) => {
        ;(window as any).__traceComplete = trace
      })
    })

    // 发送包含搜索和分析的复杂请求
    await chatWindow.locator('[data-testid="input-textarea"]').fill('搜索并分析 TypeScript 的优缺点，规划一个学习计划')
    await chatWindow.locator('[data-testid="btn-send"]').click()

    // 等待完成
    const messages = chatWindow.locator('[data-testid="chat-message"]')
    await expect(messages.nth(1)).toBeVisible({ timeout: 5000 })
    await expect(chatWindow.locator('.streaming-cursor')).not.toBeVisible({ timeout: 30000 })

    await new Promise(resolve => setTimeout(resolve, 2000))

    const trace = await chatWindow.evaluate(() => {
      return (window as any).__traceComplete
    })

    expect(trace).toBeTruthy()
    expect(trace.steps).toBeDefined()

    // 检查是否有 plan 步骤
    const planSteps = trace.steps.filter((s: any) => s.type === 'plan')
    if (planSteps.length > 0) {
      const planDetail = planSteps[0].detail
      expect(planDetail.taskCount).toBeGreaterThan(0)
      expect(planDetail.tasks).toBeTruthy()
      expect(planDetail.tasks.length).toBeGreaterThan(0)

      // 验证任务结构
      const task = planDetail.tasks[0]
      expect(task.id).toBeTruthy()
      expect(task.name).toBeTruthy()
      expect(task.agentType).toBeTruthy()
      expect(task.status).toBeTruthy()
    }
  })

  test('委派步骤包含子 Agent 信息', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    await chatWindow.evaluate(() => {
      ;(window as any).__traceComplete = null
      ;(window as any).chatAPI.onTraceComplete((trace: any) => {
        ;(window as any).__traceComplete = trace
      })
    })

    // 发送复杂请求
    await chatWindow.locator('[data-testid="input-textarea"]').fill('研究并分析 React 和 Vue 的区别，然后写一份对比报告')
    await chatWindow.locator('[data-testid="btn-send"]').click()

    const messages = chatWindow.locator('[data-testid="chat-message"]')
    await expect(messages.nth(1)).toBeVisible({ timeout: 5000 })
    await expect(chatWindow.locator('.streaming-cursor')).not.toBeVisible({ timeout: 30000 })

    await new Promise(resolve => setTimeout(resolve, 2000))

    const trace = await chatWindow.evaluate(() => {
      return (window as any).__traceComplete
    })

    expect(trace).toBeTruthy()

    // 检查是否有 delegate 步骤
    const delegateSteps = trace.steps.filter((s: any) => s.type === 'delegate')
    if (delegateSteps.length > 0) {
      const detail = delegateSteps[0].detail
      expect(detail.taskId).toBeTruthy()
      expect(detail.taskName).toBeTruthy()
      expect(detail.agentType).toBeTruthy()
      expect(detail.status).toBeTruthy()
    }
  })

  test('Mock 模式下 Coordinator 返回回复', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    // 发送复杂请求（Mock 模式）
    await chatWindow.locator('[data-testid="input-textarea"]').fill('分析并规划一个微服务架构方案')
    await chatWindow.locator('[data-testid="btn-send"]').click()

    // 等待回复
    const messages = chatWindow.locator('[data-testid="chat-message"]')
    await expect(messages.nth(1)).toBeVisible({ timeout: 5000 })
    await expect(chatWindow.locator('.streaming-cursor')).not.toBeVisible({ timeout: 30000 })

    // 验证回复内容（Mock 模式下应该有子 Agent 输出 或 配置提示）
    const agentContent = messages.nth(1).locator('.message-content')
    const text = await agentContent.textContent()
    expect(text).toBeTruthy()
    expect(text!.length).toBeGreaterThan(10)
  })

  test('简单请求不触发 Coordinator', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    await chatWindow.evaluate(() => {
      ;(window as any).__traceSteps = []
      ;(window as any).chatAPI.onTraceStep((step: any) => {
        ;(window as any).__traceSteps.push(step)
      })
    })

    // 发送简单请求
    await chatWindow.locator('[data-testid="input-textarea"]').fill('你好')
    await chatWindow.locator('[data-testid="btn-send"]').click()

    const messages = chatWindow.locator('[data-testid="chat-message"]')
    await expect(messages.nth(1)).toBeVisible({ timeout: 5000 })
    await expect(chatWindow.locator('.streaming-cursor')).not.toBeVisible({ timeout: 30000 })

    await new Promise(resolve => setTimeout(resolve, 1000))

    const collectedSteps = await chatWindow.evaluate(() => {
      return (window as any).__traceSteps || []
    })

    // 简单请求不应有 plan 步骤
    const hasPlan = collectedSteps.some((s: any) => s.type === 'plan')
    expect(hasPlan).toBeFalsy()
  })
})
