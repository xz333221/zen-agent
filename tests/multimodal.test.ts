import { describe, it, expect } from 'vitest'
import {
  hasImageInContent,
  hasImageInMessages,
  extractTextFromContent,
  resolveModelKey,
  buildLLMMessages,
  type LLMMessage
} from '../agent/utils/multimodal'

describe('hasImageInContent / hasImageInMessages', () => {
  it('字符串内容不含图片', () => {
    expect(hasImageInContent('纯文本')).toBe(false)
  })

  it('含 image_url part 时检测到图片', () => {
    const content = [
      { type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } }
    ]
    expect(hasImageInContent(content)).toBe(true)
    expect(hasImageInMessages([{ role: 'user', content } as LLMMessage])).toBe(true)
  })

  it('image_url 无 url 时不算图片', () => {
    expect(hasImageInContent([{ type: 'image_url' }])).toBe(false)
  })
})

describe('extractTextFromContent', () => {
  it('字符串原样返回', () => {
    expect(extractTextFromContent('hello')).toBe('hello')
  })

  it('数组内容拼接 text parts，忽略图片', () => {
    const content = [
      { type: 'text', text: '第一段' },
      { type: 'image_url', image_url: { url: 'data:x' } },
      { type: 'text', text: '第二段' }
    ]
    expect(extractTextFromContent(content as never)).toBe('第一段 第二段')
  })

  it('非数组非字符串返回空', () => {
    expect(extractTextFromContent(null as never)).toBe('')
  })
})

describe('resolveModelKey', () => {
  it('无图片时使用默认模型', () => {
    const msgs = [{ role: 'user', content: '文本' } as LLMMessage]
    expect(resolveModelKey(msgs, 'p::default', 'p::vision')).toBe('p::default')
  })

  it('有图片且配置了 visionModel 时切换', () => {
    const msgs = [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:x' } }]
    } as LLMMessage]
    expect(resolveModelKey(msgs, 'p::default', 'p::vision')).toBe('p::vision')
  })

  it('有图片但未配置 visionModel 时保持默认', () => {
    const msgs = [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:x' } }]
    } as LLMMessage]
    expect(resolveModelKey(msgs, 'p::default', undefined)).toBe('p::default')
  })
})

describe('buildLLMMessages', () => {
  it('末尾非 user 消息时直接追加新 user 消息', () => {
    const history: LLMMessage[] = [
      { role: 'user', content: '问题1' },
      { role: 'assistant', content: '回答1' }
    ]
    const result = buildLLMMessages('系统提示', history, '问题2')
    expect(result.length).toBe(4)
    expect(result[0]).toEqual({ role: 'system', content: '系统提示' })
    expect(result[3]).toEqual({ role: 'user', content: '问题2' })
  })

  it('末尾是 user 消息时合并 prompt（纯文本拼接）', () => {
    const history: LLMMessage[] = [
      { role: 'user', content: '带图问题' }
    ]
    const result = buildLLMMessages('sys', history, '补充说明')
    expect(result.length).toBe(2)
    expect(result[1].content).toBe('带图问题\n\n补充说明')
  })

  it('末尾是多模态 user 消息时追加 text part（不产生连续 user 消息）', () => {
    const history: LLMMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '看这张图' },
          { type: 'image_url', image_url: { url: 'data:x' } }
        ]
      }
    ]
    const result = buildLLMMessages('sys', history, '补充prompt')
    expect(result.length).toBe(2)
    const parts = result[1].content as Array<{ type: string; text?: string }>
    expect(parts.length).toBe(3)
    expect(parts[2]).toEqual({ type: 'text', text: '补充prompt' })
  })

  it('无系统提示时不添加 system 消息', () => {
    const result = buildLLMMessages('', [{ role: 'assistant', content: 'a' }], 'q')
    expect(result[0].role).toBe('assistant')
  })

  it('不修改原始历史消息对象（不可变性）', () => {
    const original: LLMMessage = { role: 'user', content: '原始' }
    const history: LLMMessage[] = [original]
    buildLLMMessages('sys', history, '追加')
    expect(original.content).toBe('原始')
  })
})
