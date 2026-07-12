/**
 * 打开 URL 工具 — 在用户默认浏览器中打开网址
 *
 * 使用 Electron 的 shell.openExternal() 实现，
 * 支持 http/https 协议的 URL。
 * 对于本地文件路径，使用 shell.openPath() 打开。
 */

import type { ToolDef, ToolExecutor, ToolResult } from './types'

const OPEN_URL_DEF: ToolDef = {
  id: 'open_url',
  name: 'OpenUrl',
  description: '在用户默认浏览器中打开指定 URL。参数: url (要打开的网址，如 https://weread.qq.com/)',
  category: 'builtin',
  schema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: '要打开的 URL（必须包含 http:// 或 https:// 协议前缀）'
      }
    },
    required: ['url']
  },
  requiresApproval: false,
  timeoutMs: 10000
}

// 延迟导入 electron，避免在非 electron 环境中报错
async function getShell() {
  try {
    const electron = await import('electron')
    return electron.shell
  } catch {
    return null
  }
}

export const openUrl: ToolExecutor = {
  def: OPEN_URL_DEF,
  async execute(params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const startTime = Date.now()
    const url = String(params.url || '').trim()

    if (!url) {
      return {
        callId: `open-url-${Date.now()}`,
        success: false,
        result: null,
        resultType: 'error',
        resultSummary: '缺少 URL 参数',
        duration: Date.now() - startTime,
        error: 'URL parameter is required'
      }
    }

    // 验证 URL 格式
    let parsedUrl: URL
    try {
      parsedUrl = new URL(url)
    } catch {
      return {
        callId: `open-url-${Date.now()}`,
        success: false,
        result: null,
        resultType: 'error',
        resultSummary: `无效的 URL: ${url}`,
        duration: Date.now() - startTime,
        error: `Invalid URL format: ${url}`
      }
    }

    // 安全检查：只允许 http/https 协议
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return {
        callId: `open-url-${Date.now()}`,
        success: false,
        result: null,
        resultType: 'error',
        resultSummary: `不支持的协议: ${parsedUrl.protocol}，仅支持 http/https`,
        duration: Date.now() - startTime,
        error: `Unsupported protocol: ${parsedUrl.protocol}. Only http/https are allowed.`
      }
    }

    if (signal?.aborted) {
      return {
        callId: `open-url-${Date.now()}`,
        success: false,
        result: null,
        resultType: 'error',
        resultSummary: '操作被中止',
        duration: Date.now() - startTime,
        error: 'aborted'
      }
    }

    const shell = await getShell()
    if (!shell) {
      return {
        callId: `open-url-${Date.now()}`,
        success: false,
        result: null,
        resultType: 'error',
        resultSummary: '无法访问系统 Shell（可能不在 Electron 环境中）',
        duration: Date.now() - startTime,
        error: 'Electron shell module not available'
      }
    }

    try {
      await shell.openExternal(url)
      return {
        callId: `open-url-${Date.now()}`,
        success: true,
        result: { url },
        resultType: 'text',
        resultSummary: `已在默认浏览器中打开: ${url}`,
        duration: Date.now() - startTime
      }
    } catch (err) {
      return {
        callId: `open-url-${Date.now()}`,
        success: false,
        result: null,
        resultType: 'error',
        resultSummary: `打开 URL 失败: ${err instanceof Error ? err.message : String(err)}`,
        duration: Date.now() - startTime,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  }
}
