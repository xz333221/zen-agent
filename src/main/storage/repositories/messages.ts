/**
 * 消息 Repository — CRUD 操作
 */

import { query, execute } from '../database'
import type { ChatMessage } from '@shared/types'
import { incrementMessageCount } from './sessions'

interface MessageRow {
  id: string
  session_id: string
  role: string
  content: string
  timestamp: number
  trace: string | null
  images: string | null
}

/** 添加消息 */
export function addMessage(
  sessionId: string,
  message: ChatMessage
): void {
  execute(
    `INSERT INTO messages (id, session_id, role, content, timestamp, trace, images)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      message.id,
      sessionId,
      message.role,
      message.content,
      message.timestamp,
      message.trace ? JSON.stringify(message.trace) : null,
      message.images && message.images.length > 0 ? JSON.stringify(message.images) : null
    ]
  )
  incrementMessageCount(sessionId)
}

/** 获取会话的所有消息（按时间正序） */
export function getMessages(sessionId: string): ChatMessage[] {
  const rows = query<MessageRow>(
    'SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC',
    [sessionId]
  )
  return rows.map(rowToMessage)
}

/** 获取会话最近的 N 条消息 */
export function getRecentMessages(sessionId: string, limit: number): ChatMessage[] {
  const rows = query<MessageRow>(
    'SELECT * FROM (SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?) ORDER BY timestamp ASC',
    [sessionId, limit]
  )
  return rows.map(rowToMessage)
}

/** 删除会话的所有消息 */
export function deleteMessages(sessionId: string): void {
  execute('DELETE FROM messages WHERE session_id = ?', [sessionId])
}

/** 行转对象 */
function rowToMessage(row: MessageRow): ChatMessage {
  let images: ChatMessage['images']
  if (row.images) {
    try {
      images = JSON.parse(row.images)
    } catch (err) {
      console.warn('[Messages] Failed to parse images JSON:', err)
      images = undefined
    }
  }
  return {
    id: row.id,
    role: row.role as ChatMessage['role'],
    content: row.content,
    timestamp: row.timestamp,
    trace: row.trace ? JSON.parse(row.trace) : undefined,
    images
  }
}
