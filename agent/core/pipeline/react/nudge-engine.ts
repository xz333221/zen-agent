/**
 * 纠偏引擎（NudgeEngine）
 *
 * ReAct 循环中的 7 种纠偏机制，从原 agent-loop.ts 主循环中剥离。
 * 每种机制检测一种 LLM 的常见失败模式，注入一条"系统提醒"观察
 * 让模型重试，每种机制最多触发 NUDGE_MAX 次（防止无限循环）。
 *
 * 机制一览:
 *  1   未使用工具就直接回答（但问题明显需要工具）
 *  1.5 未搜索就输出具体数据（复用对话历史中的旧数据）
 *  2   使用了工具但不信任结果（声称"在沙箱中"等）
 *  3   搜索结果不足就放弃
 *  4   把本可以自己完成的工作推卸给用户
 *  5   声称"我不能/没有能力"但实际有工具可用
 *  6   FINAL_ANSWER 但无 CONTENT（模型放弃或格式错误）
 *  7   只输出 THOUGHT 没有 ACTION（格式不完整）
 *  8   工具因参数名错误而失败（如用 query 代替 command/path）
 */

import { getToolDefs } from '../../action-executor'
import { getToolParamExample } from '../../../tools/param-examples'
import type { ReActStep } from '../../types'
import type { AnyMessage } from '../../../utils/multimodal'
import type { ParsedReActResponse } from './react-parser'
import type { ToolAssessment } from './tool-assessor'

/** 纠偏检查的输入 */
export interface NudgeInput {
  parsed: ParsedReActResponse
  reactSteps: ReActStep[]
  /** 当前迭代序号（0 起） */
  iteration: number
  maxIterations: number
  thinkResponse: string
  toolAssessment: ToolAssessment
  toolNames: string[]
  historyMessages: AnyMessage[]
}

/** 纠偏触发结果 */
export interface NudgeFired {
  /** 机制标识（用于日志） */
  kind: 'nudge1' | 'nudge15' | 'nudge2' | 'nudge3' | 'nudge4' | 'nudge5' | 'nudge6' | 'nudge7' | 'nudge8' | 'nudge9' | 'nudge10'
  /** 注入给模型的系统提醒（作为 observation） */
  observation: string
  /** Think 步骤重命名标签 */
  stepLabel: string
  /** 当前触发次数 / 上限 */
  count: number
  max: number
}

type NudgeKind = NudgeFired['kind']

export class NudgeEngine {
  private counts: Record<NudgeKind, number> = {
    nudge1: 0,
    nudge15: 0,
    nudge2: 0,
    nudge3: 0,
    nudge4: 0,
    nudge5: 0,
    nudge6: 0,
    nudge7: 0,
    nudge8: 0,
    nudge9: 0,
    nudge10: 0
  }

  private readonly NUDGE_MAX = 2

  /** 某机制是否已耗尽（react-loop 的兜底逻辑需要判断 nudge6） */
  isExhausted(kind: NudgeKind): boolean {
    return this.counts[kind] >= this.NUDGE_MAX
  }

  /**
   * 纠偏机制 7：模型只输出 THOUGHT 没有 ACTION（格式不完整）
   *
   * 当模型输出了 THOUGHT 但没有 ACTION 字段时，说明格式不完整。
   * 解析器会把这种情况默认为 FINAL_ANSWER，但实际上模型只是忘了写 ACTION。
   * 注入格式纠正 nudge，让模型补上 ACTION 和 ACTION_INPUT（或 CONTENT）。
   */
  checkIncompleteFormat(input: NudgeInput): NudgeFired | null {
    const { parsed, iteration, maxIterations, toolAssessment } = input

    if (parsed.hasAction || parsed.hasContent || !parsed.thought) return null
    if (this.counts.nudge7 >= this.NUDGE_MAX) return null
    if (iteration >= maxIterations - 2) return null

    this.counts.nudge7++

    // 根据工具评估结果给出针对性建议
    let toolHint = ''
    if (toolAssessment.needsTool && toolAssessment.suggestedTools.length > 0) {
      toolHint = `\n💡 系统建议你使用以下工具: ${toolAssessment.suggestedTools.join(', ')}（原因: ${toolAssessment.reason}）`
    }

    return {
      kind: 'nudge7',
      count: this.counts.nudge7,
      max: this.NUDGE_MAX,
      stepLabel: 'Think (已驳回，格式不完整，需补上 ACTION)',
      observation: `[系统提醒] 你的回复只有 THOUGHT，缺少 ACTION 字段。请按照以下格式补全回复：

如果要使用工具：
THOUGHT: <你的思考>
ACTION: <工具名称，如 web_search / file_reader / terminal 等>
ACTION_INPUT: <JSON 格式的工具参数>

如果要直接回答：
THOUGHT: <你的思考>
ACTION: FINAL_ANSWER
CONTENT: <给用户的回答内容>${toolHint}

请重新回复，确保包含 ACTION 字段。`
    }
  }

  /**
   * 纠偏机制 1-6：FINAL_ANSWER / DIRECT_ANSWER 场景，按优先级顺序检查
   *
   * 返回第一个触发的纠偏；都不触发返回 null（表示可以接受最终回答）。
   */
  checkFinalAnswer(input: NudgeInput): NudgeFired | null {
    return this.checkNoToolUse(input)
      ?? this.checkStaleData(input)
      ?? this.checkDistrust(input)
      ?? this.checkInsufficientSearch(input)
      ?? this.checkLazyAnswer(input)
      ?? this.checkAskForConfirmation(input)
      ?? this.checkGiveUp(input)
      ?? this.checkEmptyContent(input)
  }

  /**
   * 纠偏机制 1：未使用工具就回答
   *
   * 如果第一轮 LLM 就想直接回答（没用过任何工具），但用户的问题明显需要本地操作，
   * 注入强提醒让 LLM 使用 terminal/file_reader 等工具，然后重试。
   */
  private checkNoToolUse(input: NudgeInput): NudgeFired | null {
    const { parsed, reactSteps, iteration, toolAssessment } = input

    if (iteration !== 0 || reactSteps.length !== 0) return null
    if (!toolAssessment.needsTool) return null
    if (this.counts.nudge1 >= this.NUDGE_MAX) return null

    this.counts.nudge1++

    const suggestedHint = toolAssessment.suggestedTools.length > 0
      ? `\n💡 系统评估建议使用的工具: ${toolAssessment.suggestedTools.join(', ')}（原因: ${toolAssessment.reason}）`
      : ''

    return {
      kind: 'nudge1',
      count: this.counts.nudge1,
      max: this.NUDGE_MAX,
      stepLabel: 'Think (已驳回，需用工具)',
      observation: `[系统提醒] 你直接给出了最终答案，但你还没有尝试使用工具。你运行在用户的本地电脑上（不是远程服务器），你有多种工具可以使用。请重新思考：用户想要什么操作？你应该用哪个工具？${suggestedHint}\n请按照 THOUGHT/ACTION/ACTION_INPUT 格式回复，使用合适的工具（如 web_search 搜索网络、terminal 执行命令、file_reader 读取文件等）完成用户的请求。`
    }
  }

  /**
   * 纠偏机制 1.5：未搜索就输出具体数据（复用旧对话数据）
   *
   * LLM 没有使用任何工具，但最终回答中包含具体数据（数字、时间戳、表格等），
   * 说明它直接复用了对话历史中的旧数据，而不是搜索获取最新数据。
   * 这种情况在 follow-up 请求中尤其常见（如用户说"给我准确的数据"）。
   */
  private checkStaleData(input: NudgeInput): NudgeFired | null {
    const { parsed, iteration, thinkResponse, historyMessages } = input

    const hasExecutedTools = this.hasExecutedTools(input.reactSteps)
    const hasNotUsedTools = input.reactSteps.length === 0 || !hasExecutedTools

    if (!hasNotUsedTools || iteration !== 0) return null
    if (this.counts.nudge15 >= this.NUDGE_MAX) return null
    if (iteration >= input.maxIterations - 2) return null

    const answerText = (parsed.actionInput || parsed.content || thinkResponse || '')
    const answerLower = answerText.toLowerCase()

    // 检测回答中是否包含具体数据模式
    const hasSpecificData =
      // 包含具体数字（如 3993.33, -0.07%, 4027.26 等）
      /\d{3,}\.\d{2}/.test(answerText) ||
      // 包含时间戳（如 09:23, 11:40, 15:00 等）
      /\d{1,2}:\d{2}/.test(answerText) ||
      // 包含"数据未获取到"等放弃措辞
      answerLower.includes('数据未获取') || answerLower.includes('数据加载中') ||
      // 包含表格格式（markdown table）
      /\|.*\d.*\|/.test(answerText) ||
      // 包含具体价格/点数
      /点|元|港元|美元/.test(answerText) && /\d{3,}/.test(answerText)

    // 检测对话历史中是否包含实时数据话题
    let hasRealtimeContext = false
    if (historyMessages && historyMessages.length > 0) {
      const recentContext = historyMessages
        .slice(-6)
        .map(m => m.content)
        .join(' ')
        .toLowerCase()
      const realtimeTopics = [
        '股价', '大盘', '指数', '上证', '深证', '创业板', 'a股', '股票',
        '行情', '涨跌', '收盘', '开盘', '盘中', '天气', '气温', '汇率',
        '油价', '金价', '新闻', '今日行情',
      ]
      hasRealtimeContext = realtimeTopics.some(kw => recentContext.includes(kw))
    }

    if (!hasSpecificData || !hasRealtimeContext) return null

    this.counts.nudge15++

    return {
      kind: 'nudge15',
      count: this.counts.nudge15,
      max: this.NUDGE_MAX,
      stepLabel: 'Think (已驳回，重新思考)',
      observation: `[系统提醒] 你的回答中包含具体数据（数字、时间戳等），但你没有使用任何工具搜索获取最新数据。这些数据很可能来自之前对话中的旧信息，可能已经过时。

⚠️ 重要：不要直接复用对话历史中的数据来回答用户！当用户要求"准确的数据"或"更新"时，你必须使用 web_search 工具重新搜索获取最新数据。

请重新思考：
1. 用户想要什么数据？（如大盘指数、股价、天气等）
2. 你应该用什么搜索关键词？（简洁精准，如"上证指数 今日行情"）
3. 请使用 web_search 工具搜索，然后基于搜索结果回答。

请按照 THOUGHT/ACTION/ACTION_INPUT 格式回复，使用 web_search 工具获取最新数据。`
    }
  }

  /**
   * 纠偏机制 2：使用了工具但不信任结果
   *
   * LLM 成功执行了工具，但在最终回答中声称"结果不可信"、"在沙箱中"等。
   * 这种情况下，注入提醒让 LLM 信任工具结果。
   */
  private checkDistrust(input: NudgeInput): NudgeFired | null {
    const { parsed, iteration, thinkResponse } = input

    const finalText = (parsed.actionInput || parsed.content || thinkResponse || '').toLowerCase()
    const hasExecutedTools = this.hasExecutedTools(input.reactSteps)

    const distrustPatterns = [
      '沙箱', 'sandbox', '不可信', '并不真实', '不真实', '虚假',
      '无法访问', '不能真正', '不能访问', '无法真正',
      '我没有你的', '我无法替你', '本地 powershell',
      // 注意：'远程' 和 '容器' 单独匹配会误触发
      // （如"远程仓库"是 git 术语），改用更具体的短语
      '远程服务器', '远程容器', '远程环境', '远程机器',
      '容器中', 'container环境', 'docker容器',
      '不是真的', '不是真正', '并非真正', '模拟环境',
      '测试环境', 'mock', '假的', '不是实际',
    ]
    const hasDistrust = distrustPatterns.some(p => finalText.includes(p))

    if (!hasExecutedTools || !hasDistrust) return null
    if (this.counts.nudge2 >= this.NUDGE_MAX) return null
    if (iteration >= input.maxIterations - 2) return null

    this.counts.nudge2++

    return {
      kind: 'nudge2',
      count: this.counts.nudge2,
      max: this.NUDGE_MAX,
      stepLabel: 'Think (已驳回，重新思考)',
      observation: '[系统提醒] 你已经成功使用工具执行了命令，工具返回的结果是真实可信的。你运行在用户的本地电脑上（不是沙箱、不是远程容器），terminal 工具的 stdout 是命令在用户电脑上的实际输出。命令执行成功（exit 0）就代表操作真的完成了。请不要质疑工具结果，直接基于工具的输出向用户报告操作结果即可。'
    }
  }

  /**
   * 纠偏机制 3：搜索结果不足就放弃
   *
   * LLM 执行了 web_search，但最终回答中包含"数据加载中""盘中""尚未稳定"等措辞，
   * 说明搜索结果没有获取到用户需要的具体数据，但 LLM 直接放弃了。
   * 此时注入提醒，让 LLM 换关键词再搜索或用 fetch_url 抓取具体页面。
   */
  private checkInsufficientSearch(input: NudgeInput): NudgeFired | null {
    const { parsed, reactSteps, iteration, thinkResponse, toolNames } = input

    const finalText = (parsed.actionInput || parsed.content || thinkResponse || '').toLowerCase()
    const hasExecutedTools = this.hasExecutedTools(reactSteps)

    const searchNudgePatterns = [
      '数据加载中', '加载中', '尚未稳定', '尚未返回', '暂无数据',
      '盘中动态可查', '盘中实时刷新', '数据加载', '暂未返回',
      '未找到关于', '未找到', '无搜索结果', '搜索结果为空',
      '无法获取', '未能获取', '获取失败',
      '建议你', '建议查看', '建议你查看',  // 过度推卸给用户
    ]
    const hasSearchNudge = searchNudgePatterns.some(p => finalText.includes(p))
    const searchCount = reactSteps.filter(s => s.action === 'web_search').length
    const fetchCount = reactSteps.filter(s => s.action === 'fetch_url').length
    const hasSearchTool = toolNames.includes('web_search')
    const hasFetchTool = toolNames.includes('fetch_url')

    if (!hasExecutedTools || !hasSearchNudge || !hasSearchTool) return null
    if (this.counts.nudge3 >= this.NUDGE_MAX) return null
    if (iteration >= input.maxIterations - 2) return null
    if (searchCount >= 3) return null  // 限制纠偏次数

    this.counts.nudge3++

    // 收集搜索结果中的 URL，供 LLM 参考
    const searchUrls: string[] = []
    for (const step of reactSteps) {
      if (step.action === 'web_search' && step.observation) {
        const urlMatches = step.observation.match(/链接:\s*(https?:\/\/[^\s\n]+)/g)
        if (urlMatches) {
          for (const m of urlMatches) {
            const url = m.replace(/链接:\s*/, '').trim()
            if (!searchUrls.includes(url)) searchUrls.push(url)
          }
        }
      }
    }

    const urlList = searchUrls.length > 0
      ? `\n之前搜索结果中的 URL（可以用 fetch_url 抓取）：\n${searchUrls.slice(0, 5).map((u, idx) => `  ${idx + 1}. ${u}`).join('\n')}`
      : ''

    const fetchHint = hasFetchTool
      ? `\n或者使用 fetch_url 工具抓取之前搜索结果中的具体页面 URL，获取页面中的实时数据。`
      : ''

    return {
      kind: 'nudge3',
      count: this.counts.nudge3,
      max: this.NUDGE_MAX,
      stepLabel: 'Think (已驳回，重新思考)',
      observation: `[系统提醒] 你的回答中包含"数据加载中"/"暂无数据"等措辞，说明你还没有获取到用户需要的具体数据。不要轻易放弃！请尝试以下策略：
1. 换不同关键词再搜索一次（用更短、更精准的关键词，如"上证指数 今日" 而不是 "2026年7月13日 A股大盘走势 上证指数"）
2. 如果之前搜索结果中有可能包含数据的页面 URL，使用 fetch_url 工具抓取该页面内容${fetchHint}
3. 尝试搜索数据源网站的页面（如东方财富 quote.eastmoney.com、雪球 xueqiu.com 等）

已搜索 ${searchCount} 次，已抓取 ${fetchCount} 个页面。${urlList}

请继续尝试，直到获取到实际数据或确认确实无法获取后再回答。`
    }
  }

  /**
   * 纠偏机制 4：推卸工作给用户
   *
   * LLM 没有使用工具（或使用后仍在回答中让用户自己去做），
   * 但回答中包含"告诉我你的 XX""你可以通过 XX 查看""你可以自己 XX"等措辞，
   * 说明它把本可以自己完成的工作推给了用户。
   */
  private checkLazyAnswer(input: NudgeInput): NudgeFired | null {
    const { parsed, iteration, thinkResponse, toolNames } = input

    const lazyPatterns = [
      '告诉我你的', '告诉我你', '请告诉我', '可以告诉我',
      '你可以通过', '你可以查看', '你可以自己', '你可以用',
      '你可以导出', '你可以定位', '你可以找到', '你可以查看完整',
      '你可以直接定位', '你可以界面', '你可以在界面',
      '如果你需要我', '如果你需要', '可以告诉我你的操作系统',
      '告诉我你的操作系统', '告诉我你的系统',
      '你可以终端', '你可以命令', '你可以查看历史',
      '你可以右键', '你可以设置', '你可以打开',
      '请提供你的', '请告诉我你的', '需要你提供',
      '你需要告诉我', '需要你提供',
    ]
    const answerText = (parsed.actionInput || parsed.content || thinkResponse || '').toLowerCase()
    const hasLazyPattern = lazyPatterns.some(p => answerText.includes(p))
    const hasTools = toolNames.length > 0
    const hasNotUsedTools = !this.hasExecutedTools(input.reactSteps)

    if (!hasLazyPattern || !hasTools || !hasNotUsedTools) return null
    if (this.counts.nudge4 >= this.NUDGE_MAX) return null
    if (iteration >= input.maxIterations - 2) return null

    this.counts.nudge4++

    return {
      kind: 'nudge4',
      count: this.counts.nudge4,
      max: this.NUDGE_MAX,
      stepLabel: 'Think (已驳回，重新思考)',
      observation: `[系统提醒] 你的回答中包含"告诉我你的 XX""你可以通过 XX 查看"等措辞，把本可以自己完成的工作推给了用户。这是不允许的！

⚠️ 重要原则：你是运行在用户本地电脑上的 AI 助手，你有 terminal、file_reader、file_search 等工具。你应该主动使用这些工具帮用户完成任务，而不是让用户自己去做。

具体来说：
1. 你已经知道用户的操作系统（${process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux'}），不需要询问用户操作系统版本
2. 当用户问"存储位置""文件在哪""路径是什么"时，用 terminal 工具执行命令查找（如 dir /s 搜索文件，或查看应用数据目录）
3. 当用户问"有哪些项目"时，用 file_search 工具搜索
4. 当用户问"查看文件内容"时，用 file_reader 工具读取
5. 当用户问"执行命令"时，用 terminal 工具执行
6. 绝对不要说"你可以通过 XX 功能查看""你可以自己 XX""告诉我你的 XX" — 这些是你应该做的事！

请重新思考：用户想要什么？你应该用哪个工具来完成？请按照 THOUGHT/ACTION/ACTION_INPUT 格式回复，使用合适的工具。`
    }
  }

  /**
   * 纠偏机制 9：征询确认而非直接动手（编码任务的"方案确认"陷阱）
   *
   * 与 nudge4 的区别：nudge4 处理"没用过工具就把工作推给用户"（要求 hasNotUsedTools），
   * 而本机制处理"已经用工具探索过项目，却给出完整方案让用户确认再动手"。
   * 这种情况 nudge4 不会触发（因为已用过工具），但本质上仍是把本可自己完成的
   * 编码动作推给了用户。
   *
   * 典型表现：
   *  - "要不要我现在就开始动手？"
   *  - "告诉我「开始吧」我就直接改"
   *  - "建议分两步：先做后端，再做前端"
   *  - "接下来怎么走？"
   *
   * 触发条件：命中征询措辞 + 有可用工具（尤其 file_writer）+ 未达上限。
   * 不要求"没用过工具"——即使已探索过项目，只要还在征询确认而非动手，就纠偏。
   */
  private checkAskForConfirmation(input: NudgeInput): NudgeFired | null {
    const { parsed, iteration, thinkResponse, toolNames } = input

    // 征询确认再动手的措辞模式
    const askConfirmPatterns = [
      // 直接征询"要不要/需不需要我开始"
      '要不要我现在', '要不要我开始', '要不要我直接', '要不要我动手',
      '需要我开始', '需要我直接', '需要我动手', '是否开始',
      '是否需要我', '是否要我', '要不要我',
      // "告诉我开始吧 / 告诉我「"
      '告诉我「', '告诉我开始', '告诉我「开始',
      // "我就直接改/动手"（暗示在等指令）
      '我就直接改', '我就开始', '我就动手', '我就直接动手',
      // 分步征询
      '建议分两步', '先做后端', '先做前端', '先动后端', '先动前端',
      '先改后端', '先改前端', '先做后端再', '先做前端再',
      // "接下来怎么走"
      '接下来怎么走', '接下来怎么做', '接下来如何',
      // 等待用户确认信号
      '确认后我就', '你说一声我就', '等你说', '等你确认',
      // "可以开始吗 / 行吗"
      '可以开始吗', '可以动手吗', '可以吗？',
    ]
    const answerText = (parsed.actionInput || parsed.content || thinkResponse || '').toLowerCase()
    const hasAskConfirm = askConfirmPatterns.some(p => answerText.includes(p))
    const hasTools = toolNames.length > 0

    if (!hasAskConfirm || !hasTools) return null
    if (this.counts.nudge9 >= this.NUDGE_MAX) return null
    if (iteration >= input.maxIterations - 2) return null

    // 如果有 file_writer 工具，说明模型完全有能力直接写代码
    const hasFileWriter = toolNames.includes('file_writer')
    // 如果有 terminal 工具，也能执行命令式修改
    const hasTerminal = toolNames.includes('terminal')

    this.counts.nudge9++

    const toolHint = hasFileWriter
      ? `你有 file_writer 工具，可以直接写入/修改文件（参数: {"path": "...", "content": "...", "mode": "write"/"append"}）。`
      : hasTerminal
        ? `你有 terminal 工具，可以直接执行命令修改文件（如用 powershell 写入、用 git apply 打补丁等）。`
        : `你有 ${toolNames.join(', ')} 等工具，请直接用工具完成任务。`

    return {
      kind: 'nudge9',
      count: this.counts.nudge9,
      max: this.NUDGE_MAX,
      stepLabel: 'Think (已驳回，不要征询确认，直接动手)',
      observation: `[系统提醒] 你的回答中包含"要不要我开始""告诉我开始吧""建议分两步"等征询确认的措辞，把本可以自己完成的动作推给了用户。这不允许！

⚠️ 核心原则（编码任务）：用户让你写代码/改代码/实现功能，就是授权你直接动手。你不应该先给出完整方案让用户确认再动手，而应该直接用工具完成修改。

具体要求：
1. ${toolHint}
2. 对于编码任务，直接用 file_writer 写入修改后的文件内容，或用 terminal 执行修改命令
3. 不要说"要不要我开始""告诉我开始吧""建议分两步""接下来怎么走" — 直接做
4. 只有在以下情况才需要征询用户：
   - 存在多个差异很大、影响重大的实现方向需要用户拍板
   - 涉及不可逆的危险操作（如删除重要文件、覆盖未备份的数据、推送到远程主分支等）
   - 用户的需求本身存在歧义，无法合理推断
5. 除此之外，能自己做的就直接做完，做完后简要汇报改了什么即可

请重新思考：用户让你做什么？你现在掌握的信息是否足够直接动手？如果足够，直接使用工具修改文件；如果确实缺信息，用工具去获取（读文件、执行命令），而不是问用户。

请按照 THOUGHT/ACTION/ACTION_INPUT 格式回复，使用 file_writer 等工具直接动手。`
    }
  }

  /**
   * 纠偏机制 5：声称"我不能/没有能力"但实际有工具可用
   *
   * LLM 没有使用工具就回答，且回答中包含"我没有能力""我无法""我做不到"等放弃措辞。
   * 这种情况下，LLM 可能不知道自己可以用工具解决这个问题。
   */
  private checkGiveUp(input: NudgeInput): NudgeFired | null {
    const { parsed, iteration, thinkResponse, toolNames } = input

    const giveUpPatterns = [
      '我没有能力', '我无法', '我做不到', '我不能', '我没有办法',
      '我没有gps', '没有gps', '没有定位', '无法定位', '无法获取',
      '无法访问', '不能访问', '无法真正', '不能真正',
      '没有访问', '不能获取', '无法知道', '不能知道',
      '我不知道你在哪', '不知道你在哪', '无法知道你的',
      '我没有你的', '我没有这个能力', '不具备',
      '没有这个功能', '没有这种能力', '无法提供',
      '无法精确', '不能精确', '无法确定', '不能确定',
      '我没有权限', '无法访问你的',
      'i don\'t have', 'i cannot', 'i can\'t', 'i don\'t know',
      'unable to', 'no access', 'no capability',
    ]
    const answerText = (parsed.actionInput || parsed.content || thinkResponse || '').toLowerCase()
    const hasGiveUp = giveUpPatterns.some(p => answerText.includes(p))
    const hasTools = toolNames.length > 0
    const hasNotUsedTools = !this.hasExecutedTools(input.reactSteps)

    if (!hasGiveUp || !hasTools || !hasNotUsedTools) return null
    if (this.counts.nudge5 >= this.NUDGE_MAX) return null
    if (iteration >= input.maxIterations - 2) return null

    this.counts.nudge5++

    // 构建工具能力提示
    const toolDefs = getToolDefs()
    const toolCapabilities = toolDefs.map(t => `- ${t.id}: ${t.description.slice(0, 120)}`).join('\n')

    return {
      kind: 'nudge5',
      count: this.counts.nudge5,
      max: this.NUDGE_MAX,
      stepLabel: 'Think (已驳回，重新思考)',
      observation: `[系统提醒] 你的回答中包含"我没有能力""我无法""我做不到"等措辞，但你还没有尝试使用工具！

⚠️ 重要：你运行在用户的本地电脑上，你有以下工具：
${toolCapabilities}

在说"我不能"之前，请先思考：
1. 这个问题是否可以通过执行命令来解决？（如 curl 获取网络信息、dir 查找文件、系统命令获取硬件信息等）
2. 这个问题是否可以通过搜索网络来解决？（如查最新信息、查概念解释等）
3. 这个问题是否可以通过读取本地文件来解决？

常见例子：
- "你在哪/你的位置" → 用 terminal 执行 curl ipinfo.io 获取 IP 地理位置
- "你有什么文件/项目" → 用 file_search 搜索
- "文件内容是什么" → 用 file_reader 读取
- "最新信息" → 用 web_search 搜索
- "系统信息" → 用 terminal 执行系统命令（如 systeminfo、wmic 等）

请重新思考：你能用哪个工具来解决这个问题？请按照 THOUGHT/ACTION/ACTION_INPUT 格式回复，尝试使用工具。`
    }
  }

  /**
   * 纠偏机制 6：FINAL_ANSWER 但没有 CONTENT（模型放弃或格式错误）
   *
   * 当模型输出了 FINAL_ANSWER 但没有 CONTENT 字段时，
   * 说明模型要么想继续但错误地结束了，要么忘记写 CONTENT。
   * 只要已用过工具且无 CONTENT 就触发，不管是否有"继续"意图。
   */
  private checkEmptyContent(input: NudgeInput): NudgeFired | null {
    const { parsed, iteration } = input

    const hasEmptyContent = !parsed.content && !parsed.actionInput
    const hasExecutedTools = this.hasExecutedTools(input.reactSteps)

    if (!hasEmptyContent || !hasExecutedTools) return null
    if (this.counts.nudge6 >= this.NUDGE_MAX) return null
    if (iteration >= input.maxIterations - 2) return null

    this.counts.nudge6++

    return {
      kind: 'nudge6',
      count: this.counts.nudge6,
      max: this.NUDGE_MAX,
      stepLabel: 'Think (已驳回，需给出回答或继续用工具)',
      observation: `[系统提醒] 你输出了 FINAL_ANSWER 但没有给出 CONTENT（给用户的实际回答内容）。你已经执行过工具获取了信息，现在必须基于已有信息给用户回答。

请选择以下方式之一：
1. 如果你已经从之前的工具调用中获取了有用信息（如读取了文件、搜索到结果），请基于已有信息给用户一个总结性回答。回答必须写在 CONTENT 字段中。
2. 如果你确实还需要继续用工具获取更多信息，请使用对应的工具（web_search/fetch_url/file_reader/terminal 等），而不是 FINAL_ANSWER。

格式（给出回答）:
THOUGHT: 基于已获取的信息，我得出结论...
ACTION: FINAL_ANSWER
CONTENT: （给用户的实际回答，必须有实质内容，不能为空）

格式（继续用工具）:
THOUGHT: 我需要继续获取...
ACTION: web_search
ACTION_INPUT: {"query": "..."}`
    }
  }

  /**
   * 纠偏机制 8：工具因参数名错误而失败
   *
   * 检测上一步工具执行失败且错误信息含"缺少XX参数"/"XX parameter is required"，
   * 说明模型用了错误的参数名（如对 terminal 用 query 而非 command）。
   * 注入纠偏提醒，告知正确参数名和示例。
   *
   * @param stepsToScan 可选：要扫描的步骤集合（多 tool_calls 批量执行后传入
   *                    本批新产生的 steps）；缺省只检查 reactSteps 最后一条
   */
  checkWrongParams(input: NudgeInput, stepsToScan?: ReActStep[]): NudgeFired | null {
    const { reactSteps, iteration, maxIterations } = input

    // 检测参数错误模式
    const paramErrorPatterns = [
      /缺少\S*参数/,
      /parameter is required/i,
      /missing.*parameter/i,
    ]

    // 批量执行时扫描本批所有 steps，找第一条参数错误者；缺省只看最后一条
    const candidates = stepsToScan && stepsToScan.length > 0
      ? stepsToScan
      : reactSteps.slice(-1)

    const failedStep = candidates.find(s =>
      s.action !== 'FINAL_ANSWER' &&
      s.action !== 'DIRECT_ANSWER' &&
      paramErrorPatterns.some(re => re.test(s.observation || ''))
    )
    if (!failedStep) return null

    if (this.counts.nudge8 >= this.NUDGE_MAX) return null
    if (iteration >= maxIterations - 2) return null

    this.counts.nudge8++

    // 构建该工具的正确参数提示
    const toolDefs = getToolDefs()
    const toolDef = toolDefs.find(t => t.id === failedStep.action)
    let paramHint = ''
    if (toolDef) {
      const params = Object.entries(toolDef.schema.properties)
        .map(([name, prop]) => {
          const req = toolDef.schema.required.includes(name) ? '必填' : '可选'
          return `  ${name} (${prop.type}, ${req}): ${prop.description}`
        })
        .join('\n')
      paramHint = `\n\n工具 ${failedStep.action} 的正确参数：\n${params}\n\n正确示例：`

      // 共享示例表（与 param-normalizer 的 hint 同一数据源）
      const example = getToolParamExample(failedStep.action)
      if (example) {
        paramHint += `\n${example}`
      }
    }

    return {
      kind: 'nudge8',
      count: this.counts.nudge8,
      max: this.NUDGE_MAX,
      stepLabel: 'Think (已驳回，参数名错误)',
      observation: `[系统提醒] 上一步工具 ${failedStep.action} 执行失败，原因是你用了错误的参数名。${paramHint}

⚠️ 重要：每个工具有不同的参数名，不能通用 "query"！
- terminal 用 "command"（不是 query）
- file_reader 用 "path"（不是 query）
- web_search / file_search 用 "query"

请重新调用 ${failedStep.action} 工具，使用正确的参数名。`
    }
  }

  /**
   * 纠偏机制 10：模型调用了不存在的工具名
   *
   * 文本 ReAct 协议下模型可能幻觉出工具名（如 file_write / read_file）。
   * 旧行为是把 thought 当作最终回答输出并结束循环 —— 对编码任务是灾难。
   * 改为注入纠偏提醒，让模型用正确的工具名重试。
   */
  checkUnknownTool(
    action: string,
    iteration: number,
    maxIterations: number,
    toolNames: string[]
  ): NudgeFired | null {
    if (this.counts.nudge10 >= this.NUDGE_MAX) return null
    if (iteration >= maxIterations - 2) return null

    this.counts.nudge10++

    return {
      kind: 'nudge10',
      count: this.counts.nudge10,
      max: this.NUDGE_MAX,
      stepLabel: 'Think (已驳回，工具名不存在)',
      observation: `[系统提醒] 你尝试调用工具 "${action}"，但它不存在。可用工具只有：${toolNames.join(', ')}。

请从可用工具列表中选择正确的工具名重新调用；如果现有工具确实都无法完成任务，再用 FINAL_ANSWER 回答（并说明限制）。

请按照 THOUGHT/ACTION/ACTION_INPUT 格式回复。`
    }
  }

  /** 是否已执行过真实工具调用（排除 FINAL_ANSWER / DIRECT_ANSWER 占位步骤） */
  private hasExecutedTools(reactSteps: ReActStep[]): boolean {
    return reactSteps.some(s => s.action !== 'FINAL_ANSWER' && s.action !== 'DIRECT_ANSWER')
  }
}
