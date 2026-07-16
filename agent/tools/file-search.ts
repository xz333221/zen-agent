/**
 * 文件搜索工具 — 供 Agent ReAct 循环调用
 *
 * 基于本地文件索引快速搜索文件和项目。
 * 索引在应用启动时构建，包含常用目录下的文件和项目。
 *
 * 参数:
 * - query: 搜索关键词（文件名或目录名，如 "zen-git" 或 "package.json"）
 * - type: 搜索类型（file/directory/project/all，默认 all）
 * - maxResults: 最大返回数（默认 20）
 */

import { fileIndexer } from './file-index'
import type { ToolDef, ToolExecutor, ToolResult } from './types'

const FILE_SEARCH_DEF: ToolDef = {
  id: 'file_search',
  name: 'FileSearch',
  description: `搜索本地文件和项目。基于预构建的文件索引，速度极快。参数: query (搜索关键词，如项目名"zen-agent"或文件名"package.json"，留空则返回所有已知项目), type (搜索类型: file/directory/project/all，默认 all), maxResults (最大返回数，默认 20)。示例: {"query": "zen-agent"}, {"query": "", "type": "project"}`,
  category: 'builtin',
  schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '搜索关键词（文件名、目录名或路径片段）'
      },
      type: {
        type: 'string',
        description: '搜索类型: "file" 搜索文件, "directory" 搜索目录, "project" 搜索项目, "all" 搜索全部（默认 all）',
        enum: ['file', 'directory', 'project', 'all'],
        default: 'all'
      },
      maxResults: {
        type: 'number',
        description: '最大返回结果数（默认 20）',
        default: 20
      }
    },
    required: ['query']
  },
  requiresApproval: false,
  timeoutMs: 5000
}

export const fileSearch: ToolExecutor = {
  def: FILE_SEARCH_DEF,
  async execute(params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const startTime = Date.now()
    const query = String(params.query || params.keyword || params.search || params.q || '')
    const type = (String(params.type || 'all') as 'file' | 'directory' | 'project' | 'all')
    const maxResults = Number(params.maxResults) || 20

    if (signal?.aborted) {
      return {
        callId: `fs-${Date.now()}`,
        success: false,
        result: null,
        resultType: 'error',
        resultSummary: '搜索被中止',
        duration: Date.now() - startTime,
        error: 'aborted'
      }
    }

    // 检查索引是否已构建
    const stats = fileIndexer.getStats()
    if (stats.totalEntries === 0) {
      return {
        callId: `fs-${Date.now()}`,
        success: false,
        result: null,
        resultType: 'error',
        resultSummary: '文件索引尚未构建，请稍后再试或手动触发索引构建',
        duration: Date.now() - startTime,
        error: 'Index not built'
      }
    }

    // 执行搜索
    const results = fileIndexer.search(query, { type, maxResults })

    // 格式化结果
    const formatted = results.map((r, i) => {
      const parts: string[] = []
      parts.push(`[${i + 1}] ${r.name}`)
      parts.push(`  路径: ${r.path}`)
      parts.push(`  类型: ${r.type}${r.projectType ? ` (${r.projectType})` : ''}`)
      if (r.gitRemote) parts.push(`  Git: ${r.gitRemote}`)
      if (r.size > 0) parts.push(`  大小: ${(r.size / 1024).toFixed(1)}KB`)
      parts.push(`  修改: ${new Date(r.modifiedAt).toLocaleDateString('zh-CN')}`)
      return parts.join('\n')
    })

    const output = formatted.length > 0
      ? `找到 ${results.length} 个结果:\n\n${formatted.join('\n\n')}`
      : query
        ? `未找到匹配 "${query}" 的文件或目录`
        : `共找到 ${results.length} 个项目`

    return {
      callId: `fs-${Date.now()}`,
      success: true,
      result: {
        query,
        type,
        results: results.map(r => ({
          path: r.path,
          name: r.name,
          type: r.type,
          ext: r.ext,
          projectType: r.projectType,
          gitRemote: r.gitRemote,
          size: r.size,
          modifiedAt: r.modifiedAt
        })),
        totalResults: results.length
      },
      resultType: 'text',
      resultSummary: `搜索"${query || '(所有项目)'}": 找到 ${results.length} 个结果 (${Date.now() - startTime}ms)`,
      duration: Date.now() - startTime
    }
  }
}
