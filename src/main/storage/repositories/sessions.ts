/**
 * 会话 Repository — CRUD 操作
 */

import { query, execute } from '../database'
import type { Session } from '@shared/types'

interface SessionRow {
  id: string
  title: string
  created_at: number
  updated_at: number
  message_count: number
}

/** 创建会话 */
export function createSession(id: string, title = '新对话'): Session {
  const now = Date.now()
  execute(
    'INSERT INTO sessions (id, title, created_at, updated_at, message_count) VALUES (?, ?, ?, ?, 0)',
    [id, title, now, now]
  )
  return {
    id,
    title,
    createdAt: now,
    updatedAt: now,
    messageCount: 0
  }
}

/** 获取会话 */
export function getSession(id: string): Session | null {
  const rows = query<SessionRow>(
    'SELECT * FROM sessions WHERE id = ?',
    [id]
  )
  if (rows.length === 0) return null
  return rowToSession(rows[0])
}

/** 获取所有会话（按更新时间倒序） */
export function getAllSessions(): Session[] {
  const rows = query<SessionRow>(
    'SELECT * FROM sessions ORDER BY updated_at DESC'
  )
  return rows.map(rowToSession)
}

/** 更新会话标题 */
export function updateSessionTitle(id: string, title: string): void {
  execute(
    'UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?',
    [title, Date.now(), id]
  )
}

/** 更新会话消息数 */
export function incrementMessageCount(id: string): void {
  execute(
    'UPDATE sessions SET message_count = message_count + 1, updated_at = ? WHERE id = ?',
    [Date.now(), id]
  )
}

/** 删除会话（连同消息） */
export function deleteSession(id: string): void {
  execute('DELETE FROM messages WHERE session_id = ?', [id])
  execute('DELETE FROM sessions WHERE id = ?', [id])
}

/** 行转对象 */
function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count
  }
}
