/**
 * 计算器工具 — 安全的数学表达式求值
 *
 * 支持:
 * - 基本运算: +, -, *, /, %, **
 * - 括号分组
 * - 数学函数: sqrt, abs, sin, cos, tan, log, ln, exp, pow, round, floor, ceil, max, min
 * - 常量: pi, e
 */

import type { ToolDef, ToolExecutor, ToolResult } from './types'

const CALCULATOR_DEF: ToolDef = {
  id: 'calculator',
  name: 'Calculator',
  description: '计算数学表达式，支持基本运算、三角函数、对数等。例: "sqrt(144) + 2^3" 或 "sin(pi/4) * 100"',
  category: 'builtin',
  schema: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: '数学表达式，如 "2 + 3 * 4"、"sqrt(16)"、"sin(pi/2)"'
      }
    },
    required: ['expression']
  },
  requiresApproval: false,
  timeoutMs: 5000
}

// ── 安全的数学函数白名单 ──
const MATH_FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  atan2: Math.atan2,
  log: Math.log10,
  ln: Math.log,
  log2: Math.log2,
  exp: Math.exp,
  pow: Math.pow,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  max: Math.max,
  min: Math.min,
  sign: Math.sign,
  random: Math.random
}

const MATH_CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
  PI: Math.PI,
  E: Math.E
}

/**
 * 安全求值数学表达式
 * 使用 Function 构造器 + 白名单过滤，避免 eval 的安全风险
 */
function safeEval(expression: string): number {
  // 清理输入
  let expr = expression.trim()

  // 替换常量
  for (const [name, value] of Object.entries(MATH_CONSTANTS)) {
    expr = expr.replace(new RegExp(`\\b${name}\\b`, 'g'), String(value))
  }

  // 替换函数名为 Math.xxx
  for (const [name] of Object.entries(MATH_FUNCTIONS)) {
    expr = expr.replace(new RegExp(`\\b${name}\\(`, 'g'), `__fn_${name}(`)
  }

  // 替换 ^ 为 ** （幂运算）
  expr = expr.replace(/\^/g, '**')

  // 安全检查：只允许数字、运算符、括号、小数点和函数调用
  const allowedPattern = /^[\d+\-*/%.()\s,]*$|^[\d+\-*/%.()\s,]*(__fn_\w+\([\d+\-*/%.()\s,]*\)[\d+\-*/%.()\s,]*)*$/
  // 更宽松的检查：移除函数调用后验证剩余字符
  const withoutFuncs = expr.replace(/__fn_\w+\(/g, '(').replace(/,/g, '')
  if (!/^[\d+\-*/%.()\s ePItruefalse]*$/.test(withoutFuncs)) {
    throw new Error(`表达式包含不允许的字符: ${expression}`)
  }

  // 构建安全的求值环境
  const fnNames = Object.keys(MATH_FUNCTIONS).map(n => `__fn_${n}`)
  const fnValues = Object.values(MATH_FUNCTIONS)

  const evaluator = new Function(...fnNames, `"use strict"; return (${expr});`)
  const result = evaluator(...fnValues)

  if (typeof result !== 'number' || !isFinite(result)) {
    throw new Error(`计算结果无效: ${result}`)
  }

  return result
}

export const calculator: ToolExecutor = {
  def: CALCULATOR_DEF,
  async execute(params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const startTime = Date.now()
    const expression = String(params.expression || '')

    if (!expression) {
      return {
        callId: `calc-${Date.now()}`,
        success: false,
        result: null,
        resultType: 'error',
        resultSummary: '缺少表达式参数',
        duration: Date.now() - startTime,
        error: 'Expression parameter is required'
      }
    }

    // 检查中止信号
    if (signal?.aborted) {
      return {
        callId: `calc-${Date.now()}`,
        success: false,
        result: null,
        resultType: 'error',
        resultSummary: '计算被中止',
        duration: Date.now() - startTime,
        error: 'aborted'
      }
    }

    try {
      const result = safeEval(expression)
      const rounded = Math.round(result * 1e10) / 1e10 // 避免浮点精度问题

      return {
        callId: `calc-${Date.now()}`,
        success: true,
        result: { expression, result: rounded },
        resultType: 'json',
        resultSummary: `${expression} = ${rounded}`,
        duration: Date.now() - startTime
      }
    } catch (err) {
      const error = err as Error
      return {
        callId: `calc-${Date.now()}`,
        success: false,
        result: { expression, error: error.message },
        resultType: 'error',
        resultSummary: `计算失败: ${error.message}`,
        duration: Date.now() - startTime,
        error: error.message
      }
    }
  }
}
