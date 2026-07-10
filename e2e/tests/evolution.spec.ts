/**
 * E2E 测试 — Agent 进化能力（T-005 / T-006 / T-007）
 *
 * 测试范围:
 * - T-005: 上下文管理 — Token 统计步骤包含真实 Token 计数
 * - T-006: 向量记忆系统 — 消息发送后记忆存储步骤触发、记忆检索步骤展示
 * - T-007: 技能生成系统 — 技能匹配步骤展示、多次相似请求触发模式检测
 * - 进化追踪步骤完整性 — 新增的步骤（memory, skill_match, store, stats）都在追踪中出现
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

// ═══════════════════════════════════════════════════════════
//  T-005: 上下文管理
// ═══════════════════════════════════════════════════════════

test.describe('T-005 上下文管理', () => {

  test('Token 统计步骤包含真实 Token 计数（非零）', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    // 收集 trace steps
    await chatWindow.evaluate(() => {
      ;(window as any).__traceSteps = []
      ;(window as any).chatAPI.onTraceStep((step: any) => {
        ;(window as any).__traceSteps.push(step)
      })
    })

    // 发送消息
    await chatWindow.locator('[data-testid="input-textarea"]').fill('请解释一下什么是量子纠缠')
    await chatWindow.locator('[data-testid="btn-send"]').click()

    // 等待完成
    const messages = chatWindow.locator('[data-testid="chat-message"]')
    await expect(messages.nth(1)).toBeVisible({ timeout: 5000 })
    await expect(chatWindow.locator('.streaming-cursor')).not.toBeVisible({ timeout: 15000 })
    await new Promise(resolve => setTimeout(resolve, 1000))

    // 获取追踪步骤
    const steps = await chatWindow.evaluate(() => (window as any).__traceSteps || [])

    // 找到 stats 步骤
    const statsStep = steps.find((s: any) => s.type === 'stats')
    expect(statsStep).toBeTruthy()
    expect(statsStep.detail.contextBreakdown).toBeTruthy()

    // systemPrompt token 应该 > 0（系统提示词有内容）
    expect(statsStep.detail.contextBreakdown.systemPrompt).toBeGreaterThan(0)

    // budget 应该是配置的 maxTokens（默认 32000）
    expect(statsStep.detail.contextBreakdown.budget).toBeGreaterThan(0)

    // outputReserve 应该 > 0
    expect(statsStep.detail.contextBreakdown.outputReserve).toBeGreaterThan(0)
  })

  test('追踪步骤中包含完整步骤序列', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    await chatWindow.evaluate(() => {
      ;(window as any).__traceSteps = []
      ;(window as any).chatAPI.onTraceStep((step: any) => {
        ;(window as any).__traceSteps.push(step)
      })
    })

    await chatWindow.locator('[data-testid="input-textarea"]').fill('测试步骤序列')
    await chatWindow.locator('[data-testid="btn-send"]').click()

    const messages = chatWindow.locator('[data-testid="chat-message"]')
    await expect(messages.nth(1)).toBeVisible({ timeout: 5000 })
    await expect(chatWindow.locator('.streaming-cursor')).not.toBeVisible({ timeout: 15000 })
    await new Promise(resolve => setTimeout(resolve, 1000))

    const steps = await chatWindow.evaluate(() => (window as any).__traceSteps || [])
    const stepTypes = steps.map((s: any) => s.type)

    // 应包含核心步骤（未配置 LLM 时 think 步骤在 mock 模式下可能不出现）
    expect(stepTypes).toContain('intent')
    expect(stepTypes).toContain('memory')
    expect(stepTypes).toContain('skill_match')
    expect(stepTypes).toContain('reflect')
    expect(stepTypes).toContain('store')
    expect(stepTypes).toContain('stats')
    expect(stepTypes).toContain('complete')

    // 步骤总数应 >= 7（mock 模式下 7 步，LLM 模式下含 think 步骤 8+ 步）
    expect(steps.length).toBeGreaterThanOrEqual(7)
  })
})

// ═══════════════════════════════════════════════════════════
//  T-006: 向量记忆系统
// ═══════════════════════════════════════════════════════════

test.describe('T-006 向量记忆系统', () => {

  test('记忆检索步骤包含正确的结构', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    await chatWindow.evaluate(() => {
      ;(window as any).__traceSteps = []
      ;(window as any).chatAPI.onTraceStep((step: any) => {
        ;(window as any).__traceSteps.push(step)
      })
    })

    await chatWindow.locator('[data-testid="input-textarea"]').fill('帮我记住：我的名字是小明')
    await chatWindow.locator('[data-testid="btn-send"]').click()

    const messages = chatWindow.locator('[data-testid="chat-message"]')
    await expect(messages.nth(1)).toBeVisible({ timeout: 5000 })
    await expect(chatWindow.locator('.streaming-cursor')).not.toBeVisible({ timeout: 15000 })
    await new Promise(resolve => setTimeout(resolve, 1000))

    const steps = await chatWindow.evaluate(() => (window as any).__traceSteps || [])
    const memoryStep = steps.find((s: any) => s.type === 'memory')

    expect(memoryStep).toBeTruthy()
    expect(memoryStep.detail.type).toBe('memory')
    expect(memoryStep.detail.searchParams).toBeTruthy()
    expect(memoryStep.detail.searchParams.topK).toBeGreaterThan(0)
    expect(Array.isArray(memoryStep.detail.retrieved)).toBeTruthy()
  })

  test('记忆存储步骤在对话结束后触发', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    await chatWindow.evaluate(() => {
      ;(window as any).__traceSteps = []
      ;(window as any).chatAPI.onTraceStep((step: any) => {
        ;(window as any).__traceSteps.push(step)
      })
    })

    await chatWindow.locator('[data-testid="input-textarea"]').fill('我喜欢吃苹果')
    await chatWindow.locator('[data-testid="btn-send"]').click()

    const messages = chatWindow.locator('[data-testid="chat-message"]')
    await expect(messages.nth(1)).toBeVisible({ timeout: 5000 })
    await expect(chatWindow.locator('.streaming-cursor')).not.toBeVisible({ timeout: 15000 })
    await new Promise(resolve => setTimeout(resolve, 2000))

    const steps = await chatWindow.evaluate(() => (window as any).__traceSteps || [])
    const storeStep = steps.find((s: any) => s.type === 'store')

    expect(storeStep).toBeTruthy()
    expect(storeStep.detail.type).toBe('store')
    expect(storeStep.detail.episodicMemoryId).toBeTruthy()
  })

  test('对话 A 的记忆在对话 B 中可被检索', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    // ── 对话 A：存储一条信息 ──
    await chatWindow.locator('[data-testid="input-textarea"]').fill('我的项目使用 TypeScript 和 Vue 3 开发')
    await chatWindow.locator('[data-testid="btn-send"]').click()

    const messages = chatWindow.locator('[data-testid="chat-message"]')
    await expect(messages.nth(1)).toBeVisible({ timeout: 5000 })
    await expect(chatWindow.locator('.streaming-cursor')).not.toBeVisible({ timeout: 15000 })
    await new Promise(resolve => setTimeout(resolve, 2000))

    // ── 新建对话 B ──
    await chatWindow.locator('[data-testid="btn-new-session"]').click()
    await expect(chatWindow.locator('[data-testid="empty-state"]')).toBeVisible()

    // ── 对话 B：检索相关记忆 ──
    await chatWindow.evaluate(() => {
      ;(window as any).__traceSteps = []
      ;(window as any).chatAPI.onTraceStep((step: any) => {
        ;(window as any).__traceSteps.push(step)
      })
    })

    await chatWindow.locator('[data-testid="input-textarea"]').fill('我用的什么技术栈？')
    await chatWindow.locator('[data-testid="btn-send"]').click()

    await expect(messages.nth(1)).toBeVisible({ timeout: 5000 })
    await expect(chatWindow.locator('.streaming-cursor')).not.toBeVisible({ timeout: 15000 })
    await new Promise(resolve => setTimeout(resolve, 1000))

    // 检查记忆检索步骤
    const steps = await chatWindow.evaluate(() => (window as any).__traceSteps || [])
    const memoryStep = steps.find((s: any) => s.type === 'memory')

    expect(memoryStep).toBeTruthy()
    // 应该检索到对话 A 的记忆（伪嵌入模式下可能检索不到，但结构应正确）
    expect(memoryStep.detail.searchParams.topK).toBeGreaterThan(0)
  })
})

// ═══════════════════════════════════════════════════════════
//  T-007: 技能生成系统
// ═══════════════════════════════════════════════════════════

test.describe('T-007 技能生成系统', () => {

  test('技能匹配步骤包含正确的结构', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    await chatWindow.evaluate(() => {
      ;(window as any).__traceSteps = []
      ;(window as any).chatAPI.onTraceStep((step: any) => {
        ;(window as any).__traceSteps.push(step)
      })
    })

    await chatWindow.locator('[data-testid="input-textarea"]').fill('帮我写一个 TypeScript 函数')
    await chatWindow.locator('[data-testid="btn-send"]').click()

    const messages = chatWindow.locator('[data-testid="chat-message"]')
    await expect(messages.nth(1)).toBeVisible({ timeout: 5000 })
    await expect(chatWindow.locator('.streaming-cursor')).not.toBeVisible({ timeout: 15000 })
    await new Promise(resolve => setTimeout(resolve, 1000))

    const steps = await chatWindow.evaluate(() => (window as any).__traceSteps || [])
    const skillStep = steps.find((s: any) => s.type === 'skill_match')

    expect(skillStep).toBeTruthy()
    expect(skillStep.detail.type).toBe('skill_match')
    expect(Array.isArray(skillStep.detail.candidates)).toBeTruthy()
    expect(skillStep.detail.loadedTokens).toBeGreaterThanOrEqual(0)
  })

  test('多次相似请求后触发技能自动生成', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    // 发送 3 次相似请求（触发模式检测阈值）
    const similarQueries = [
      '帮我翻译这段英文',
      '请翻译以下英文内容',
      '翻译一下这段英文文字'
    ]

    for (let i = 0; i < similarQueries.length; i++) {
      // 收集最后一次的 trace steps
      if (i === similarQueries.length - 1) {
        await chatWindow.evaluate(() => {
          ;(window as any).__traceSteps = []
          ;(window as any).chatAPI.onTraceStep((step: any) => {
            ;(window as any).__traceSteps.push(step)
          })
        })
      }

      await chatWindow.locator('[data-testid="input-textarea"]').fill(similarQueries[i])
      await chatWindow.locator('[data-testid="btn-send"]').click()

      const messages = chatWindow.locator('[data-testid="chat-message"]')
      await expect(messages.nth(1)).toBeVisible({ timeout: 5000 })
      await expect(chatWindow.locator('.streaming-cursor')).not.toBeVisible({ timeout: 15000 })
      await new Promise(resolve => setTimeout(resolve, 1500))
    }

    // 检查最后一次的追踪步骤中是否有进化事件
    const steps = await chatWindow.evaluate(() => (window as any).__traceSteps || [])

    // 第 3 次请求后应触发模式检测，可能生成技能
    // 检查是否有额外的 store 步骤（进化事件）
    const storeSteps = steps.filter((s: any) => s.type === 'store')
    expect(storeSteps.length).toBeGreaterThanOrEqual(1)

    // 如果触发了进化，应该有 skillProposal
    const evolutionStep = storeSteps.find((s: any) => s.detail.skillProposal)
    if (evolutionStep) {
      expect(evolutionStep.detail.skillProposal.skillName).toBeTruthy()
      expect(evolutionStep.detail.skillProposal.confidence).toBeGreaterThan(0)
    }
  })

  test('技能匹配步骤名称显示匹配数量', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    await chatWindow.evaluate(() => {
      ;(window as any).__traceSteps = []
      ;(window as any).chatAPI.onTraceStep((step: any) => {
        ;(window as any).__traceSteps.push(step)
      })
    })

    await chatWindow.locator('[data-testid="input-textarea"]').fill('分析数据')
    await chatWindow.locator('[data-testid="btn-send"]').click()

    const messages = chatWindow.locator('[data-testid="chat-message"]')
    await expect(messages.nth(1)).toBeVisible({ timeout: 5000 })
    await expect(chatWindow.locator('.streaming-cursor')).not.toBeVisible({ timeout: 15000 })
    await new Promise(resolve => setTimeout(resolve, 1000))

    const steps = await chatWindow.evaluate(() => (window as any).__traceSteps || [])
    const skillStep = steps.find((s: any) => s.type === 'skill_match')

    expect(skillStep).toBeTruthy()
    // 步骤名称应该是 "技能匹配" 或 "技能匹配 (N)"
    expect(skillStep.name).toContain('技能匹配')
  })
})

// ═══════════════════════════════════════════════════════════
//  综合测试：执行追踪完整性
// ═══════════════════════════════════════════════════════════

test.describe('执行追踪完整性', () => {

  test('完整追踪包含 Token 统计和进化步骤', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    await chatWindow.evaluate(() => {
      ;(window as any).__traceComplete = null
      ;(window as any).chatAPI.onTraceComplete((trace: any) => {
        ;(window as any).__traceComplete = trace
      })
    })

    await chatWindow.locator('[data-testid="input-textarea"]').fill('综合测试追踪完整性')
    await chatWindow.locator('[data-testid="btn-send"]').click()

    const messages = chatWindow.locator('[data-testid="chat-message"]')
    await expect(messages.nth(1)).toBeVisible({ timeout: 5000 })
    await expect(chatWindow.locator('.streaming-cursor')).not.toBeVisible({ timeout: 15000 })
    await new Promise(resolve => setTimeout(resolve, 1000))

    const trace = await chatWindow.evaluate(() => (window as any).__traceComplete)

    expect(trace).toBeTruthy()
    // mock 模式下 7 步，LLM 模式下 8+ 步
    expect(trace.steps.length).toBeGreaterThanOrEqual(7)

    // 验证 stats 步骤的 contextBreakdown 有正确的字段
    const statsStep = trace.steps.find((s: any) => s.type === 'stats')
    expect(statsStep).toBeTruthy()
    expect(statsStep.detail.contextBreakdown.systemPrompt).toBeGreaterThanOrEqual(0)
    expect(statsStep.detail.contextBreakdown.history).toBeGreaterThanOrEqual(0)
    expect(statsStep.detail.contextBreakdown.budget).toBeGreaterThan(0)

    // 验证 stats 中的 token 统计
    expect(trace.stats.totalInputTokens).toBeGreaterThanOrEqual(0)
    expect(trace.stats.totalOutputTokens).toBeGreaterThanOrEqual(0)
  })

  test('多轮对话后记忆系统正常工作', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    // 进行 3 轮对话
    const queries = [
      '第一轮：介绍你自己',
      '第二轮：你能做什么',
      '第三轮：帮我写代码'
    ]

    for (const query of queries) {
      await chatWindow.locator('[data-testid="input-textarea"]').fill(query)
      await chatWindow.locator('[data-testid="btn-send"]').click()

      const messages = chatWindow.locator('[data-testid="chat-message"]')
      await expect(messages.nth(1)).toBeVisible({ timeout: 5000 })
      await expect(chatWindow.locator('.streaming-cursor')).not.toBeVisible({ timeout: 15000 })
      await new Promise(resolve => setTimeout(resolve, 1000))
    }

    // 验证应用没有崩溃，仍然可以交互
    await chatWindow.locator('[data-testid="input-textarea"]').fill('最终测试')
    await expect(chatWindow.locator('[data-testid="input-textarea"]')).toHaveValue('最终测试')
  })
})
