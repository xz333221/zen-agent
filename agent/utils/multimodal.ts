/**
 * 多模态消息工具 — 纯函数
 *
 * 从 agent-loop.ts / context-manager.ts 中抽取的共享实现
 * （历史上这两个文件各有一份完全相同的 extractTextFromContent）。
 */

import type { ChatMessagePart } from '../providers/types'

/** 任意角色的消息形状（结构性类型，兼容各处的消息定义） */
export interface AnyMessage {
  role: string
  content: string | ChatMessagePart[]
}

/** 发送给 LLM 的标准消息形状 */
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ChatMessagePart[]
}

/** 检测消息内容是否包含图片（多模态数组格式） */
export function hasImageInContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  return (content as ChatMessagePart[]).some(
    part => part.type === 'image_url' && part.image_url?.url
  )
}

/** 检测消息列表中是否包含任何图片消息 */
export function hasImageInMessages(messages: AnyMessage[]): boolean {
  return messages.some(m => hasImageInContent(m.content))
}

/** 从多模态消息内容中提取纯文本 */
export function extractTextFromContent(content: string | ChatMessagePart[]): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as ChatMessagePart[])
    .filter(part => part.type === 'text' && part.text)
    .map(part => part.text!)
    .join(' ')
}

/**
 * 根据消息内容选择合适的模型 key
 * - 含图片消息且显式配置了 visionModel 时切换到视觉模型
 * - 否则使用 defaultModelKey（大多数现代模型原生支持多模态）
 */
export function resolveModelKey(
  messages: AnyMessage[],
  defaultModelKey: string,
  visionModel?: string
): string {
  if (hasImageInMessages(messages)) {
    if (visionModel) {
      console.log(`[multimodal] Multimodal detected — using configured vision model: ${visionModel}`)
      return visionModel
    }
    console.log(`[multimodal] Multimodal detected — using default model (native vision support assumed)`)
  }
  return defaultModelKey
}

/**
 * 构建发送给 LLM 的消息列表，避免连续两条 user 消息。
 *
 * 当 historyMessages 末尾已经是 user 消息时，将追加的 prompt 合并进去，
 * 而不是创建新的 user 消息。这对于多模态消息尤其重要 ——
 * 部分模型在遇到连续两条 user 消息时会忽略前一条中的图片。
 */
export function buildLLMMessages<T extends AnyMessage>(
  systemPrompt: string,
  historyMessages: T[],
  appendUserPrompt: string
): T[] {
  const messages: T[] = []

  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt } as T)
  }

  // 检查最后一条消息是否是 user
  const lastIdx = historyMessages.length - 1
  const lastMsg = historyMessages[lastIdx]

  if (lastMsg && lastMsg.role === 'user' && appendUserPrompt) {
    // 合并 prompt 到最后一条 user 消息
    for (let i = 0; i < lastIdx; i++) {
      messages.push(historyMessages[i])
    }

    if (typeof lastMsg.content === 'string') {
      // 纯文本：直接拼接
      messages.push({
        ...lastMsg,
        content: lastMsg.content + '\n\n' + appendUserPrompt
      })
    } else {
      // 多模态：在数组末尾追加 text part
      const parts = [...(lastMsg.content as ChatMessagePart[])]
      parts.push({ type: 'text', text: appendUserPrompt })
      messages.push({
        ...lastMsg,
        content: parts
      })
    }
  } else {
    // 末尾不是 user 消息，或者没有追加 prompt，直接展开
    for (const msg of historyMessages) {
      messages.push(msg)
    }
    if (appendUserPrompt) {
      messages.push({ role: 'user', content: appendUserPrompt } as T)
    }
  }

  return messages
}
