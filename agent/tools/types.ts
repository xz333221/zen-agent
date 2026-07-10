/**
 * 工具系统类型定义
 */

export interface ToolDef {
  id: string
  name: string
  description: string
  category: 'builtin' | 'custom'
  schema: ToolSchema
  requiresApproval: boolean
  timeoutMs: number
}

export interface ToolSchema {
  type: 'object'
  properties: Record<string, ToolParam>
  required: string[]
}

export interface ToolParam {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object'
  description: string
  enum?: string[]
  default?: unknown
}

export interface ToolCall {
  id: string
  toolId: string
  parameters: Record<string, unknown>
}

export interface ToolResult {
  callId: string
  success: boolean
  result: unknown
  resultType: 'text' | 'json' | 'code' | 'file' | 'image' | 'error'
  resultSummary: string
  duration: number
  error?: string
}

/** 工具执行器接口 */
export interface ToolExecutor {
  def: ToolDef
  execute(params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>
}

/** 危险操作检测 */
export interface DangerousAction {
  toolId: string
  reason: string
  params: Record<string, unknown>
}
