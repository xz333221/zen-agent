/**
 * 工具结果观察文本构建
 *
 * 将工具执行结果格式化为详细的观察文本，供 LLM 后续推理使用。
 */

import type { ToolResult } from '../../../tools/types'

/** 工具结果的可能形状（不同工具返回不同结构） */
interface ToolResultPayload {
  // 搜索结果
  engine?: string
  results?: Array<{ index?: number; title?: string; url?: string; snippet?: string; content?: string }>
  // terminal / file 操作结果
  stdout?: string
  stderr?: string
  exitCode?: number
  command?: string
  cwd?: string
  platform?: string
  shell?: string
  // fetch_url 结果
  url?: string
  finalUrl?: string
  contentType?: string
  content?: string
  length?: number
  // file_reader 结果
  path?: string
  totalLines?: number
  displayedLines?: number
  truncated?: boolean
  size?: number
}

/** 构建详细的观察结果文本 */
export function buildObservationText(toolResult: ToolResult): string {
  let observationText = toolResult.resultSummary

  if (!toolResult.result || typeof toolResult.result !== 'object') {
    return observationText
  }

  const result = toolResult.result as ToolResultPayload

  // ── terminal 命令输出 ──
  if (typeof result.stdout === 'string' || typeof result.stderr === 'string' || typeof result.exitCode === 'number') {
    if (result.command) {
      observationText += `\n命令: ${result.command}`
    }
    if (result.cwd) {
      observationText += `\n工作目录: ${result.cwd}`
    }
    if (typeof result.exitCode === 'number') {
      observationText += `\n退出码: ${result.exitCode}`
    }
    if (result.stdout && result.stdout.trim()) {
      observationText += `\n--- stdout ---\n${result.stdout}`
    }
    if (result.stderr && result.stderr.trim()) {
      observationText += `\n--- stderr ---\n${result.stderr}`
    }
    return observationText
  }

  // ── 搜索结果 ──
  if (result.results && Array.isArray(result.results) && result.results.length > 0) {
    const engineInfo = result.engine ? `（来源: ${result.engine}）` : ''
    observationText = `${toolResult.resultSummary}${engineInfo}\n\n搜索结果详情：`
    for (const r of result.results) {
      observationText += `\n[${r.index || '?'}] ${r.title || '(无标题)'}\n`
      observationText += `  链接: ${r.url || ''}\n`
      if (r.snippet) {
        observationText += `  摘要: ${r.snippet}\n`
      }
      if (r.content) {
        observationText += `  内容: ${r.content}\n`
      }
    }
    return observationText
  }

  // ── file_reader 文件读取结果 ──
  // file_reader 返回 { path, content, ... }，必须把 content 放进 observation
  // 注意：必须在 fetch_url 之前判断，因为两者都有 content 字段，
  // 但 file_reader 有 path 无 url，fetch_url 有 url
  if (typeof result.content === 'string' && result.path && !result.url) {
    return `${toolResult.resultSummary}\n\n--- 文件内容 ---\n${result.content}`
  }

  // ── fetch_url 网页抓取结果 ──
  if (typeof result.content === 'string' && result.url) {
    return `${toolResult.resultSummary}\n\n--- 抓取内容 ---\n${result.content}`
  }

  return observationText
}
