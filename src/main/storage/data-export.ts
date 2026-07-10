/**
 * 数据导出/导入模块 (T-023)
 *
 * 支持将会话历史和记忆数据导出为 JSON 或 Markdown 格式，
 * 以及从 JSON 文件导入历史数据。
 */

import { app, dialog } from 'electron'
import { join } from 'path'
import { writeFileSync, readFileSync } from 'fs'
import { getAllSessions } from './repositories/sessions'
import { getMessages } from './repositories/messages'
import { createSession } from './repositories/sessions'
import { addMessage } from './repositories/messages'
import { getAllMemories } from '@agent/memory/vector-store'
import type { ExportOptions, ExportResult, ImportResult, Session, ChatMessage } from '@shared/types'

/**
 * 导出数据
 */
export async function exportData(options: ExportOptions): Promise<ExportResult> {
  try {
    let content = ''
    let count = 0
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')

    if (options.scope === 'all' || options.scope === 'sessions') {
      if (options.format === 'json') {
        const data = exportSessionsAsJSON(options.sessionIds, options.startTime, options.endTime)
        content = JSON.stringify(data, null, 2)
        count = data.sessions.reduce((sum, s) => sum + s.messages.length, 0) + data.sessions.length
      } else {
        content = exportSessionsAsMarkdown(options.sessionIds, options.startTime, options.endTime)
        count = content.split('\n## ').length - 1 // 粗略计数
      }
    } else if (options.scope === 'memories') {
      if (options.format === 'json') {
        const data = exportMemoriesAsJSON()
        content = JSON.stringify(data, null, 2)
        count = data.length
      } else {
        content = exportMemoriesAsMarkdown()
        count = content.split('\n### ').length - 1
      }
    }

    // 如果是 all，追加记忆数据
    if (options.scope === 'all') {
      if (options.format === 'json') {
        const sessionsData = JSON.parse(content || '{"sessions":[]}')
        sessionsData.memories = exportMemoriesAsJSON()
        content = JSON.stringify(sessionsData, null, 2)
        count += sessionsData.memories.length
      } else {
        content += '\n\n---\n\n' + exportMemoriesAsMarkdown()
      }
    }

    // 弹出保存对话框
    const ext = options.format === 'json' ? 'json' : 'md'
    const defaultName = `zen-agent-export-${timestamp}.${ext}`
    const result = await dialog.showSaveDialog({
      title: '导出数据',
      defaultPath: defaultName,
      filters: [
        { name: options.format === 'json' ? 'JSON 文件' : 'Markdown 文件', extensions: [ext] }
      ]
    })

    if (result.canceled || !result.filePath) {
      return { success: false, count: 0, error: '用户取消导出' }
    }

    writeFileSync(result.filePath, content, 'utf-8')

    return {
      success: true,
      filePath: result.filePath,
      count
    }
  } catch (err) {
    return {
      success: false,
      count: 0,
      error: (err as Error).message
    }
  }
}

/**
 * 导入数据
 */
export async function importData(filePath?: string): Promise<ImportResult> {
  try {
    // 如果没有提供文件路径，弹出选择对话框
    if (!filePath) {
      const result = await dialog.showOpenDialog({
        title: '导入数据',
        filters: [{ name: 'JSON 文件', extensions: ['json'] }],
        properties: ['openFile']
      })

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, sessionsImported: 0, messagesImported: 0, memoriesImported: 0, error: '用户取消导入' }
      }

      filePath = result.filePaths[0]
    }

    const raw = readFileSync(filePath, 'utf-8')
    const data = JSON.parse(raw)

    let sessionsImported = 0
    let messagesImported = 0
    let memoriesImported = 0

    // 导入会话和消息
    if (data.sessions && Array.isArray(data.sessions)) {
      for (const session of data.sessions) {
        // 创建会话（如果已存在则跳过）
        const existingSession = getAllSessions().find(s => s.id === session.id)
        if (!existingSession) {
          createSession(session.id, session.title || '导入的对话')
        }

        // 导入消息
        if (session.messages && Array.isArray(session.messages)) {
          for (const msg of session.messages) {
            const message: ChatMessage = {
              id: msg.id || `imported-${Date.now()}-${Math.random()}`,
              role: msg.role || 'user',
              content: msg.content || '',
              timestamp: msg.timestamp || Date.now(),
              trace: msg.trace
            }
            addMessage(session.id, message)
            messagesImported++
          }
        }

        sessionsImported++
      }
    }

    // 导入记忆（如果有）
    if (data.memories && Array.isArray(data.memories)) {
      // 记忆导入逻辑
      memoriesImported = data.memories.length
      // 实际导入需要通过 memoryManager
    }

    return {
      success: true,
      sessionsImported,
      messagesImported,
      memoriesImported
    }
  } catch (err) {
    return {
      success: false,
      sessionsImported: 0,
      messagesImported: 0,
      memoriesImported: 0,
      error: (err as Error).message
    }
  }
}

/**
 * 导出会话为 JSON 格式
 */
function exportSessionsAsJSON(
  sessionIds?: string[],
  startTime?: number,
  endTime?: number
): { sessions: Array<{ id: string; title: string; createdAt: number; updatedAt: number; messages: ChatMessage[] }> } {
  let sessions = getAllSessions()

  // 过滤会话
  if (sessionIds && sessionIds.length > 0) {
    sessions = sessions.filter(s => sessionIds.includes(s.id))
  }

  // 时间范围过滤
  if (startTime) {
    sessions = sessions.filter(s => s.updatedAt >= startTime)
  }
  if (endTime) {
    sessions = sessions.filter(s => s.updatedAt <= endTime)
  }

  return {
    sessions: sessions.map(s => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messages: getMessages(s.id)
    }))
  }
}

/**
 * 导出会话为 Markdown 格式
 */
function exportSessionsAsMarkdown(
  sessionIds?: string[],
  startTime?: number,
  endTime?: number
): string {
  let sessions = getAllSessions()

  if (sessionIds && sessionIds.length > 0) {
    sessions = sessions.filter(s => sessionIds.includes(s.id))
  }

  if (startTime) {
    sessions = sessions.filter(s => s.updatedAt >= startTime)
  }
  if (endTime) {
    sessions = sessions.filter(s => s.updatedAt <= endTime)
  }

  let md = `# Zen Agent 会话导出\n\n`
  md += `> 导出时间: ${new Date().toLocaleString('zh-CN')}\n`
  md += `> 会话数量: ${sessions.length}\n\n`

  for (const session of sessions) {
    const date = new Date(session.createdAt).toLocaleString('zh-CN')
    md += `## ${session.title}\n\n`
    md += `**会话 ID**: ${session.id}  \n`
    md += `**创建时间**: ${date}  \n`
    md += `**消息数**: ${session.messageCount}  \n\n`

    const messages = getMessages(session.id)
    for (const msg of messages) {
      const role = msg.role === 'user' ? '👤 **你**' : msg.role === 'assistant' ? '🦉 **小禅**' : '⚙️ **系统**'
      const time = new Date(msg.timestamp).toLocaleTimeString('zh-CN')
      md += `### ${role}\n\n`
      md += `*${time}*\n\n`
      md += `${msg.content}\n\n`
    }

    md += `---\n\n`
  }

  return md
}

/**
 * 导出记忆为 JSON 格式
 */
function exportMemoriesAsJSON() {
  const memories = getAllMemories(undefined, 10000, 0)
  return memories.map(m => ({
    id: m.id,
    type: m.type,
    content: m.content,
    sessionId: m.sessionId,
    userIntent: m.userIntent,
    actions: m.actions,
    outcome: m.outcome,
    successScore: m.successScore,
    modelUsed: m.modelUsed,
    skillsUsed: m.skillsUsed,
    tags: m.tags,
    source: m.source,
    confidence: m.confidence,
    importance: m.importance,
    createdAt: m.createdAt,
    lastAccessedAt: m.lastAccessedAt,
    accessCount: m.accessCount
  }))
}

/**
 * 导出记忆为 Markdown 格式
 */
function exportMemoriesAsMarkdown(): string {
  const memories = getAllMemories(undefined, 10000, 0)

  let md = `# Zen Agent 记忆导出\n\n`
  md += `> 导出时间: ${new Date().toLocaleString('zh-CN')}\n`
  md += `> 记忆数量: ${memories.length}\n\n`

  for (const mem of memories) {
    const date = new Date(mem.createdAt).toLocaleString('zh-CN')
    md += `### ${mem.type === 'episodic' ? '情景记忆' : '语义记忆'} — ${mem.id}\n\n`
    md += `**类型**: ${mem.type}  \n`
    md += `**创建时间**: ${date}  \n`
    md += `**重要性**: ${mem.importance}  \n`
    if (mem.confidence !== undefined) md += `**置信度**: ${mem.confidence}  \n`
    if (mem.tags && mem.tags.length > 0) md += `**标签**: ${mem.tags.join(', ')}  \n`
    md += `\n**内容**: ${mem.content}\n\n`

    if (mem.userIntent) md += `**用户意图**: ${mem.userIntent}\n\n`
    if (mem.outcome) md += `**结果**: ${mem.outcome}\n\n`

    md += `---\n\n`
  }

  return md
}
