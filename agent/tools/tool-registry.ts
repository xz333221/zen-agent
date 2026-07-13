/**
 * 工具注册表 — 自动注册所有内置工具
 *
 * 在应用启动时调用 registerBuiltinTools() 即可注册全部内置工具。
 * AgentLoop 中的 action-executor.ts 会自动发现已注册的工具。
 */

import { registerTool } from '../core/action-executor'
import { calculator } from './calculator'
import { fileReader } from './file-reader'
import { fileWriter } from './file-writer'
import { codeExecutor } from './code-executor'
import { webSearch } from './web-search'
import { fetchUrl } from './fetch-url'
import { openUrl } from './open-url'
import { browserTools } from './browser-tools'
import { terminal } from './terminal'
import type { ToolDef, ToolExecutor } from './types'

// ── 所有内置工具列表 ──
const builtinTools: ToolExecutor[] = [
  calculator,
  fileReader,
  fileWriter,
  codeExecutor,
  webSearch,
  fetchUrl,
  openUrl,
  terminal,
  ...browserTools
]

/** 已注册标记，避免重复注册 */
let registered = false

/**
 * 注册所有内置工具
 * 应在应用启动时调用（IPC handler 注册阶段）
 */
export function registerBuiltinTools(): void {
  if (registered) return

  for (const tool of builtinTools) {
    registerTool(tool)
  }

  registered = true
  console.log(`[ToolRegistry] Registered ${builtinTools.length} builtin tools: ${builtinTools.map(t => t.def.id).join(', ')}`)
}

/**
 * 获取所有内置工具定义
 */
export function getBuiltinToolDefs(): ToolDef[] {
  return builtinTools.map(t => t.def)
}

/**
 * 获取内置工具数量
 */
export function getBuiltinToolCount(): number {
  return builtinTools.length
}
