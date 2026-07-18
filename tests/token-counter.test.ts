import { describe, it, expect } from 'vitest'
import {
  countTextTokens,
  countMessageTokens,
  countMessagesTokens,
  fitMessagesToBudget
} from '../agent/utils/token-counter'

describe('countTextTokens', () => {
  it('空字符串返回 0', () => {
    expect(countTextTokens('')).toBe(0)
  })

  it('纯 ASCII 文本按 ~0.25 token/字符估算', () => {
    // 40 个 ASCII 字符 → 10 token
    expect(countTextTokens('a'.repeat(40))).toBe(10)
  })

  it('CJK 文本按 ~0.7 token/字估算', () => {
    // 10 个汉字 → 7 token
    expect(countTextTokens('你好世界测试文本九十')).toBe(7)
  })

  it('中英文混合文本合理累计', () => {
    // 4 汉字 (2.8) + 8 ASCII (2) → ceil(4.8) = 5
    expect(countTextTokens('你好ab cd ef')).toBeGreaterThan(0)
    const mixed = countTextTokens('你好世界abcd')
    expect(mixed).toBe(Math.ceil(4 * 0.7 + 4 * 0.25))
  })

  it('多模态数组：文本部分计数，图片每张按 1000 计', () => {
    const parts = [
      { type: 'text', text: 'a'.repeat(40) },       // 10
      { type: 'image_url', image_url: { url: 'data:...' } }  // 1000
    ]
    expect(countTextTokens(parts as unknown as string)).toBe(1010)
  })

  it('非字符串非数组类型转为字符串计数', () => {
    expect(countTextTokens(12345 as unknown as string)).toBeGreaterThan(0)
  })
})

describe('countMessageTokens', () => {
  it('包含内容 token + 固定开销 + role token', () => {
    const result = countMessageTokens({ role: 'user', content: 'a'.repeat(40) })
    expect(result.contentTokens).toBe(10)
    // 开销 = 4 (MESSAGE_OVERHEAD) + role token 数
    expect(result.overheadTokens).toBe(4 + countTextTokens('user'))
    expect(result.total).toBe(result.contentTokens + result.overheadTokens)
  })
})

describe('countMessagesTokens', () => {
  it('空列表返回 0', () => {
    expect(countMessagesTokens([])).toBe(0)
  })

  it('总数 = 各消息 total 之和 + 对话级开销 3', () => {
    const messages = [
      { role: 'user' as const, content: 'a'.repeat(40) },
      { role: 'assistant' as const, content: 'b'.repeat(40) }
    ]
    const expected =
      3 +
      countMessageTokens(messages[0]).total +
      countMessageTokens(messages[1]).total
    expect(countMessagesTokens(messages)).toBe(expected)
  })
})

describe('fitMessagesToBudget', () => {
  it('预算充足时保留全部消息', () => {
    const messages = [
      { role: 'user' as const, content: 'a'.repeat(40) },
      { role: 'assistant' as const, content: 'b'.repeat(40) }
    ]
    expect(fitMessagesToBudget(messages, 100000)).toBe(2)
  })

  it('预算不足时从末尾保留最近的消息', () => {
    // 每条消息 ~14 token，预算只够 1 条
    const messages = [
      { role: 'user' as const, content: 'a'.repeat(40) },
      { role: 'user' as const, content: 'b'.repeat(40) },
      { role: 'user' as const, content: 'c'.repeat(40) }
    ]
    const oneMsgTokens = countMessageTokens(messages[0]).total
    const budget = 3 + oneMsgTokens + 1 // 对话开销 + 1 条消息 + 余量
    expect(fitMessagesToBudget(messages, budget)).toBe(1)
  })

  it('预算为 0 时一条都保留不了', () => {
    const messages = [{ role: 'user' as const, content: 'hello' }]
    expect(fitMessagesToBudget(messages, 0)).toBe(0)
  })
})
