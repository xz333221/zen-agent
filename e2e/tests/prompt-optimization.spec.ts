/**
 * E2E 测试 — Prompt 自适应优化（T-008）
 *
 * 测试范围:
 * - 反馈 API 存在于 chatAPI
 * - 记录显式反馈（👍/👎）
 * - 记录隐式反馈（copy/edit/ignore）
 * - 获取当前 Prompt 版本
 * - 获取所有 Prompt 版本列表
 * - 多次负反馈后触发 Prompt 优化
 * - Prompt 版本回滚
 * - A/B 测试配置
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

test.describe('T-008 Prompt 自适应优化', () => {

  // ═══════════════════════════════════════════════════════════
  //  API 可用性
  // ═══════════════════════════════════════════════════════════

  test('chatAPI 包含反馈和 Prompt 管理方法', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    const methods = await chatWindow.evaluate(() => {
      const api = (window as any).chatAPI
      return {
        hasRecordFeedback: typeof api.recordFeedback === 'function',
        hasGetCurrentPrompt: typeof api.getCurrentPrompt === 'function',
        hasGetPromptVersions: typeof api.getPromptVersions === 'function',
        hasOptimizePrompt: typeof api.optimizePrompt === 'function',
        hasRollbackPrompt: typeof api.rollbackPrompt === 'function',
        hasSetABTest: typeof api.setABTest === 'function',
        hasConcludeABTest: typeof api.concludeABTest === 'function'
      }
    })

    expect(methods.hasRecordFeedback).toBeTruthy()
    expect(methods.hasGetCurrentPrompt).toBeTruthy()
    expect(methods.hasGetPromptVersions).toBeTruthy()
    expect(methods.hasOptimizePrompt).toBeTruthy()
    expect(methods.hasRollbackPrompt).toBeTruthy()
    expect(methods.hasSetABTest).toBeTruthy()
    expect(methods.hasConcludeABTest).toBeTruthy()
  })

  // ═══════════════════════════════════════════════════════════
  //  显式反馈
  // ═══════════════════════════════════════════════════════════

  test('记录显式正反馈', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    const result = await chatWindow.evaluate(() => {
      return (window as any).chatAPI.recordFeedback({
        feedbackType: 'positive',
        messageId: 'test-msg-1',
        userQuery: '测试问题',
        agentResponse: '测试回复'
      })
    })

    expect(result).toBeTruthy()
    expect(result.success).toBeTruthy()
    expect(result.shouldOptimize).toBeFalsy()
  })

  test('记录显式负反馈', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    const result = await chatWindow.evaluate(() => {
      return (window as any).chatAPI.recordFeedback({
        feedbackType: 'negative',
        messageId: 'test-msg-2',
        userQuery: '测试问题',
        agentResponse: '测试回复',
        comment: '回答不准确'
      })
    })

    expect(result).toBeTruthy()
    expect(result.success).toBeTruthy()
  })

  // ═══════════════════════════════════════════════════════════
  //  隐式反馈
  // ═══════════════════════════════════════════════════════════

  test('记录隐式反馈（复制操作）', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    const result = await chatWindow.evaluate(() => {
      return (window as any).chatAPI.recordFeedback({
        feedbackType: 'neutral',
        implicitAction: 'copy',
        messageId: 'test-msg-3'
      })
    })

    expect(result).toBeTruthy()
    expect(result.success).toBeTruthy()
  })

  test('记录隐式反馈（编辑后重发）', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    const result = await chatWindow.evaluate(() => {
      return (window as any).chatAPI.recordFeedback({
        feedbackType: 'neutral',
        implicitAction: 'edit',
        messageId: 'test-msg-4'
      })
    })

    expect(result).toBeTruthy()
    expect(result.success).toBeTruthy()
  })

  // ═══════════════════════════════════════════════════════════
  //  Prompt 版本管理
  // ═══════════════════════════════════════════════════════════

  test('初始化时创建默认 Prompt v1', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    const current = await chatWindow.evaluate(() => {
      return (window as any).chatAPI.getCurrentPrompt()
    })

    expect(current).toBeTruthy()
    expect(current.version).toBe(1)
    expect(current.content).toBeTruthy()
    expect(current.content.length).toBeGreaterThan(50)
    expect(current.isCurrent).toBeTruthy()
    expect(current.target).toBe('system')
  })

  test('获取 Prompt 版本列表', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    const versions = await chatWindow.evaluate(() => {
      return (window as any).chatAPI.getPromptVersions()
    })

    expect(versions).toBeTruthy()
    expect(Array.isArray(versions)).toBeTruthy()
    expect(versions.length).toBeGreaterThanOrEqual(1)

    // 第一个版本应该是 v1
    expect(versions[0].version).toBe(1)
  })

  // ═══════════════════════════════════════════════════════════
  //  Prompt 优化触发
  // ═══════════════════════════════════════════════════════════

  test('多次负反馈后触发自动优化', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    // 发送 3 次负反馈（达到阈值）
    for (let i = 0; i < 3; i++) {
      await chatWindow.evaluate((idx) => {
        return (window as any).chatAPI.recordFeedback({
          feedbackType: 'negative',
          messageId: `test-msg-neg-${idx}`,
          userQuery: `测试问题 ${idx}`,
          agentResponse: `回复 ${idx}`,
          comment: '回答太长了，不够简洁'
        })
      }, i)
    }

    // 手动触发优化（因为自动优化在 agent-loop 中检查）
    const result = await chatWindow.evaluate(() => {
      return (window as any).chatAPI.optimizePrompt()
    })

    expect(result).toBeTruthy()
    expect(result.success).toBeTruthy()
    expect(result.newVersion).toBeGreaterThan(1)
    expect(result.method).toBeTruthy()
    expect(result.changes).toBeDefined()
    expect(Array.isArray(result.changes)).toBeTruthy()
  })

  test('优化后新版本成为当前版本', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    // 记录负反馈
    for (let i = 0; i < 3; i++) {
      await chatWindow.evaluate((idx) => {
        return (window as any).chatAPI.recordFeedback({
          feedbackType: 'negative',
          messageId: `test-msg-neg2-${idx}`,
          comment: '回答不准确'
        })
      }, i)
    }

    // 触发优化
    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.optimizePrompt()
    })

    // 获取当前版本
    const current = await chatWindow.evaluate(() => {
      return (window as any).chatAPI.getCurrentPrompt()
    })

    // 应该是新版本
    expect(current.version).toBeGreaterThan(1)
    expect(current.isCurrent).toBeTruthy()

    // 版本列表应该有多个版本
    const versions = await chatWindow.evaluate(() => {
      return (window as any).chatAPI.getPromptVersions()
    })
    expect(versions.length).toBeGreaterThanOrEqual(2)
  })

  // ═══════════════════════════════════════════════════════════
  //  Prompt 回滚
  // ═══════════════════════════════════════════════════════════

  test('回滚到上一个 Prompt 版本', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    // 先记录负反馈并触发优化
    for (let i = 0; i < 3; i++) {
      await chatWindow.evaluate((idx) => {
        return (window as any).chatAPI.recordFeedback({
          feedbackType: 'negative',
          messageId: `test-msg-rollback-${idx}`
        })
      }, i)
    }

    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.optimizePrompt()
    })

    // 确认当前版本 > 1
    const beforeRollback = await chatWindow.evaluate(() => {
      return (window as any).chatAPI.getCurrentPrompt()
    })
    expect(beforeRollback.version).toBeGreaterThan(1)

    // 回滚
    const rollbackResult = await chatWindow.evaluate(() => {
      return (window as any).chatAPI.rollbackPrompt()
    })

    expect(rollbackResult).toBeTruthy()
    expect(rollbackResult.success).toBeTruthy()
    expect(rollbackResult.newVersion).toBeLessThan(beforeRollback.version)

    // 确认当前版本已回滚
    const afterRollback = await chatWindow.evaluate(() => {
      return (window as any).chatAPI.getCurrentPrompt()
    })
    expect(afterRollback.version).toBeLessThan(beforeRollback.version)
  })

  // ═══════════════════════════════════════════════════════════
  //  A/B 测试
  // ═══════════════════════════════════════════════════════════

  test('配置 A/B 测试', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    const result = await chatWindow.evaluate(() => {
      return (window as any).chatAPI.setABTest({
        enabled: true,
        variantRatio: 0.5
      })
    })

    expect(result).toBeTruthy()
    expect(result.success).toBeTruthy()
    expect(result.config.enabled).toBeTruthy()
    expect(result.config.variantRatio).toBe(0.5)
  })

  test('结束 A/B 测试（不足两版本时返回失败）', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    // 没有创建第二个版本，直接结束 A/B 测试
    const result = await chatWindow.evaluate(() => {
      return (window as any).chatAPI.concludeABTest()
    })

    // 只有一个版本时应该返回失败
    expect(result).toBeTruthy()
    expect(result.success).toBeFalsy()
  })

  test('优化后结束 A/B 测试', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    // 先创建第二个版本
    for (let i = 0; i < 3; i++) {
      await chatWindow.evaluate((idx) => {
        return (window as any).chatAPI.recordFeedback({
          feedbackType: 'negative',
          messageId: `test-msg-ab-${idx}`
        })
      }, i)
    }

    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.optimizePrompt()
    })

    // 开启 A/B 测试
    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.setABTest({ enabled: true, variantRatio: 0.5 })
    })

    // 结束 A/B 测试
    const result = await chatWindow.evaluate(() => {
      return (window as any).chatAPI.concludeABTest()
    })

    expect(result).toBeTruthy()
    expect(result.success).toBeTruthy()
    expect(result.reason).toContain('A/B 测试完成')
  })

  // ═══════════════════════════════════════════════════════════
  //  集成测试
  // ═══════════════════════════════════════════════════════════

  test('对话后 Prompt 版本仍然正常', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    // 发送一条消息
    await chatWindow.locator('[data-testid="input-textarea"]').fill('测试 Prompt 持久性')
    await chatWindow.locator('[data-testid="btn-send"]').click()

    const messages = chatWindow.locator('[data-testid="chat-message"]')
    await expect(messages.nth(1)).toBeVisible({ timeout: 5000 })
    await expect(chatWindow.locator('.streaming-cursor')).not.toBeVisible({ timeout: 15000 })

    // Prompt 版本应该仍然可用
    const current = await chatWindow.evaluate(() => {
      return (window as any).chatAPI.getCurrentPrompt()
    })

    expect(current).toBeTruthy()
    expect(current.content).toBeTruthy()
    expect(current.content.length).toBeGreaterThan(50)
  })

  test('负反馈后在 Agent 循环中自动触发优化', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    // 收集 trace steps
    await chatWindow.evaluate(() => {
      ;(window as any).__traceSteps = []
      ;(window as any).chatAPI.onTraceStep((step: any) => {
        ;(window as any).__traceSteps.push(step)
      })
    })

    // 记录 3 次负反馈
    for (let i = 0; i < 3; i++) {
      await chatWindow.evaluate((idx) => {
        return (window as any).chatAPI.recordFeedback({
          feedbackType: 'negative',
          messageId: `test-msg-auto-${idx}`
        })
      }, i)
    }

    // 发送消息触发 Agent 循环（循环中会检查 shouldOptimizePrompt）
    await chatWindow.locator('[data-testid="input-textarea"]').fill('触发自动优化')
    await chatWindow.locator('[data-testid="btn-send"]').click()

    const messages = chatWindow.locator('[data-testid="chat-message"]')
    await expect(messages.nth(1)).toBeVisible({ timeout: 5000 })
    await expect(chatWindow.locator('.streaming-cursor')).not.toBeVisible({ timeout: 15000 })
    await new Promise(resolve => setTimeout(resolve, 2000))

    // 检查追踪步骤中是否有 Prompt 优化事件
    const steps = await chatWindow.evaluate(() => (window as any).__traceSteps || [])
    const storeSteps = steps.filter((s: any) => s.type === 'store')

    // 应该有至少一个包含 Prompt 优化的 store 步骤
    const promptOptStep = storeSteps.find((s: any) =>
      s.name?.includes('Prompt 优化') || s.detail?.skillProposal?.skillName?.includes('Prompt')
    )

    if (promptOptStep) {
      // 如果触发了优化，验证结构
      expect(promptOptStep.detail.type).toBe('store')
      expect(promptOptStep.detail.episodicMemoryId).toBeTruthy()
    }

    // 验证新版本已创建
    const current = await chatWindow.evaluate(() => {
      return (window as any).chatAPI.getCurrentPrompt()
    })
    expect(current.version).toBeGreaterThan(1)
  })
})
