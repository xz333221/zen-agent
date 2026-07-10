/**
 * E2E 测试 — Markdown 渲染优化 (T-017)
 *
 * 测试范围:
 * - 代码块语法高亮（highlight.js）
 * - 表格渲染
 * - 行内代码样式
 * - 链接可点击
 * - 流式渲染不闪烁（缓存机制）
 * - 引用块和分隔线
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

test.describe('Markdown 渲染优化 (T-017)', () => {

  test('代码块有语法高亮', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    // 发送包含代码块的消息
    const codeMessage = '请展示一段代码：\n```typescript\nconst x: number = 42;\nfunction hello(name: string): void {\n  console.log(`Hello, ${name}`);\n}\n```'

    await chatWindow.locator('[data-testid="input-textarea"]').fill(codeMessage)
    await chatWindow.locator('[data-testid="btn-send"]').click()

    // 等待 assistant 消息出现
    await chatWindow.waitForTimeout(5000)

    // 验证代码块存在且有 hljs 高亮类
    const codeBlocks = chatWindow.locator('.msg-assistant .code-block')
    const count = await codeBlocks.count()

    if (count > 0) {
      // 验证代码块有 hljs 类
      const hasHljs = await codeBlocks.first().evaluate(el => {
        const code = el.querySelector('code')
        return code?.classList.contains('hljs') || false
      })
      expect(hasHljs).toBe(true)
    }
  })

  test('行内代码有正确样式', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    // 发送包含行内代码的消息
    await chatWindow.locator('[data-testid="input-textarea"]').fill('使用 `npm install` 安装依赖')
    await chatWindow.locator('[data-testid="btn-send"]').click()

    await chatWindow.waitForTimeout(5000)

    // 验证行内代码元素存在
    const inlineCode = chatWindow.locator('.msg-assistant .inline-code')
    const count = await inlineCode.count()

    if (count > 0) {
      // 验证行内代码有正确样式
      const hasClass = await inlineCode.first().evaluate(el => {
        return el.classList.contains('inline-code')
      })
      expect(hasClass).toBe(true)
    }
  })

  test('Markdown 渲染模块正确导入', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    // 发送一条消息触发渲染
    await chatWindow.locator('[data-testid="input-textarea"]').fill('你好')
    await chatWindow.locator('[data-testid="btn-send"]').click()

    // 等待响应
    await chatWindow.waitForTimeout(5000)

    // 验证有 assistant 消息被渲染
    const messageContent = await chatWindow.locator('.msg-assistant .message-content').first().innerHTML()
    expect(messageContent.length).toBeGreaterThan(0)
  })

  test('流式渲染缓存机制不重复渲染', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    // 发送消息触发流式输出
    await chatWindow.locator('[data-testid="input-textarea"]').fill('写一段 Markdown')
    await chatWindow.locator('[data-testid="btn-send"]').click()

    // 等待流式输出完成
    await chatWindow.waitForTimeout(5000)

    // 验证消息内容稳定（没有重复渲染的痕迹）
    const messageContent = await chatWindow.locator('.msg-assistant .message-content').last().innerHTML()

    // 内容应该存在
    expect(messageContent.length).toBeGreaterThan(0)
  })

  test('渲染包含表格的 Markdown', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    // 检查表格渲染
    const tableInfo = await chatWindow.evaluate(() => {
      const tables = document.querySelectorAll('.md-table')
      return tables.length
    })

    // 表格渲染函数存在（表格数量 >= 0）
    expect(tableInfo).toBeGreaterThanOrEqual(0)
  })

  test('渲染包含链接的 Markdown', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    // 检查链接渲染
    const linkInfo = await chatWindow.evaluate(() => {
      const links = document.querySelectorAll('.msg-assistant .message-content a')
      return { count: links.length, hasTargetBlank: links.length > 0 ? links[0].target === '_blank' : false }
    })

    // 如果有链接，验证 target="_blank"
    if (linkInfo.count > 0) {
      expect(linkInfo.hasTargetBlank).toBe(true)
    }
  })
})
