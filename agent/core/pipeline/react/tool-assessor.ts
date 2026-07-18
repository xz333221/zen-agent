/**
 * 工具需求评估
 *
 * 两级策略:
 * 1. shouldUseTool — 关键词快速预筛（命中则跳过 LLM 评估，节省 API 调用）
 * 2. assessToolNeed — LLM 驱动的语义级评估（替代维护无尽的关键词列表）
 */

import { isLLMConfigured, getConfig } from '../../../providers/llm-config'
import { countTextTokens } from '../../../utils/token-counter'
import { extractTextFromContent, type AnyMessage } from '../../../utils/multimodal'
import { formatToolDescriptions } from './prompts'
import type { ToolDef } from '../../../tools/types'
import type { PipelineContext } from '../context'

/** 工具评估结果 */
export interface ToolAssessment {
  needsTool: boolean
  suggestedTools: string[]
  reason: string
}

export const EMPTY_ASSESSMENT: ToolAssessment = {
  needsTool: false,
  suggestedTools: [],
  reason: ''
}

/**
 * 检测用户输入是否暗示需要使用工具（关键词快速预筛）
 *
 * 当用户要求执行本地操作（git, 运行代码, 提交, 推送等）时，
 * LLM 不应该直接回答"我做不到"，而应该尝试使用 terminal/file_reader 等工具。
 *
 * 也检查对话历史上下文 — 当用户发送 follow-up 消息（如"给我准确的数据"）
 * 且对话历史中包含实时数据相关话题时，也应触发工具使用。
 */
export function shouldUseTool(
  userInput: string,
  availableTools: string[],
  historyMessages?: AnyMessage[]
): boolean {
  if (availableTools.length === 0) return false

  const input = userInput.toLowerCase()

  // 终端操作关键词
  const terminalKeywords = [
    'git', 'commit', 'push', 'pull', 'merge', 'branch', '提交', '推送', '拉取',
    'npm', 'yarn', 'pnpm', 'pip', 'install', '安装', '运行', '执行',
    'node', 'python', 'go run', 'cargo', 'make',
    '命令行', '终端', 'terminal', 'cmd', 'shell',
    'build', '编译', '打包', 'deploy', '部署',
    '启动', '重启', 'start', 'restart', 'stop',
    'status', 'log', 'diff', '查看状态'
  ]

  // 文件操作关键词
  const fileKeywords = [
    '读取文件', '查看文件', '打开文件', '修改文件', '写入文件', '创建文件',
    'read file', 'write file', 'edit file', '看一下文件',
    'package.json', 'config', '配置文件', '.ts', '.js', '.py', '.vue',
    '代码', '源码', '看看这个文件'
  ]

  // 文件搜索关键词（file_search）
  const fileSearchKeywords = [
    '找', '查找文件', '查找项目', '搜索文件', '搜索项目', '找一下',
    '有没有', '在哪个', '在哪个目录', '项目在哪', '仓库在哪',
    '有哪些', '有哪些项目', '列出项目', '列出所有', '所有项目',
    'find file', 'find project', 'search file', 'locate', 'list project',
    '拉取代码', '拉代码', 'clone', '开源项目', '在做',
    '电脑上', '本机', '本地项目', '本地文件',
    '看一下项目', '看看项目', '什么项目', '几个项目'
  ]

  // 本地资源定位关键词（terminal / file_reader / file_search）
  // 当用户询问文件/数据存储位置、路径、数据库位置等时，应该用工具查找
  const localResourceKeywords = [
    '存储位置', '存储在哪', '存在哪', '保存在哪', '保存在', '数据存储',
    '数据库', 'sqlite', 'db文件', '数据文件', '数据库文件',
    '路径是', '路径在哪', '文件路径', '具体路径', '完整路径',
    '在哪呢', '在哪里', '在什么位置', '什么位置', '具体位置',
    '定位', '找到这个文件', '找到文件',
    '配置在哪', '配置文件在哪', '日志在哪', '日志文件',
    '安装在哪', '安装在', '安装位置',
    '数据目录', '数据文件夹', '应用数据', '应用目录',
    '数据在', '文件在', '目录在', '文件夹在',
    '在哪里可以找到', '在哪查看', '在哪看到',
  ]

  // 搜索关键词（web_search）
  const searchKeywords = [
    '搜索', '查找', '最新', 'search', 'google', '百度',
    '当前价格', '最新版本', '今天', '实时',
    // follow-up 请求中常见的需要重新搜索的关键词
    '准确', '更新', '重新', '正确', '最新数据', '实时数据',
    '现在', '当前', '目前', '刚刚', '-refresh', '刷新',
    '不对', '错了', '错误', '不对啊', '不太对',  // 用户指出数据有误
    '再搜', '重新搜', '再查', '重新查',  // 明确要求重新搜索
    // 平台/产品操作类问题 — 需要搜索官方文档
    '怎么看', '怎么用', '如何查看', '如何使用', '怎么操作',
    '在哪看', '在哪里看', '怎么查看', '怎么找到',
    '怎么看自己', '怎么看我的', '怎么知道',
    '官方文档', '帮助文档', '操作手册', '使用指南',
  ]

  const hasTerminal = availableTools.includes('terminal')
  const hasFileReader = availableTools.includes('file_reader')
  const hasFileWriter = availableTools.includes('file_writer')
  const hasWebSearch = availableTools.includes('web_search')
  const hasFileSearchTool = availableTools.includes('file_search')

  if (hasTerminal && terminalKeywords.some(kw => input.includes(kw.toLowerCase()))) return true
  if ((hasFileReader || hasFileWriter) && fileKeywords.some(kw => input.includes(kw.toLowerCase()))) return true
  if (hasWebSearch && searchKeywords.some(kw => input.includes(kw.toLowerCase()))) return true
  if (hasFileSearchTool && fileSearchKeywords.some(kw => input.includes(kw.toLowerCase()))) return true
  // 本地资源定位 — terminal 或 file_search 都可以查找
  if ((hasTerminal || hasFileSearchTool || hasFileReader) && localResourceKeywords.some(kw => input.includes(kw.toLowerCase()))) return true

  // 检测路径模式（如 e:\, C:\, /home/ 等）
  if (hasTerminal || hasFileReader) {
    if (/[a-z]:\\/i.test(userInput) || /\/(home|usr|opt|var|tmp)\//.test(userInput)) return true
  }

  // ── 上下文感知：检查对话历史是否包含实时数据相关话题 ──
  // 当用户发送 follow-up 消息（如"给我准确的数据"），且对话历史中
  // 包含股价、天气、新闻等实时数据话题时，应该触发 web_search
  if (hasWebSearch && historyMessages && historyMessages.length > 0) {
    // 合并最近几条对话内容作为上下文
    const recentContext = historyMessages
      .slice(-6)  // 最近 6 条消息
      .map(m => extractTextFromContent(m.content))
      .join(' ')
      .toLowerCase()

    // 实时数据话题关键词
    const realtimeTopics = [
      '股价', '大盘', '指数', '上证', '深证', '创业板', 'a股', '股票',
      '行情', '涨跌', '收盘', '开盘', '盘中',
      '天气', '气温', '温度',
      '新闻', '今日', '今天',
      '汇率', '油价', '金价',
      '数据', '实时', '最新',
    ]

    // 用户输入中包含要求更新/准确/重新获取的意图
    const updateIntentKeywords = [
      '准确', '更新', '重新', '最新', '正确', '现在', '当前',
      '不对', '错了', '再', '刷新', '实时',
    ]

    const hasRealtimeTopic = realtimeTopics.some(kw => recentContext.includes(kw))
    const hasUpdateIntent = updateIntentKeywords.some(kw => input.includes(kw))

    if (hasRealtimeTopic && hasUpdateIntent) {
      console.log(`[ToolAssessor] shouldUseTool: follow-up request with realtime context detected`)
      return true
    }
  }

  // ── 上下文感知：检查对话历史是否包含本地资源相关话题 ──
  // 当用户发送 follow-up 消息（如"具体的存储位置呢？"），且对话历史中
  // 包含数据库、存储、路径等本地资源话题时，应该触发 terminal/file_search 工具
  if ((hasTerminal || hasFileSearchTool || hasFileReader) && historyMessages && historyMessages.length > 0) {
    const recentContext = historyMessages
      .slice(-6)
      .map(m => extractTextFromContent(m.content))
      .join(' ')
      .toLowerCase()

    // 本地资源话题关键词
    const localResourceTopics = [
      '存储', '数据库', 'sqlite', '保存', '数据存', '数据持久',
      '路径', '文件在哪', '配置文件', '日志文件',
      '应用数据', '数据目录', '应用目录',
    ]

    // follow-up 中常见的追问位置/路径的意图
    const locationIntentKeywords = [
      '具体', '位置', '在哪', '路径', '哪个文件', '哪个目录',
      '哪里', '什么位置', '怎么找到', '怎么查看',
    ]

    const hasLocalTopic = localResourceTopics.some(kw => recentContext.includes(kw))
    const hasLocationIntent = locationIntentKeywords.some(kw => input.includes(kw))

    if (hasLocalTopic && hasLocationIntent) {
      console.log(`[ToolAssessor] shouldUseTool: follow-up request with local resource context detected`)
      return true
    }
  }

  return false
}

/**
 * LLM 驱动的工具需求评估
 *
 * 让 LLM 根据问题语义和工具描述判断是否需要使用工具、应该用哪个工具。
 * 这是一种更智能、更可扩展的方式：
 * - 不需要维护无穷的关键词列表
 * - 能理解问题的语义意图
 * - 能根据工具的实际描述做匹配
 * - 能处理从未见过的新问题
 */
export async function assessToolNeed(
  ctx: PipelineContext,
  userInput: string,
  toolDefs: ToolDef[],
  historyMessages: AnyMessage[]
): Promise<ToolAssessment> {
  if (toolDefs.length === 0) return { ...EMPTY_ASSESSMENT }
  if (!isLLMConfigured()) return { ...EMPTY_ASSESSMENT }

  // 构建对话历史摘要（最近 4 条，供 LLM 理解上下文）
  const recentHistory = historyMessages.slice(-4)
    .map(m => `${m.role}: ${extractTextFromContent(m.content).slice(0, 200)}`)
    .join('\n')
  const historySection = recentHistory
    ? `\n\n最近对话上下文:\n${recentHistory}`
    : ''

  const platform = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux'

  const prompt = `你是一个工具使用评估器。请判断以下用户问题是否需要使用工具来回答。

用户问题: "${userInput}"${historySection}

可用工具:
${formatToolDescriptions(toolDefs)}

判断原则:
- 你已知用户的操作系统是 ${platform}，不要建议询问用户操作系统
- 当用户问"在哪""路径""存储位置""数据库""配置文件"等位置类问题时，通常需要 terminal 工具查找
- 当用户问"有哪些项目""电脑上有什么""找一下"时，需要 file_search 工具
- 当用户问"最新""今天""现在""实时"等实时信息时，需要 web_search 工具
- ⚠️ 当用户问"怎么看""怎么用""如何查看""如何使用""在哪看""怎么操作"等操作类问题时，需要 web_search 工具搜索官方文档或教程
  例: "火山引擎怎么看使用量" → 需要 web_search 搜索"火山引擎 方舟 用量统计"
  例: "GitHub 怎么创建组织" → 需要 web_search 搜索"GitHub 创建组织 教程"
  例: "微信读书怎么导出笔记" → 需要 web_search 搜索"微信读书 导出笔记"
- 当用户问"查看文件""读取文件""看看代码"时，需要 file_reader 工具
- 当用户问"写入""修改""创建文件"时，需要 file_writer 工具
- 当用户问"打开网站""打开网页"时，需要 open_url 工具
- 当用户问"浏览器""点击按钮""输入文字""截图"时，需要 browser 工具
- ⚠️ 能力类问题（如"你知道我在哪吗""你能查到我的IP吗""你有什么信息"）通常需要工具：
  - "你在哪/你的位置" → terminal 执行 curl ipinfo.io 获取 IP 地理位置
  - "我的IP" → terminal 执行 curl ipinfo.io 或 ipconfig
  - "系统信息/硬件信息" → terminal 执行 systeminfo / wmic 等
  - "网络状态" → terminal 执行 ipconfig / netstat 等
  - 这类问题看似是问你的能力，实际上用户想要你用工具去获取信息
- 纯知识问答（如"什么是递归""解释一下概念"）不需要工具
- 纯计算问题（如"2+2等于几"）不需要工具（除非需要计算器工具）
- 如果不确定，倾向于需要工具（宁可多用工具也不要漏掉）
- follow-up 问题（如"具体的存储位置呢？"）需要结合上下文判断

请返回 JSON（不要其他文字）:
{"needsTool": true, "suggestedTools": ["terminal"], "reason": "用户询问存储位置，需要用terminal查找文件路径"}`

  try {
    const config = getConfig()
    const response = await ctx.services.llm.chat({
      messages: [
        { role: 'system', content: '你是工具使用评估助手，只返回 JSON。' },
        { role: 'user', content: prompt }
      ],
      // 优先使用 fastModel（轻量分类任务），fallback 到主模型
      modelKey: config.agent.fastModel || config.defaultModelKey,
      temperature: 0,
      maxTokens: 300,
      signal: ctx.signal,
      timeoutMs: 10000
    })

    ctx.trace.totalInputTokens += countTextTokens(prompt)
    ctx.trace.totalOutputTokens += countTextTokens(response)
    ctx.trace.modelsUsed.add(config.defaultModelKey)

    // 解析 JSON
    const jsonMatch = response.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      console.warn('[ToolAssessor] assessToolNeed: no JSON in response, falling back')
      return { ...EMPTY_ASSESSMENT }
    }

    const parsed = JSON.parse(jsonMatch[0])
    const result = {
      needsTool: !!parsed.needsTool,
      suggestedTools: Array.isArray(parsed.suggestedTools)
        ? parsed.suggestedTools.filter((t: unknown) => typeof t === 'string')
        : [],
      reason: typeof parsed.reason === 'string' ? parsed.reason : ''
    }

    console.log(`[ToolAssessor] assessToolNeed: needsTool=${result.needsTool}, suggestedTools=[${result.suggestedTools.join(', ')}], reason="${result.reason}"`)
    return result
  } catch (err) {
    console.warn('[ToolAssessor] assessToolNeed failed, falling back to shouldUseTool:', err)
    return { ...EMPTY_ASSESSMENT }
  }
}
