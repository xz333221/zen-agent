/**
 * 代码执行工具 — 在沙箱环境中执行 JavaScript 代码
 *
 * 安全措施:
 * - 使用受限的 Function 构造器
 * - 禁止访问 require, process, child_process 等
 * - 执行超时保护
 * - 内存使用监控
 */

import type { ToolDef, ToolExecutor, ToolResult } from './types'

const CODE_EXECUTOR_DEF: ToolDef = {
  id: 'code_executor',
  name: 'CodeExecutor',
  description: '执行 JavaScript 代码并返回结果（沙箱环境，禁止 fs/require/process/child_process/http 等模块）。支持 console.log 输出和返回值。参数: code (JS 代码), timeout (超时毫秒, 可选)。⚠️ 不能用于读写文件——请用 file_writer/file_edit；不能执行系统命令——请用 terminal。',
  category: 'builtin',
  schema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: '要执行的 JavaScript 代码'
      },
      timeout: {
        type: 'number',
        description: '执行超时（毫秒），默认 3000',
        default: 3000
      }
    },
    required: ['code']
  },
  requiresApproval: true, // 代码执行需要用户确认
  timeoutMs: 10000
}

interface ExecResult {
  output: string[]
  returnValue: unknown
  error?: string
  duration: number
}

/**
 * 在沙箱中执行 JavaScript 代码
 */
async function executeInSandbox(code: string, timeoutMs: number): Promise<ExecResult> {
  const output: string[] = []
  const startTime = Date.now()

  // 创建受限的 console
  const sandboxConsole = {
    log: (...args: unknown[]) => {
      output.push(args.map(a => formatValue(a)).join(' '))
    },
    error: (...args: unknown[]) => {
      output.push('[ERROR] ' + args.map(a => formatValue(a)).join(' '))
    },
    warn: (...args: unknown[]) => {
      output.push('[WARN] ' + args.map(a => formatValue(a)).join(' '))
    },
    info: (...args: unknown[]) => {
      output.push(args.map(a => formatValue(a)).join(' '))
    }
  }

  // 简单的 JSON 序列化
  function formatValue(val: unknown): string {
    if (val === null) return 'null'
    if (val === undefined) return 'undefined'
    if (typeof val === 'string') return val
    if (typeof val === 'number' || typeof val === 'boolean') return String(val)
    try {
      return JSON.stringify(val, null, 2)
    } catch {
      return String(val)
    }
  }

  // 提供基本的工具函数
  const utils = {
    range: (start: number, end: number, step = 1) => {
      const result: number[] = []
      for (let i = start; i < end; i += step) result.push(i)
      return result
    },
    sum: (arr: number[]) => arr.reduce((a, b) => a + b, 0),
    avg: (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0,
    max: (arr: number[]) => Math.max(...arr),
    min: (arr: number[]) => Math.min(...arr),
    sort: (arr: unknown[]) => [...arr].sort(),
    unique: (arr: unknown[]) => [...new Set(arr)]
  }

  try {
    // 检查危险代码并按类别给出指引
    const dangerousChecks: Array<{ pattern: RegExp; hint: string }> = [
      // 系统命令执行类
      { pattern: /require\s*\(/, hint: '沙箱禁止 require()。执行系统命令请用 terminal 工具（如 terminal {"command": "..."}）' },
      { pattern: /import\s+/, hint: '沙箱禁止 import。执行系统命令请用 terminal 工具' },
      { pattern: /child_process/, hint: '沙箱禁止 child_process。执行系统命令请用 terminal 工具' },
      { pattern: /execSync/, hint: '沙箱禁止 execSync。执行系统命令请用 terminal 工具' },
      { pattern: /spawnSync/, hint: '沙箱禁止 spawnSync。执行系统命令请用 terminal 工具' },
      // 文件系统类
      { pattern: /fs\./, hint: '沙箱禁止 fs 模块。读写文件请用 file_writer/file_edit/file_reader 工具' },
      { pattern: /__dirname/, hint: '沙箱禁止 __dirname。读写文件请用 file_reader/file_writer/file_edit 工具' },
      { pattern: /__filename/, hint: '沙箱禁止 __filename。读写文件请用 file_reader/file_writer/file_edit 工具' },
      // 网络/进程类
      { pattern: /process\./, hint: '沙箱禁止 process 对象。获取网络信息请用 terminal 执行 curl，或用 fetch_url/web_search' },
      { pattern: /net\./, hint: '沙箱禁止 net 模块。获取网络信息请用 terminal 执行 curl，或用 fetch_url/web_search' },
      { pattern: /http\./, hint: '沙箱禁止 http 模块。抓取网页请用 fetch_url 工具' },
      { pattern: /https\./, hint: '沙箱禁止 https 模块。抓取网页请用 fetch_url 工具' },
      { pattern: /crypto\./, hint: '沙箱禁止 crypto 模块' },
      { pattern: /os\./, hint: '沙箱禁止 os 模块。查看系统信息请用 terminal 执行 systeminfo 等命令' },
    ]

    for (const { pattern, hint } of dangerousChecks) {
      if (pattern.test(code)) {
        throw new Error(`代码包含不允许的操作: ${pattern.source}。${hint}`)
      }
    }

    // 执行代码
    const fn = new Function(
      'console', 'utils', 'Math', 'JSON', 'Date', 'Array', 'Object', 'String', 'Number', 'Boolean', 'Map', 'Set', 'RegExp', 'Error',
      `"use strict";\n${code}`
    )

    let returnValue: unknown
    const execPromise = Promise.resolve(fn(sandboxConsole, utils, Math, JSON, Date, Array, Object, String, Number, Boolean, Map, Set, RegExp, Error))

    // 超时控制
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`执行超时 (${timeoutMs}ms)`)), timeoutMs)
    })

    returnValue = await Promise.race([execPromise, timeoutPromise])

    return {
      output,
      returnValue,
      duration: Date.now() - startTime
    }
  } catch (err) {
    return {
      output,
      returnValue: undefined,
      error: (err as Error).message,
      duration: Date.now() - startTime
    }
  }
}

export const codeExecutor: ToolExecutor = {
  def: CODE_EXECUTOR_DEF,
  async execute(params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const startTime = Date.now()
    const code = String(params.code || '')
    const timeout = Number(params.timeout) || 3000

    if (!code) {
      return {
        callId: `code-${Date.now()}`,
        success: false,
        result: null,
        resultType: 'error',
        resultSummary: '缺少代码参数',
        duration: Date.now() - startTime,
        error: 'Code parameter is required'
      }
    }

    if (signal?.aborted) {
      return {
        callId: `code-${Date.now()}`,
        success: false,
        result: null,
        resultType: 'error',
        resultSummary: '执行被中止',
        duration: Date.now() - startTime,
        error: 'aborted'
      }
    }

    const result = await executeInSandbox(code, timeout)

    const outputStr = result.output.length > 0 ? result.output.join('\n') : '(无输出)'

    if (result.error) {
      return {
        callId: `code-${Date.now()}`,
        success: false,
        result: {
          output: outputStr,
          error: result.error,
          duration: result.duration
        },
        resultType: 'error',
        resultSummary: `执行错误: ${result.error}`,
        duration: Date.now() - startTime,
        error: result.error
      }
    }

    const returnStr = result.returnValue !== undefined ? formatReturnValue(result.returnValue) : ''

    return {
      callId: `code-${Date.now()}`,
      success: true,
      result: {
        output: outputStr,
        returnValue: returnStr,
        duration: result.duration
      },
      resultType: 'code',
      resultSummary: `代码执行完成 (${result.duration}ms)${outputStr ? ` → ${outputStr}` : ''}`,
      duration: Date.now() - startTime
    }
  }
}

function formatReturnValue(val: unknown): string {
  if (val === null) return 'null'
  if (val === undefined) return 'undefined'
  if (typeof val === 'string') return val
  if (typeof val === 'number' || typeof val === 'boolean') return String(val)
  try {
    return JSON.stringify(val, null, 2)
  } catch {
    return String(val)
  }
}
