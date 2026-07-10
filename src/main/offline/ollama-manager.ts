/**
 * Ollama Manager — 本地 LLM 管理 (T-024)
 *
 * 支持通过 Ollama 运行本地 LLM 模型，实现完全离线运行。
 * 包括模型列表查询、模型下载、模型删除和离线模式切换。
 */

import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import type { OllamaStatus, OllamaModel, OllamaPullProgress } from '@shared/types'

// ── 默认 Ollama 地址 ──
const DEFAULT_OLLAMA_HOST = 'http://localhost:11434'

// ── 配置文件路径 ──
function getOfflineConfigPath(): string {
  return join(app.getPath('userData'), 'offline-config.json')
}

// ── 离线配置 ──
interface OfflineConfig {
  enabled: boolean
  host: string
  currentModel: string
}

const DEFAULT_CONFIG: OfflineConfig = {
  enabled: false,
  host: DEFAULT_OLLAMA_HOST,
  currentModel: ''
}

let currentConfig: OfflineConfig = { ...DEFAULT_CONFIG }
let configLoaded = false

/** 加载配置 */
function loadConfig(): OfflineConfig {
  if (configLoaded) return currentConfig
  try {
    const configPath = getOfflineConfigPath()
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, 'utf-8')
      currentConfig = { ...DEFAULT_CONFIG, ...JSON.parse(raw) }
    }
  } catch (err) {
    console.error('[OllamaManager] Failed to load config:', err)
  }
  configLoaded = true
  return currentConfig
}

/** 保存配置 */
function saveConfig(): void {
  try {
    const configPath = getOfflineConfigPath()
    writeFileSync(configPath, JSON.stringify(currentConfig, null, 2), 'utf-8')
  } catch (err) {
    console.error('[OllamaManager] Failed to save config:', err)
  }
}

// ── Ollama API 调用 ──

/** 检查 Ollama 是否在线 */
async function checkOnline(host: string): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    timer.unref?.()
    const response = await fetch(`${host}/api/tags`, {
      signal: controller.signal
    })
    clearTimeout(timer)
    return response.ok
  } catch {
    return false
  }
}

/** 获取已安装的模型列表 */
async function listModels(host: string): Promise<OllamaModel[]> {
  try {
    const response = await fetch(`${host}/api/tags`)
    if (!response.ok) return []
    const data = await response.json()
    return (data.models || []).map((m: any) => ({
      name: m.name,
      size: m.size || 0,
      digest: m.digest || '',
      modifiedAt: m.modified_at || '',
      parameterSize: m.details?.parameter_size,
      quantizationLevel: m.details?.quantization_level
    }))
  } catch {
    return []
  }
}

/** 拉取（下载）模型 */
async function pullModel(
  host: string,
  modelName: string,
  onProgress?: (progress: OllamaPullProgress) => void
): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(`${host}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName })
    })

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` }
    }

    const reader = response.body?.getReader()
    if (!reader) {
      return { success: false, error: '无法读取响应流' }
    }

    const decoder = new TextDecoder()
    let totalSize = 0

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const text = decoder.decode(value, { stream: true })
      const lines = text.split('\n').filter(l => l.trim())

      for (const line of lines) {
        try {
          const data = JSON.parse(line)
          if (data.total) {
            totalSize = data.total
          }
          const percent = data.total ? Math.round((data.completed || 0) / data.total * 100) : 0
          onProgress?.({
            model: modelName,
            status: 'pulling',
            percent,
            downloaded: data.completed,
            total: data.total,
            message: data.status
          })
        } catch {
          // 忽略解析错误的行
        }
      }
    }

    onProgress?.({
      model: modelName,
      status: 'success',
      percent: 100,
      message: '下载完成'
    })

    return { success: true }
  } catch (err) {
    onProgress?.({
      model: modelName,
      status: 'error',
      message: (err as Error).message
    })
    return { success: false, error: (err as Error).message }
  }
}

/** 删除模型 */
async function deleteModel(host: string, modelName: string): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(`${host}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName })
    })

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` }
    }

    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

// ── Ollama 管理器 ──

class OllamaManager {
  /** 获取 Ollama 状态 */
  async getStatus(): Promise<OllamaStatus> {
    const config = loadConfig()
    const online = await checkOnline(config.host)
    const models = online ? await listModels(config.host) : []

    return {
      online,
      host: config.host,
      offlineMode: config.enabled,
      models,
      currentModel: config.currentModel
    }
  }

  /** 获取模型列表 */
  async getModels(): Promise<OllamaModel[]> {
    const config = loadConfig()
    const online = await checkOnline(config.host)
    if (!online) return []
    return listModels(config.host)
  }

  /** 拉取模型 */
  async pullModel(modelName: string, onProgress?: (progress: OllamaPullProgress) => void): Promise<{ success: boolean; error?: string }> {
    const config = loadConfig()
    const online = await checkOnline(config.host)
    if (!online) {
      return { success: false, error: 'Ollama 服务未运行，请先启动 Ollama' }
    }
    return pullModel(config.host, modelName, onProgress)
  }

  /** 删除模型 */
  async deleteModel(modelName: string): Promise<{ success: boolean; error?: string }> {
    const config = loadConfig()
    const online = await checkOnline(config.host)
    if (!online) {
      return { success: false, error: 'Ollama 服务未运行' }
    }
    return deleteModel(config.host, modelName)
  }

  /** 启用/禁用离线模式 */
  setEnabled(enabled: boolean): { success: boolean } {
    const config = loadConfig()
    config.enabled = enabled
    saveConfig()
    return { success: true }
  }

  /** 设置当前模型 */
  setCurrentModel(model: string): { success: boolean } {
    const config = loadConfig()
    config.currentModel = model
    saveConfig()
    return { success: true }
  }

  /** 设置 Ollama 主机地址 */
  setHost(host: string): { success: boolean } {
    const config = loadConfig()
    config.host = host || DEFAULT_OLLAMA_HOST
    saveConfig()
    return { success: true }
  }

  /** 获取离线配置 */
  getConfig(): OfflineConfig {
    return loadConfig()
  }

  /** 检查是否启用了离线模式 */
  isOfflineMode(): boolean {
    return loadConfig().enabled
  }

  /** 获取推荐的模型列表 */
  getRecommendedModels(): Array<{ name: string; description: string; size: string }> {
    return [
      { name: 'llama3.2:3b', description: 'Meta Llama 3.2 3B — 轻量级，适合日常对话', size: '~2GB' },
      { name: 'llama3.2:1b', description: 'Meta Llama 3.2 1B — 最轻量，快速响应', size: '~1.3GB' },
      { name: 'qwen2.5:7b', description: '通义千问 2.5 7B — 中文优秀', size: '~4.7GB' },
      { name: 'qwen2.5:3b', description: '通义千问 2.5 3B — 中文轻量', size: '~2GB' },
      { name: 'gemma2:2b', description: 'Google Gemma 2 2B — 轻量级', size: '~1.6GB' },
      { name: 'phi3:3.8b', description: 'Microsoft Phi-3 3.8B — 小而精', size: '~2.5GB' }
    ]
  }
}

// ── 单例 ──
export const ollamaManager = new OllamaManager()
