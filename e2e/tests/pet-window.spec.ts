/**
 * E2E 测试 — 宠物窗口
 *
 * 测试范围:
 * - 宠物窗口启动并显示猫头鹰 SVG
 * - 初始状态为 idle
 * - 首次启动问候气泡出现
 * - 气泡可以关闭
 * - 气泡动作按钮可以点击
 * - 点击宠物打开对话窗口
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

test.describe('宠物窗口', () => {

  test('应用启动后显示宠物窗口', async () => {
    testApp = await launchApp()
    const { petWindow } = testApp

    // 宠物根元素可见
    await expect(petWindow.locator('[data-testid="pet-root"]')).toBeVisible()

    // SVG 猫头鹰可见
    await expect(petWindow.locator('[data-testid="zen-owl"]')).toBeVisible()

    // SVG 内有 body 椭圆
    await expect(petWindow.locator('.zen-owl .body')).toBeVisible()

    // 眼睛可见
    await expect(petWindow.locator('.zen-owl .eye-socket-left')).toBeVisible()
    await expect(petWindow.locator('.zen-owl .eye-socket-right')).toBeVisible()
  })

  test('初始状态为 idle（有 state-idle class）', async () => {
    testApp = await launchApp()
    const { petWindow } = testApp

    const owl = petWindow.locator('[data-testid="zen-owl"]')
    await expect(owl).toHaveClass(/state-idle/)
  })

  test('首次启动显示问候气泡', async () => {
    testApp = await launchApp()
    const { petWindow } = testApp

    // 等待气泡出现（有 800ms 延迟）
    const bubble = petWindow.locator('[data-testid="speech-bubble"]')
    await expect(bubble).toBeVisible({ timeout: 5000 })

    // 气泡包含问候文字
    await expect(bubble.locator('.bubble-text')).toContainText('小禅')

    // 气泡有动作按钮
    await expect(bubble.locator('[data-testid="bubble-action"]')).toBeVisible()
    await expect(bubble.locator('[data-testid="bubble-action"]')).toContainText('开始对话')
  })

  test('点击气泡关闭按钮可以关闭气泡', async () => {
    testApp = await launchApp()
    const { petWindow } = testApp

    // 等待气泡
    const bubble = petWindow.locator('[data-testid="speech-bubble"]')
    await expect(bubble).toBeVisible({ timeout: 5000 })

    // 气泡在 200x200 透明窗口外，用 dispatchEvent 模拟点击
    await petWindow.locator('[data-testid="bubble-close"]').dispatchEvent('click')

    // 气泡消失
    await expect(bubble).not.toBeVisible()
  })

  test('点击宠物根元素打开对话窗口', async () => {
    testApp = await launchApp()
    const { petWindow, chatWindow } = testApp

    // 对话窗口已可见（launchApp 内部已点击打开）
    await expect(chatWindow.locator('[data-testid="chat-root"]')).toBeVisible()

    // 对话窗口有标题栏
    await expect(chatWindow.locator('[data-testid="title-bar"]')).toBeVisible()

    // 标题栏有 Zen Agent 文字
    await expect(chatWindow.locator('.title-text')).toContainText('Zen Agent')
  })

  test('宠物 SVG 包含完整身体结构', async () => {
    testApp = await launchApp()
    const { petWindow } = testApp

    // 身体
    await expect(petWindow.locator('.zen-owl .body')).toBeVisible()
    // 腹部
    await expect(petWindow.locator('.zen-owl .belly')).toBeVisible()
    // 左右翅膀
    await expect(petWindow.locator('.zen-owl .wing-left')).toBeVisible()
    await expect(petWindow.locator('.zen-owl .wing-right')).toBeVisible()
    // 喙
    await expect(petWindow.locator('.zen-owl .beak')).toBeVisible()
    // 爪子
    await expect(petWindow.locator('.zen-owl .foot-left')).toBeVisible()
    await expect(petWindow.locator('.zen-owl .foot-right')).toBeVisible()
  })
})
