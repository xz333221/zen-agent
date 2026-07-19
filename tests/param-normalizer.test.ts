import { describe, it, expect } from 'vitest'
import { normalizeParams } from '../agent/tools/param-normalizer'
import type { ToolSchema } from '../agent/tools/types'

// ── 模拟 file_writer 的 schema ──
const FILE_WRITER_SCHEMA: ToolSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '文件路径' },
    content: { type: 'string', description: '要写入的内容' },
    mode: { type: 'string', description: '写入模式', enum: ['write', 'append'], default: 'write' },
  },
  required: ['path', 'content'],
}

// ── 模拟 terminal 的 schema ──
const TERMINAL_SCHEMA: ToolSchema = {
  type: 'object',
  properties: {
    command: { type: 'string', description: '要执行的命令' },
    cwd: { type: 'string', description: '工作目录', default: '' },
    timeout: { type: 'number', description: '超时毫秒', default: 30000 },
  },
  required: ['command'],
}

describe('normalizeParams — 对象参数提取', () => {
  it('content 收到 {$text: "..."} → 提取成功', () => {
    const r = normalizeParams('file_writer', {
      path: 'e:\\a.txt',
      content: { $text: 'hello world' },
    }, FILE_WRITER_SCHEMA)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.params.content).toBe('hello world')
  })

  it('content 收到 {content: "..."} → 同名键优先提取', () => {
    const r = normalizeParams('file_writer', {
      path: 'e:\\a.txt',
      content: { content: 'nested content' },
    }, FILE_WRITER_SCHEMA)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.params.content).toBe('nested content')
  })

  it('command 收到 {command: "..."} → 同名键优先，不被其他候选键干扰', () => {
    const r = normalizeParams('terminal', {
      command: { command: 'dir', path: 'decoy' },
    }, TERMINAL_SCHEMA)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.params.command).toBe('dir')
  })

  it('对象无候选键 → ok:false 且 hint 含参数名', () => {
    const r = normalizeParams('file_writer', {
      path: 'e:\\a.txt',
      content: { zzz: 123 },
    }, FILE_WRITER_SCHEMA)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/缺少\S*参数/)
      expect(r.hint).toContain('content')
      expect(r.hint).toContain('path')
    }
  })

  it('数组中取第一个字符串元素', () => {
    const r = normalizeParams('terminal', {
      command: ['git status'],
    }, TERMINAL_SCHEMA)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.params.command).toBe('git status')
  })
})

describe('normalizeParams — packed-value salvage', () => {
  it('path 字段打包了整段参数 → 拆出 path 和 content', () => {
    const r = normalizeParams('file_writer', {
      path: 'path: e:\\a.txt, content: hello',
    }, FILE_WRITER_SCHEMA)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.params.path).toBe('e:\\a.txt')
      expect(r.params.content).toBe('hello')
    }
  })

  it('不误伤：content 含 "path:" 但 path 已存在 → 原样保留', () => {
    const legitimateContent = '配置格式：path: /tmp/x, content: yyy 的说明文档'
    const r = normalizeParams('file_writer', {
      path: 'e:\\a.txt',
      content: legitimateContent,
    }, FILE_WRITER_SCHEMA)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.params.content).toBe(legitimateContent)
  })
})

describe('normalizeParams — 标量 coercion 与 enum', () => {
  it('timeout 收到数字字符串 → 转 number', () => {
    const r = normalizeParams('terminal', {
      command: 'dir',
      timeout: '30000',
    }, TERMINAL_SCHEMA)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.params.timeout).toBe(30000)
  })

  it('enum 非法值 → 丢弃走默认，不报错', () => {
    const r = normalizeParams('file_writer', {
      path: 'e:\\a.txt',
      content: 'x',
      mode: 'overwrite',
    }, FILE_WRITER_SCHEMA)
    expect(r.ok).toBe(true)
    if (r.ok) expect('mode' in r.params).toBe(false)
  })

  it('string 参数收到 number → 字符串化', () => {
    const r = normalizeParams('file_writer', {
      path: 'e:\\a.txt',
      content: 42,
    }, FILE_WRITER_SCHEMA)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.params.content).toBe('42')
  })
})

describe('normalizeParams — required 校验与边界', () => {
  it('缺 required → ok:false，error 命中 nudge8 正则 /缺少\\S*参数/', () => {
    const r = normalizeParams('file_writer', { content: 'x' }, FILE_WRITER_SCHEMA)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/缺少\S*参数/)
  })

  it('空串 content（path 存在）→ 放行（合法清空语义）', () => {
    const r = normalizeParams('file_writer', {
      path: 'e:\\a.txt',
      content: '',
    }, FILE_WRITER_SCHEMA)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.params.content).toBe('')
  })

  it('非对象入参：纯文本 → salvage 到第一个 required', () => {
    const r = normalizeParams('terminal', 'git status', TERMINAL_SCHEMA)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.params.command).toBe('git status')
  })

  it('非对象入参：null → ok:false', () => {
    const r = normalizeParams('terminal', null, TERMINAL_SCHEMA)
    expect(r.ok).toBe(false)
  })

  it('可选参数显式传 null → 视为未提供', () => {
    const r = normalizeParams('terminal', {
      command: 'dir',
      cwd: null,
    }, TERMINAL_SCHEMA)
    expect(r.ok).toBe(true)
    if (r.ok) expect('cwd' in r.params).toBe(false)
  })

  it('可选 string 参数收到垃圾对象 → 丢弃而非整体失败', () => {
    const r = normalizeParams('terminal', {
      command: 'dir',
      cwd: { zzz: 1 },
    }, TERMINAL_SCHEMA)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.params.command).toBe('dir')
      expect('cwd' in r.params).toBe(false)
    }
  })
})
