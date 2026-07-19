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
import { fileEditor } from './file-edit'
import { codeExecutor } from './code-executor'
import { webSearch } from './web-search'
import { fetchUrl } from './fetch-url'
import { openUrl } from './open-url'
import { browserTools } from './browser-tools'
import { terminal } from './terminal'
import { fileSearch } from './file-search'
import { fileIndexer } from './file-index'
import type { ToolDef, ToolExecutor } from './types'

// ── 所有内置工具列表 ──
const builtinTools: ToolExecutor[] = [
  calculator,
  fileReader,
  fileWriter,
  fileEditor,
  codeExecutor,
  webSearch,
  fetchUrl,
  openUrl,
  terminal,
  fileSearch,
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
 * 初始化文件索引（异步，不阻塞启动）
 * 在应用启动后调用，后台扫描常用目录
 */
export function initFileIndex(): void {
  // 延迟 5 秒后开始构建，避免影响启动性能
  setTimeout(() => {
    fileIndexer.buildIndex().catch(err => {
      console.error('[ToolRegistry] File index build failed:', err)
    })
  }, 5000)

  // 每小时刷新一次
  setInterval(() => {
    if (fileIndexer.isStale()) {
      fileIndexer.refresh().catch(err => {
        console.error('[ToolRegistry] File index refresh failed:', err)
      })
    }
  }, 60 * 60 * 1000).unref?.()
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
