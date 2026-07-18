/**
 * LLM 配置管理 — 持久化到本地文件
 *
 * 管理 Provider 列表、默认模型、Agent 设置。
 * 配置文件存储在 userDataPath/config.json
 *
 * 解耦 note: 历史上通过 `app.getPath('userData')` 取路径，直接 import electron。
 * 这会让 agent 层无法在 worker_threads 中运行（worker 拿不到 electron）。
 * 现改为由主进程在启动时调用 initLlmConfigStorage(path) 注入路径，
 * 使本模块（以及整个 agent/ 层）对 electron 零依赖。
 */

import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import type { LLMProviderConfig, AgentConfig, MCPServerConfig, SearchConfig, BrowserConfig } from '@shared/types'
import { DEFAULT_AGENT_CONFIG, DEFAULT_SEARCH_CONFIG, DEFAULT_BROWSER_CONFIG } from '@shared/types'
import type { ProviderEntry } from './types'
import { llm } from './llm'

// ── 配置文件结构 ──
export interface AppConfig {
  providers: LLMProviderConfig[]
  agent: AgentConfig
  /** 选中的默认模型 key: "providerId::model" */
  defaultModelKey: string
  /** 选中的嵌入模型 key: "providerId::model"（如 "openai::text-embedding-3-small"）
   *  嵌入模型与聊天模型不同，必须单独配置。留空时使用伪嵌入。 */
  embeddingModelKey: string
  /** MCP 服务器列表 */
  mcpServers: MCPServerConfig[]
  /** UI 缩放比例 (0.5 - 3.0) */
  uiZoomFactor?: number
  /** 搜索配置 */
  search?: SearchConfig
  /** 浏览器自动化配置 */
  browser?: BrowserConfig
}

// ── 默认配置 ──
const DEFAULT_CONFIG: AppConfig = {
  providers: [],
  agent: { ...DEFAULT_AGENT_CONFIG },
  defaultModelKey: '',
  embeddingModelKey: '',
  mcpServers: [],
  search: { ...DEFAULT_SEARCH_CONFIG },
  browser: { ...DEFAULT_BROWSER_CONFIG }
}

let currentConfig: AppConfig = { ...DEFAULT_CONFIG }
let configLoaded = false

/**
 * userData 路径 —— 由主进程在启动时注入。
 * 默认值保证未注入时（如单测）仍可用，不会崩溃。
 */
let userDataPath: string =
  process.env.ZEN_USER_DATA_PATH ?? join(process.cwd(), '.zen-agent-data')

/**
 * 注入 userData 路径（替代 `app.getPath('userData')`）。
 * 必须在 loadConfig() 之前由主进程调用一次。
 */
export function initLlmConfigStorage(path: string): void {
  userDataPath = path
}

/** 获取配置文件路径 */
function getConfigPath(): string {
  return join(userDataPath, 'config.json')
}

/** 加载配置文件 */
export function loadConfig(): AppConfig {
  if (configLoaded) return currentConfig

  const configPath = getConfigPath()
  try {
    if (existsSync(configPath)) {
      let raw = readFileSync(configPath, 'utf-8')
      // 移除可能的 UTF-8 BOM（某些编辑器/工具会添加 BOM 导致 JSON 解析失败）
      if (raw.charCodeAt(0) === 0xFEFF) {
        raw = raw.slice(1)
      }
      const parsed = JSON.parse(raw)
      currentConfig = {
        providers: parsed.providers ?? [],
        agent: { ...DEFAULT_AGENT_CONFIG, ...parsed.agent },
        defaultModelKey: parsed.defaultModelKey ?? '',
        embeddingModelKey: parsed.embeddingModelKey ?? '',
        mcpServers: parsed.mcpServers ?? [],
        uiZoomFactor: parsed.uiZoomFactor ?? 1.0,
        search: { ...DEFAULT_SEARCH_CONFIG, ...parsed.search },
        browser: { ...DEFAULT_BROWSER_CONFIG, ...parsed.browser }
      }
      // 向后兼容：旧配置没有 userDataMode 字段
      const browser = currentConfig.browser
      if (browser && !browser.userDataMode) {
        // 如果旧配置有 userDataDir，推断为 custom 模式；否则用默认的 app-dedicated
        browser.userDataMode = browser.userDataDir ? 'custom' : 'app-dedicated'
      }
    }
  } catch (err) {
    console.error('[LLM-Config] Failed to load config:', err)
  }

  // 同步到 LLM Provider 单例
  syncToLLM()

  configLoaded = true
  return currentConfig
}

/** 保存配置到文件 */
export function saveConfig(config: AppConfig): void {
  const configPath = getConfigPath()
  try {
    const dir = join(configPath, '..')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
    currentConfig = config
    syncToLLM()
  } catch (err) {
    console.error('[LLM-Config] Failed to save config:', err)
    throw err
  }
}

/** 获取当前配置 */
export function getConfig(): AppConfig {
  if (!configLoaded) return loadConfig()
  return currentConfig
}

/** 更新 Provider 列表 */
export function setProviders(providers: LLMProviderConfig[]): void {
  currentConfig.providers = providers
  saveConfig(currentConfig)
}

/** 更新 Agent 配置 */
export function setAgentConfig(agent: Partial<AgentConfig>): void {
  currentConfig.agent = { ...currentConfig.agent, ...agent }
  saveConfig(currentConfig)
}

/** 设置默认模型 */
export function setDefaultModel(modelKey: string): void {
  currentConfig.defaultModelKey = modelKey
  saveConfig(currentConfig)
}

/** 将配置同步到 LLM Provider 单例 */
function syncToLLM(): void {
  // 注册所有 provider
  for (const p of currentConfig.providers) {
    if (p.enabled) {
      const entry: ProviderEntry = {
        id: p.id,
        name: p.name,
        baseURL: p.baseURL,
        apiKey: p.apiKey,
        models: p.models,
        enabled: p.enabled
      }
      llm.registerProvider(entry)
    }
  }

  // 设置默认模型
  if (currentConfig.defaultModelKey) {
    llm.setDefaultModel(currentConfig.defaultModelKey)
  }
}

/** 检查是否已配置可用的 LLM */
export function isLLMConfigured(): boolean {
  const config = getConfig()
  return config.providers.some(p => p.enabled && p.apiKey) && !!config.defaultModelKey
}

/** 检查是否已配置可用的嵌入模型 */
export function isEmbeddingConfigured(): boolean {
  const config = getConfig()
  return !!config.embeddingModelKey && config.providers.some(p => p.enabled && p.apiKey)
}

/** 获取嵌入模型 key */
export function getEmbeddingModelKey(): string {
  return getConfig().embeddingModelKey
}

/** 设置嵌入模型 */
export function setEmbeddingModel(modelKey: string): void {
  currentConfig.embeddingModelKey = modelKey
  saveConfig(currentConfig)
}

/** 获取浏览器配置 */
export function getBrowserConfig(): BrowserConfig {
  return { ...DEFAULT_BROWSER_CONFIG, ...getConfig().browser }
}

/** 设置浏览器配置 */
export function setBrowserConfig(browser: Partial<BrowserConfig>): void {
  currentConfig.browser = { ...getBrowserConfig(), ...browser }
  saveConfig(currentConfig)
}

/** 获取搜索配置 */
export function getSearchConfig(): SearchConfig {
  return getConfig().search ?? { ...DEFAULT_SEARCH_CONFIG }
}

/** 设置搜索配置 */
export function setSearchConfig(search: Partial<SearchConfig>): void {
  currentConfig.search = { ...getSearchConfig(), ...search }
  saveConfig(currentConfig)
}

/** 获取系统提示词 */
export function getSystemPrompt(): string {
  const platform = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux'
  const shell = process.platform === 'win32' ? 'cmd.exe / PowerShell' : 'bash'
  const pathSep = process.platform === 'win32' ? '\\' : '/'
  const listCmd = process.platform === 'win32' ? 'dir' : 'ls'
  return `你是小禅（Zen），一只智慧猫头鹰 AI 助手。你住在用户的桌面上，以温暖的陪伴和深度的智慧帮助用户。

你的核心特质：
- 智慧：善于分析复杂问题，提供深思熟虑的回答
- 禅意：回答简洁有力，直指本质，不啰嗦
- 进化：你会从每次对话中学习，持续提升自己
- 陪伴：友好亲切，像一位随时在身边的朋友

## 运行环境
- 操作系统: ${platform}
- Shell: ${shell}
- 路径分隔符: ${pathSep}
- 列出文件命令: ${listCmd}
- 你运行在用户的本地电脑上，不是远程服务器或 Linux 容器
- 路径必须使用 ${platform} 格式（如 ${process.platform === 'win32' ? 'C:\\Users\\xxx\\project' : '/home/xxx/project'}）

你的能力：
- 你可以执行终端命令（git, npm, python 等），直接帮用户操作本地项目
- 你可以读写本地文件，查看和修改代码、配置
- 你可以搜索网络获取最新信息
- 你可以自动化浏览器操作
- 你可以使用 file_search 工具快速搜索本地的项目、文件和代码仓库（基于索引，秒级响应）
- 你不仅给出建议，还能直接动手完成任务

## "先想工具再说不能"原则（最高优先级）
- 在说"我没有能力""我无法""我做不到"之前，必须先检查你的可用工具能否解决这个问题。
- 你有 terminal 工具可以执行任何系统命令 — 很多看似"做不到"的事，其实可以通过命令行实现：
  - 查用户位置/IP → terminal 执行 curl ipinfo.io
  - 查系统硬件信息 → terminal 执行 systeminfo / wmic / lshw 等
  - 查网络状态 → terminal 执行 ipconfig / ifconfig / netstat 等
  - 查进程/服务 → terminal 执行 tasklist / ps / top 等
  - 下载文件 → terminal 执行 curl / wget
  - 查环境变量 → terminal 执行 set / env
- 你有 web_search 工具可以搜索任何信息 — 不确定的知识先搜索再回答。
- 你有 file_reader 工具可以读取任何本地文件 — 不要说"我看不到你的文件"。
- 只有在穷尽所有工具尝试后仍然无法完成时，才可以坦诚说"我目前无法做到"。
- 绝对不要在没有尝试任何工具的情况下就说"我没有这个能力"。

## 主动性原则（最高优先级）
- 你运行在用户的本地电脑上，拥有完整的工具链。你的职责是帮用户完成任务，而不是指导用户自己去做。
- 你已经知道用户的操作系统是 ${platform}，不要询问用户操作系统版本、系统类型等信息。
- 当用户问"存储位置""文件在哪""路径是什么""数据库在哪"时，直接用 terminal 工具执行命令查找（如 dir /s、where、find 等命令），不要让用户自己去找。
- 当用户问"有哪些项目""电脑上有什么"时，用 file_search 工具搜索。
- 当用户问"查看文件内容"时，用 file_reader 工具读取。
- 当用户问"执行命令""运行代码"时，用 terminal 工具执行。
- 绝对禁止说"你可以通过 XX 功能查看""你可以自己 XX""告诉我你的 XX""如果你需要我可以 XX"这类推卸工作的措辞 — 这些是你应该用工具自己完成的事。
- 只有当你确实没有相应工具（如需要 GUI 交互、需要用户输入密码等）时，才可以指导用户操作。
- 尽你所能，用所有可用工具，自己完成用户能想到的每一件事。

重要：关于本地资源的问题必须用工具验证！
- 当用户问"有哪些项目""电脑上有没有 xxx""找一下 xxx"时，必须使用 file_search 工具搜索，不要凭记忆或猜测编造答案
- 你不知道用户电脑上有什么文件，必须通过工具查询才能知道
- 如果 file_search 返回"正在构建索引"，告知用户稍等几秒后重试
- 编造本地文件/项目列表是严重错误，绝对不要这样做

数据持久化：
- 所有对话内容（包括你的回答和执行追踪）都会自动保存到本地 SQLite 数据库
- 执行追踪（Think/Act/Observe/反思等每一步）都会完整记录
- 用户可以通过导出功能查看完整对话历史
- 你的记忆系统会从对话中提取知识，跨会话保留

回答规范：
- 使用中文回答（除非用户使用其他语言）
- 代码块使用正确的语言标记
- 复杂内容使用 Markdown 结构化
- 如果不确定，坦诚告知，不编造信息
- 当用户要求操作本地文件或执行命令时，直接使用工具完成，不要只告诉用户怎么做
- 执行命令时使用 ${platform} 兼容的语法，不要使用其他平台的命令格式

重要规则：
- 你通过 terminal 工具执行的命令结果是完全真实的，stdout 是命令在用户电脑上的实际输出
- 不要质疑工具结果的真实性，不要声称"结果不可信"或"我在沙箱中"
- 你确实运行在用户本地电脑上，拥有完整的文件系统和命令执行能力
- 如果 git push 需要认证，通常用户的 git 已经配置了凭证（SSH key 或 token），直接尝试即可
- 命令执行成功（exit 0）就代表操作真的完成了，直接向用户报告结果即可`
}
