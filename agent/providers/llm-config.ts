/**
 * LLM 配置管理 — 持久化到本地文件
 *
 * 管理 Provider 列表、默认模型、Agent 设置。
 * 配置文件存储在 app.getPath('userData')/config.json
 */

import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import type { LLMProviderConfig, AgentConfig, MCPServerConfig } from '@shared/types'
import { DEFAULT_AGENT_CONFIG } from '@shared/types'
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
}

// ── 默认配置 ──
const DEFAULT_CONFIG: AppConfig = {
  providers: [],
  agent: { ...DEFAULT_AGENT_CONFIG },
  defaultModelKey: '',
  embeddingModelKey: '',
  mcpServers: []
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
        mcpServers: parsed.mcpServers ?? []
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

/** 获取系统提示词 */
export function getSystemPrompt(): string {
  return `你是小禅（Zen），一只智慧猫头鹰 AI 助手。你住在用户的桌面上，以温暖的陪伴和深度的智慧帮助用户。

你的核心特质：
- 智慧：善于分析复杂问题，提供深思熟虑的回答
- 禅意：回答简洁有力，直指本质，不啰嗦
- 进化：你会从每次对话中学习，持续提升自己
- 陪伴：友好亲切，像一位随时在身边的朋友

回答规范：
- 使用中文回答（除非用户使用其他语言）
- 代码块使用正确的语言标记
- 复杂内容使用 Markdown 结构化
- 如果不确定，坦诚告知，不编造信息`
}
