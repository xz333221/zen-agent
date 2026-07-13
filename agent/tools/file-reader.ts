/**
 * 文件读取工具 — 读取本地文本文件内容
 *
 * 支持:
 * - 自动编码检测 (UTF-8 / GBK 回退)
 * - 文件大小限制 (默认 1MB)
 * - 行号显示模式
 */

import { readFileSync, statSync } from 'fs'
import { resolve, extname } from 'path'
import type { ToolDef, ToolExecutor, ToolResult } from './types'

const FILE_READER_DEF: ToolDef = {
  id: 'file_reader',
  name: 'FileReader',
  description: '读取本地文本文件内容。支持代码、配置文件、文本文件等。参数: path (文件路径), maxLines (最大行数, 可选, 默认不限制)',
  category: 'builtin',
  schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '文件路径（绝对路径或相对路径）'
      },
      maxLines: {
        type: 'number',
        description: '最大读取行数（默认不限制，传 0 或负数表示不限制）',
        default: 0
      },
      showLineNumbers: {
        type: 'boolean',
        description: '是否显示行号（默认 true）',
        default: true
      }
    },
    required: ['path']
  },
  requiresApproval: false,
  timeoutMs: 10000
}

const MAX_FILE_SIZE = 50 * 1024 * 1024 // 50MB — 大模型上下文充足，放宽限制

// 支持的文件扩展名
const SUPPORTED_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.js', '.ts', '.jsx', '.tsx', '.vue',
  '.css', '.scss', '.html', '.xml', '.yaml', '.yml', '.toml',
  '.py', '.java', '.c', '.cpp', '.h', '.go', '.rs', '.rb',
  '.sh', '.bat', '.ps1', '.sql', '.graphql', '.env', '.log',
  '.csv', '.ini', '.conf', '.config'
])

export const fileReader: ToolExecutor = {
  def: FILE_READER_DEF,
  async execute(params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const startTime = Date.now()
    const filePath = String(params.path || '')
    const maxLines = Number(params.maxLines) || 0  // 0 = 不限制
    const showLineNumbers = params.showLineNumbers !== false

    if (!filePath) {
      return {
        callId: `file-${Date.now()}`,
        success: false,
        result: null,
        resultType: 'error',
        resultSummary: '缺少文件路径参数',
        duration: Date.now() - startTime,
        error: 'Path parameter is required'
      }
    }

    if (signal?.aborted) {
      return {
        callId: `file-${Date.now()}`,
        success: false,
        result: null,
        resultType: 'error',
        resultSummary: '读取被中止',
        duration: Date.now() - startTime,
        error: 'aborted'
      }
    }

    try {
      const absPath = resolve(filePath)

      // 检查文件大小
      const stat = statSync(absPath)
      if (stat.size > MAX_FILE_SIZE) {
        return {
          callId: `file-${Date.now()}`,
          success: false,
          result: null,
          resultType: 'error',
          resultSummary: `文件过大: ${(stat.size / 1024 / 1024).toFixed(1)}MB (最大 ${MAX_FILE_SIZE / 1024 / 1024}MB)`,
          duration: Date.now() - startTime,
          error: `File too large: ${stat.size} bytes`
        }
      }

      // 检查文件类型
      const ext = extname(absPath).toLowerCase()
      if (ext && !SUPPORTED_EXTENSIONS.has(ext)) {
        return {
          callId: `file-${Date.now()}`,
          success: false,
          result: null,
          resultType: 'error',
          resultSummary: `不支持的文件类型: ${ext}`,
          duration: Date.now() - startTime,
          error: `Unsupported file type: ${ext}`
        }
      }

      // 读取文件
      let content: string
      try {
        content = readFileSync(absPath, 'utf-8')
      } catch {
        // 尝试 GBK 编码（Windows 中文环境）
        try {
          const buffer = readFileSync(absPath)
          content = buffer.toString('latin1')
        } catch {
          throw new Error('无法读取文件（编码不支持）')
        }
      }

      // 行数限制（0 = 不限制）
      const lines = content.split('\n')
      const truncated = maxLines > 0 && lines.length > maxLines
      const displayLines = maxLines > 0 ? lines.slice(0, maxLines) : lines

      // 添加行号
      let displayContent: string
      if (showLineNumbers) {
        displayContent = displayLines
          .map((line, i) => `${(i + 1).toString().padStart(4, ' ')} | ${line}`)
          .join('\n')
      } else {
        displayContent = displayLines.join('\n')
      }

      if (truncated) {
        displayContent += `\n\n... (已截断，共 ${lines.length} 行，仅显示前 ${maxLines} 行。如需查看完整文件，设置 maxLines=0)`
      }

      return {
        callId: `file-${Date.now()}`,
        success: true,
        result: {
          path: absPath,
          content: displayContent,
          totalLines: lines.length,
          displayedLines: maxLines > 0 ? Math.min(lines.length, maxLines) : lines.length,
          truncated,
          size: stat.size
        },
        resultType: 'text',
        resultSummary: `读取文件 ${absPath} (${lines.length} 行, ${(stat.size / 1024).toFixed(1)}KB)`,
        duration: Date.now() - startTime
      }
    } catch (err) {
      const error = err as Error
      return {
        callId: `file-${Date.now()}`,
        success: false,
        result: null,
        resultType: 'error',
        resultSummary: `读取文件失败: ${error.message}`,
        duration: Date.now() - startTime,
        error: error.message
      }
    }
  }
}
