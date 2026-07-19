import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { fileEditor } from '../agent/tools/file-edit'

// ── 临时测试目录 ──
const TEST_DIR = join(tmpdir(), 'zen-agent-file-edit-test')

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true })
})

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true })
  }
})

/** 在测试目录下创建文件并返回路径 */
function makeFile(name: string, content: string): string {
  const p = join(TEST_DIR, name)
  writeFileSync(p, content, 'utf-8')
  return p
}

describe('file_edit — 唯一替换成功', () => {
  it('old_string 唯一匹配 → 替换成功并返回行号', async () => {
    const path = makeFile('unique.ts', 'line1\nfoo()\nline3\n')
    const r = await fileEditor.execute({
      path,
      old_string: 'foo()',
      new_string: 'bar()',
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.result).toMatchObject({
        path,
        replacements: 1,
        bytesBefore: expect.any(Number),
        bytesAfter: expect.any(Number),
      })
      // 行号是 1-based，foo() 在第 2 行
      expect((r.result as { lineNumbers: number[] }).lineNumbers).toEqual([2])
    }
    // 验证文件内容
    const { readFileSync } = await import('fs')
    const content = readFileSync(path, 'utf-8')
    expect(content).toBe('line1\nbar()\nline3\n')
  })

  it('多行 old_string 含缩进 → 精确匹配替换', async () => {
    const path = makeFile('indent.ts', 'function hello() {\n  console.log("hi")\n}\n')
    const r = await fileEditor.execute({
      path,
      old_string: '  console.log("hi")',
      new_string: '  console.log("hello world")',
    })
    expect(r.success).toBe(true)
    const { readFileSync } = await import('fs')
    const content = readFileSync(path, 'utf-8')
    expect(content).toBe('function hello() {\n  console.log("hello world")\n}\n')
  })
})

describe('file_edit — 未找到匹配', () => {
  it('old_string 不存在 → 失败且提示用 file_reader 确认', async () => {
    const path = makeFile('notfound.ts', 'line1\nline2\n')
    const r = await fileEditor.execute({
      path,
      old_string: 'nonexistent()',
      new_string: 'replacement()',
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.resultSummary).toContain('未找到匹配文本')
      expect(r.resultSummary).toContain('file_reader')
      // 包含文件前 5 行锚点
      expect(r.resultSummary).toContain('1| line1')
    }
  })
})

describe('file_edit — 多处匹配', () => {
  it('多处匹配默认失败（expected_count=1）', async () => {
    const path = makeFile('multi.ts', 'foo()\nbar\nfoo()\n')
    const r = await fileEditor.execute({
      path,
      old_string: 'foo()',
      new_string: 'baz()',
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.resultSummary).toContain('匹配次数不符')
      expect(r.resultSummary).toContain('期望 1 次')
      expect(r.resultSummary).toContain('实际找到 2 次')
    }
  })

  it('expected_count=2 → 多处全部替换成功', async () => {
    const path = makeFile('multi2.ts', 'foo()\nbar\nfoo()\n')
    const r = await fileEditor.execute({
      path,
      old_string: 'foo()',
      new_string: 'baz()',
      expected_count: 2,
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect((r.result as { replacements: number }).replacements).toBe(2)
    }
    const { readFileSync } = await import('fs')
    const content = readFileSync(path, 'utf-8')
    expect(content).toBe('baz()\nbar\nbaz()\n')
  })
})

describe('file_edit — 空 new_string 删除', () => {
  it('new_string 为空串 → 删除 old_string 片段', async () => {
    const path = makeFile('delete.ts', 'keep1\ndelete_me\nkeep2\n')
    const r = await fileEditor.execute({
      path,
      old_string: 'delete_me\n',
      new_string: '',
    })
    expect(r.success).toBe(true)
    const { readFileSync } = await import('fs')
    const content = readFileSync(path, 'utf-8')
    expect(content).toBe('keep1\nkeep2\n')
  })
})

describe('file_edit — 空 old_string 失败', () => {
  it('old_string 为空串 → 失败', async () => {
    const path = makeFile('empty.ts', 'content\n')
    const r = await fileEditor.execute({
      path,
      old_string: '',
      new_string: 'something',
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.resultSummary).toContain('old_string')
      expect(r.resultSummary).toContain('不能为空')
    }
  })
})

describe('file_edit — 文件不存在', () => {
  it('文件不存在 → 失败并提示用 file_writer 新建', async () => {
    const path = join(TEST_DIR, 'nonexistent.ts')
    const r = await fileEditor.execute({
      path,
      old_string: 'foo()',
      new_string: 'bar()',
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.resultSummary).toContain('文件不存在')
      expect(r.resultSummary).toContain('file_writer')
    }
  })
})

describe('file_edit — 参数防御', () => {
  it('old_string 收到对象 → 失败', async () => {
    const path = makeFile('obj.ts', 'content\n')
    const r = await fileEditor.execute({
      path,
      old_string: { text: 'foo' } as unknown,
      new_string: 'bar',
    } as Record<string, unknown>)
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.resultSummary).toContain('old_string')
    }
  })

  it('缺 path → 失败', async () => {
    const r = await fileEditor.execute({
      old_string: 'foo',
      new_string: 'bar',
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.resultSummary).toContain('路径')
    }
  })
})
