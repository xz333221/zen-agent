/**
 * LLM 配置管理 — 持久化到本地文件
 *
 * 管理 Provider 列表、默认模型、Agent 设置。
 * 配置文件存储在 app.getPath('userData')/config.json
 */

import { app } from 'electron'
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

/** 获取配置文件路径 */
function getConfigPath(): string {
  const userDataPath = app.getPath('userData')
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
      if (!currentConfig.browser.userDataMode) {
        // 如果旧配置有 userDataDir，推断为 custom 模式；否则用默认的 app-dedicated
        currentConfig.browser.userDataMode = currentConfig.browser.userDataDir ? 'custom' : 'app-dedicated'
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
- 你不仅给出建议，还能直接动手完成任务

回答规范：
- 使用中文回答（除非用户使用其他语言）
- 代码块使用正确的语言标记
- 复杂内容使用 Markdown 结构化
- 如果不确定，坦诚告知，不编造信息
- 当用户要求操作本地文件或执行命令时，直接使用工具完成，不要只告诉用户怎么做
- 执行命令时使用 ${platform} 兼容的语法，不要使用其他平台的命令格式`
}
