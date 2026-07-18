import { describe, it, expect } from 'vitest'
import { parseReActResponse, parseToolParams } from '../agent/core/pipeline/react/react-parser'

describe('parseReActResponse', () => {
  it('解析标准 FINAL_ANSWER 格式', () => {
    const response = `THOUGHT: 这个问题很简单
ACTION: FINAL_ANSWER
CONTENT: 答案是 42`
    const parsed = parseReActResponse(response)
    expect(parsed.thought).toBe('这个问题很简单')
    expect(parsed.action).toBe('FINAL_ANSWER')
    expect(parsed.content).toBe('答案是 42')
    expect(parsed.hasAction).toBe(true)
    expect(parsed.hasContent).toBe(true)
  })

  it('解析工具调用格式', () => {
    const response = `THOUGHT: 需要搜索最新信息
ACTION: web_search
ACTION_INPUT: {"query": "上证指数 今日"}`
    const parsed = parseReActResponse(response)
    expect(parsed.action).toBe('web_search')
    expect(parsed.actionInput).toBe('{"query": "上证指数 今日"}')
  })

  it('无 ACTION 字段时默认为 FINAL_ANSWER 且 hasAction=false', () => {
    const response = 'THOUGHT: 只有思考没有动作'
    const parsed = parseReActResponse(response)
    expect(parsed.action).toBe('FINAL_ANSWER')
    expect(parsed.hasAction).toBe(false)
    expect(parsed.thought).toBe('只有思考没有动作')
  })

  it('完全不符合格式时 thought 取响应前 500 字符', () => {
    const response = '这是一段没有任何标记的自由文本'
    const parsed = parseReActResponse(response)
    expect(parsed.thought).toBe(response)
    expect(parsed.hasContent).toBe(false)
  })

  it('CONTENT 后面的多行内容完整保留', () => {
    const response = `THOUGHT: t
ACTION: FINAL_ANSWER
CONTENT: 第一行
第二行
第三行`
    const parsed = parseReActResponse(response)
    expect(parsed.content).toBe('第一行\n第二行\n第三行')
  })

  it('大小写不敏感', () => {
    const response = `thought: 小写标记
action: FINAL_ANSWER
content: 内容`
    const parsed = parseReActResponse(response)
    expect(parsed.thought).toBe('小写标记')
    expect(parsed.content).toBe('内容')
  })
})

describe('parseToolParams', () => {
  it('空输入返回空对象', () => {
    expect(parseToolParams('')).toEqual({})
  })

  it('标准 JSON 直接解析', () => {
    expect(parseToolParams('{"query": "test", "limit": 5}')).toEqual({ query: 'test', limit: 5 })
  })

  it('从混杂文本中提取 JSON 对象', () => {
    expect(parseToolParams('参数是 {"query": "上证指数"} 就这样')).toEqual({ query: '上证指数' })
  })

  it('JSON 对象损坏但有 query 字段时提取 query', () => {
    // 有完整 {...} 但 parse 失败 → 提取 "query" 字段
    expect(parseToolParams('{"query": "abc", broken}')).toEqual({ query: 'abc' })
  })

  it('无闭合花括号时按纯文本处理', () => {
    expect(parseToolParams('{"query": " broken json')).toEqual({ query: '{"query": " broken json' })
  })

  it('单行纯文本作为 query', () => {
    expect(parseToolParams('上证指数 今日行情')).toEqual({ query: '上证指数 今日行情' })
  })

  it('多行非 JSON 文本回退为 raw', () => {
    const result = parseToolParams('第一行\n第二行')
    expect(result).toEqual({ raw: '第一行\n第二行' })
  })
})
