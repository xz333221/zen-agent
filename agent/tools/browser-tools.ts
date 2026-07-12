/**
 * 浏览器自动化工具集 — 让 AI 能够控制和操作浏览器
 *
 * 工具列表:
 * 1. browser_navigate  — 导航到指定 URL
 * 2. browser_get_text  — 获取页面文本内容
 * 3. browser_click     — 点击页面元素
 * 4. browser_type      — 在输入框中输入文字
 * 5. browser_screenshot — 截图并保存到文件
 * 6. browser_eval      — 在页面中执行 JavaScript
 * 7. browser_scroll    — 滚动页面
 * 8. browser_close     — 关闭浏览器
 *
 * 所有工具共享同一个浏览器实例（通过 BrowserManager 单例管理）。
 */

import { browserManager } from './browser-manager'
import type { ToolDef, ToolExecutor, ToolResult } from './types'
import { resolve } from 'path'
import { tmpdir } from 'os'

// ═══════════════════════════════════════════════════════════
//  辅助函数
// ═══════════════════════════════════════════════════════════

function makeResult(
  success: boolean,
  resultSummary: string,
  result: unknown = null,
  resultType: ToolResult['resultType'] = 'text',
  error?: string,
  duration: number = 0
): ToolResult {
  return {
    callId: `browser-${Date.now()}`,
    success,
    result,
    resultType: success ? resultType : 'error',
    resultSummary,
    duration,
    error
  }
}

// ═══════════════════════════════════════════════════════════
//  1. browser_navigate — 导航到 URL
// ═══════════════════════════════════════════════════════════

const NAVIGATE_DEF: ToolDef = {
  id: 'browser_navigate',
  name: 'BrowserNavigate',
  description: '打开浏览器并导航到指定 URL。如果浏览器未启动会自动启动有头浏览器。浏览器用户数据目录模式由设置决定：临时目录（无登录态）、小禅专属目录（持久化、独立于用户Chrome）或自定义目录（加载用户Chrome登录态）。参数: url (目标网址)',
  category: 'builtin',
  schema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: '要导航到的 URL（如 https://weread.qq.com/）'
      }
    },
    required: ['url']
  },
  requiresApproval: false,
  timeoutMs: 60000
}

export const browserNavigate: ToolExecutor = {
  def: NAVIGATE_DEF,
  async execute(params, signal): Promise<ToolResult> {
    const start = Date.now()
    const url = String(params.url || '').trim()

    if (!url) return makeResult(false, '缺少 url 参数', null, 'error', 'URL is required', Date.now() - start)
    if (signal?.aborted) return makeResult(false, '操作被中止', null, 'error', 'aborted', Date.now() - start)

    try {
      // 验证 URL
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return makeResult(false, `不支持的协议: ${parsed.protocol}`, null, 'error', 'Invalid protocol', Date.now() - start)
      }

      const page = await browserManager.getPage()
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })

      // 等待页面基本加载
      await page.waitForNetworkIdle({ idleTime: 1500, timeout: 8000 }).catch(() => {})

      const title = await page.title()
      const text = await browserManager.getPageText(2000)

      return makeResult(
        true,
        `已导航到: ${url}\n页面标题: ${title}\n页面内容预览:\n${text}`,
        { url, title, textPreview: text.slice(0, 500) },
        'json',
        undefined,
        Date.now() - start
      )
    } catch (err) {
      return makeResult(false, `导航失败: ${err instanceof Error ? err.message : String(err)}`, null, 'error', String(err), Date.now() - start)
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  2. browser_get_text — 获取页面文本内容
// ═══════════════════════════════════════════════════════════

const GET_TEXT_DEF: ToolDef = {
  id: 'browser_get_text',
  name: 'BrowserGetText',
  description: '获取当前浏览器页面的文本内容。参数: selector (可选，CSS 选择器，留空获取整页文本), maxLength (可选，最大返回字符数，默认 3000)',
  category: 'builtin',
  schema: {
    type: 'object',
    properties: {
      selector: {
        type: 'string',
        description: 'CSS 选择器（如 "#content", ".article", "h1"），留空则获取整页文本'
      },
      maxLength: {
        type: 'number',
        description: '最大返回字符数（默认 3000）',
        default: 3000
      }
    },
    required: []
  },
  requiresApproval: false,
  timeoutMs: 15000
}

export const browserGetText: ToolExecutor = {
  def: GET_TEXT_DEF,
  async execute(params, signal): Promise<ToolResult> {
    const start = Date.now()
    if (signal?.aborted) return makeResult(false, '操作被中止', null, 'error', 'aborted', Date.now() - start)
    if (!browserManager.isRunning()) return makeResult(false, '浏览器未启动，请先使用 browser_navigate 打开一个页面', null, 'error', 'Browser not running', Date.now() - start)

    try {
      const page = await browserManager.getPage()
      const selector = String(params.selector || '').trim()
      const maxLength = Number(params.maxLength) || 3000

      let text: string
      if (selector) {
        const element = await page.$(selector)
        if (!element) {
          return makeResult(false, `未找到选择器 "${selector}" 对应的元素`, null, 'error', 'Element not found', Date.now() - start)
        }
        text = await page.evaluate((el) => el.textContent || '', element)
      } else {
        text = await page.evaluate(() => document.body.innerText)
      }

      const truncated = text.length > maxLength
      const result = truncated ? text.slice(0, maxLength) + '\n...(内容过长，已截断)' : text

      return makeResult(
        true,
        `页面文本内容${selector ? `（选择器: ${selector}）` : ''}:\n${result}`,
        { text: result, truncated, fullLength: text.length },
        'text',
        undefined,
        Date.now() - start
      )
    } catch (err) {
      return makeResult(false, `获取文本失败: ${err instanceof Error ? err.message : String(err)}`, null, 'error', String(err), Date.now() - start)
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  3. browser_click — 点击页面元素
// ═══════════════════════════════════════════════════════════

const CLICK_DEF: ToolDef = {
  id: 'browser_click',
  name: 'BrowserClick',
  description: '点击浏览器页面中的元素。参数: selector (CSS 选择器，如 "button.submit", "#login-btn", "a[href*=login]")',
  category: 'builtin',
  schema: {
    type: 'object',
    properties: {
      selector: {
        type: 'string',
        description: '要点击的元素的 CSS 选择器'
      }
    },
    required: ['selector']
  },
  requiresApproval: false,
  timeoutMs: 15000
}

export const browserClick: ToolExecutor = {
  def: CLICK_DEF,
  async execute(params, signal): Promise<ToolResult> {
    const start = Date.now()
    if (signal?.aborted) return makeResult(false, '操作被中止', null, 'error', 'aborted', Date.now() - start)
    if (!browserManager.isRunning()) return makeResult(false, '浏览器未启动', null, 'error', 'Browser not running', Date.now() - start)

    const selector = String(params.selector || '').trim()
    if (!selector) return makeResult(false, '缺少 selector 参数', null, 'error', 'Selector is required', Date.now() - start)

    try {
      const page = await browserManager.getPage()

      // 等待元素出现
      await page.waitForSelector(selector, { visible: true, timeout: 10000 })
      await page.click(selector)

      // 等待可能的页面变化
      await page.waitForNetworkIdle({ idleTime: 1000, timeout: 5000 }).catch(() => {})

      const title = await page.title()
      const url = page.url()
      const text = await browserManager.getPageText(1000)

      return makeResult(
        true,
        `已点击元素: ${selector}\n当前页面: ${url}\n标题: ${title}\n内容预览:\n${text}`,
        { selector, currentUrl: url, title },
        'json',
        undefined,
        Date.now() - start
      )
    } catch (err) {
      return makeResult(false, `点击失败: ${err instanceof Error ? err.message : String(err)}`, null, 'error', String(err), Date.now() - start)
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  4. browser_type — 在输入框中输入文字
// ═══════════════════════════════════════════════════════════

const TYPE_DEF: ToolDef = {
  id: 'browser_type',
  name: 'BrowserType',
  description: '在浏览器页面的输入框中输入文字。参数: selector (CSS 选择器，指向 input 或 textarea), text (要输入的文字), submit (可选，是否按回车提交，默认 false)',
  category: 'builtin',
  schema: {
    type: 'object',
    properties: {
      selector: {
        type: 'string',
        description: '输入框的 CSS 选择器（如 "input#search", "textarea#content"）'
      },
      text: {
        type: 'string',
        description: '要输入的文字内容'
      },
      submit: {
        type: 'boolean',
        description: '是否在输入后按回车键提交（默认 false）',
        default: false
      }
    },
    required: ['selector', 'text']
  },
  requiresApproval: false,
  timeoutMs: 15000
}

export const browserType: ToolExecutor = {
  def: TYPE_DEF,
  async execute(params, signal): Promise<ToolResult> {
    const start = Date.now()
    if (signal?.aborted) return makeResult(false, '操作被中止', null, 'error', 'aborted', Date.now() - start)
    if (!browserManager.isRunning()) return makeResult(false, '浏览器未启动', null, 'error', 'Browser not running', Date.now() - start)

    const selector = String(params.selector || '').trim()
    const text = String(params.text || '')
    const submit = Boolean(params.submit)

    if (!selector) return makeResult(false, '缺少 selector 参数', null, 'error', 'Selector is required', Date.now() - start)

    try {
      const page = await browserManager.getPage()

      await page.waitForSelector(selector, { visible: true, timeout: 10000 })
      await page.click(selector, { clickCount: 3 }) // 选中所有文字
      await page.keyboard.press('Backspace') // 清空
      await page.type(selector, text, { delay: 30 }) // 逐字输入模拟人类

      if (submit) {
        await page.keyboard.press('Enter')
        await page.waitForNetworkIdle({ idleTime: 1500, timeout: 8000 }).catch(() => {})
      }

      const url = page.url()
      const title = await page.title()
      const pageText = await browserManager.getPageText(1000)

      return makeResult(
        true,
        `已在 "${selector}" 中输入: "${text}"${submit ? '（已按回车）' : ''}\n当前页面: ${url}\n标题: ${title}\n内容预览:\n${pageText}`,
        { selector, text, submitted: submit, currentUrl: url, title },
        'json',
        undefined,
        Date.now() - start
      )
    } catch (err) {
      return makeResult(false, `输入失败: ${err instanceof Error ? err.message : String(err)}`, null, 'error', String(err), Date.now() - start)
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  5. browser_screenshot — 截图并保存到文件
// ═══════════════════════════════════════════════════════════

const SCREENSHOT_DEF: ToolDef = {
  id: 'browser_screenshot',
  name: 'BrowserScreenshot',
  description: '截取当前浏览器页面的截图，保存为 PNG 文件。参数: fullPage (可选，是否截取完整页面，默认 false)',
  category: 'builtin',
  schema: {
    type: 'object',
    properties: {
      fullPage: {
        type: 'boolean',
        description: '是否截取完整可滚动页面（默认 false，只截取可视区域）',
        default: false
      }
    },
    required: []
  },
  requiresApproval: false,
  timeoutMs: 20000
}

export const browserScreenshot: ToolExecutor = {
  def: SCREENSHOT_DEF,
  async execute(params, signal): Promise<ToolResult> {
    const start = Date.now()
    if (signal?.aborted) return makeResult(false, '操作被中止', null, 'error', 'aborted', Date.now() - start)
    if (!browserManager.isRunning()) return makeResult(false, '浏览器未启动', null, 'error', 'Browser not running', Date.now() - start)

    try {
      const page = await browserManager.getPage()
      const fullPage = Boolean(params.fullPage)

      const filename = `browser-screenshot-${Date.now()}.png`
      const filepath = resolve(tmpdir(), filename)

      await page.screenshot({ path: filepath, fullPage, type: 'png' })

      const url = page.url()
      const title = await page.title()

      return makeResult(
        true,
        `截图已保存到: ${filepath}\n页面: ${url}\n标题: ${title}${fullPage ? '（完整页面）' : '（可视区域）'}`,
        { filepath, url, title, fullPage },
        'file',
        undefined,
        Date.now() - start
      )
    } catch (err) {
      return makeResult(false, `截图失败: ${err instanceof Error ? err.message : String(err)}`, null, 'error', String(err), Date.now() - start)
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  6. browser_eval — 在页面中执行 JavaScript
// ═══════════════════════════════════════════════════════════

const EVAL_DEF: ToolDef = {
  id: 'browser_eval',
  name: 'BrowserEval',
  description: '在浏览器页面中执行 JavaScript 代码并返回结果。参数: code (JavaScript 代码，可以使用 document API)',
  category: 'builtin',
  schema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: '要执行的 JavaScript 代码（如 "document.title", "document.querySelectorAll(\'a\').length"）'
      }
    },
    required: ['code']
  },
  requiresApproval: true,
  timeoutMs: 15000
}

export const browserEval: ToolExecutor = {
  def: EVAL_DEF,
  async execute(params, signal): Promise<ToolResult> {
    const start = Date.now()
    if (signal?.aborted) return makeResult(false, '操作被中止', null, 'error', 'aborted', Date.now() - start)
    if (!browserManager.isRunning()) return makeResult(false, '浏览器未启动', null, 'error', 'Browser not running', Date.now() - start)

    const code = String(params.code || '')
    if (!code) return makeResult(false, '缺少 code 参数', null, 'error', 'Code is required', Date.now() - start)

    try {
      const page = await browserManager.getPage()
      const result = await page.evaluate(code)

      const resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
      const truncated = resultStr.length > 3000
      const display = truncated ? resultStr.slice(0, 3000) + '\n...(结果过长，已截断)' : resultStr

      return makeResult(
        true,
        `JavaScript 执行结果:\n${display}`,
        { result: truncated ? resultStr.slice(0, 3000) : resultStr, truncated },
        'text',
        undefined,
        Date.now() - start
      )
    } catch (err) {
      return makeResult(false, `执行失败: ${err instanceof Error ? err.message : String(err)}`, null, 'error', String(err), Date.now() - start)
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  7. browser_scroll — 滚动页面
// ═══════════════════════════════════════════════════════════

const SCROLL_DEF: ToolDef = {
  id: 'browser_scroll',
  name: 'BrowserScroll',
  description: '滚动浏览器页面。参数: direction (方向: "down" 或 "up", 默认 "down"), amount (滚动量，像素，默认 500)',
  category: 'builtin',
  schema: {
    type: 'object',
    properties: {
      direction: {
        type: 'string',
        description: '滚动方向: "down"（向下）或 "up"（向上）',
        enum: ['down', 'up'],
        default: 'down'
      },
      amount: {
        type: 'number',
        description: '滚动像素量（默认 500）',
        default: 500
      }
    },
    required: []
  },
  requiresApproval: false,
  timeoutMs: 10000
}

export const browserScroll: ToolExecutor = {
  def: SCROLL_DEF,
  async execute(params, signal): Promise<ToolResult> {
    const start = Date.now()
    if (signal?.aborted) return makeResult(false, '操作被中止', null, 'error', 'aborted', Date.now() - start)
    if (!browserManager.isRunning()) return makeResult(false, '浏览器未启动', null, 'error', 'Browser not running', Date.now() - start)

    try {
      const page = await browserManager.getPage()
      const direction = String(params.direction || 'down') as 'down' | 'up'
      const amount = Number(params.amount) || 500

      const scrollY = direction === 'down' ? amount : -amount
      await page.evaluate((dy) => window.scrollBy(0, dy), scrollY)

      // 等待可能的动态加载
      await new Promise(r => setTimeout(r, 800))

      const text = await browserManager.getPageText(1500)
      const scrollPosition = await page.evaluate(() => ({
        y: window.scrollY,
        total: document.body.scrollHeight,
        viewport: window.innerHeight
      }))

      return makeResult(
        true,
        `已向${direction === 'down' ? '下' : '上'}滚动 ${amount}px\n滚动位置: ${scrollPosition.y}/${scrollPosition.total}px\n当前内容预览:\n${text}`,
        { direction, amount, scrollPosition },
        'json',
        undefined,
        Date.now() - start
      )
    } catch (err) {
      return makeResult(false, `滚动失败: ${err instanceof Error ? err.message : String(err)}`, null, 'error', String(err), Date.now() - start)
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  8. browser_close — 关闭浏览器
// ═══════════════════════════════════════════════════════════

const CLOSE_DEF: ToolDef = {
  id: 'browser_close',
  name: 'BrowserClose',
  description: '关闭浏览器，释放资源。当完成所有浏览器操作后应调用此工具。',
  category: 'builtin',
  schema: {
    type: 'object',
    properties: {},
    required: []
  },
  requiresApproval: false,
  timeoutMs: 10000
}

export const browserClose: ToolExecutor = {
  def: CLOSE_DEF,
  async execute(_params, signal): Promise<ToolResult> {
    const start = Date.now()
    if (signal?.aborted) return makeResult(false, '操作被中止', null, 'error', 'aborted', Date.now() - start)

    try {
      await browserManager.close()
      return makeResult(true, '浏览器已关闭', { closed: true }, 'text', undefined, Date.now() - start)
    } catch (err) {
      return makeResult(false, `关闭浏览器失败: ${err instanceof Error ? err.message : String(err)}`, null, 'error', String(err), Date.now() - start)
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  导出所有浏览器工具
// ═══════════════════════════════════════════════════════════

export const browserTools: ToolExecutor[] = [
  browserNavigate,
  browserGetText,
  browserClick,
  browserType,
  browserScreenshot,
  browserEval,
  browserScroll,
  browserClose
]
