/**
 * E2E 测试 — 内置工具集 (T-012)
 *
 * 测试范围:
 * - 工具注册表包含 4 个内置工具
 * - 计算器工具正确执行数学表达式
 * - 文件读取工具正确读取文件内容
 * - 代码执行工具正确执行 JS 代码
 * - 网络搜索工具返回搜索结果
 * - 不存在的工具返回错误
 * - chatAPI 包含工具相关方法
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

test.describe('内置工具集 (T-012)', () => {

  test('工具注册表包含所有内置工具', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    const tools = await chatWindow.evaluate(() => {
      return (window as any).chatAPI.getTools()
    })

    expect(tools).toBeTruthy()
    expect(Array.isArray(tools)).toBeTruthy()
    expect(tools.length).toBeGreaterThanOrEqual(9)

    const toolIds = tools.map((t: any) => t.id)
    expect(toolIds).toContain('calculator')
    expect(toolIds).toContain('file_reader')
    expect(toolIds).toContain('code_executor')
    expect(toolIds).toContain('web_search')
    expect(toolIds).toContain('fetch_url')
  })

  test('计算器工具正确执行基本运算', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    const result = await chatWindow.evaluate(() => {
      return (window as any).chatAPI.executeTool('calculator', { expression: '2 + 3 * 4' })
    })

    expect(result).toBeTruthy()
    expect(result.success).toBe(true)
    expect(result.result.result).toBe(14)
    expect(result.resultSummary).toContain('14')
  })

  test('计算器工具支持数学函数', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    const result = await chatWindow.evaluate(() => {
      return (window as any).chatAPI.executeTool('calculator', { expression: 'sqrt(144)' })
    })

    expect(result.success).toBe(true)
    expect(result.result.result).toBe(12)
  })

  test('计算器工具支持常量', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    const result = await chatWindow.evaluate(() => {
      return (window as any).chatAPI.executeTool('calculator', { expression: 'sin(pi/2)' })
    })

    expect(result.success).toBe(true)
    // sin(pi/2) = 1 (with minor floating point error)
    expect(Math.abs(result.result.result - 1)).toBeLessThan(0.0001)
  })

  test('计算器工具处理无效表达式', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    const result = await chatWindow.evaluate(() => {
      return (window as any).chatAPI.executeTool('calculator', { expression: 'abc + def' })
    })

    expect(result.success).toBe(false)
    expect(result.resultType).toBe('error')
  })

  test('文件读取工具正确读取文件', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    // 读取 package.json
    const result = await chatWindow.evaluate(() => {
      return (window as any).chatAPI.executeTool('file_reader', { path: 'package.json', maxLines: 10 })
    })

    expect(result.success).toBe(true)
    expect(result.result.totalLines).toBeGreaterThan(0)
    expect(result.result.content).toContain('zen-agent')
  })

  test('文件读取工具处理不存在的文件', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    const result = await chatWindow.evaluate(() => {
      return (window as any).chatAPI.executeTool('file_reader', { path: 'nonexistent-file.txt' })
    })

    expect(result.success).toBe(false)
    expect(result.resultType).toBe('error')
  })

  test('代码执行工具正确执行 JS 代码', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    const result = await chatWindow.evaluate(() => {
      return (window as any).chatAPI.executeTool('code_executor', {
        code: 'const x = 5; const y = 10; console.log(x + y); return x * y;'
      })
    })

    expect(result.success).toBe(true)
    expect(result.result.output).toContain('15')
    expect(result.result.returnValue).toBe('50')
  })

  test('代码执行工具阻止危险操作', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    const result = await chatWindow.evaluate(() => {
      return (window as any).chatAPI.executeTool('code_executor', {
        code: 'require("fs").readFileSync("/etc/passwd")'
      })
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('不允许')
  })

  test('网络搜索工具返回搜索结果', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    const result = await chatWindow.evaluate(() => {
      return (window as any).chatAPI.executeTool('web_search', { query: 'TypeScript', maxResults: 3 })
    })

    expect(result.success).toBe(true)
    expect(result.result.results).toBeTruthy()
    expect(result.result.results.length).toBeGreaterThan(0)
    expect(result.result.results[0].title).toBeTruthy()
  })

  test('不存在的工具返回错误', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    const result = await chatWindow.evaluate(() => {
      return (window as any).chatAPI.executeTool('nonexistent_tool', {})
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('not found')
  })

  test('chatAPI 包含工具相关方法', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    const methods = await chatWindow.evaluate(() => {
      const api = (window as any).chatAPI
      return {
        hasGetTools: typeof api.getTools === 'function',
        hasExecuteTool: typeof api.executeTool === 'function'
      }
    })

    expect(methods.hasGetTools).toBeTruthy()
    expect(methods.hasExecuteTool).toBeTruthy()
  })

  test('工具定义包含正确的 schema', async () => {
    testApp = await launchApp()
    const { chatWindow } = testApp

    const tools = await chatWindow.evaluate(() => {
      return (window as any).chatAPI.getTools()
    })

    for (const tool of tools) {
      expect(tool.id).toBeTruthy()
      expect(tool.name).toBeTruthy()
      expect(tool.description).toBeTruthy()
      expect(tool.schema).toBeTruthy()
      expect(tool.schema.type).toBe('object')
      expect(tool.schema.properties).toBeTruthy()
      expect(tool.schema.required).toBeTruthy()
      expect(typeof tool.requiresApproval).toBe('boolean')
      expect(typeof tool.timeoutMs).toBe('number')
    }
  })
})
