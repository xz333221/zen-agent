/**
 * AgentRunner — Agent 执行的生命周期服务
 *
 * 目的:
 * 把 Agent 的创建、回调装配、中止信号、错误分类从 IPC handler 中抽出来，
 * 形成一层薄薄的"执行边界"。IPC handler 只负责:
 *   1. DB 准备（会话/历史/持久化）
 *   2. 构造 AgentEventSink（把事件转发到渲染进程）
 *   3. 调用 runner.run()
 *
 * 为什么不直接在 handler 里 new AgentLoop:
 * - handler 里 20+ 行回调装配与 webContents 紧耦合，无法复用、无法测试
 * - 错误分类、abort、partial-response 收集散落各处
 * - 这层边界是"把 Agent 移出主进程"的接缝: 未来把 run() 换成
 *   "在 worker_threads 中执行并通过 MessagePort 转发事件"时，
 *   IPC handler 与 AgentEventSink 都不用改 —— 只需替换 Runner 实现。
 *
 * 不依赖 electron，可被 worker 或测试直接复用。
 */

import { AgentLoop, createAgentContext } from '@agent/core/agent-loop'
import type { AgentContext, AgentResult } from '@agent/core/types'
import type { TraceStep, ExecutionTrace } from '@shared/types'

/** Agent 向外发射的事件汇 —— 渲染进程适配器实现此接口 */
export interface AgentEventSink {
  onChunk?(delta: string): void
  onStepStart?(step: TraceStep): void
  onStepComplete?(step: TraceStep): void
  onTraceComplete?(trace: ExecutionTrace): void
  onStateChange?(state: string): void
  onError?(error: Error): void
}

/** 一次 Agent 运行的输入 */
export interface AgentRunInput {
  /** 用户原始输入文本 */
  message: string
  /** 会话 ID */
  sessionId: string
  /** 已构造好的消息序列（system prompt + 历史 + 当前用户消息，含多模态） */
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: unknown }>
  /** Agent 上下文设置 */
  settings: {
    maxTokens: number
    outputReserve: number
    recentMessageWindow: number
    compressionThreshold: number
    maxMemoriesRetrieved: number
    maxSkillsLoaded: number
  }
}

/** 一次 Agent 运行的输出 */
export interface AgentRunOutput {
  result: AgentResult
  /** 累计的完整响应文本（用于中止时保存部分回复） */
  fullResponse: string
}

/**
 * 错误分类 — 从 IPC handler 迁入，集中于一处便于复用/测试。
 */
export function classifyAgentError(error: Error): {
  type: 'network' | 'auth' | 'rate_limit' | 'aborted' | 'timeout' | 'unknown'
  userMessage: string
} {
  const msg = (error?.message || String(error ?? '')).toLowerCase()

  // 先检查超时 —— 超时 abort 会让 SDK 报 "aborted"，但根因是超时，必须优先
  if (msg.includes('timed out') || msg.includes('timeout')) {
    return { type: 'timeout', userMessage: '请求超时，请稍后重试或检查网络连接' }
  }

  if (msg === 'aborted' || msg.includes('user abort') || msg.includes('request was aborted')) {
    if (msg.includes('timed out') || msg.includes('timeout')) {
      return { type: 'timeout', userMessage: '请求超时，请稍后重试或检查网络连接' }
    }
    return { type: 'aborted', userMessage: '已停止生成' }
  }

  if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('invalid api key')) {
    return { type: 'auth', userMessage: 'API Key 无效，请在设置中检查配置' }
  }

  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')) {
    return { type: 'rate_limit', userMessage: '请求过于频繁，请稍后重试' }
  }

  if (msg.includes('econnrefused') || msg.includes('enetunreach') || msg.includes('fetch failed')) {
    return { type: 'network', userMessage: '无法连接到 API 服务器，请检查网络或 baseURL 配置' }
  }

  return { type: 'unknown', userMessage: `发生错误: ${error?.message || String(error ?? '未知错误')}` }
}

/**
 * AgentRunner —— 拥有 AgentLoop 生命周期。
 *
 * 单实例即可（非必须），持有一个可中止的当前运行。
 */
export class AgentRunner {
  /** 当前运行的中止控制器（null 表示无运行） */
  private currentAbort: AbortController | null = null
  /** 最近一次运行累计的完整响应文本（运行结束后仍保留，供中止时读取部分回复） */
  private lastFullResponse = ''

  /** 是否有运行中 */
  get isRunning(): boolean {
    return this.currentAbort !== null
  }

  /** 最近一次运行累计的响应文本（含被中止的部分） */
  get partialResponse(): string {
    return this.lastFullResponse
  }

  /** 中止当前运行 */
  abort(): void {
    if (this.currentAbort) {
      this.currentAbort.abort()
      this.currentAbort = null
    }
  }

  /**
   * 执行一次 Agent 循环。
   *
   * @throws 当 Agent 抛出错误时原样向上抛（由调用方决定如何分类/展示）
   */
  async run(input: AgentRunInput, sink: AgentEventSink): Promise<AgentRunOutput> {
    this.currentAbort = new AbortController()
    this.lastFullResponse = ''

    let fullResponse = ''

    const agentContext: AgentContext = createAgentContext(
      input.sessionId,
      // AgentContext 的 messages 类型要求 content: string；多模态内容在
      // IPC handler 已把最后一条 user 消息替换为 parts 数组，这里透传。
      input.messages as AgentContext['messages'],
      input.settings
    )
    agentContext.signal = this.currentAbort.signal

    const agent = new AgentLoop({
      onChunk: (delta: string) => {
        fullResponse += delta
        this.lastFullResponse = fullResponse
        sink.onChunk?.(delta)
      },
      onStepStart: (step: TraceStep) => sink.onStepStart?.(step),
      onStepComplete: (step: TraceStep) => sink.onStepComplete?.(step),
      onTraceComplete: (trace: ExecutionTrace) => sink.onTraceComplete?.(trace),
      onStateChange: (state: string) => sink.onStateChange?.(state),
      onError: (error: Error) => sink.onError?.(error)
    })

    try {
      const result = await agent.run(input.message, agentContext)
      this.lastFullResponse = fullResponse
      return { result, fullResponse }
    } finally {
      this.currentAbort = null
    }
  }
}
