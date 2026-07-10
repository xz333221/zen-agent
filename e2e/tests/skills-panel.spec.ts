/**
 * E2E 测试 — 技能管理面板 (T-009)
 *
 * 测试范围:
 * - 通过 IPC 打开技能窗口
 * - 技能窗口显示空列表和统计
 * - 创建新技能
 * - 编辑技能并保存
 * - 删除技能
 * - 通过 IPC 直接操作技能数据
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

test.describe('技能管理面板', () => {

  test('通过 IPC 打开技能窗口', async () => {
    testApp = await launchApp()
    const { chatWindow, app } = testApp

    // 通过 chatAPI 打开技能面板
    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.openPanel('skills')
    })

    // 等待技能窗口出现
    const skillsWindow = await waitForSkillsWindow(app)
    await skillsWindow.waitForLoadState('domcontentloaded')

    // 验证技能窗口内容
    await expect(skillsWindow.locator('[data-testid="skills-root"]')).toBeVisible({ timeout: 10000 })
  })

  test('技能窗口显示统计栏和空列表', async () => {
    testApp = await launchApp()
    const { chatWindow, app } = testApp

    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.openPanel('skills')
    })

    const skillsWindow = await waitForSkillsWindow(app)
    await skillsWindow.waitForLoadState('domcontentloaded')
    await expect(skillsWindow.locator('[data-testid="skills-root"]')).toBeVisible({ timeout: 10000 })

    // 等待加载完成
    await expect(skillsWindow.locator('.skills-content')).toBeVisible({ timeout: 5000 })

    // 统计栏可见
    await expect(skillsWindow.locator('[data-testid="stats-bar"]')).toBeVisible()

    // 空状态显示
    await expect(skillsWindow.locator('[data-testid="empty-skills"]')).toBeVisible()
  })

  test('创建新技能', async () => {
    testApp = await launchApp()
    const { chatWindow, app } = testApp

    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.openPanel('skills')
    })

    const skillsWindow = await waitForSkillsWindow(app)
    await skillsWindow.waitForLoadState('domcontentloaded')
    await expect(skillsWindow.locator('.skills-content')).toBeVisible({ timeout: 5000 })

    // 点击新建技能
    await skillsWindow.locator('[data-testid="btn-add-skill"]').click()

    // 等待弹窗出现
    await expect(skillsWindow.locator('[data-testid="skill-modal"]')).toBeVisible()

    // 填写技能信息
    await skillsWindow.locator('[data-testid="input-skill-name"]').fill('测试技能')
    await skillsWindow.locator('[data-testid="input-skill-description"]').fill('这是一个用于测试的技能')
    await skillsWindow.locator('[data-testid="input-skill-content"]').fill('You are a helpful assistant for testing.')

    // 保存
    await skillsWindow.locator('[data-testid="btn-save-skill"]').click()

    // 弹窗关闭
    await expect(skillsWindow.locator('[data-testid="skill-modal"]')).not.toBeVisible()

    // 技能应出现在列表中
    await expect(skillsWindow.locator('[data-testid="skill-list"]')).toBeVisible()
    await expect(skillsWindow.locator('[data-testid="skill-name"]', { hasText: '测试技能' })).toBeVisible()

    // 成功提示
    await expect(skillsWindow.locator('[data-testid="success-msg"]')).toBeVisible()
  })

  test('编辑技能并保存', async () => {
    testApp = await launchApp()
    const { chatWindow, app } = testApp

    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.openPanel('skills')
    })

    const skillsWindow = await waitForSkillsWindow(app)
    await skillsWindow.waitForLoadState('domcontentloaded')
    await expect(skillsWindow.locator('.skills-content')).toBeVisible({ timeout: 5000 })

    // 先创建一个技能
    await skillsWindow.locator('[data-testid="btn-add-skill"]').click()
    await expect(skillsWindow.locator('[data-testid="skill-modal"]')).toBeVisible()
    await skillsWindow.locator('[data-testid="input-skill-name"]').fill('待编辑技能')
    await skillsWindow.locator('[data-testid="input-skill-description"]').fill('编辑前描述')
    await skillsWindow.locator('[data-testid="input-skill-content"]').fill('原始内容')
    await skillsWindow.locator('[data-testid="btn-save-skill"]').click()
    await expect(skillsWindow.locator('[data-testid="skill-modal"]')).not.toBeVisible()

    // 等待列表刷新
    await expect(skillsWindow.locator('[data-testid="skill-name"]', { hasText: '待编辑技能' })).toBeVisible()

    // 点击编辑
    await skillsWindow.locator('[data-testid="btn-edit-skill"]').first().click()

    // 弹窗出现，修改名称
    await expect(skillsWindow.locator('[data-testid="skill-modal"]')).toBeVisible()
    await skillsWindow.locator('[data-testid="input-skill-name"]').fill('已编辑技能')
    await skillsWindow.locator('[data-testid="input-skill-description"]').fill('编辑后描述')
    await skillsWindow.locator('[data-testid="btn-save-skill"]').click()

    // 弹窗关闭
    await expect(skillsWindow.locator('[data-testid="skill-modal"]')).not.toBeVisible()

    // 验证更新后的名称
    await expect(skillsWindow.locator('[data-testid="skill-name"]', { hasText: '已编辑技能' })).toBeVisible()
  })

  test('删除技能', async () => {
    testApp = await launchApp()
    const { chatWindow, app } = testApp

    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.openPanel('skills')
    })

    const skillsWindow = await waitForSkillsWindow(app)
    await skillsWindow.waitForLoadState('domcontentloaded')
    await expect(skillsWindow.locator('.skills-content')).toBeVisible({ timeout: 5000 })

    // 先创建一个技能
    await skillsWindow.locator('[data-testid="btn-add-skill"]').click()
    await expect(skillsWindow.locator('[data-testid="skill-modal"]')).toBeVisible()
    await skillsWindow.locator('[data-testid="input-skill-name"]').fill('待删除技能')
    await skillsWindow.locator('[data-testid="input-skill-description"]').fill('即将被删除')
    await skillsWindow.locator('[data-testid="input-skill-content"]').fill('内容')
    await skillsWindow.locator('[data-testid="btn-save-skill"]').click()
    await expect(skillsWindow.locator('[data-testid="skill-modal"]')).not.toBeVisible()
    await expect(skillsWindow.locator('[data-testid="skill-name"]', { hasText: '待删除技能' })).toBeVisible()

    // 点击删除
    skillsWindow.on('dialog', dialog => dialog.accept())
    await skillsWindow.locator('[data-testid="btn-delete-skill"]').first().click()

    // 等待列表刷新 — 空状态出现
    await expect(skillsWindow.locator('[data-testid="empty-skills"]')).toBeVisible({ timeout: 5000 })

    // 成功提示
    await expect(skillsWindow.locator('[data-testid="success-msg"]')).toBeVisible()
  })

  test('通过 IPC 直接创建和读取技能', async () => {
    testApp = await launchApp()
    const { chatWindow, app } = testApp

    // 先发送一条消息以触发数据库初始化
    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.send('hello')
    })
    await chatWindow.waitForTimeout(3000)

    // 打开技能窗口
    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.openPanel('skills')
    })

    // 等待技能窗口出现
    const skillsWindow = await waitForSkillsWindow(app)
    await skillsWindow.waitForLoadState('domcontentloaded')

    // 在技能窗口中验证 API 可用
    const apiExists = await skillsWindow!.evaluate(() => {
      return typeof (window as any).skillsAPI !== 'undefined'
    })
    expect(apiExists).toBe(true)

    // 通过 skillsAPI 创建技能
    const skill = await skillsWindow!.evaluate(() => {
      return (window as any).skillsAPI.create({
        name: 'IPC测试技能',
        description: '通过 IPC 创建',
        content: 'Test prompt template',
        status: 'active'
      })
    })
    expect(skill).toBeTruthy()
    expect(skill.name).toBe('IPC测试技能')

    // 通过 skillsAPI 列表验证
    const list = await skillsWindow!.evaluate(() => {
      return (window as any).skillsAPI.list()
    })
    expect(Array.isArray(list)).toBe(true)
    expect(list.some((s: any) => s.name === 'IPC测试技能')).toBe(true)

    // 删除技能
    await skillsWindow!.evaluate((id) => {
      return (window as any).skillsAPI.remove(id)
    }, skill.id)

    // 验证删除
    const listAfter = await skillsWindow!.evaluate(() => {
      return (window as any).skillsAPI.list()
    })
    expect(listAfter.some((s: any) => s.id === skill.id)).toBe(false)
  })

  test('搜索和筛选技能', async () => {
    testApp = await launchApp()
    const { chatWindow, app } = testApp

    await chatWindow.evaluate(() => {
      return (window as any).chatAPI.openPanel('skills')
    })

    const skillsWindow = await waitForSkillsWindow(app)
    await skillsWindow.waitForLoadState('domcontentloaded')
    await expect(skillsWindow.locator('.skills-content')).toBeVisible({ timeout: 5000 })

    // 创建两个技能
    for (const [name, desc] of [['代码审查', '审查代码质量'], ['翻译助手', '翻译文本']]) {
      await skillsWindow.locator('[data-testid="btn-add-skill"]').click()
      await expect(skillsWindow.locator('[data-testid="skill-modal"]')).toBeVisible()
      await skillsWindow.locator('[data-testid="input-skill-name"]').fill(name)
      await skillsWindow.locator('[data-testid="input-skill-description"]').fill(desc)
      await skillsWindow.locator('[data-testid="input-skill-content"]').fill('content')
      await skillsWindow.locator('[data-testid="btn-save-skill"]').click()
      await expect(skillsWindow.locator('[data-testid="skill-modal"]')).not.toBeVisible()
    }

    // 验证两个技能都在列表中
    await expect(skillsWindow.locator('[data-testid="skill-list"]')).toBeVisible()
    const skillCards = skillsWindow.locator('.skill-card')
    await expect(skillCards).toHaveCount(2)

    // 搜索 "代码"
    await skillsWindow.locator('[data-testid="search-input"]').fill('代码')
    await expect(skillsWindow.locator('[data-testid="skill-name"]', { hasText: '代码审查' })).toBeVisible()
    await expect(skillsWindow.locator('[data-testid="skill-name"]', { hasText: '翻译助手' })).not.toBeVisible()

    // 清空搜索
    await skillsWindow.locator('[data-testid="search-input"]').fill('')
    await expect(skillCards).toHaveCount(2)
  })
})

/** 等待技能窗口出现 */
async function waitForSkillsWindow(app: any, timeout = 10000): Promise<any> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const win = app.windows().find((w: any) => w.url().includes('skills'))
    if (win) return win
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error('Skills window did not appear within timeout')
}
