/**
 * ReAct 响应解析器 — 纯函数
 *
 * 从 LLM 输出中解析 THOUGHT / ACTION / ACTION_INPUT / CONTENT 字段。
 */

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

/**
 * 容错解析工具参数 JSON
 *
 * 依次尝试: 直接解析 → 提取 JSON 对象 → 提取 query 字段 → 纯文本作为 query
 */
export function parseToolParams(actionInput: string): Record<string, unknown> {
  if (!actionInput) return {}

  try {
    return JSON.parse(actionInput)
  } catch {
    // JSON 解析失败，尝试从文本中提取 JSON 对象
    const jsonMatch = actionInput.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0])
      } catch {
        // 仍然失败，尝试提取 query 字段
        const queryMatch = actionInput.match(/"query"\s*:\s*"([^"]+)"/i)
        if (queryMatch) {
          return { query: queryMatch[1] }
        }
        // 最后回退：将整个文本作为 query（适用于 web_search 等工具）
        const cleaned = actionInput
          .replace(/ACTION_INPUT:\s*/i, '')
          .replace(/ACTION:\s*\S+/i, '')
          .replace(/THOUGHT:[\s\S]*$/i, '')
          .replace(/CONTENT:[\s\S]*$/i, '')
          .replace(/[{}\[\]"]/g, '')
          .trim()
        if (cleaned) {
          return { query: cleaned }
        }
        return { raw: actionInput }
      }
    }
    // 没有 JSON 对象，尝试作为纯文本 query
    const cleaned = actionInput.trim()
    if (cleaned && !cleaned.includes('\n')) {
      return { query: cleaned }
    }
    return { raw: actionInput }
  }
}
