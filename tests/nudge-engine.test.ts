import { describe, it, expect } from 'vitest'
import { NudgeEngine, type NudgeInput } from '../agent/core/pipeline/react/nudge-engine'
import type { ParsedReActResponse } from '../agent/core/pipeline/react/react-parser'
import type { ReActStep } from '../agent/core/types'

const MAX_ITERATIONS = 50

function makeParsed(overrides: Partial<ParsedReActResponse> = {}): ParsedReActResponse {
  return {
    thought: '思考中',
    action: 'FINAL_ANSWER',
    actionInput: '',
    content: '这是回答',
    hasAction: true,
    hasContent: true,
    ...overrides
  }
}

function makeInput(overrides: Partial<NudgeInput> = {}): NudgeInput {
  return {
    parsed: makeParsed(),
    reactSteps: [],
    iteration: 1,
    maxIterations: MAX_ITERATIONS,
    thinkResponse: '',
    toolAssessment: { needsTool: false, suggestedTools: [], reason: '' },
    toolNames: ['web_search', 'terminal', 'fetch_url'],
    historyMessages: [],
    ...overrides
  }
}

/** 构造一条已执行工具的推理步骤 */
function toolStep(action = 'web_search', observation = '搜索结果...'): ReActStep {
  return { think: 't', action, actionInput: {}, observation }
}

describe('NudgeEngine — nudge7 格式不完整', () => {
  it('只有 THOUGHT 没有 ACTION 时触发', () => {
    const engine = new NudgeEngine()
    const input = makeInput({
      parsed: makeParsed({ hasAction: false, hasContent: false, thought: '只有思考' })
    })
    const fired = engine.checkIncompleteFormat(input)
    expect(fired).not.toBeNull()
    expect(fired!.kind).toBe('nudge7')
    expect(fired!.observation).toContain('缺少 ACTION 字段')
  })

  it('有 ACTION 时不触发', () => {
    const engine = new NudgeEngine()
    expect(engine.checkIncompleteFormat(makeInput())).toBeNull()
  })

  it('最多触发 2 次', () => {
    const engine = new NudgeEngine()
    const input = makeInput({
      parsed: makeParsed({ hasAction: false, hasContent: false, thought: 't' })
    })
    expect(engine.checkIncompleteFormat(input)).not.toBeNull()
    expect(engine.checkIncompleteFormat(input)).not.toBeNull()
    expect(engine.checkIncompleteFormat(input)).toBeNull()
  })

  it('接近迭代上限时不再触发', () => {
    const engine = new NudgeEngine()
    const input = makeInput({
      parsed: makeParsed({ hasAction: false, hasContent: false, thought: 't' }),
      iteration: MAX_ITERATIONS - 1
    })
    expect(engine.checkIncompleteFormat(input)).toBeNull()
  })
})

describe('NudgeEngine — nudge1 未用工具就回答', () => {
  it('首轮 + 工具评估为需要 + 无推理步骤时触发', () => {
    const engine = new NudgeEngine()
    const input = makeInput({
      iteration: 0,
      reactSteps: [],
      toolAssessment: { needsTool: true, suggestedTools: ['web_search'], reason: '需要实时数据' }
    })
    const fired = engine.checkFinalAnswer(input)
    expect(fired?.kind).toBe('nudge1')
    expect(fired!.observation).toContain('web_search')
  })

  it('工具评估为不需要时不触发', () => {
    const engine = new NudgeEngine()
    const input = makeInput({ iteration: 0, reactSteps: [] })
    expect(engine.checkFinalAnswer(input)).toBeNull()
  })

  it('非首轮不触发', () => {
    const engine = new NudgeEngine()
    const input = makeInput({
      iteration: 1,
      reactSteps: [],
      toolAssessment: { needsTool: true, suggestedTools: [], reason: '' }
    })
    expect(engine.checkFinalAnswer(input)).toBeNull()
  })
})

describe('NudgeEngine — nudge1.5 复用旧数据', () => {
  it('首轮回答含具体数据且历史含实时话题时触发', () => {
    const engine = new NudgeEngine()
    const input = makeInput({
      iteration: 0,
      parsed: makeParsed({ content: '上证指数收于 3993.33 点' }),
      historyMessages: [{ role: 'user', content: '今天大盘行情怎么样' }]
    })
    const fired = engine.checkFinalAnswer(input)
    expect(fired?.kind).toBe('nudge15')
  })

  it('历史无实时话题时不触发', () => {
    const engine = new NudgeEngine()
    const input = makeInput({
      iteration: 0,
      parsed: makeParsed({ content: '圆周率约 3.14159' }),
      historyMessages: [{ role: 'user', content: '写个冒泡排序' }]
    })
    expect(engine.checkFinalAnswer(input)).toBeNull()
  })
})

describe('NudgeEngine — nudge2 不信任工具结果', () => {
  it('用过工具但回答声称"沙箱"时触发', () => {
    const engine = new NudgeEngine()
    const input = makeInput({
      reactSteps: [toolStep('terminal', 'file created')],
      parsed: makeParsed({ content: '这可能只是在沙箱中执行，结果不真实' })
    })
    const fired = engine.checkFinalAnswer(input)
    expect(fired?.kind).toBe('nudge2')
  })

  it('未用工具时不触发', () => {
    const engine = new NudgeEngine()
    const input = makeInput({
      parsed: makeParsed({ content: '这可能只是在沙箱中执行' })
    })
    expect(engine.checkFinalAnswer(input)).toBeNull()
  })
})

describe('NudgeEngine — nudge3 搜索不足就放弃', () => {
  it('搜索后回答"未找到"时触发换词搜索', () => {
    const engine = new NudgeEngine()
    const input = makeInput({
      reactSteps: [toolStep('web_search', '链接: https://example.com/1')],
      parsed: makeParsed({ content: '抱歉，未找到相关数据' })
    })
    const fired = engine.checkFinalAnswer(input)
    expect(fired?.kind).toBe('nudge3')
    expect(fired!.observation).toContain('https://example.com/1')
  })

  it('已搜索 3 次后不再触发', () => {
    const engine = new NudgeEngine()
    const input = makeInput({
      reactSteps: [toolStep(), toolStep(), toolStep()],
      parsed: makeParsed({ content: '抱歉，未找到相关数据' })
    })
    expect(engine.checkFinalAnswer(input)).toBeNull()
  })
})

describe('NudgeEngine — nudge4 推卸工作给用户', () => {
  it('未用工具且回答让用户自己操作时触发', () => {
    const engine = new NudgeEngine()
    const input = makeInput({
      parsed: makeParsed({ content: '你可以通过任务管理器查看进程' })
    })
    const fired = engine.checkFinalAnswer(input)
    expect(fired?.kind).toBe('nudge4')
  })

  it('用过工具后不触发', () => {
    const engine = new NudgeEngine()
    const input = makeInput({
      reactSteps: [toolStep('terminal')],
      parsed: makeParsed({ content: '你可以通过任务管理器查看进程' })
    })
    expect(engine.checkFinalAnswer(input)).toBeNull()
  })
})

describe('NudgeEngine — nudge5 声称不能', () => {
  it('未用工具且声称"我无法"时触发', () => {
    const engine = new NudgeEngine()
    const input = makeInput({
      parsed: makeParsed({ content: '我无法获取你的位置信息' })
    })
    const fired = engine.checkFinalAnswer(input)
    expect(fired?.kind).toBe('nudge5')
  })
})

describe('NudgeEngine — nudge6 空 CONTENT', () => {
  it('用过工具但 FINAL_ANSWER 无内容时触发', () => {
    const engine = new NudgeEngine()
    const input = makeInput({
      reactSteps: [toolStep('file_reader', 'file content')],
      parsed: makeParsed({ content: '', actionInput: '', hasContent: false })
    })
    const fired = engine.checkFinalAnswer(input)
    expect(fired?.kind).toBe('nudge6')
    expect(engine.isExhausted('nudge6')).toBe(false)
  })

  it('触发 2 次后 isExhausted 为 true（供兜底逻辑判断）', () => {
    const engine = new NudgeEngine()
    const input = makeInput({
      reactSteps: [toolStep('file_reader', 'file content')],
      parsed: makeParsed({ content: '', actionInput: '', hasContent: false })
    })
    engine.checkFinalAnswer(input)
    engine.checkFinalAnswer(input)
    expect(engine.isExhausted('nudge6')).toBe(true)
    expect(engine.checkFinalAnswer(input)).toBeNull()
  })
})

describe('NudgeEngine — 优先级顺序', () => {
  it('nudge1 优先于 nudge4/5（首轮无工具时）', () => {
    const engine = new NudgeEngine()
    // 同时满足 nudge1（首轮+需要工具）、nudge4（你可以查看）、nudge5（我无法）
    const input = makeInput({
      iteration: 0,
      toolAssessment: { needsTool: true, suggestedTools: [], reason: '' },
      parsed: makeParsed({ content: '我无法帮你，你可以查看任务管理器' })
    })
    const fired = engine.checkFinalAnswer(input)
    expect(fired?.kind).toBe('nudge1')
  })
})
