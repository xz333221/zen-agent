/**
 * SQLite 数据库管理（基于 sql.js WASM）
 *
 * 使用 sql.js 的 WASM 版本，通过直接传入 wasmBinary 避免路径解析问题。
 * 数据库文件存储在 app.getPath('userData')/zen-agent.db
 * 每次修改后自动持久化到文件。
 */

import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import type { Database, SqlJsStatic } from 'sql.js'

// 懒加载 sql.js — 不在顶层 import，避免模块加载时初始化 WASM 运行时
let _initSqlJs: typeof import('sql.js')['default'] | null = null
function getInitSqlJs(): typeof import('sql.js')['default'] {
  if (!_initSqlJs) {
    _initSqlJs = require('sql.js')
  }
  return _initSqlJs!
}

let db: Database | null = null
let SQL: SqlJsStatic | null = null
let dbPath: string = ''
let saveTimer: ReturnType<typeof setTimeout> | null = null
let initPromise: Promise<Database> | null = null

/** 初始化数据库 */
export function initDatabase(): Promise<Database> {
  if (db) return Promise.resolve(db)
  if (initPromise) return initPromise

  initPromise = doInit()
  return initPromise
}

async function doInit(): Promise<Database> {
  try {
    // 直接读取 WASM 二进制文件，避免路径解析问题
    const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm')
    const wasmBinary = readFileSync(wasmPath)
    // 注意 Buffer.buffer 可能是共享内存池，需按偏移精确切出独立的 ArrayBuffer
    const wasmArrayBuffer = wasmBinary.buffer.slice(
      wasmBinary.byteOffset,
      wasmBinary.byteOffset + wasmBinary.byteLength
    ) as ArrayBuffer

    SQL = await getInitSqlJs()({ wasmBinary: wasmArrayBuffer })

    // 数据库文件路径
    const userDataPath = app.getPath('userData')
    dbPath = join(userDataPath, 'zen-agent.db')

    // 加载已有数据库或创建新的
    if (existsSync(dbPath)) {
      const buffer = readFileSync(dbPath)
      db = new SQL.Database(buffer)
    } else {
      db = new SQL.Database()
    }

    // 执行迁移
    runMigrations(db)

    // 注册自动保存
    setupAutoSave()

    console.log('[DB] SQLite initialized successfully at', dbPath)
    return db
  } catch (err) {
    console.error('[DB] Failed to initialize SQLite:', err)
    // 创建一个内存数据库作为 fallback
    try {
      SQL = await getInitSqlJs()()
      db = new SQL.Database()
      runMigrations(db)
      console.warn('[DB] Using in-memory fallback database (data will not persist)')
    } catch (err2) {
      console.error('[DB] Complete database initialization failure:', err2)
    }
    return db!
  }
}

/** 获取数据库实例 */
export function getDatabase(): Database | null {
  return db
}

/** 确保数据库已初始化 */
export async function ensureDatabase(): Promise<Database | null> {
  if (db) return db
  await initDatabase()
  return db
}

/** 手动保存数据库到文件 */
export function saveDatabase(): void {
  if (!db || !dbPath) return

  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }

  try {
    const data = db.export()
    const dir = join(dbPath, '..')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(dbPath, Buffer.from(data))
  } catch (err) {
    console.error('[DB] Failed to save:', err)
  }
}

/** 防抖自动保存（500ms 内多次修改只保存一次） */
function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveDatabase()
    saveTimer = null
  }, 500)
  saveTimer.unref?.()
}

/** 设置自动保存钩子 */
function setupAutoSave(): void {
  app.on('before-quit', () => {
    saveDatabase()
  })
}

/** 数据库迁移 */
function runMigrations(database: Database): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '新对话',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0
    )
  `)

  database.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      trace TEXT,
      images TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `)

  // ── 迁移:为旧库补 images 列(图片附件持久化) ──
  addColumnIfMissing(database, 'messages', 'images', 'TEXT')

  database.run(`
    CREATE INDEX IF NOT EXISTS idx_messages_session
    ON messages(session_id, timestamp)
  `)

  database.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)

  // ── 记忆系统表 ──
  database.run(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('episodic', 'semantic')),
      mem_type TEXT,
      content TEXT NOT NULL,
      embedding TEXT,
      session_id TEXT,
      user_intent TEXT,
      actions TEXT,
      outcome TEXT,
      success_score REAL,
      model_used TEXT,
      skills_used TEXT,
      tags TEXT,
      source TEXT,
      confidence REAL,
      importance REAL DEFAULT 0.5,
      created_at INTEGER NOT NULL,
      last_accessed_at INTEGER,
      access_count INTEGER DEFAULT 0
    )
  `)

  database.run(`
    CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type)
  `)

  database.run(`
    CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC)
  `)

  database.run(`
    CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id)
  `)

  // ── 技能系统表 ──
  database.run(`
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      content TEXT NOT NULL,
      auto_generated INTEGER NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 0.5,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('active', 'draft', 'disabled', 'rejected')),
      source_episodes TEXT,
      embedding TEXT,
      execution_count INTEGER NOT NULL DEFAULT 0,
      success_rate REAL NOT NULL DEFAULT 0,
      avg_duration REAL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  database.run(`
    CREATE INDEX IF NOT EXISTS idx_skills_status ON skills(status)
  `)

  // ── Prompt 版本管理表 ──
  database.run(`
    CREATE TABLE IF NOT EXISTS prompt_versions (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      content TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT 'system',
      is_current INTEGER NOT NULL DEFAULT 0,
      performance REAL DEFAULT 0,
      created_at INTEGER NOT NULL,
      feedback_count INTEGER DEFAULT 0,
      negative_count INTEGER DEFAULT 0,
      positive_count INTEGER DEFAULT 0
    )
  `)

  database.run(`
    CREATE INDEX IF NOT EXISTS idx_prompt_target ON prompt_versions(target, is_current)
  `)

  // ── 用户反馈记录表 ──
  database.run(`
    CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      session_id TEXT,
      feedback_type TEXT NOT NULL CHECK(feedback_type IN ('positive', 'negative', 'neutral')),
      feedback_source TEXT NOT NULL DEFAULT 'explicit' CHECK(feedback_source IN ('explicit', 'implicit')),
      user_query TEXT,
      agent_response TEXT,
      comment TEXT,
      created_at INTEGER NOT NULL
    )
  `)

  database.run(`
    CREATE INDEX IF NOT EXISTS idx_feedback_type ON feedback(feedback_type)
  `)

  // ── 自进化记录表 ──
  database.run(`
    CREATE TABLE IF NOT EXISTS evolution_records (
      id TEXT PRIMARY KEY,
      trigger_reason TEXT NOT NULL,
      goal TEXT NOT NULL DEFAULT '',
      files_changed TEXT NOT NULL DEFAULT '[]',
      plan_json TEXT,
      test_result_json TEXT,
      evaluation_json TEXT,
      outcome TEXT NOT NULL DEFAULT 'failure',
      commit_hash TEXT,
      failure_reason TEXT,
      tokens_input INTEGER NOT NULL DEFAULT 0,
      tokens_output INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      logs_json TEXT NOT NULL DEFAULT '[]'
    )
  `)

  database.run(`
    CREATE INDEX IF NOT EXISTS idx_evolution_outcome ON evolution_records(outcome)
  `)

  database.run(`
    CREATE INDEX IF NOT EXISTS idx_evolution_started ON evolution_records(started_at DESC)
  `)

  // ── Token 使用记录表 ──
  database.run(`
    CREATE TABLE IF NOT EXISTS token_usage (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'chat'
    )
  `)

  database.run(`
    CREATE INDEX IF NOT EXISTS idx_token_usage_time ON token_usage(timestamp DESC)
  `)

  scheduleSave()
}

/**
 * 轻量迁移工具：为已存在的表添加列（若列不存在）。
 * SQLite 不支持 IF NOT EXISTS 形式的 ADD COLUMN，用 pragma 探测。
 */
function addColumnIfMissing(database: Database, table: string, column: string, definition: string): void {
  try {
    // PRAGMA table_info 返回行: [cid, name, type, notnull, dflt_value, pk]
    // sql.js 的 exec() 返回 [{ columns, values }]，values 是数据行数组
    const info = database.exec(`PRAGMA table_info(${table})`)
    const rows = info[0]?.values ?? []
    const exists = rows.some((row: any) => row[1] === column)
    if (!exists) {
      database.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
      console.log(`[DB] Migration: added column ${table}.${column}`)
    }
  } catch (err) {
    console.error(`[DB] Migration failed for ${table}.${column}:`, err)
  }
}

/** 执行查询（返回行数组） */
export function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): T[] {
  if (!db) {
    console.warn('[DB] Query attempted before initialization')
    return []
  }
  const stmt = db.prepare(sql)
  stmt.bind(params as any)
  const rows: T[] = []
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as T)
  }
  stmt.free()
  return rows
}

/** 执行写操作（INSERT/UPDATE/DELETE） */
export function execute(sql: string, params: unknown[] = []): void {
  if (!db) {
    console.warn('[DB] Execute attempted before initialization')
    return
  }
  db.run(sql, params as any)
  scheduleSave()
}

/** 关闭数据库 */
export function closeDatabase(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  saveDatabase()
  if (db) {
    db.close()
    db = null
  }
}
