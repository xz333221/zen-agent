/**
 * 网络搜索工具 — 百度 + 搜狗 + Bing + SearXNG 多引擎搜索
 *
 * 搜索引擎策略（针对国内网络环境优化）：
 * 1. 百度（国内最佳，对中文搜索结果质量最高，bot 友好）
 * 2. 搜狗（国内可用，结果质量好）
 * 3. Bing（国内可用，但对部分中文查询可能返回不相关结果）
 * 4. SearXNG（自建/公共元搜索引擎，聚合多个搜索引擎结果）
 *
 * 引擎优先级由用户在设置中配置，当第一个引擎结果不足时自动尝试下一个。
 */

import type { ToolDef, ToolExecutor, ToolResult } from './types'
import type { SearchConfig, SearchEngine } from '@shared/types'
import { DEFAULT_SEARCH_CONFIG } from '@shared/types'
import { getSearchConfig } from '@agent/providers/llm-config'

const WEB_SEARCH_DEF: ToolDef = {
  id: 'web_search',
  name: 'WebSearch',
  description: '搜索网络获取最新信息。参数: query (搜索关键词), maxResults (最大结果数, 默认 5), fetchContent (是否抓取网页内容, 默认 true)',
  category: 'builtin',
  schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '搜索关键词'
      },
      maxResults: {
        type: 'number',
        description: '最大结果数（默认 5）',
        default: 5
      },
      fetchContent: {
        type: 'boolean',
        description: '是否抓取搜索结果的网页内容摘要（默认 true）',
        default: true
      }
    },
    required: ['query']
  },
  requiresApproval: false,
  timeoutMs: 30000
}

export interface SearchResult {
  title: string
  url: string
  snippet: string
  content?: string
}

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/**
 * 从可能包含 raw 字段的参数中提取 query
 */
function extractQuery(params: Record<string, unknown>): string {
  const directQuery = params.query
  if (directQuery && typeof directQuery === 'string' && directQuery.trim()) {
    return directQuery.trim()
  }

  const raw = params.raw
  if (raw && typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (parsed.query) return String(parsed.query).trim()
      if (parsed.q) return String(parsed.q).trim()
    } catch {
      const queryMatch = raw.match(/"query"\s*:\s*"([^"]+)"/i)
      if (queryMatch) return queryMatch[1].trim()

      const actionInputMatch = raw.match(/ACTION_INPUT:\s*(\{[^}]+\})/i)
      if (actionInputMatch) {
        try {
          const parsed = JSON.parse(actionInputMatch[1])
          if (parsed.query) return String(parsed.query).trim()
        } catch { /* ignore */ }
      }

      const cleaned = raw
        .replace(/ACTION_INPUT:.*$/is, '')
        .replace(/ACTION:.*$/is, '')
        .replace(/THOUGHT:.*$/is, '')
        .replace(/CONTENT:.*$/is, '')
        .replace(/[{}"\[\]]/g, '')
        .replace(/\n+/g, ' ')
        .trim()
      if (cleaned.length > 2 && cleaned.length < 200) {
        return cleaned
      }
    }
  }

  return ''
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

// ═══════════════════════════════════════════════════════════
//  SearXNG 搜索
// ═══════════════════════════════════════════════════════════

/**
 * 通过 SearXNG 实例搜索
 *
 * SearXNG 提供 JSON API: GET /search?q=...&format=json
 * 返回结构: { results: [{ title, url, content, engine, ... }] }
 */
async function searxngSearch(
  query: string,
  maxResults: number,
  instanceUrl: string,
  signal?: AbortSignal
): Promise<{ results: SearchResult[]; engine: string }> {
  if (!instanceUrl) {
    console.warn('[WebSearch] SearXNG: no instance URL configured')
    return { results: [], engine: 'SearXNG' }
  }

  // 规范化 URL：移除尾部斜杠
  const baseUrl = instanceUrl.replace(/\/+$/, '')

  try {
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      pageno: '1',
      safesearch: '0'
    })

    const url = `${baseUrl}/search?${params.toString()}`
    console.log(`[WebSearch] SearXNG → GET ${url}`)
    const response = await fetch(url, {
      signal,
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'application/json',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      },
      redirect: 'follow'
    })

    if (!response.ok) {
      console.warn(`[WebSearch] SearXNG (${baseUrl}) HTTP ${response.status}`)
      return { results: [], engine: 'SearXNG' }
    }

    const data = await response.json() as {
      results?: Array<{
        title?: string
        url?: string
        content?: string
        engine?: string[]
      }>
    }

    const results: SearchResult[] = []
    const seen = new Set<string>()

    if (data.results && Array.isArray(data.results)) {
      for (const item of data.results) {
        if (results.length >= maxResults) break
        if (!item.title || !item.url) continue
        if (seen.has(item.url)) continue
        seen.add(item.url)

        results.push({
          title: item.title,
          url: item.url,
          snippet: item.content || ''
        })
      }
    }

    console.log(`[WebSearch] SearXNG (${baseUrl}): found ${results.length} results for "${query}"`)
    return { results, engine: 'SearXNG' }
  } catch (err) {
    console.warn('[WebSearch] SearXNG search failed:', err instanceof Error ? err.message : err)
    return { results: [], engine: 'SearXNG' }
  }
}

// ═══════════════════════════════════════════════════════════
//  百度搜索
// ═══════════════════════════════════════════════════════════

async function baiduSearch(query: string, maxResults: number, signal?: AbortSignal): Promise<{ results: SearchResult[]; engine: string }> {
  try {
    const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=${maxResults + 5}`
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
      console.warn(`[WebSearch] Baidu HTTP ${response.status}`)
      return { results: [], engine: 'Baidu' }
    }

    const html = await decodeResponse(response)
    const results = parseBaiduHtml(html, maxResults)

    console.log(`[WebSearch] Baidu: found ${results.length} results for "${query}"`)
    return { results, engine: 'Baidu' }
  } catch (err) {
    console.warn('[WebSearch] Baidu search failed:', err instanceof Error ? err.message : err)
    return { results: [], engine: 'Baidu' }
  }
}

/**
 * 解析百度 HTML 搜索结果
 *
 * 百度结果结构（2024+ 新版）：
 * - 标题在 <h3 class="cosc-title ..."> → <a class="cosc-title-a" href="..."> → <!--s-text-->标题<!--/s-text-->
 * - 链接是百度重定向 URL: http://www.baidu.com/link?url=...
 * - 摘要在 <!--s-data:{"summaryData":{"generalLines":[{"data":[{"text":"..."}]}]}}--> JSON 中
 * - 部分结果有 data-url 属性包含真实 URL
 */
function parseBaiduHtml(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = []
  const seen = new Set<string>()

  // 策略 1：匹配 <h3> 中的 <a> 链接（百度新版结构）
  // 百度 h3 结构：<h3 class="cosc-title ..."><a class="cosc-title-a ..." href="http://www.baidu.com/link?url=...">...<!--s-text-->title<!--/s-text-->...</a></h3>
  const h3Regex = /<h3[^>]*>[\s\S]*?<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/gi
  let h3Match: RegExpExecArray | null

  while ((h3Match = h3Regex.exec(html)) !== null && results.length < maxResults) {
    const linkUrl = h3Match[1]
    const rawTitle = h3Match[2]

    // 提取标题：优先从 <!--s-text-->...<!--/s-text--> 中提取
    let title = ''
    const sTextMatch = rawTitle.match(/<!--s-text-->([\s\S]*?)<!--\/s-text-->/i)
    if (sTextMatch) {
      title = sTextMatch[1].replace(/<[^>]+>/g, '').trim()
    } else {
      title = rawTitle.replace(/<[^>]+>/g, '').trim()
    }

    if (!title || title.length < 3) continue
    if (seen.has(linkUrl)) continue

    seen.add(linkUrl)

    // 尝试提取摘要：在 h3 之后搜索 s-data JSON
    const afterH3 = html.slice(h3Regex.lastIndex, h3Regex.lastIndex + 5000)
    let snippet = ''

    // 从 <!--s-data:{"summaryData":...}--> 中提取摘要
    const sDataMatch = afterH3.match(/<!--s-data:(\{[^>]*\})-->/i)
    if (sDataMatch) {
      try {
        const sData = JSON.parse(sDataMatch[1])
        if (sData.summaryData?.generalLines?.[0]?.data?.[0]?.text) {
          snippet = sData.summaryData.generalLines[0].data[0].text.replace(/<[^>]+>/g, '').trim()
        }
      } catch { /* ignore JSON parse error */ }
    }

    // 如果没有从 s-data 提取到摘要，尝试从 <span> 中提取
    if (!snippet) {
      const spanMatch = afterH3.match(/<span[^>]*class="[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
      if (spanMatch) {
        const text = spanMatch[1].replace(/<[^>]+>/g, '').trim()
        if (text.length > 15) {
          snippet = text
        }
      }
    }

    results.push({ title, url: linkUrl, snippet })
  }

  // 策略 2：匹配所有 <h3><a> 组合（兼容旧版百度结构）
  if (results.length < 2) {
    const simpleH3Regex = /<h3[^>]*>\s*<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
    let simpleMatch: RegExpExecArray | null

    while ((simpleMatch = simpleH3Regex.exec(html)) !== null && results.length < maxResults) {
      const linkUrl = simpleMatch[1]
      const title = simpleMatch[2].replace(/<[^>]+>/g, '').trim()

      if (!title || title.length < 3) continue
      if (linkUrl.includes('baidu.com/link') === false && linkUrl.includes('baidu.com') === true) continue
      if (seen.has(linkUrl)) continue

      seen.add(linkUrl)
      results.push({ title, url: linkUrl, snippet: '' })
    }
  }

  return results
}

/**
 * 解析百度重定向链接，获取真实 URL
 */
async function resolveBaiduRedirect(redirectUrl: string, signal?: AbortSignal): Promise<string> {
  try {
    const response = await fetch(redirectUrl, {
      signal,
      headers: { 'User-Agent': BROWSER_UA },
      redirect: 'follow'
    })
    if (response.url && !response.url.includes('baidu.com/link')) {
      return response.url
    }
  } catch {
    // 解析失败，返回原始重定向链接
  }
  return redirectUrl
}

// ═══════════════════════════════════════════════════════════
//  搜狗搜索
// ═══════════════════════════════════════════════════════════

async function sogouSearch(query: string, maxResults: number, signal?: AbortSignal): Promise<{ results: SearchResult[]; engine: string }> {
  try {
    const url = `https://www.sogou.com/web?query=${encodeURIComponent(query)}&ie=utf8`
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
      console.warn(`[WebSearch] Sogou HTTP ${response.status}`)
      return { results: [], engine: 'Sogou' }
    }

    const html = await decodeResponse(response)
    const results = parseSogouHtml(html, maxResults)

    console.log(`[WebSearch] Sogou: found ${results.length} results for "${query}"`)
    return { results, engine: 'Sogou' }
  } catch (err) {
    console.warn('[WebSearch] Sogou search failed:', err instanceof Error ? err.message : err)
    return { results: [], engine: 'Sogou' }
  }
}

/**
 * 解析搜狗 HTML 搜索结果
 *
 * 搜狗结果结构：
 * - 结果块在 <div class="vrwrap"> 中
 * - 标题在 <h3 class="vr-title"> → <a href="/link?url=..."> 中
 * - 摘要在 <p class="star-wiki"> 或其他 <p> 中
 * - 搜狗有时在 data-url 属性中直接提供真实 URL
 */
function parseSogouHtml(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = []
  const seen = new Set<string>()

  // 匹配 <div class="vrwrap"> 结果块
  const blockRegex = /<div[^>]*class="[^"]*vrwrap[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<div[^>]*class="[^"]*vrwrap|<div[^>]*class="[^"]*results|<$)/gi
  let blockMatch: RegExpExecArray | null

  while ((blockMatch = blockRegex.exec(html)) !== null && results.length < maxResults) {
    const block = blockMatch[1]

    // 提取标题和链接
    const h3LinkMatch = block.match(/<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
    if (!h3LinkMatch) continue

    let linkUrl = h3LinkMatch[1]
    const title = h3LinkMatch[2]
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]+>/g, '')
      .trim()

    if (!title || title.length < 3) continue

    // 搜狗链接是相对路径，需要补全
    if (linkUrl.startsWith('/link?')) {
      linkUrl = `https://www.sogou.com${linkUrl}`
    }

    if (seen.has(linkUrl)) continue
    seen.add(linkUrl)

    // 提取摘要
    let snippet = ''
    // 策略 1：<p class="star-wiki">
    const starWikiMatch = block.match(/<p[^>]*class="[^"]*star-wiki[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
    if (starWikiMatch) {
      snippet = starWikiMatch[1]
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<[^>]+>/g, '')
        .trim()
    }

    // 策略 2：任意 <p> 标签中的长文本
    if (!snippet || snippet.length < 10) {
      const pMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
      if (pMatch) {
        const text = pMatch[1]
          .replace(/<!--[\s\S]*?-->/g, '')
          .replace(/<[^>]+>/g, '')
          .trim()
        if (text.length > 15) {
          snippet = text
        }
      }
    }

    // 策略 3：从 data-url 属性提取真实 URL
    const dataUrlMatch = block.match(/data-url="(https?:\/\/[^"]+)"/i)
    const realUrl = dataUrlMatch ? dataUrlMatch[1] : linkUrl

    results.push({ title, url: realUrl, snippet })
  }

  // 备用策略：提取所有 <h3><a> 组合
  if (results.length < 2) {
    const h3Regex = /<h3[^>]*class="[^"]*vr-title[^"]*"[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
    let h3Match: RegExpExecArray | null

    while ((h3Match = h3Regex.exec(html)) !== null && results.length < maxResults) {
      let linkUrl = h3Match[1]
      const title = h3Match[2]
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<[^>]+>/g, '')
        .trim()

      if (!title || title.length < 3) continue
      if (linkUrl.startsWith('/link?')) {
        linkUrl = `https://www.sogou.com${linkUrl}`
      }
      if (seen.has(linkUrl)) continue
      seen.add(linkUrl)

      results.push({ title, url: linkUrl, snippet: '' })
    }
  }

  return results
}

// ═══════════════════════════════════════════════════════════
//  Bing 搜索（备选）
// ═══════════════════════════════════════════════════════════

async function bingSearch(query: string, maxResults: number, signal?: AbortSignal): Promise<{ results: SearchResult[]; engine: string }> {
  const bingHosts = [
    { url: 'https://cn.bing.com', name: 'Bing' },
    { url: 'https://www.bing.com', name: 'Bing (国际版)' }
  ]

  for (const host of bingHosts) {
    try {
      const url = `${host.url}/search?q=${encodeURIComponent(query)}&count=${maxResults + 5}&form=QBLH&setlang=zh-CN&cc=CN`
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
        console.warn(`[WebSearch] Bing (${host.url}) HTTP ${response.status}`)
        continue
      }

      const html = await decodeResponse(response)
      const results = parseBingHtml(html, maxResults)

      if (results.length > 0) {
        console.log(`[WebSearch] Bing (${host.url}): found ${results.length} results for "${query}"`)
        return { results, engine: host.name }
      }
    } catch (err) {
      console.warn(`[WebSearch] Bing (${host.url}) failed:`, err instanceof Error ? err.message : err)
    }
  }

  return { results: [], engine: 'Bing' }
}

function parseBingHtml(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = []
  const seen = new Set<string>()

  const algoRegex = /<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/gi
  let algoMatch: RegExpExecArray | null

  while ((algoMatch = algoRegex.exec(html)) !== null && results.length < maxResults) {
    const block = algoMatch[1]

    const h2LinkMatch = block.match(/<h2[^>]*>\s*<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
    if (!h2LinkMatch) continue

    const linkUrl = h2LinkMatch[1]
    const title = h2LinkMatch[2].replace(/<[^>]+>/g, '').trim()
    if (!title || title.length < 3) continue
    if (linkUrl.includes('bing.com/aclk') || linkUrl.includes('go.microsoft.com')) continue
    if (seen.has(linkUrl)) continue
    seen.add(linkUrl)

    let snippet = ''
    const snippetPatterns = [
      /<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i,
      /<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i,
    ]
    for (const pattern of snippetPatterns) {
      const m = block.match(pattern)
      if (m) {
        snippet = m[1].replace(/<[^>]+>/g, '').trim()
        break
      }
    }

    results.push({ title, url: linkUrl, snippet })
  }

  return results
}

// ═══════════════════════════════════════════════════════════
//  引擎调度
// ═══════════════════════════════════════════════════════════

/**
 * 根据引擎类型执行单引擎搜索
 */
async function searchWithEngine(
  engine: SearchEngine,
  query: string,
  maxResults: number,
  config: SearchConfig,
  signal?: AbortSignal
): Promise<{ results: SearchResult[]; engine: string }> {
  switch (engine) {
    case 'searxng':
      return searxngSearch(query, maxResults, config.searxngUrl, signal)
    case 'baidu':
      return baiduSearch(query, maxResults, signal)
    case 'sogou':
      return sogouSearch(query, maxResults, signal)
    case 'bing':
      return bingSearch(query, maxResults, signal)
    default:
      return baiduSearch(query, maxResults, signal)
  }
}

/**
 * 获取用户搜索配置（从配置文件读取，agent 进程中使用）
 */
function getActiveSearchConfig(): SearchConfig {
  try {
    return getSearchConfig()
  } catch {
    // 如果配置不可用（例如在测试环境中），使用默认配置
    return { ...DEFAULT_SEARCH_CONFIG }
  }
}

// ═══════════════════════════════════════════════════════════
//  网页内容抓取
// ═══════════════════════════════════════════════════════════

async function fetchUrlContent(url: string, signal?: AbortSignal): Promise<string> {
  try {
    const response = await fetch(url, {
      signal,
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      },
      redirect: 'follow'
    })

    if (!response.ok) return ''

    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) return ''

    const html = await decodeResponse(response)

    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i)
    const title = titleMatch ? titleMatch[1].trim() : ''

    const descMatch = html.match(/<meta\s+(?:name|property)=["'](?:description|og:description)["']\s+content=["']([^"']+)["']/i)
    const description = descMatch ? descMatch[1].trim() : ''

    const cleaned = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim()

    const contentSnippet = cleaned

    const parts: string[] = []
    if (title) parts.push(`标题: ${title}`)
    if (description) parts.push(`描述: ${description}`)
    if (contentSnippet) parts.push(`内容: ${contentSnippet}`)

    return parts.join('\n')
  } catch {
    return ''
  }
}

// ═══════════════════════════════════════════════════════════
//  对外搜索接口（供 IPC 测试和工具执行器共用）
// ═══════════════════════════════════════════════════════════

/**
 * 执行搜索，使用指定配置
 *
 * @param query 搜索关键词
 * @param config 搜索配置（引擎、备用引擎、SearXNG URL 等）
 * @param signal 取消信号
 * @returns 搜索结果数组
 */
export async function performSearch(
  query: string,
  config?: SearchConfig,
  signal?: AbortSignal
): Promise<SearchResult[]> {
  const cfg = config ?? getActiveSearchConfig()
  const maxResults = cfg.maxResults || 5

  let searchResults: SearchResult[] = []
  let engine = ''

  // 1. 先尝试主引擎
  if (!signal?.aborted) {
    const primary = await searchWithEngine(cfg.engine, query, maxResults, cfg, signal)
    searchResults = primary.results
    engine = primary.engine
  }

  // 2. 如果主引擎结果不足，尝试备用引擎
  if (searchResults.length < 2 && cfg.fallbackEngine !== 'none' && !signal?.aborted) {
    const fallback = await searchWithEngine(cfg.fallbackEngine, query, maxResults, cfg, signal)
    if (fallback.results.length > searchResults.length) {
      searchResults = fallback.results
      engine = engine ? `${engine} + ${fallback.engine}` : fallback.engine
    }
  }

  // 3. 第三引擎兜底：主引擎和备用引擎都返回 0 结果时，自动尝试百度/Bing
  //    百度对中文查询最友好，作为最后兜底确保不会因为单个引擎失效而完全搜不到结果
  if (searchResults.length === 0 && !signal?.aborted) {
    const triedEngines = new Set<string>([cfg.engine, cfg.fallbackEngine])
    // 优先尝试百度（中文查询最佳）
    if (!triedEngines.has('baidu')) {
      console.log(`[WebSearch] 主引擎和备用引擎均无结果，兜底尝试百度...`)
      const baiduResult = await searchWithEngine('baidu', query, maxResults, cfg, signal)
      if (baiduResult.results.length > 0) {
        searchResults = baiduResult.results
        engine = `${engine} + Baidu(兜底)`
      }
    }
    // 百度也没用或已试过，尝试 Bing
    if (searchResults.length === 0 && !triedEngines.has('bing') && !signal?.aborted) {
      console.log(`[WebSearch] 仍无结果，兜底尝试 Bing...`)
      const bingResult = await searchWithEngine('bing', query, maxResults, cfg, signal)
      if (bingResult.results.length > 0) {
        searchResults = bingResult.results
        engine = `${engine} + ${bingResult.engine}(兜底)`
      }
    }
  }

  const finalResults = searchResults.slice(0, maxResults)

  // 解析百度重定向链接（获取真实 URL）
  if (finalResults.length > 0 && !signal?.aborted) {
    const redirectResults = await Promise.allSettled(
      finalResults
        .filter(r => r.url.includes('baidu.com/link'))
        .map(r => resolveBaiduRedirect(r.url, signal))
    )

    let redirectIdx = 0
    for (const r of finalResults) {
      if (r.url.includes('baidu.com/link') && redirectIdx < redirectResults.length) {
        const result = redirectResults[redirectIdx]
        if (result.status === 'fulfilled' && result.value) {
          r.url = result.value
        }
        redirectIdx++
      }
    }
  }

  // 可选：抓取网页内容
  if (cfg.fetchContent && finalResults.length > 0 && !signal?.aborted) {
    const contents = await Promise.allSettled(
      finalResults
        .filter(r => !r.content && r.url)
        .slice(0, 3)
        .map(r => fetchUrlContent(r.url, signal))
    )

    let contentIdx = 0
    for (const r of finalResults) {
      if (!r.content && r.url && contentIdx < contents.length) {
        const result = contents[contentIdx]
        if (result.status === 'fulfilled' && result.value) {
          r.content = result.value
        }
        contentIdx++
      }
    }
  }

  // 附加引擎信息到第一条结果（供调用方使用）
  if (finalResults.length > 0) {
    (finalResults[0] as any)._engine = engine
  }

  return finalResults
}

// ═══════════════════════════════════════════════════════════
//  工具执行器
// ═══════════════════════════════════════════════════════════

export const webSearch: ToolExecutor = {
  def: WEB_SEARCH_DEF,
  async execute(params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const startTime = Date.now()

    const query = extractQuery(params)
    const config = getActiveSearchConfig()

    // 工具参数可覆盖配置中的 maxResults 和 fetchContent
    const maxResults = Number(params.maxResults) || config.maxResults || 5
    const fetchContent = params.fetchContent !== undefined ? params.fetchContent !== false : config.fetchContent

    if (!query) {
      return {
        callId: `search-${Date.now()}`,
        success: false,
        result: null,
        resultType: 'error',
        resultSummary: '缺少搜索关键词',
        duration: Date.now() - startTime,
        error: 'Query parameter is required'
      }
    }

    if (signal?.aborted) {
      return {
        callId: `search-${Date.now()}`,
        success: false,
        result: null,
        resultType: 'error',
        resultSummary: '搜索被中止',
        duration: Date.now() - startTime,
        error: 'aborted'
      }
    }

    try {
      const searchConfig: SearchConfig = {
        ...config,
        maxResults,
        fetchContent
      }

      const finalResults = await performSearch(query, searchConfig, signal)

      // 提取引擎信息
      const engine = (finalResults[0] as any)?._engine || config.engine

      const formattedResults = finalResults.map((r, i) => ({
        index: i + 1,
        title: r.title,
        url: r.url,
        snippet: r.snippet,
        content: r.content || undefined
      }))

      const summary = finalResults.length > 0
        ? `通过 ${engine} 搜索，找到 ${finalResults.length} 条关于 "${query}" 的结果${fetchContent ? '（含网页内容）' : ''}`
        : `通过 ${engine} 搜索，未找到关于 "${query}" 的结果`

      return {
        callId: `search-${Date.now()}`,
        success: true,
        result: {
          query,
          engine,
          results: formattedResults,
          count: formattedResults.length
        },
        resultType: 'json',
        resultSummary: summary,
        duration: Date.now() - startTime
      }
    } catch (err) {
      const error = err as Error
      return {
        callId: `search-${Date.now()}`,
        success: false,
        result: null,
        resultType: 'error',
        resultSummary: `搜索失败: ${error.message}`,
        duration: Date.now() - startTime,
        error: error.message
      }
    }
  }
}
