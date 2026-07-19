/**
 * 工具参数规范化层
 *
 * 背景：LLM（尤其文本 ReAct 协议下）经常发出损坏的工具参数：
 * - string 参数收到对象：content = {"$text": "..."} → String(obj) = "[object Object]"
 * - 整段参数被打包进一个字段：path = "path: e:\\a.txt, content: hello"
 * - number 参数收到字符串：timeout = "30000"
 * - enum 参数收到非法值：mode = "overwrite"
 *
 * 本模块在 executeAction 中对所有工具调用做统一矫正：
 * 能修的自动修（提取/转换/拆分），修不了的返回带工具特定 hint 的失败结果，
 * 让 nudge8 和模型下一轮能自我纠正 —— 绝不让 "[object Object]" 落盘。
 */

import type { ToolSchema } from './types'
import { getToolParamExample } from './param-examples'

export type NormalizeResult =
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; error: string; hint: string }

/** string 参数收到对象时的候选提取键（按优先级） */
const TEXT_CANDIDATE_KEYS = [
  '$text', 'text', 'content', 'body', 'value',
  'code', 'command', 'query', 'path', 'url', 'raw',
]

/** 判断是否为非 null 的普通对象 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 从对象/数组中提取字符串值
 * 优先与目标参数同名的键，再按候选键顺序找
 */
function extractStringFromValue(value: unknown, paramName: string): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)

  if (Array.isArray(value)) {
    // 数组：取第一个能提取出字符串的元素
    for (const item of value) {
      const s = extractStringFromValue(item, paramName)
      if (s !== null) return s
    }
    return null
  }

  if (isPlainObject(value)) {
    // 1. 优先同名键（修 content 字段时先找 obj.content，避免整包误塞）
    const prioritized = [paramName, ...TEXT_CANDIDATE_KEYS.filter(k => k !== paramName)]
    for (const key of prioritized) {
      if (key in value) {
        const s = extractStringFromValue(value[key], paramName)
        if (s !== null) return s
      }
    }
  }

  return null
}

/** 标量 coercion：按 schema 声明类型矫正单字段值，返回矫正后的值（无法矫正返回原值） */
function coerceScalar(value: unknown, declaredType: string): unknown {
  switch (declaredType) {
    case 'string':
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      return value
    case 'number':
      if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value)
        if (!Number.isNaN(n)) return n
      }
      return value
    case 'boolean':
      if (value === 'true') return true
      if (value === 'false') return false
      return value
    case 'array':
    case 'object':
      if (typeof value === 'string') {
        try {
          return JSON.parse(value)
        } catch {
          return value
        }
      }
      return value
    default:
      return value
  }
}

/**
 * packed-value salvage：字符串值里打包了多个参数（"path: xxx, content: yyy"）
 *
 * 三重门槛（缺一不可，防止误伤正文含冒号的合法内容）：
 *  a. 存在其他 required 参数缺失
 *  b. 值以 schema 中真实存在的键开头（"key:" 形态）
 *  c. 只吸收 schema 里真实存在的键，剩余文本拼回原参数
 */
function salvagePackedValue(
  params: Record<string, unknown>,
  paramName: string,
  value: string,
  schema: ToolSchema
): Record<string, unknown> {
  const schemaKeys = Object.keys(schema.properties)
  const missingRequired = schema.required.filter(
    r => r !== paramName && !(r in params)
  )
  // 门槛 a：没有其他 required 缺失时不拆
  if (missingRequired.length === 0) return params

  // 门槛 b：必须以 schema 键开头（含参数自身——模型常把 "path: xxx, content: yyy"
  // 整段塞进 path 字段，首键恰是参数名本身）
  const startsWithKey = schemaKeys.some(
    k => new RegExp(`^\\s*${k}\\s*:`).test(value)
  )
  if (!startsWithKey) return params

  // 按 "key:" 边界切段
  const keyPattern = new RegExp(`(?:^|,)\\s*(${schemaKeys.join('|')})\\s*:`, 'g')
  const segments: Array<{ key: string | null; text: string }> = []
  let lastIndex = 0
  let lastKey: string | null = null
  let match: RegExpExecArray | null

  while ((match = keyPattern.exec(value)) !== null) {
    if (lastIndex < match.index || segments.length === 0) {
      segments.push({ key: lastKey, text: value.slice(lastIndex, match.index) })
    }
    lastKey = match[1]
    lastIndex = keyPattern.lastIndex
  }
  segments.push({ key: lastKey, text: value.slice(lastIndex) })

  // 门槛 c：只吸收 schema 键，无法归属的文本拼回原参数
  const result = { ...params }
  const leftovers: string[] = []
  for (const seg of segments) {
    const text = seg.text.replace(/^,?\s*/, '').replace(/[\s,]+$/, '')
    if (!text) continue
    if (seg.key && seg.key in schema.properties && seg.key !== paramName) {
      result[seg.key] = text
    } else {
      leftovers.push(seg.text)
    }
  }

  // 原参数保留无法归属的部分（没有则删除，让后续 required 校验判定）
  const leftoverText = leftovers.join('').trim()
  if (leftoverText) {
    result[paramName] = leftoverText
  } else {
    delete result[paramName]
  }
  return result
}

/** 生成工具特定的 hint（参数清单 + 示例 + 诊断） */
function buildHint(
  toolId: string,
  schema: ToolSchema,
  diagnosis: string
): string {
  const paramList = Object.entries(schema.properties)
    .map(([name, prop]) => {
      const req = schema.required.includes(name) ? '必填' : '可选'
      return `  ${name} (${prop.type}, ${req}): ${prop.description}`
    })
    .join('\n')
  const example = getToolParamExample(toolId)

  return `工具 ${toolId} 的正确参数：\n${paramList}${example ? `\n\n正确示例：\n${example}` : ''}\n\n诊断：${diagnosis}`
}

/**
 * 规范化工具参数
 *
 * @param toolId  工具 id（用于生成 hint）
 * @param params  原始参数（可能是任何值：对象/字符串/null）
 * @param schema  工具的参数 schema
 */
export function normalizeParams(
  toolId: string,
  params: unknown,
  schema: ToolSchema
): NormalizeResult {
  let normalized: Record<string, unknown>

  // ── 1. 非对象入参兜底 ──
  if (!isPlainObject(params)) {
    if (typeof params === 'string' && params.trim()) {
      const primary = schema.required[0]
      if (primary) {
        normalized = { [primary]: params.trim() }
      } else {
        return {
          ok: false,
          error: `缺少必填参数（收到纯文本，无法归属）`,
          hint: buildHint(toolId, schema, `你传入的是纯文本而非 JSON 对象`),
        }
      }
    } else {
      return {
        ok: false,
        error: `缺少必填参数（参数必须是 JSON 对象，收到 ${params === null ? 'null' : typeof params}）`,
        hint: buildHint(toolId, schema, `参数必须是 JSON 对象，收到 ${params === null ? 'null' : typeof params}`),
      }
    }
  } else {
    normalized = { ...params }
  }

  // ── 2. 逐字段处理 ──
  for (const [name, prop] of Object.entries(schema.properties)) {
    if (!(name in normalized)) continue
    let value = normalized[name]
    const isRequired = schema.required.includes(name)

    // 可选参数显式传 null/undefined → 视为未提供（让工具用默认值）
    if (!isRequired && (value === null || value === undefined)) {
      delete normalized[name]
      continue
    }

    // 标量 coercion（number 字符串 → number 等）
    value = coerceScalar(value, prop.type)

    // string 参数收到对象/数组 → 提取字符串
    if (prop.type === 'string' && typeof value !== 'string' && value !== undefined && value !== null) {
      const extracted = extractStringFromValue(value, name)
      if (extracted === null) {
        // 可选参数提取失败 → 丢弃该字段而非整体失败
        if (!isRequired) {
          delete normalized[name]
          continue
        }
        return {
          ok: false,
          error: `缺少必填参数 "${name}"（收到的是${Array.isArray(value) ? '数组' : '对象'}而非字符串，无法提取文本）`,
          hint: buildHint(
            toolId,
            schema,
            `参数 "${name}" 必须是字符串，你传入的是 ${JSON.stringify(value).slice(0, 120)}。请直接传字符串值。`
          ),
        }
      }
      value = extracted
    }

    // packed-value salvage（仅 string 参数）
    if (prop.type === 'string' && typeof value === 'string') {
      const salvaged = salvagePackedValue(normalized, name, value, schema)
      if (salvaged !== normalized) {
        normalized = salvaged
        // 当前参数可能已被拆分删除
        value = normalized[name]
        if (value === undefined) continue
      }
    }

    // enum 矫正：非法值丢弃走默认
    if (prop.enum && typeof value === 'string' && !prop.enum.includes(value)) {
      delete normalized[name]
      continue
    }

    if (name in normalized) {
      normalized[name] = value
    }
  }

  // ── 3. required 校验（区分"缺失"和"空串"——空串是合法值）──
  for (const req of schema.required) {
    if (!(req in normalized) || normalized[req] === undefined || normalized[req] === null) {
      return {
        ok: false,
        error: `缺少必填参数 "${req}"`,
        hint: buildHint(toolId, schema, `缺少必填参数 "${req}"`),
      }
    }
    // 必填 string 参数最终仍不是字符串（极端情况，如 boolean 值）
    const prop = schema.properties[req]
    if (prop?.type === 'string' && typeof normalized[req] !== 'string') {
      return {
        ok: false,
        error: `缺少必填参数 "${req}"（类型错误：收到 ${typeof normalized[req]}）`,
        hint: buildHint(toolId, schema, `参数 "${req}" 必须是字符串`),
      }
    }
  }

  return { ok: true, params: normalized }
}
