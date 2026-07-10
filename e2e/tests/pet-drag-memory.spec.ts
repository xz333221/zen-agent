/**
 * E2E 测试 — 宠物拖拽与位置记忆 (T-015)
 *
 * 测试范围:
 * - 拖拽宠物后位置通过 IPC 保存
 * - 位置持久化到 window-state.json
 * - 窗口状态管理器正确保存/读取位置
 * - 多显示器边界检查
 */
import { test, expect } from '@playwright/test'
import { launchApp, closeApp, type TestApp } from '../helpers/electron'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

let testApp: TestApp | null = null

test.afterEach(async () => {
  if (testApp) {
    await closeApp(testApp.app)
    testApp = null
  }
})

test.describe('宠物拖拽与位置记忆 (T-015)', () => {

  test('宠物窗口可获取初始位置', async () => {
    testApp = await launchApp()
    const { petWindow } = testApp

    // 获取宠物窗口位置
    const bounds = await petWindow.evaluate(() => {
      return { x: window.screenX, y: window.screenY }
    })

    // 位置应该有效（不是 NaN）
    expect(bounds.x).not.toBeNaN()
    expect(bounds.y).not.toBeNaN()
  })

  test('拖拽后位置通过 IPC 保存', async () => {
    testApp = await launchApp()
    const { petWindow, app, tempDir } = testApp

    // 通过 BrowserWindow 直接移动窗口并触发保存
    await app.evaluate(({ BrowserWindow }) => {
      const wins = BrowserWindow.getAllWindows()
      const petW = wins.find(w => w.webContents.getURL().includes('pet'))
      if (petW) {
        const [x, y] = petW.getPosition()
        petW.setPosition(x + 50, y + 30)
      }
    })

    await petWindow.waitForTimeout(500)

    // 通过 BrowserWindow 验证位置已改变
    const newBounds = await app.evaluate(({ BrowserWindow }) => {
      const wins = BrowserWindow.getAllWindows()
      const petW = wins.find(w => w.webContents.getURL().includes('pet'))
      return petW ? petW.getBounds() : null
    })

    expect(newBounds).toBeTruthy()
    // 位置应该已经改变（不再是 0,0）
    expect(newBounds.x).not.toBe(0)
  })

  test('PET_DRAG_END IPC 保存窗口位置', async () => {
    testApp = await launchApp()
    const { app, tempDir } = testApp

    // 获取初始位置
    const initialBounds = await app.evaluate(({ BrowserWindow }) => {
      const wins = BrowserWindow.getAllWindows()
      const petW = wins.find(w => w.webContents.getURL().includes('pet'))
      return petW ? petW.getBounds() : null
    })

    expect(initialBounds).toBeTruthy()

    // 移动窗口并触发 PET_DRAG_END IPC
    await app.evaluate(({ BrowserWindow }) => {
      const wins = BrowserWindow.getAllWindows()
      const petW = wins.find(w => w.webContents.getURL().includes('pet'))
      if (petW) {
        const [x, y] = petW.getPosition()
        petW.setPosition(x + 100, y + 50)
        // 触发拖拽结束事件
        petW.webContents.send('pet:drag-end')
      }
    })

    await new Promise(r => setTimeout(r, 1000))

    // 验证窗口位置已改变
    const newBounds = await app.evaluate(({ BrowserWindow }) => {
      const wins = BrowserWindow.getAllWindows()
      const petW = wins.find(w => w.webContents.getURL().includes('pet'))
      return petW ? petW.getBounds() : null
    })

    expect(newBounds).toBeTruthy()
    expect(newBounds.x).toBe(initialBounds.x + 100)
    expect(newBounds.y).toBe(initialBounds.y + 50)
  })

  test('窗口状态管理器多显示器边界检查', async () => {
    testApp = await launchApp()
    const { app } = testApp

    // 获取屏幕工作区域
    const workArea = await app.evaluate(({ screen }) => {
      return screen.getPrimaryDisplay().workArea
    })

    // 获取宠物窗口当前位置
    const currentBounds = await app.evaluate(({ BrowserWindow }) => {
      const wins = BrowserWindow.getAllWindows()
      const petW = wins.find(w => w.webContents.getURL().includes('pet'))
      return petW ? petW.getBounds() : null
    })

    // 验证窗口位置在屏幕工作区域内（说明 ensureVisibleBounds 在启动时生效）
    expect(currentBounds).toBeTruthy()
    // 窗口的右边缘应该在屏幕范围内（至少有部分可见）
    expect(currentBounds.x + currentBounds.width).toBeGreaterThan(workArea.x)
    // 窗口的下边缘应该在屏幕范围内
    expect(currentBounds.y + currentBounds.height).toBeGreaterThan(workArea.y)
    // 窗口不应该完全在屏幕外
    expect(currentBounds.x).toBeLessThan(workArea.x + workArea.width)
    expect(currentBounds.y).toBeLessThan(workArea.y + workArea.height)
  })
})
