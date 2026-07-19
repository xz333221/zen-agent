/**
 * ReAct 循环 — Think → Act → Observe 推理执行器
 *
 * 从原 agent-loop.ts 的 runReActLoop 迁出:
 * - 实例状态（nudge 计数器、工具评估）收敛到 NudgeEngine 和本类字段
 * - 追踪记录通过 ctx.trace（TraceRecorder）
 * - LLM 调用通过 ctx.services.llm
 */

import { isLLMConfigured, getConfig } from '../../../providers/llm-config'
import { executeAction, getToolNames, getToolDefs, toActDetail } from '../../action-executor'
import { countTextTokens } from '../../../utils/token-counter'
import {
  hasImageInMessages,
  resolveModelKey,
  buildLLMMessages,
  type LLMMessage
} from '../../../utils/multimodal'
import type { ReActStep } from '../../types'
import type { ObserveDetail, ThinkDetail } from '../../../../src/shared/types'
import type { PipelineContext } from '../context'
import { parseReActResponse, parseToolParams } from './react-parser'
import type { ParsedReActResponse } from './react-parser'
import type { ChatToolCall } from '../../../providers/types'
import { buildReActSystemPrompt, buildThinkPrompt } from './prompts'
import { shouldUseTool, assessToolNeed, EMPTY_ASSESSMENT, type ToolAssessment } from './tool-assessor'
import { NudgeEngine, type NudgeFired } from './nudge-engine'
import { buildObservationText } from './observation'

const MAX_ITERATIONS = 50  // 最大循环次数（大模型上下文充足，放宽限制）

/** 将文本分割为块（模拟流式输出） */
function splitIntoChunks(text: string, size: number): string[] {
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size))
  }
  return chunks
}

/** 循环耗尽时的响应 */
function getLoopExhaustedResponse(userInput: string, steps: ReActStep[]): string {
  return `我在处理"${userInput.slice(0, 50)}"时经过了 ${steps.length} 步推理，但未能得出完整结论。\n\n已完成的推理步骤:\n${steps.map((s, i) => `${i + 1}. ${s.think.slice(0, 100)}`).join('\n')}`
}

export interface ReActLoopResult {
  output: string
  llmCalls: number
}

/** 将工具定义转为 OpenAI 兼容的 tools 格式 */
function buildOpenAITools(toolDefs: ReturnType<typeof getToolDefs>) {
  return toolDefs.map(d => ({
    type: 'function' as const,
    function: {
      name: d.id,
      description: d.description,
      parameters: d.schema as unknown as Record<string, unknown>
    }
  }))
}

export class ReActLoop {
  private nudges = new NudgeEngine()
  /** 工具需求评估结果（在循环前通过 LLM 评估，供 nudge 和 Think prompt 使用） */
  private toolAssessment: ToolAssessment = { ...EMPTY_ASSESSMENT }

  constructor(private ctx: PipelineContext) {}

  /**
   * 执行 ReAct 循环
   * 对于简单问题，直接流式输出回答
   * 对于复杂问题，使用 Think-Act-Observe 循环
   */
  async run(
    reactSteps: ReActStep[],
    complexity: 'low' | 'medium' | 'high'
  ): Promise<ReActLoopResult> {
    const { userInput } = this.ctx
    const config = getConfig()
    const toolNames = getToolNames()
    let llmCalls = 0

    // 构建系统提示词
    const systemPrompt = buildReActSystemPrompt(toolNames)

    // 使用上下文管理器处理后的消息（含摘要压缩）
    // managedContext 已在 context 阶段生成
    const managedMessages = this.ctx.managedContext?.messages ?? this.ctx.agentContext.messages

    // 分离系统提示和历史消息（managedMessages 中第一条是 system prompt）
    const systemMsg = managedMessages[0]?.role === 'system' ? managedMessages[0] : null
    const historyMessages = systemMsg
      ? managedMessages.slice(1)
      : managedMessages

    // 用增强后的系统提示词替换（包含 ReAct 指令）
    const finalSystemPrompt = systemMsg
      ? systemPrompt  // 使用 ReAct 增强版系统提示词
      : systemPrompt

    // 对于简单问题，直接流式输出（跳过 ReAct 循环）
    if (complexity === 'low' && toolNames.length === 0) {
      llmCalls++
      return this.runSimplePath(historyMessages, finalSystemPrompt, config, llmCalls)
    }

    // 复杂问题：使用 ReAct 循环
    let isComplete = false
    let finalOutput = ''

    // ── 工具需求评估（LLM 驱动，替代关键词匹配）──
    // 先用 shouldUseTool 快速预筛：关键词命中则跳过 LLM 评估（节省 API 调用）
    // 关键词未命中时，用 LLM 做语义级判断
    if (toolNames.length > 0) {
      const fastCheck = shouldUseTool(userInput, toolNames, historyMessages)
      if (fastCheck) {
        this.toolAssessment = { needsTool: true, suggestedTools: [], reason: '关键词快速匹配命中' }
        console.log('[ReAct] Tool assessment: fast-path match (skipped LLM call)')
      } else {
        console.log('[ReAct] Tool assessment: running LLM-based assessment...')
        const tAssess = Date.now()
        this.toolAssessment = await assessToolNeed(this.ctx, userInput, getToolDefs(), historyMessages)
        llmCalls++
        console.log(`[ReAct] Tool assessment ✓ ${Date.now() - tAssess}ms — needsTool=${this.toolAssessment.needsTool}`)
      }
    }

    console.log(`[ReAct] Loop starting — complexity=${complexity}, maxIterations=${MAX_ITERATIONS}, tools=[${toolNames.join(', ')}]`)

    // ── 原生 function calling 工具定义（循环外构建一次，run 内工具集不变）──
    const openaiTools = toolNames.length > 0
      ? buildOpenAITools(getToolDefs())
      : undefined

    for (let i = 0; i < MAX_ITERATIONS && !isComplete; i++) {
      if (this.ctx.signal?.aborted) {
        console.warn('[ReAct] Loop aborted by signal')
        throw new Error('aborted')
      }

      // ── Think 步骤 ──
      this.ctx.callbacks.onStateChange?.('thinking')

      // 首轮含图片时发送提示
      if (i === 0 && hasImageInMessages(historyMessages)) {
        this.ctx.callbacks.onChunk?.('正在分析图片...\n\n')
      }

      const thinkPrompt = buildThinkPrompt(userInput, reactSteps, toolNames, this.toolAssessment)
      llmCalls++
      // 多模态检测：含图片时切换到视觉模型
      const reactModelKey = resolveModelKey(historyMessages, config.defaultModelKey, config.agent.visionModel)
      this.ctx.trace.modelsUsed.add(reactModelKey)

      console.log(`[ReAct] Iteration ${i + 1}/${MAX_ITERATIONS} — Think step starting...`)
      const thinkStart = Date.now()

      // ── 优先使用原生 function calling ──
      // 如果模型支持 tool_calls，直接走原生路径，避免文本 ReAct 解析；
      // 已确认不支持的模型直接走文本协议，不再每轮白调一次
      let thinkResponse = ''
      let nativeToolCalls: ChatToolCall[] | undefined
      const canUseNativeTools = openaiTools
        && !this.ctx.services.llm.isToolsUnsupported(reactModelKey)

      if (canUseNativeTools) {
        // 尝试原生 function calling
        try {
          const toolResponse = await this.ctx.services.llm.chatWithTools({
            messages: buildLLMMessages(finalSystemPrompt, historyMessages, thinkPrompt),
            modelKey: reactModelKey,
            temperature: 0.3,
            maxTokens: Math.min(config.agent.outputReserve * 2, 8000),
            signal: this.ctx.signal,
            timeoutMs: 120 * 1000,
            tools: openaiTools,
            toolChoice: 'auto'
          })
          thinkResponse = toolResponse.content
          nativeToolCalls = toolResponse.toolCalls
        } catch (err) {
          // 原生 function calling 失败（模型不支持或 API 报错），fallback 到文本 ReAct
          console.warn(`[ReAct] Iteration ${i + 1} — native function calling failed, falling back to text ReAct:`, (err as Error)?.message)
          thinkResponse = await this.ctx.services.llm.chat({
            messages: buildLLMMessages(finalSystemPrompt, historyMessages, thinkPrompt),
            modelKey: reactModelKey,
            temperature: 0.3,
            maxTokens: Math.min(config.agent.outputReserve * 2, 8000),
            signal: this.ctx.signal,
            timeoutMs: 120 * 1000
          })
        }
      } else {
        // 无工具或简单问题，走普通 chat
        thinkResponse = await this.ctx.services.llm.chat({
          messages: buildLLMMessages(finalSystemPrompt, historyMessages, thinkPrompt),
          modelKey: reactModelKey,
          temperature: 0.3,
          maxTokens: Math.min(config.agent.outputReserve * 2, 8000),
          signal: this.ctx.signal,
          timeoutMs: 120 * 1000
        })
      }

      const thinkElapsed = Date.now() - thinkStart
      this.ctx.trace.totalInputTokens += countTextTokens(finalSystemPrompt) + countTextTokens(thinkPrompt)
      this.ctx.trace.totalOutputTokens += countTextTokens(thinkResponse)

      // ── 解析响应 ──
      // 优先用原生 tool_calls，没有则 fallback 到文本 ReAct 解析
      let parsed: ParsedReActResponse
      // 待执行的工具调用队列（native 路径可能有多个并行 call；文本路径最多一个）
      let pendingToolCalls: Array<{ action: string; actionInput: string; id?: string }> = []

      if (nativeToolCalls && nativeToolCalls.length > 0) {
        // 模型返回了原生 tool_calls：parsed 记录第一个（供 nudge/日志），
        // 全部 call 进入队列顺序执行
        const first = nativeToolCalls[0]
        parsed = {
          thought: thinkResponse.slice(0, 500),
          action: first.name,
          actionInput: first.arguments,
          content: '',
          hasAction: true,
          hasContent: false
        }
        pendingToolCalls = nativeToolCalls.map(tc => ({
          action: tc.name,
          actionInput: tc.arguments,
          id: tc.id
        }))
        console.log(`[ReAct] Iteration ${i + 1} — native tool_calls: ${nativeToolCalls.length} call(s) [${nativeToolCalls.map(t => t.name).join(', ')}], firstArgs=${first.arguments.slice(0, 100)}`)
      } else if (!thinkResponse) {
        // 原生路径返回空内容且无 tool_calls（模型可能直接返回了 finish_reason=stop）
        parsed = {
          thought: '',
          action: 'FINAL_ANSWER',
          actionInput: '',
          content: '',
          hasAction: false,
          hasContent: false
        }
      } else {
        // 文本 ReAct 解析（fallback）
        parsed = parseReActResponse(thinkResponse)
      }
      console.log(`[ReAct] Iteration ${i + 1} — Think ✓ ${thinkElapsed}ms, action=${parsed.action}, response=${thinkResponse.length}chars`)

      // 创建 Think 步骤（nudge 触发时会重命名该步骤）
      const thinkStep = this.recordThinkStep(
        parsed.thought,
        parsed.action,
        toolNames.length > 0 ? toolNames : undefined
      )

      const nudgeInput = {
        parsed,
        reactSteps,
        iteration: i,
        maxIterations: MAX_ITERATIONS,
        thinkResponse,
        toolAssessment: this.toolAssessment,
        toolNames,
        historyMessages
      }

      // ── 纠偏机制 7：模型只输出 THOUGHT 没有 ACTION（格式不完整）──
      const nudge7 = this.nudges.checkIncompleteFormat(nudgeInput)
      if (nudge7) {
        this.applyNudge(nudge7, thinkStep, reactSteps, parsed.thought, i)
        continue
      }

      // 检查是否完成
      if (parsed.action === 'FINAL_ANSWER' || parsed.action === 'DIRECT_ANSWER') {
        // ── 纠偏机制 1-6（按优先级顺序检查）──
        const nudge = this.nudges.checkFinalAnswer(nudgeInput)
        if (nudge) {
          this.applyNudge(nudge, thinkStep, reactSteps, parsed.thought, i)
          continue
        }

        finalOutput = parsed.actionInput || parsed.content || ''
        // 防御：如果 parsed 字段都为空，但 thinkResponse 有内容
        if (!finalOutput && thinkResponse) {
          // 检查 thinkResponse 是否只是原始格式标记（THOUGHT/ACTION/CONTENT）而非实际回答
          // 如果已用过工具但模型没给 CONTENT，thinkResponse 会是原始 LLM 响应（含标记）
          // 这种情况不能直接输出原始响应给用户，需要提取有用信息或提示
          const hasExecutedToolsFinal = reactSteps.some(s => s.action !== 'FINAL_ANSWER' && s.action !== 'DIRECT_ANSWER')
          const looksLikeRawReAct = /THOUGHT:|ACTION:|ACTION_INPUT:|CONTENT:/i.test(thinkResponse)

          if (hasExecutedToolsFinal && looksLikeRawReAct && this.nudges.isExhausted('nudge6')) {
            // nudge6 已用完，模型还是不给 CONTENT — 生成一个基于已有工具结果的兜底回答
            console.warn(`[ReAct] Iteration ${i + 1} — FINAL_ANSWER still empty after nudge6 exhausted. Generating fallback from tool results.`)

            // 从已有的工具结果中提取信息，构建一个兜底回答
            const toolOutputs: string[] = []
            for (const step of reactSteps) {
              if (step.action !== 'FINAL_ANSWER' && step.action !== 'DIRECT_ANSWER' && step.observation) {
                toolOutputs.push(`[${step.action}] ${step.observation.slice(0, 500)}`)
              }
            }
            if (toolOutputs.length > 0) {
              finalOutput = `抱歉，我在处理过程中遇到了一些问题。以下是我已获取的信息：\n\n${toolOutputs.join('\n\n')}\n\n如需更多帮助，请告诉我具体想了解什么。`
            } else {
              finalOutput = '抱歉，我在处理你的问题时遇到了困难，未能生成完整的回答。请尝试重新提问或换一种问法。'
            }
          } else {
            finalOutput = thinkResponse
          }
        }
        // 最终兜底：如果连 thinkResponse 都为空，给出提示而非空白
        if (!finalOutput) {
          finalOutput = '（模型返回了空响应，请重试或换一个问题）'
          console.warn(`[ReAct] Iteration ${i + 1} — FINAL_ANSWER but all fields empty! thinkResponse.len=${thinkResponse.length}, parsed=`, JSON.stringify(parsed).slice(0, 200))
        }
        console.log(`[ReAct] Iteration ${i + 1} — FINAL_ANSWER, output=${finalOutput.length}chars`)

        // 流式输出最终回答
        await this.streamToUser(finalOutput)

        reactSteps.push({
          think: parsed.thought,
          action: 'FINAL_ANSWER',
          actionInput: {},
          observation: finalOutput
        })

        isComplete = true
        break
      }

      // ── Act 步骤（工具调用，可能多个） ──
      this.ctx.callbacks.onStateChange?.('working')

      // 文本 ReAct 路径：单个 action 入队
      if (pendingToolCalls.length === 0 && parsed.action && toolNames.includes(parsed.action)) {
        pendingToolCalls = [{ action: parsed.action, actionInput: parsed.actionInput }]
      }

      // ── 未知工具名防线 ──
      // 模型明确想调工具（hasAction）但名字不存在：纠偏重试，
      // 而不是把 thought 当作最终回答输出并结束（对编码任务是灾难）。
      if (pendingToolCalls.length === 0 && parsed.hasAction && parsed.action && toolNames.length > 0) {
        const nudge10 = this.nudges.checkUnknownTool(parsed.action, i, MAX_ITERATIONS, toolNames)
        if (nudge10) {
          this.applyNudge(nudge10, thinkStep, reactSteps, parsed.thought, i)
          continue
        }
        // 超过纠偏上限后落到原逻辑（当作最终回答），避免死循环
      }

      if (pendingToolCalls.length > 0) {
        const batchStartStepCount = reactSteps.length
        let anyFailed = false

        for (let idx = 0; idx < pendingToolCalls.length; idx++) {
          const call = pendingToolCalls[idx]
          console.log(`[ReAct] Iteration ${i + 1} — executing tool ${idx + 1}/${pendingToolCalls.length}: ${call.action}`)
          // native 的 arguments 也可能截断/损坏，统一过 parseToolParams 做 salvage
          const toolParams = parseToolParams(call.actionInput, call.action)

          const toolCall = {
            id: call.id || `call-${Date.now()}-${idx}`,
            toolId: call.action,
            parameters: toolParams
          }

          const toolStart = Date.now()
          const toolResult = await executeAction(toolCall, this.ctx.signal)
          console.log(`[ReAct] Iteration ${i + 1} — tool ${call.action} ✓ ${Date.now() - toolStart}ms, success=${toolResult.success}`)

          // 创建 Act 步骤
          this.recordActStep(call.action, toolParams, toolResult)

          // 构建详细的观察结果（包含实际输出内容，供 LLM 后续推理使用）
          const observationText = buildObservationText(toolResult)

          // 创建 Observe 步骤
          const observeDetail: ObserveDetail = {
            type: 'observe',
            analysis: toolResult.success
              ? `工具 ${call.action} 执行成功: ${toolResult.resultSummary}`
              : `工具 ${call.action} 执行失败: ${toolResult.error || toolResult.resultSummary}`,
            isComplete: false,
            remainingSteps: []
          }
          this.ctx.trace.recordStep('observe', `Observe #${i + 1}`, '👁', observeDetail)

          if (!toolResult.success) anyFailed = true

          reactSteps.push({
            // thought 只挂在第一个 step 上，避免 buildThinkPrompt 重复打印 N 次
            think: idx === 0 ? parsed.thought : '',
            action: call.action,
            actionInput: toolParams,
            observation: observationText
          })
        }

        // ── 纠偏机制 8：整批执行完后检查是否有参数名错误 ──
        if (anyFailed) {
          const nudge8 = this.nudges.checkWrongParams(nudgeInput, reactSteps.slice(batchStartStepCount))
          if (nudge8) {
            this.applyNudge(nudge8, thinkStep, reactSteps, parsed.thought, i)
            continue
          }
        }
      } else {
        // 未知动作，当作最终回答
        finalOutput = parsed.content || parsed.thought || thinkResponse || ''
        if (!finalOutput) {
          finalOutput = '（模型返回了无法解析的响应，请重试）'
          console.warn(`[ReAct] Iteration ${i + 1} — unknown action "${parsed.action}", all fields empty!`)
        }
        console.log(`[ReAct] Iteration ${i + 1} — unknown action "${parsed.action}", treating as final answer, output=${finalOutput.length}chars`)
        if (finalOutput) {
          await this.streamToUser(finalOutput)
        }

        reactSteps.push({
          think: parsed.thought,
          action: 'FINAL_ANSWER',
          actionInput: {},
          observation: finalOutput
        })

        isComplete = true
        break
      }
    }

    // 如果循环结束仍未完成，生成一个总结
    if (!isComplete) {
      console.warn(`[ReAct] Loop exhausted after ${MAX_ITERATIONS} iterations without completion`)
      finalOutput = getLoopExhaustedResponse(userInput, reactSteps)
      this.ctx.callbacks.onChunk?.(finalOutput)
    }

    return { output: finalOutput, llmCalls }
  }

  /**
   * 简单问题的直接流式回答路径（complexity=low 且无工具）
   */
  private async runSimplePath(
    historyMessages: LLMMessage[],
    finalSystemPrompt: string,
    config: ReturnType<typeof getConfig>,
    llmCalls: number
  ): Promise<ReActLoopResult> {
    const { userInput } = this.ctx

    // 多模态检测
    const hasImage = hasImageInMessages(historyMessages)
    console.log(`[ReAct] Simple path: complexity=low, tools=0, hasImage=${hasImage}, historyMsgs=${historyMessages.length}`)
    const effectiveModelKey = resolveModelKey(historyMessages, config.defaultModelKey, config.agent.visionModel)
    this.ctx.trace.modelsUsed.add(effectiveModelKey)

    // 构建消息列表：避免连续两条 user 消息（会导致部分模型忽略图片）
    const simpleMessages = buildLLMMessages(finalSystemPrompt, historyMessages, userInput)
    console.log(`[ReAct] simpleMessages built: ${simpleMessages.length} msgs, model=${effectiveModelKey}`)

    // 如果含图片，先发送“正在分析图片...”提示，避免用户以为卡住
    if (hasImage) {
      this.ctx.callbacks.onChunk?.('正在分析图片...\n\n')
    }

    let output = ''
    console.log(`[ReAct] Calling chatStream: model=${effectiveModelKey}, msgCount=${simpleMessages.length}, timeout=8min`)
    const streamResult = await this.ctx.services.llm.chatStream(
      {
        messages: simpleMessages,
        modelKey: effectiveModelKey,
        temperature: 0.7,
        maxTokens: config.agent.outputReserve,
        signal: this.ctx.signal,
        timeoutMs: 8 * 60 * 1000
      },
      {
        onChunk: (delta: string) => {
          output += delta
          this.ctx.callbacks.onChunk?.(delta)
        },
        onDone: () => {
          console.log(`[ReAct] chatStream onDone: output length=${output.length}`)
          this.ctx.trace.totalOutputTokens += countTextTokens(output)
        },
        onError: (error: Error) => {
          console.error(`[ReAct] chatStream onError: ${error.message}`)
          throw error
        }
      }
    )
    console.log(`[ReAct] chatStream returned: streamResult=${streamResult?.length || 0} chars, output=${output.length} chars`)
    this.ctx.trace.totalInputTokens += countTextTokens(finalSystemPrompt) + countTextTokens(userInput)

    // 关键修复：如果流式过程中未输出任何内容（可能因为内容被 <think> 标签包裹，
    // ThinkFilter 过滤掉了所有 chunk），使用 chatStream 返回的完整结果作为 fallback
    if (!output && streamResult) {
      console.warn(`[ReAct] Stream produced 0 chunks but streamResult has ${streamResult.length} chars — likely all content was inside <think> tags. Using fallback.`)
      output = streamResult
      this.ctx.callbacks.onChunk?.(output)
    }

    // 终极安全网：如果 output 仍然为空，发送提示信息避免前端空白
    if (!output) {
      console.warn(`[ReAct] Simple path: output is empty after all fallbacks. Sending placeholder.`)
      output = '（未能获取到响应内容，请重试）'
      this.ctx.callbacks.onChunk?.(output)
    }

    // 添加一个 Think 步骤记录
    this.recordThinkStep('问题简单，直接回答', 'DIRECT_ANSWER', [])

    return { output, llmCalls }
  }

  /** 应用纠偏：重命名 Think 步骤并注入观察，继续循环 */
  private applyNudge(
    nudge: NudgeFired,
    thinkStep: { name: string },
    reactSteps: ReActStep[],
    thought: string,
    iteration: number
  ): void {
    console.log(`[ReAct] Iteration ${iteration + 1} — ${nudge.kind} fired (${nudge.count}/${nudge.max}). Injecting nudge and retrying.`)

    // 保留 Think 步骤但标记为"已驳回"
    thinkStep.name = nudge.stepLabel

    reactSteps.push({
      think: thought,
      action: 'FINAL_ANSWER',
      actionInput: {},
      observation: nudge.observation
    })
  }

  /** 流式输出最终回答（分块模拟流式） */
  private async streamToUser(text: string): Promise<void> {
    if (!text) {
      // 极端情况：发送占位文本确保前端有内容显示
      this.ctx.callbacks.onChunk?.('（未能生成回复，请重试）')
      return
    }
    const chunks = splitIntoChunks(text, 3) // 每次发 3 个字符
    for (const chunk of chunks) {
      this.ctx.callbacks.onChunk?.(chunk)
      await new Promise(r => setTimeout(r, 10)) // 轻微延迟模拟流式
    }
  }

  private recordThinkStep(reasoning: string, decision: string, toolsConsidered?: string[]): { name: string } {
    const detail: ThinkDetail = {
      type: 'think',
      reasoning,
      decision,
      toolsConsidered
    }
    return this.ctx.trace.recordStep('think', 'Think', '💭', detail)
  }

  private recordActStep(
    toolName: string,
    params: Record<string, unknown>,
    result: import('../../../tools/types').ToolResult
  ): void {
    const detail = toActDetail(toolName, params, result, false)
    this.ctx.trace.recordStep('act', `Act: ${toolName}`, '🔍', detail)
  }
}
