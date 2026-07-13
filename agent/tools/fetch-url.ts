/**
 * 网页抓取工具 — 获取指定 URL 的网页内容
 *
 * 当 web_search 返回的搜索结果摘要不足以回答用户问题时，
 * 可以使用此工具抓取搜索结果中的具体页面，获取完整内容。
 *
 * 支持自动编码检测（UTF-8 / GBK / GB18030）、
 * HTML 清洗、正文提取、JSON API 响应解析。
 */

import type { ToolDef, ToolExecutor, ToolResult } from './types'

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const FETCH_URL_DEF: ToolDef = {
  id: 'fetch_url',
  name: 'FetchUrl',
  description: '抓取指定 URL 的网页内容，用于获取搜索结果中具体页面的详细内容。参数: url (要抓取的网页地址), maxLength (返回内容的最大字符数, 默认 8000)',
  category: 'builtin',
  schema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: '要抓取的网页 URL（必须包含 http:// 或 https:// 前缀）'
      },
      maxLength: {
        type: 'number',
        description: '返回内容的最大字符数（默认 8000，避免内容过长消耗过多 token）',
        default: 8000
      }
    },
    required: ['url']
  },
  requiresApproval: false,
  timeoutMs: 20000
}

/**
 * 解码 fetch 响应，自动检测编码（UTF-8 / GBK / GB18030）
 */
async function decodeResponse(response: Response): Promise<string> {
  const buffer = await response.arrayBuffer()
  const bytes = new Uint8Array(buffer)

  const headerStr = new TextDecoder('utf-8').decode(bytes.slice(0, 1024))
  const charsetMatch = headerStr.match(/charset=["']?([\w-]+)/i)
  const charset = charsetMatch ? charsetMatch[1].toLowerCase() : 'utf-8'

  if (charset === 'gbk' || charset === 'gb2312' || charset === 'gb18030') {
    return new TextDecoder('gb18030').decode(bytes)
  }
  return new TextDecoder('utf-8').decode(bytes)
}

/**
 * 从 HTML 中提取正文内容
 *
 * 策略：
 * 1. 移除 script/style/nav/footer/header 等非正文标签
 * 2. 提取 <title>、<meta description> 作为元信息
 * 3. 提取 JSON-LD 结构化数据
 * 4. 清洗 HTML 标签，保留纯文本
 * 5. 压缩空白，截取指定长度
 */
function extractReadableContent(html: string, maxLength: number): string {
  const parts: string[] = []

  // ── 提取标题 ──
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i)
  const title = titleMatch ? titleMatch[1].trim() : ''
  if (title) parts.push(`标题: ${title}`)

  // ── 提取 meta description ──
  const descMatch = html.match(/<meta\s+(?:name|property)=["'](?:description|og:description)["']\s+content=["']([^"']+)["']/i)
  const description = descMatch ? descMatch[1].trim() : ''
  if (description) parts.push(`描述: ${description}`)

  // ── 提取 JSON-LD 结构化数据 ──
  const jsonLdMatches = html.matchAll(/<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)
  for (const match of jsonLdMatches) {
    try {
      const json = JSON.parse(match[1].trim())
      const summary = summarizeJsonLd(json)
      if (summary) parts.push(`结构化数据: ${summary}`)
    } catch { /* ignore parse errors */ }
  }

  // ── 提取内联 JSON 数据（部分网站在 <script> 中嵌入数据） ──
  // 匹配常见的数据注入模式：var data = {...}, window.__data__ = {...} 等
  const jsonVarMatches = html.matchAll(/(?:var|window\.\w+|const|let)\s+\w+\s*=\s*(\{[\s\S]{10,5000}?\});/gi)
  let jsonFound = 0
  for (const match of jsonVarMatches) {
    if (jsonFound >= 2) break // 最多提取 2 个 JSON 数据块
    try {
      const json = JSON.parse(match[1])
      const summary = summarizeJsonLd(json)
      if (summary) {
        parts.push(`内联数据: ${summary}`)
        jsonFound++
      }
    } catch { /* ignore parse errors */ }
  }

  // ── 清洗 HTML，提取纯文本 ──
  const cleaned = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
    .replace(/\s+/g, ' ')
    .trim()

  if (cleaned) {
    parts.push(`正文内容:\n${cleaned}`)
  }

  let result = parts.join('\n\n')

  // 截取到最大长度
  if (result.length > maxLength) {
    result = result.slice(0, maxLength) + '\n...(内容已截断)'
  }

  return result
}

/**
 * 简要总结 JSON-LD / 内联 JSON 数据
 * 提取关键字段，避免输出过长的 JSON
 */
function summarizeJsonLd(json: unknown): string {
  if (!json || typeof json !== 'object') return ''

  const obj = json as Record<string, unknown>
  const keys = Object.keys(obj)

  // 常见的有用字段
  const usefulKeys = [
    'name', 'title', 'description', 'price', 'amount', 'value',
    'datePublished', 'dateModified', 'author', 'publisher',
    'headline', 'text', 'content', 'body', 'summary',
    'open', 'close', 'high', 'low', 'volume', 'amount',
    'current', 'change', 'percent', 'rate',
    'last', 'prevClose', 'turnover', 'marketCap',
    'up', 'down', 'flat', 'upCount', 'downCount',
    'data', 'result', 'items', 'list', 'records'
  ]

  const parts: string[] = []
  for (const key of keys) {
    if (usefulKeys.some(uk => key.toLowerCase().includes(uk.toLowerCase()))) {
      const val = obj[key]
      if (typeof val === 'string' || typeof val === 'number') {
        parts.push(`${key}: ${val}`)
      } else if (val && typeof val === 'object') {
        // 递归一层
        const subObj = val as Record<string, unknown>
        const subKeys = Object.keys(subObj).slice(0, 5)
        for (const sk of subKeys) {
          if (typeof subObj[sk] === 'string' || typeof subObj[sk] === 'number') {
            parts.push(`${key}.${sk}: ${subObj[sk]}`)
          }
        }
      }
    }
  }

  return parts.slice(0, 20).join(', ')
}

/**
 * 尝试从 API 类型的 URL 获取 JSON 数据
 */
async function tryFetchJson(url: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const response = await fetch(url, {
      signal,
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': url
      },
      redirect: 'follow'
    })

    if (!response.ok) return null

    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('json') && !contentType.includes('text/plain')) return null

    const text = await response.text()
    try {
      const json = JSON.parse(text)
      const summary = summarizeJsonLd(json)
      if (summary) {
        return `JSON API 响应:\n${summary}\n\n原始数据（前2000字符）:\n${text.slice(0, 2000)}`
      }
      // 即使无法提取关键字段，也返回原始 JSON 文本
      return `JSON API 响应:\n${text.slice(0, 4000)}`
    } catch {
      return null
    }
  } catch {
    return null
  }
}

// ═══════════════════════════════════════════════════════════
//  工具执行器
// ═══════════════════════════════════════════════════════════

export const fetchUrl: ToolExecutor = {
  def: FETCH_URL_DEF,
  async execute(params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const startTime = Date.now()

    const url = typeof params.url === 'string' ? params.url.trim() : ''
    const maxLength = typeof params.maxLength === 'number' ? params.maxLength : 8000

    if (!url) {
      return {
        callId: `fetch-${Date.now()}`,
        success: false,
        result: null,
        resultType: 'error',
        resultSummary: '缺少 URL 参数',
        duration: Date.now() - startTime,
        error: 'URL parameter is required'
      }
    }

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return {
        callId: `fetch-${Date.now()}`,
        success: false,
        result: null,
        resultType: 'error',
        resultSummary: 'URL 必须包含 http:// 或 https:// 前缀',
        duration: Date.now() - startTime,
        error: 'Invalid URL: must start with http:// or https://'
      }
    }

    if (signal?.aborted) {
      return {
        callId: `fetch-${Date.now()}`,
        success: false,
        result: null,
        resultType: 'error',
        resultSummary: '抓取被中止',
        duration: Date.now() - startTime,
        error: 'aborted'
      }
    }

    try {
      // ── 先尝试作为 JSON API 获取（部分金融数据接口返回 JSON） ──
      const jsonResult = await tryFetchJson(url, signal)
      if (jsonResult) {
        const truncated = jsonResult.length > maxLength
          ? jsonResult.slice(0, maxLength) + '\n...(内容已截断)'
          : jsonResult

        return {
          callId: `fetch-${Date.now()}`,
          success: true,
          result: {
            url,
            contentType: 'json',
            content: truncated,
            length: truncated.length
          },
          resultType: 'json',
          resultSummary: `成功抓取 ${url}（JSON 响应，${truncated.length} 字符）`,
          duration: Date.now() - startTime
        }
      }

      // ── 作为 HTML 页面抓取 ──
      const response = await fetch(url, {
        signal,
        headers: {
          'User-Agent': BROWSER_UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Upgrade-Insecure-Requests': '1'
        },
        redirect: 'follow'
      })

      if (!response.ok) {
        return {
          callId: `fetch-${Date.now()}`,
          success: false,
          result: null,
          resultType: 'error',
          resultSummary: `抓取失败: HTTP ${response.status}`,
          duration: Date.now() - startTime,
          error: `HTTP ${response.status}`
        }
      }

      const contentType = response.headers.get('content-type') || ''
      if (!contentType.includes('text/html') && !contentType.includes('text/plain') && !contentType.includes('application/xml')) {
        return {
          callId: `fetch-${Date.now()}`,
          success: false,
          result: null,
          resultType: 'error',
          resultSummary: `不支持的内容类型: ${contentType}`,
          duration: Date.now() - startTime,
          error: `Unsupported content type: ${contentType}`
        }
      }

      const html = await decodeResponse(response)
      const content = extractReadableContent(html, maxLength)

      return {
        callId: `fetch-${Date.now()}`,
        success: true,
        result: {
          url,
          finalUrl: response.url,
          contentType: 'html',
          content,
          length: content.length
        },
        resultType: 'json',
        resultSummary: `成功抓取 ${url}（${content.length} 字符）`,
        duration: Date.now() - startTime
      }
    } catch (err) {
      const error = err as Error
      return {
        callId: `fetch-${Date.now()}`,
        success: false,
        result: null,
        resultType: 'error',
        resultSummary: `抓取失败: ${error.message}`,
        duration: Date.now() - startTime,
        error: error.message
      }
    }
  }
}
