/**
 * 动作执行器 — 管理 Agent 可用的工具和动作执行
 *
 * 当前版本没有实际工具实现，但提供了完整的执行框架。
 * 当 Agent 决定使用工具时，通过此模块查找并执行。
 * 工具不存在时返回友好的错误信息。
 */

import type { ToolDef, ToolExecutor, ToolCall, ToolResult } from '../tools/types'
import type { ActDetail } from '../../src/shared/types'

// ── 工具注册表 ──
const toolRegistry = new Map<string, ToolExecutor>()

/** 注册工具 */
export function registerTool(executor: ToolExecutor): void {
  toolRegistry.set(executor.def.id, executor)
}

/** 获取所有已注册工具定义 */
export function getToolDefs(): ToolDef[] {
  return Array.from(toolRegistry.values()).map(e => e.def)
}

/** 获取工具名称列表（供 LLM prompt 使用） */
export function getToolNames(): string[] {
  return Array.from(toolRegistry.keys())
}

/**
 * 执行一个工具调用
 * 如果工具不存在，返回友好的错误结果
 */
export async function executeAction(
  call: ToolCall,
  signal?: AbortSignal
): Promise<ToolResult> {
  const executor = toolRegistry.get(call.toolId)
  if (!executor) {
    return {
      callId: call.id,
      success: false,
      result: null,
      resultType: 'error',
      resultSummary: `工具 "${call.toolId}" 不存在`,
      duration: 0,
      error: `Tool not found: ${call.toolId}`
    }
  }

  // 超时控制
  const timeoutMs = executor.def.timeoutMs || 30000
  const timeoutCtrl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined

  const onCallerAbort = () => timeoutCtrl.abort(signal!.reason)
  if (signal) {
    if (signal.aborted) timeoutCtrl.abort(signal.reason)
    else signal.addEventListener('abort', onCallerAbort, { once: true })
  }

  timer = setTimeout(
    () => timeoutCtrl.abort(new Error(`Tool timed out after ${timeoutMs}ms`)),
    timeoutMs
  )
  timer.unref?.()

  try {
    const result = await executor.execute(call.parameters, timeoutCtrl.signal)
    return result
  } catch (err) {
    const error = err as Error
    return {
      callId: call.id,
      success: false,
      result: null,
      resultType: 'error',
      resultSummary: error.message,
      duration: 0,
      error: error.message
    }
  } finally {
    if (timer) clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onCallerAbort)
  }
}

/** 将 ToolResult 转为 ActDetail（用于 TraceStep） */
export function toActDetail(
  toolName: string,
  parameters: Record<string, unknown>,
  result: ToolResult,
  requiresApproval: boolean
): ActDetail {
  return {
    type: 'act',
    toolName,
    parameters,
    parameterSummary: JSON.stringify(parameters).slice(0, 200),
    result: result.result,
    resultSummary: result.resultSummary,
    resultType: result.resultType,
    requiresApproval,
    approved: !requiresApproval || result.success
  }
}
