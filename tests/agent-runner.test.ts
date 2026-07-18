/**
 * AgentRunner 单元测试
 *
 * 覆盖 classifyAgentError（纯函数）与 AgentRunner 的中止/部分回复语义。
 * 这是"把 Agent 移出主进程"接缝的回归保护。
 */

import { describe, it, expect } from 'vitest'
import { classifyAgentError, AgentRunner } from '../src/main/agent-runner'

describe('classifyAgentError', () => {
  it('识别超时（优先于 abort）', () => {
    const info = classifyAgentError(new Error('Request timed out after 30000ms'))
    expect(info.type).toBe('timeout')
  })

  it('识别纯用户中止', () => {
    const info = classifyAgentError(new Error('aborted'))
    expect(info.type).toBe('aborted')
  })

  it('识别 401 鉴权错误', () => {
    const info = classifyAgentError(new Error('401 Unauthorized'))
    expect(info.type).toBe('auth')
  })

  it('识别 429 限流', () => {
    const info = classifyAgentError(new Error('429 Too Many Requests'))
    expect(info.type).toBe('rate_limit')
  })

  it('识别网络错误', () => {
    const info = classifyAgentError(new Error('fetch failed, ECONNREFUSED'))
    expect(info.type).toBe('network')
  })

  it('其余归为 unknown 且带原始消息', () => {
    const info = classifyAgentError(new Error('something weird'))
    expect(info.type).toBe('unknown')
    expect(info.userMessage).toContain('something weird')
  })
})

describe('AgentRunner', () => {
  it('无运行时 abort() 是 no-op', () => {
    const runner = new AgentRunner()
    expect(runner.isRunning).toBe(false)
    expect(() => runner.abort()).not.toThrow()
    expect(runner.isRunning).toBe(false)
  })

  it('初始 partialResponse 为空字符串', () => {
    const runner = new AgentRunner()
    expect(runner.partialResponse).toBe('')
  })
})
