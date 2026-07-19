/**
 * ReAct 响应解析器 — 纯函数
 *
 * 从 LLM 输出中解析 THOUGHT / ACTION / ACTION_INPUT / CONTENT 字段。
 */

import { getToolDefs } from '../../action-executor'
import type { ToolDef } from '../../../tools/types'

const THOUGHT_RE = /THOUGHT:\s*([\s\S]*?)(?=\nACTION:|$)/i
const ACTION_RE = /ACTION:\s*(\S+)/i
const ACTION_INPUT_RE = /ACTION_INPUT:\s*([\s\S]*?)(?=\nTHOUGHT:|$)/i
const CONTENT_RE = /CONTENT:\s*([\s\S]*?)$/i

export interface ParsedReActResponse {
  thought: string
  action: string
  actionInput: string
  content: string
  hasAction: boolean
  hasContent: boolean
}

/** 解析 ReAct 格式响应 */
export function parseReActResponse(response: string): ParsedReActResponse {
  const thoughtMatch = response.match(THOUGHT_RE)
  const actionMatch = response.match(ACTION_RE)
  const actionInputMatch = response.match(ACTION_INPUT_RE)
  const contentMatch = response.match(CONTENT_RE)

  const thought = thoughtMatch ? thoughtMatch[1].trim() : response.slice(0, 500)
  const hasAction = !!actionMatch
  const action = actionMatch ? actionMatch[1].trim() : 'FINAL_ANSWER'
  const actionInput = actionInputMatch ? actionInputMatch[1].trim() : ''
  const hasContent = !!contentMatch
  const content = contentMatch ? contentMatch[1].trim() : ''

  return { thought, action, actionInput, content, hasAction, hasContent }
}

// ── 工具参数 schema 缓存 ──
let toolSchemaCache: Map<string, ToolDef> | null = null

/** 获取工具 schema 缓存（避免每次调用都遍历工具列表） */
function getToolSchemaMap(): Map<string, ToolDef> {
  if (toolSchemaCache) return toolSchemaCache
  toolSchemaCache = new Map()
  for (const def of getToolDefs()) {
    toolSchemaCache.set(def.id, def)
  }
  return toolSchemaCache
}

/** 获取工具的必填参数名列表 */
function getRequiredParams(toolId: string): string[] {
  const def = getToolSchemaMap().get(toolId)
  return def?.schema.required ?? []
}

/** 获取工具所有参数名（required + optional） */
function getAllParamNames(toolId: string): string[] {
  const def = getToolSchemaMap().get(toolId)
  if (!def) return []
  return Object.keys(def.schema.properties)
}

/**
 * 参数名自动映射 — 当模型用了错误的参数名时，尝试映射到正确名称
 *
 * 常见错误：模型对所有工具都用 "query"（因为 prompt 中 web_search 的示例用了 query）
 * 映射规则：
 *   - terminal: query/command_to_run/cmd → command
 *   - file_reader: query/file/file_path → path
 *   - file_writer: query/file → path
 *   - web_search: query/q/search → query（已正确，无需映射）
 *   - fetch_url: query/link → url
 *   - open_url: query/link → url
 */
const PARAM_ALIASES: Record<string, Record<string, string>> = {
  terminal: {
    query: 'command',
    cmd: 'command',
    command_to_run: 'command',
    commandToRun: 'command',
    shell: 'command',
  },
  file_reader: {
    query: 'path',
    file: 'path',
    file_path: 'path',
    filePath: 'path',
    filename: 'path',
  },
  file_writer: {
    query: 'path',
    file: 'path',
    file_path: 'path',
    filePath: 'path',
    filename: 'path',
  },
  file_edit: {
    query: 'path',
    file: 'path',
    file_path: 'path',
    filePath: 'path',
    filename: 'path',
  },
  fetch_url: {
    query: 'url',
    link: 'url',
    address: 'url',
  },
  open_url: {
    query: 'url',
    link: 'url',
    address: 'url',
  },
  browser_navigate: {
    query: 'url',
    link: 'url',
    address: 'url',
  },
  code_executor: {
    query: 'code',
    script: 'code',
  },
}

/**
 * 对解析出的参数做自动映射：如果用了别名，转换为正确参数名
 * 只在工具的必填参数缺失时才做映射（不破坏已正确的参数）
 */
function remapParams(
  toolId: string,
  params: Record<string, unknown>
): Record<string, unknown> {
  const required = getRequiredParams(toolId)
  const allParams = getAllParamNames(toolId)

  // 如果所有必填参数都已存在，不需要映射
  const missingRequired = required.filter(p => !(p in params))
  if (missingRequired.length === 0) return params

  const aliases = PARAM_ALIASES[toolId]
  if (!aliases) return params

  const remapped = { ...params }

  for (const missingParam of missingRequired) {
    // 查找哪个别名可以映射到缺失的参数
    for (const [alias, target] of Object.entries(aliases)) {
      if (target === missingParam && alias in remapped) {
        remapped[missingParam] = remapped[alias]
        delete remapped[alias]
        console.log(`[parseToolParams] auto-remap: ${toolId} "${alias}" → "${missingParam}"`)
        break
      }
    }
  }

  return remapped
}

/**
 * 容错解析工具参数 JSON
 *
 * 改进版：
 * 1. 先尝试直接解析 JSON
 * 2. 提取 JSON 对象子串再解析
 * 3. 根据 toolId 做 context-aware fallback：
 *    - terminal → { command: cleaned }
 *    - file_reader → { path: cleaned }
 *    - web_search / file_search → { query: cleaned }
 *    - 其他 → { raw: cleaned }
 * 4. 解析后对参数名做自动映射（remapParams）
 *
 * @param actionInput  ACTION_INPUT 字段的原始文本
 * @param toolId       工具名称（用于 context-aware fallback 和参数映射）
 */
export function parseToolParams(
  actionInput: string,
  toolId?: string
): Record<string, unknown> {
  if (!actionInput) return {}

  let params: Record<string, unknown> = {}

  // ── 尝试 1：直接解析 JSON ──
  try {
    params = JSON.parse(actionInput)
  } catch {
    // ── 尝试 2：从文本中提取 JSON 对象 ──
    const jsonMatch = actionInput.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      try {
        params = JSON.parse(jsonMatch[0])
      } catch {
        // JSON 提取也失败，走 context-aware fallback
        params = contextAwareFallback(actionInput, toolId)
      }
    } else {
      // 没有 JSON 对象，走 context-aware fallback
      params = contextAwareFallback(actionInput, toolId)
    }
  }

  // ── 尝试 3：参数名自动映射（修正 query→command / query→path 等）──
  if (toolId) {
    params = remapParams(toolId, params)
  }

  return params
}

/**
 * Context-aware fallback — 当 JSON 解析失败时，根据 toolId 选择正确的参数名
 *
 * 旧版统一返回 { query: ... }，导致 terminal/file_reader 等工具全部失败。
 * 新版根据工具的必填参数名选择正确的 key。
 * 无 toolId 时保持旧行为（向后兼容）。
 */
function contextAwareFallback(
  actionInput: string,
  toolId?: string
): Record<string, unknown> {
  // ── 无 toolId：保持旧行为（向后兼容）──
  // 先尝试提取 "query" 字段（适用于 web_search 等工具的损坏 JSON）
  if (!toolId) {
    const queryMatch = actionInput.match(/"query"\s*:\s*"([^"]+)"/i)
    if (queryMatch) {
      return { query: queryMatch[1] }
    }
    // 清除 ReAct 格式标记后的纯文本
    const cleanedOld = actionInput
      .replace(/ACTION_INPUT:\s*/i, '')
      .replace(/ACTION:\s*\S+/i, '')
      .replace(/THOUGHT:[\s\S]*$/i, '')
      .replace(/CONTENT:[\s\S]*$/i, '')
      .trim()
    if (cleanedOld && !cleanedOld.includes('\n')) {
      return { query: cleanedOld }
    }
    return { raw: actionInput }
  }

  // ── 有 toolId：context-aware fallback ──
  // 清除 ReAct 格式标记
  const cleaned = actionInput
    .replace(/ACTION_INPUT:\s*/i, '')
    .replace(/ACTION:\s*\S+/i, '')
    .replace(/THOUGHT:[\s\S]*$/i, '')
    .replace(/CONTENT:[\s\S]*$/i, '')
    .replace(/[{}\[\]"]/g, '')
    .trim()

  if (!cleaned) {
    return { raw: actionInput }
  }

  // 根据 toolId 选择正确的参数名
  const required = getRequiredParams(toolId)

  // 取第一个必填参数名作为 fallback key
  if (required.length > 0) {
    const primaryParam = required[0]
    // 如果是多行文本，只取第一行（避免把多行垃圾塞进去）
    const firstLine = cleaned.split('\n')[0].trim()
    if (firstLine) {
      console.log(`[parseToolParams] fallback: ${toolId} → { "${primaryParam}": "${firstLine.slice(0, 80)}" }`)
      return { [primaryParam]: firstLine }
    }
  }

  // 未知工具或无必填参数，用 query 作为通用 fallback（兼容 web_search 等）
  if (!cleaned.includes('\n')) {
    return { query: cleaned }
  }

  return { raw: actionInput }
}
