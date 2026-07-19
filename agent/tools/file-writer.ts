/**
 * 文件写入工具 — 写入或追加内容到本地文件
 *
 * 支持:
 * - 写入新文件（覆盖已有文件）
 * - 追加内容到文件末尾
 * - 自动创建父目录
 * - 文件大小限制 (10MB)
 */

import { writeFileSync, appendFileSync, mkdirSync, statSync } from 'fs'
import { resolve, dirname } from 'path'
import type { ToolDef, ToolExecutor, ToolResult } from './types'
import { checkProtectedPath } from './path-guard'

const FILE_WRITER_DEF: ToolDef = {
  id: 'file_writer',
  name: 'FileWriter',
  description: '写入或追加内容到本地文件。自动创建父目录。参数: path (文件路径), content (内容), mode (写入模式: write覆盖写入 / append追加, 默认 write), encoding (编码, 默认 utf-8)',
  category: 'builtin',
  schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '文件路径（绝对路径或相对路径）'
      },
      content: {
        type: 'string',
        description: '要写入的内容'
      },
      mode: {
        type: 'string',
        description: '写入模式: "write" 覆盖写入（默认）, "append" 追加到文件末尾',
        enum: ['write', 'append'],
        default: 'write'
      }
    },
    required: ['path', 'content']
  },
  requiresApproval: false,
  timeoutMs: 10000
}

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

export const fileWriter: ToolExecutor = {
  def: FILE_WRITER_DEF,
  async execute(params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const startTime = Date.now()

    // ── 防御：参数类型损坏时拒绝执行（正常路径下 action-executor 的
    // normalizeParams 已拦截，这里防未来有直接调用 executor 的新调用方）──
    if (typeof params.content === 'object' && params.content !== null) {
      return {
        callId: `file-w-${Date.now()}`,
        success: false,
        result: null,
        resultType: 'error',
        resultSummary: '缺少必填参数 "content"（收到的是对象而非字符串）。请直接传字符串内容，不要传 {"text": "..."} 之类的包装对象。',
        duration: Date.now() - startTime,
        error: 'content parameter must be a string, got object'
      }
    }

    const filePath = String(params.path || '')
    const content = String(params.content ?? '')
    const mode = params.mode === 'append' ? 'append' : 'write'

    if (content === '[object Object]') {
      return {
        callId: `file-w-${Date.now()}`,
        success: false,
        result: null,
        resultType: 'error',
        resultSummary: '缺少必填参数 "content"（内容为 "[object Object]"，说明参数序列化已损坏）。请重新以字符串形式传入文件内容。',
        duration: Date.now() - startTime,
        error: 'content corrupted to [object Object]'
      }
    }

    if (!filePath) {
      return {
        callId: `file-w-${Date.now()}`,
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
        callId: `file-w-${Date.now()}`,
        success: false,
        result: null,
        resultType: 'error',
        resultSummary: '写入被中止',
        duration: Date.now() - startTime,
        error: 'aborted'
      }
    }

    try {
      const absPath = resolve(filePath)

      // 检查是否为受保护的系统路径（共享 path-guard）
      const protectedReason = checkProtectedPath(absPath)
      if (protectedReason) {
        return {
          callId: `file-w-${Date.now()}`,
          success: false,
          result: null,
          resultType: 'error',
          resultSummary: `禁止写入受保护路径: ${protectedReason}`,
          duration: Date.now() - startTime,
          error: `Protected path: ${protectedReason}`
        }
      }

      // 检查内容大小
      const contentBytes = Buffer.byteLength(content, 'utf-8')
      if (contentBytes > MAX_FILE_SIZE) {
        return {
          callId: `file-w-${Date.now()}`,
          success: false,
          result: null,
          resultType: 'error',
          resultSummary: `内容过大: ${(contentBytes / 1024 / 1024).toFixed(1)}MB (最大 ${MAX_FILE_SIZE / 1024 / 1024}MB)`,
          duration: Date.now() - startTime,
          error: `Content too large: ${contentBytes} bytes`
        }
      }

      // 如果是追加模式，检查已有文件大小
      if (mode === 'append') {
        try {
          const stat = statSync(absPath)
          if (stat.size + contentBytes > MAX_FILE_SIZE) {
            return {
              callId: `file-w-${Date.now()}`,
              success: false,
              result: null,
              resultType: 'error',
              resultSummary: `追加后文件过大: 当前 ${Math.floor(stat.size / 1024 / 1024)}MB + 新增 ${(contentBytes / 1024 / 1024).toFixed(1)}MB`,
              duration: Date.now() - startTime,
              error: 'File would exceed size limit after append'
            }
          }
        } catch {
          // 文件不存在，追加模式等同于写入
        }
      }

      // 确保父目录存在
      const dir = dirname(absPath)
      mkdirSync(dir, { recursive: true })

      // 写入文件
      if (mode === 'append') {
        appendFileSync(absPath, content, 'utf-8')
      } else {
        writeFileSync(absPath, content, 'utf-8')
      }

      const lineCount = content.split('\n').length

      return {
        callId: `file-w-${Date.now()}`,
        success: true,
        result: {
          path: absPath,
          mode,
          bytesWritten: contentBytes,
          lines: lineCount
        },
        resultType: 'text',
        resultSummary: `${mode === 'append' ? '追加' : '写入'}文件 ${absPath} (${contentBytes} 字节, ${lineCount} 行)`,
        duration: Date.now() - startTime
      }
    } catch (err) {
      const error = err as Error
      return {
        callId: `file-w-${Date.now()}`,
        success: false,
        result: null,
        resultType: 'error',
        resultSummary: `写入文件失败: ${error.message}`,
        duration: Date.now() - startTime,
        error: error.message
      }
    }
  }
}
