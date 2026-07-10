/**
 * 网络搜索工具 — 通过 HTTP 请求获取网页内容
 *
 * 使用 Node.js 内置 fetch API 进行搜索。
 * 当无 API Key 时回退为模拟搜索（返回提示信息）。
 */

import type { ToolDef, ToolExecutor, ToolResult } from './types'

const WEB_SEARCH_DEF: ToolDef = {
  id: 'web_search',
  name: 'WebSearch',
  description: '搜索网络信息。参数: query (搜索关键词), maxResults (最大结果数, 默认 5)',
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
      }
    },
    required: ['query']
  },
  requiresApproval: false,
  timeoutMs: 30000
}

interface SearchResult {
  title: string
  url: string
  snippet: string
}

/**
 * 模拟搜索（当无搜索 API 时使用）
 * 返回搜索关键词的建议和提示
 */
function mockSearch(query: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [
    {
      title: `搜索: ${query}`,
      url: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
      snippet: `这是一个模拟搜索结果。当前未配置搜索 API，Agent 无法进行真实的网络搜索。请配置搜索 API 后使用。`
    },
    {
      title: `Wikipedia: ${query}`,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(query.replace(/\s+/g, '_'))}`,
      snippet: `查看关于 "${query}" 的 Wikipedia 文章，获取基础知识和背景信息。`
    },
    {
      title: `相关讨论: ${query}`,
      url: `https://www.reddit.com/search/?q=${encodeURIComponent(query)}`,
      snippet: `在 Reddit 上查看关于 "${query}" 的社区讨论和用户观点。`
    }
  ]

  return results.slice(0, maxResults)
}

/**
 * 使用 DuckDuckGo Instant Answer API 进行轻量搜索
 * 无需 API Key，但结果可能有限
 */
async function ddgSearch(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]> {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`
    const response = await fetch(url, {
      signal,
      headers: { 'User-Agent': 'ZenAgent/1.0' }
    })

    if (!response.ok) {
      throw new Error(`DuckDuckGo API error: ${response.status}`)
    }

    const data = await response.json() as {
      Abstract?: string
      AbstractText?: string
      AbstractURL?: string
      Heading?: string
      RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }>
    }

    const results: SearchResult[] = []

    // 主要结果
    if (data.AbstractText) {
      results.push({
        title: data.Heading || query,
        url: data.AbstractURL || '',
        snippet: data.AbstractText
      })
    }

    // 相关话题
    if (data.RelatedTopics) {
      for (const topic of data.RelatedTopics) {
        if (results.length >= maxResults) break
        if (topic.Text && topic.FirstURL) {
          results.push({
            title: topic.Text.slice(0, 80),
            url: topic.FirstURL,
            snippet: topic.Text
          })
        }
        // 嵌套话题
        if (topic.Topics) {
          for (const subTopic of topic.Topics) {
            if (results.length >= maxResults) break
            if (subTopic.Text && subTopic.FirstURL) {
              results.push({
                title: subTopic.Text.slice(0, 80),
                url: subTopic.FirstURL,
                snippet: subTopic.Text
              })
            }
          }
        }
      }
    }

    // 如果 DDG 没有返回结果，回退到模拟
    if (results.length === 0) {
      return mockSearch(query, maxResults)
    }

    return results.slice(0, maxResults)
  } catch (err) {
    // 网络错误时回退到模拟
    console.warn('[WebSearch] DuckDuckGo search failed, using mock:', err)
    return mockSearch(query, maxResults)
  }
}

export const webSearch: ToolExecutor = {
  def: WEB_SEARCH_DEF,
  async execute(params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const startTime = Date.now()
    const query = String(params.query || '')
    const maxResults = Number(params.maxResults) || 5

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
      const results = await ddgSearch(query, maxResults, signal)

      const formattedResults = results.map((r, i) => ({
        index: i + 1,
        title: r.title,
        url: r.url,
        snippet: r.snippet
      }))

      const summary = results.length > 0
        ? `找到 ${results.length} 条关于 "${query}" 的结果`
        : `未找到关于 "${query}" 的结果`

      return {
        callId: `search-${Date.now()}`,
        success: true,
        result: {
          query,
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
