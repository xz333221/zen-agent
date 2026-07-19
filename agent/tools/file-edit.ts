/**
 * 文件编辑工具 — 对已有文件做局部文本替换
 *
 * 设计动机：文本 ReAct 协议下整文件重写极易因 JSON 转义损坏而失败。
 * file_edit 采用扁平单替换 schema（path / old_string / new_string），
 * 模型只需提供要改的片段，无需重写整个文件，大幅降低损坏概率。
 *
 * 安全措施：
 * - 受保护路径检查（与 file_writer 共享 PROTECTED_PATH_PATTERNS）
 * - old_string 须逐字符一致（含缩进换行），确保精确匹配
 * - 默认要求唯一匹配（expected_count=1），多处匹配需显式声明
 * - 文件不存在时报错并提示用 file_writer 新建
 */

import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import type { ToolDef, ToolExecutor, ToolResult } from './types'
import { checkProtectedPath } from './path-guard'

const FILE_EDIT_DEF: ToolDef = {
  id: 'file_edit',
  name: 'FileEdit',
  description: '对已有文件做局部文本替换（精确匹配 old_string 替换为 new_string）。参数: path (文件路径), old_string (要替换的原文, 须逐字符一致含缩进换行), new_string (替换后的文本, 空串=删除该片段), expected_count (可选, 期望匹配次数, 默认1=必须唯一). 适合修改已有文件的局部代码, 不要整文件重写. 新建文件请用 file_writer.',
  category: 'builtin',
  schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '文件路径（绝对路径或相对路径），文件必须已存在'
      },
      old_string: {
        type: 'string',
        description: '要替换的原文片段，必须与文件中的内容逐字符一致（含缩进、换行）。不能为空。'
      },
      new_string: {
        type: 'string',
        description: '替换后的文本。可为空串（表示删除 old_string 片段）。'
      },
      expected_count: {
        type: 'number',
        description: '期望 old_string 在文件中出现的次数。默认 1（必须唯一匹配，多处匹配会报错）。如需替换多处相同文本，传入实际次数。',
        default: 1
      }
    },
    required: ['path', 'old_string', 'new_string']
  },
  requiresApproval: false,
  timeoutMs: 10000
}

/** 查找 old_string 在 content 中的所有出现位置（起始索引） */
function findAllOccurrences(content: string, search: string): number[] {
  const indices: number[] = []
  if (!search) return indices
  let from = 0
  while (true) {
    const idx = content.indexOf(search, from)
    if (idx === -1) break
    indices.push(idx)
    from = idx + search.length
  }
  return indices
}

/** 将字符偏移转为行号（1-based） */
function offsetToLine(content: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === '\n') line++
  }
  return line
}

export const fileEditor: ToolExecutor = {
  def: FILE_EDIT_DEF,
  async execute(params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const startTime = Date.now()
    const callId = `file-edit-${Date.now()}`

    // ── 防御：参数类型损坏时拒绝执行（normalizeParams 之外的兜底）──
    if (typeof params.old_string === 'object' && params.old_string !== null) {
      return {
        callId,
        success: false,
        result: null,
        resultType: 'error',
        resultSummary: '缺少必填参数 "old_string"（收到的是对象而非字符串）。请直接传字符串，不要传 {"text": "..."} 之类的包装对象。',
        duration: Date.now() - startTime,
        error: 'old_string parameter must be a string, got object'
      }
    }
    if (typeof params.new_string === 'object' && params.new_string !== null) {
      return {
        callId,
        success: false,
        result: null,
        resultType: 'error',
        resultSummary: '缺少必填参数 "new_string"（收到的是对象而非字符串）。请直接传字符串。',
        duration: Date.now() - startTime,
        error: 'new_string parameter must be a string, got object'
      }
    }

    const filePath = String(params.path || '')
    const oldString = String(params.old_string ?? '')
    const newString = String(params.new_string ?? '')
    const expectedCount = Number(params.expected_count) || 1

    // old_string 不能为空（空串无法定位）
    if (!oldString) {
      return {
        callId,
        success: false,
        result: null,
        resultType: 'error',
        resultSummary: '缺少必填参数 "old_string"（不能为空）。old_string 是要替换的原文片段，必须提供。',
        duration: Date.now() - startTime,
        error: 'old_string must not be empty'
      }
    }

    if (!filePath) {
      return {
        callId,
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
        callId,
        success: false,
        result: null,
        resultType: 'error',
        resultSummary: '编辑被中止',
        duration: Date.now() - startTime,
        error: 'aborted'
      }
    }

    try {
      const absPath = resolve(filePath)

      // 受保护路径检查
      const protectedReason = checkProtectedPath(absPath)
      if (protectedReason) {
        return {
          callId,
          success: false,
          result: null,
          resultType: 'error',
          resultSummary: `禁止编辑受保护路径: ${protectedReason}`,
          duration: Date.now() - startTime,
          error: `Protected path: ${protectedReason}`
        }
      }

      // 读取文件（不存在时给出明确指引）
      let content: string
      try {
        content = readFileSync(absPath, 'utf-8')
      } catch (err) {
        const error = err as NodeJS.ErrnoException
        if (error.code === 'ENOENT') {
          return {
            callId,
            success: false,
            result: null,
            resultType: 'error',
            resultSummary: `文件不存在: ${absPath}。新建文件请用 file_writer 工具（参数: {"path": "...", "content": "..."}）。file_edit 只能修改已有文件。`,
            duration: Date.now() - startTime,
            error: `File not found: ${absPath}`
          }
        }
        throw err
      }

      // 查找所有匹配位置
      const occurrences = findAllOccurrences(content, oldString)

      if (occurrences.length === 0) {
        // 未找到匹配：提供文件前 5 行作为锚点，帮助模型定位
        const firstLines = content.split('\n').slice(0, 5).map((line, i) => `${i + 1}| ${line}`).join('\n')
        return {
          callId,
          success: false,
          result: null,
          resultType: 'error',
          resultSummary: `未找到匹配文本。old_string（前 80 字符）: "${oldString.slice(0, 80)}" 在文件中不存在。请先用 file_reader 确认文件内容，确保 old_string 逐字符一致（含缩进和换行）。\n\n文件前 5 行（供参考）:\n${firstLines}`,
          duration: Date.now() - startTime,
          error: 'old_string not found in file'
        }
      }

      if (occurrences.length !== expectedCount) {
        // 匹配次数与期望不符
        const lineNumbers = occurrences.map(idx => offsetToLine(content, idx))
        return {
          callId,
          success: false,
          result: null,
          resultType: 'error',
          resultSummary: `匹配次数不符: 期望 ${expectedCount} 次，实际找到 ${occurrences.length} 次（行号: ${lineNumbers.join(', ')}）。如需替换所有匹配，请设置 expected_count=${occurrences.length}。如只需替换其中一处，请在 old_string 中加入更多上下文使其唯一。`,
          duration: Date.now() - startTime,
          error: `Expected ${expectedCount} occurrences, found ${occurrences.length}`
        }
      }

      // 执行替换（从后往前替换，避免索引偏移）
      let newContent = content
      for (let i = occurrences.length - 1; i >= 0; i--) {
        const idx = occurrences[i]
        newContent = newContent.slice(0, idx) + newString + newContent.slice(idx + oldString.length)
      }

      // 写入文件
      writeFileSync(absPath, newContent, 'utf-8')

      const bytesBefore = Buffer.byteLength(content, 'utf-8')
      const bytesAfter = Buffer.byteLength(newContent, 'utf-8')
      const lineNumbers = occurrences.map(idx => offsetToLine(content, idx))

      return {
        callId,
        success: true,
        result: {
          path: absPath,
          replacements: occurrences.length,
          lineNumbers,
          bytesBefore,
          bytesAfter
        },
        resultType: 'text',
        resultSummary: `替换成功: ${absPath}（${occurrences.length} 处, 行 ${lineNumbers.join(', ')}, ${bytesBefore}→${bytesAfter} 字节）`,
        duration: Date.now() - startTime
      }
    } catch (err) {
      const error = err as Error
      return {
        callId,
        success: false,
        result: null,
        resultType: 'error',
        resultSummary: `编辑文件失败: ${error.message}`,
        duration: Date.now() - startTime,
        error: error.message
      }
    }
  }
}
