import { describe, it, expect, beforeEach } from 'vitest'
import { ContextManager } from '../agent/core/context-manager'
import { countMessagesTokens } from '../agent/utils/token-counter'

/**
 * ContextManager 测试
 *
 * 注意：测试环境下 electron 被 mock，LLM 未配置，
 * 摘要器会自动走 rule 模式（不发起网络调用），恰好适合单元测试。
 */

function makeMessages(
  count: number,
  contentLen = 100
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (let i = 0; i < count; i++) {
    messages.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `消息${i} ` + '内容'.repeat(contentLen)
    })
  }
  return messages
}

describe('ContextManager', () => {
  beforeEach(() => {
    ContextManager.clearAllCache()
  })

  it('历史未超预算时不压缩，原样返回', async () => {
    const manager = new ContextManager({
      maxTokens: 32000,
      outputReserve: 4000,
      recentMessageWindow: 10,
      compressionThreshold: 16000
    })
    const history = makeMessages(4, 10)
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: '你是助手' },
      ...history
    ]

    const result = await manager.manage(messages, '新问题', 'session-1')

    expect(result.compressed).toBe(false)
    expect(result.messages[0].role).toBe('system')
    // 4 条历史 + 1 条 system + 1 条新 user 输入
    expect(result.messages.length).toBe(6)
    expect(result.messages[result.messages.length - 1]).toEqual({
      role: 'user',
      content: '新问题'
    })
  })

  it('末尾 user 消息已包含当前输入时不重复追加', async () => {
    const manager = new ContextManager({ maxTokens: 32000 })
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！' },
      { role: 'user', content: '继续刚才的话题' }
    ]

    const result = await manager.manage(messages, '继续刚才的话题', 'session-1')
    const userMessages = result.messages.filter(m => m.role === 'user')
    // 只有 2 条 user 消息（"你好" 和 "继续刚才的话题"），没有重复追加
    expect(userMessages.length).toBe(2)
  })

  it('历史超过压缩阈值时触发压缩并保留最近窗口', async () => {
    const manager = new ContextManager({
      maxTokens: 2000,
      outputReserve: 200,
      recentMessageWindow: 4,
      compressionThreshold: 500,  // 低阈值确保触发
      summaryMaxTokens: 200
    })
    const history = makeMessages(20, 50)
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: '你是助手' },
      ...history
    ]

    const result = await manager.manage(messages, '总结下', 'session-2')

    expect(result.compressed).toBe(true)
    expect(result.compressedMessageCount).toBeGreaterThan(0)
    // 压缩后应包含：system + 摘要(system) + 保留的最近消息（≤4）+ user 输入
    const systemMessages = result.messages.filter(m => m.role === 'system')
    expect(systemMessages.length).toBe(2)  // 原始 system + 摘要
    expect(String(systemMessages[1].content)).toContain('[对话摘要]')
  })

  it('压缩后的总 token 应在预算约束内收缩', async () => {
    const manager = new ContextManager({
      maxTokens: 1500,
      outputReserve: 200,
      recentMessageWindow: 6,
      compressionThreshold: 400,
      summaryMaxTokens: 150
    })
    const history = makeMessages(30, 50)
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: '你是助手' },
      ...history
    ]

    const result = await manager.manage(messages, '', 'session-3')
    const originalTokens = countMessagesTokens(history)

    expect(result.compressed).toBe(true)
    expect(result.breakdown.total).toBeLessThan(originalTokens)
  })

  it('同一会话的二次压缩复用增量缓存（summarizedUpTo 前进）', async () => {
    const manager = new ContextManager({
      maxTokens: 1200,
      outputReserve: 200,
      recentMessageWindow: 4,
      compressionThreshold: 300,
      summaryMaxTokens: 150
    })

    // 第一次压缩：20 条消息
    const history1 = makeMessages(20, 40)
    const result1 = await manager.manage(
      [{ role: 'system', content: 'sys' } as const, ...history1],
      '',
      'session-4'
    )
    expect(result1.compressed).toBe(true)
    const firstCompressedCount = result1.compressedMessageCount

    // 同会话再压一次（更多消息）
    const history2 = makeMessages(24, 40)
    const result2 = await manager.manage(
      [{ role: 'system', content: 'sys' } as const, ...history2],
      '',
      'session-4'
    )
    expect(result2.compressed).toBe(true)
    expect(result2.compressedMessageCount).toBeGreaterThanOrEqual(firstCompressedCount)
  })

  it('多模态消息（数组 content）在压缩路径不崩溃', async () => {
    const manager = new ContextManager({
      maxTokens: 800,
      outputReserve: 100,
      recentMessageWindow: 2,
      compressionThreshold: 200,
      summaryMaxTokens: 100
    })
    const messages = [
      { role: 'system' as const, content: 'sys' },
      ...makeMessages(10, 30),
      {
        role: 'user' as const,
        content: [
          { type: 'text', text: '看这张图' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,xx' } }
        ]
      }
    ]

    const result = await manager.manage(messages, '', 'session-5')
    expect(result.compressed).toBe(true)
  })

  it('clearCache 后同会话重新全量摘要', async () => {
    const manager = new ContextManager({
      maxTokens: 1200,
      outputReserve: 200,
      recentMessageWindow: 4,
      compressionThreshold: 300,
      summaryMaxTokens: 150
    })
    const history = makeMessages(20, 40)
    const msgs = [{ role: 'system' as const, content: 'sys' }, ...history]

    await manager.manage(msgs, '', 'session-6')
    ContextManager.clearCache('session-6')
    const result = await manager.manage(msgs, '', 'session-6')
    expect(result.compressed).toBe(true)
  })
})
