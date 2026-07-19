/**
 * LLM Provider 类型定义
 */

export interface LLMConfig {
  apiKey: string
  baseURL: string
  model: string
  temperature?: number
  maxTokens?: number
}

export interface ProviderEntry {
  id: string
  name: string
  baseURL: string
  apiKey: string
  models: string[]
  enabled: boolean
}

/**
 * 模型 key 格式: "providerId::model"
 * 例如: "openai::gpt-4o", "anthropic::claude-sonnet-4"
 */
export type ModelKey = string

export interface ChatMessagePart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string }
}

export interface ChatToolCall {
  id: string
  /** 工具/函数名 */
  name: string
  /** 参数 JSON 字符串 */
  arguments: string
}

export interface ChatToolResponse {
  /** 文本回复（如果模型只返回文本，无工具调用） */
  content: string
  /** 原生工具调用（如果模型返回了 tool_calls） */
  toolCalls?: ChatToolCall[]
  /** finish_reason: 'stop' | 'tool_calls' | 'length' 等 */
  finishReason?: string
}

export interface ChatRequest {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | ChatMessagePart[] }>
  modelKey?: string
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  timeoutMs?: number
  /** OpenAI 兼容的工具定义（原生 function calling） */
  tools?: Array<{
    type: 'function'
    function: {
      name: string
      description: string
      parameters: Record<string, unknown>
    }
  }>
  /** 工具选择策略：'auto' | 'none' | 'required' */
  toolChoice?: 'auto' | 'none' | 'required'
}

export interface ChatStreamCallbacks {
  onChunk: (delta: string) => void
  onDone?: (fullText: string) => void
  onError?: (error: Error) => void
}
