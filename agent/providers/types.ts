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

export interface ChatRequest {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | ChatMessagePart[] }>
  modelKey?: string
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  timeoutMs?: number
}

export interface ChatStreamCallbacks {
  onChunk: (delta: string) => void
  onDone?: (fullText: string) => void
  onError?: (error: Error) => void
}
