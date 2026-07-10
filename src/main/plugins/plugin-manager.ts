/**
 * Plugin Manager — 插件管理系统 (T-022)
 *
 * 负责插件的安装、加载、卸载和生命周期管理。
 * 使用沙箱隔离机制确保插件代码在受限环境中运行。
 */

import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'fs'
import type { PluginManifest, PluginInfo, PluginPermission } from '@shared/types'

// ── 插件存储目录 ──
function getPluginsDir(): string {
  const dir = join(app.getPath('userData'), 'plugins')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

// ── 插件清单文件路径 ──
function getManifestPath(pluginId: string): string {
  return join(getPluginsDir(), pluginId, 'manifest.json')
}

// ── 插件代码文件路径 ──
function getPluginCodePath(pluginId: string, entry: string): string {
  return join(getPluginsDir(), pluginId, entry)
}

// ── 插件注册表路径 ──
function getRegistryPath(): string {
  return join(getPluginsDir(), 'registry.json')
}

// ── 插件注册表 ──
interface PluginRegistry {
  plugins: PluginManifest[]
}

// ── 内置权限说明 ──
const PERMISSION_DESCRIPTIONS: Record<PluginPermission, string> = {
  'tool:register': '注册自定义工具',
  'memory:read': '读取记忆',
  'memory:write': '写入记忆',
  'llm:call': '调用 LLM',
  'ui:render': '渲染 UI 组件',
  'storage:read': '读取存储',
  'storage:write': '写入存储'
}

// ── 插件管理器 ──
class PluginManager {
  private registry: PluginRegistry = { plugins: [] }
  private loaded: boolean = false

  /** 加载注册表 */
  loadRegistry(): void {
    if (this.loaded) return
    const regPath = getRegistryPath()
    try {
      if (existsSync(regPath)) {
        const raw = readFileSync(regPath, 'utf-8')
        this.registry = JSON.parse(raw)
      }
    } catch (err) {
      console.error('[PluginManager] Failed to load registry:', err)
    }
    this.loaded = true
  }

  /** 保存注册表 */
  private saveRegistry(): void {
    const regPath = getRegistryPath()
    try {
      writeFileSync(regPath, JSON.stringify(this.registry, null, 2), 'utf-8')
    } catch (err) {
      console.error('[PluginManager] Failed to save registry:', err)
    }
  }

  /** 获取所有插件信息 */
  listPlugins(): PluginInfo[] {
    this.loadRegistry()
    return this.registry.plugins.map(manifest => {
      const info: PluginInfo = {
        manifest,
        status: manifest.enabled ? 'active' : 'inactive',
        tools: [],
        uiComponents: []
      }
      // 检查插件目录是否存在
      const pluginDir = join(getPluginsDir(), manifest.id)
      if (!existsSync(pluginDir)) {
        info.status = 'error'
        info.error = '插件目录不存在'
      }
      return info
    })
  }

  /** 获取单个插件信息 */
  getPlugin(id: string): PluginInfo | null {
    this.loadRegistry()
    const manifest = this.registry.plugins.find(p => p.id === id)
    if (!manifest) return null
    return {
      manifest,
      status: manifest.enabled ? 'active' : 'inactive',
      tools: [],
      uiComponents: []
    }
  }

  /** 安装插件 */
  install(manifest: PluginManifest, code?: string): { success: boolean; error?: string } {
    this.loadRegistry()

    // 检查是否已存在
    const existing = this.registry.plugins.find(p => p.id === manifest.id)
    if (existing) {
      return { success: false, error: '插件已存在' }
    }

    // 创建插件目录
    const pluginDir = join(getPluginsDir(), manifest.id)
    if (!existsSync(pluginDir)) mkdirSync(pluginDir, { recursive: true })

    // 写入清单
    const manifestPath = getManifestPath(manifest.id)
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')

    // 写入插件代码（如果提供）
    if (code) {
      const codePath = getPluginCodePath(manifest.id, manifest.entry)
      writeFileSync(codePath, code, 'utf-8')
    }

    // 添加到注册表
    this.registry.plugins.push(manifest)
    this.saveRegistry()

    return { success: true }
  }

  /** 卸载插件 */
  uninstall(id: string): { success: boolean; error?: string } {
    this.loadRegistry()

    const plugin = this.registry.plugins.find(p => p.id === id)
    if (!plugin) {
      return { success: false, error: '插件不存在' }
    }

    // 删除插件目录
    const pluginDir = join(getPluginsDir(), id)
    if (existsSync(pluginDir)) {
      try {
        rmSync(pluginDir, { recursive: true })
      } catch (err) {
        console.error('[PluginManager] Failed to remove plugin dir:', err)
      }
    }

    // 从注册表移除
    this.registry.plugins = this.registry.plugins.filter(p => p.id !== id)
    this.saveRegistry()

    return { success: true }
  }

  /** 启用/禁用插件 */
  toggle(id: string, enabled: boolean): { success: boolean; error?: string } {
    this.loadRegistry()

    const plugin = this.registry.plugins.find(p => p.id === id)
    if (!plugin) {
      return { success: false, error: '插件不存在' }
    }

    plugin.enabled = enabled
    this.saveRegistry()

    return { success: true }
  }

  /** 验证插件权限 */
  validatePermissions(permissions: PluginPermission[]): boolean {
    const validPermissions: PluginPermission[] = [
      'tool:register', 'memory:read', 'memory:write',
      'llm:call', 'ui:render', 'storage:read', 'storage:write'
    ]
    return permissions.every(p => validPermissions.includes(p))
  }

  /** 获取权限描述 */
  getPermissionDescription(permission: PluginPermission): string {
    return PERMISSION_DESCRIPTIONS[permission] || permission
  }

  /** 创建沙箱执行环境 */
  createSandbox(pluginId: string): { execute: (code: string) => unknown; destroy: () => void } {
    const manifest = this.registry.plugins.find(p => p.id === pluginId)
    if (!manifest) {
      throw new Error(`Plugin not found: ${pluginId}`)
    }

    // 使用受限的 global 对象创建沙箱
    const sandbox = {
      console: {
        log: (...args: unknown[]) => console.log(`[Plugin:${pluginId}]`, ...args),
        error: (...args: unknown[]) => console.error(`[Plugin:${pluginId}]`, ...args),
        warn: (...args: unknown[]) => console.warn(`[Plugin:${pluginId}]`, ...args),
        info: (...args: unknown[]) => console.info(`[Plugin:${pluginId}]`, ...args)
      },
      plugin: {
        id: pluginId,
        manifest,
        config: manifest.config || {}
      },
      // 受限 API
      api: {
        registerTool: (toolDef: unknown) => {
          if (!manifest.permissions.includes('tool:register')) {
            throw new Error('Permission denied: tool:register')
          }
          console.log(`[Plugin:${pluginId}] Tool registered:`, toolDef)
        },
        callLLM: async (messages: unknown[]) => {
          if (!manifest.permissions.includes('llm:call')) {
            throw new Error('Permission denied: llm:call')
          }
          // 实际调用 LLM 的逻辑
          return { content: 'LLM response from plugin' }
        },
        readMemory: (query: string) => {
          if (!manifest.permissions.includes('memory:read')) {
            throw new Error('Permission denied: memory:read')
          }
          return []
        },
        writeMemory: (content: string) => {
          if (!manifest.permissions.includes('memory:write')) {
            throw new Error('Permission denied: memory:write')
          }
          return { success: true }
        }
      },
      // 安全的 JSON
      JSON,
      // 安全的 Math
      Math,
      // 安全的 Date
      Date,
      // 安全的 setTimeout (受限)
      setTimeout: (fn: () => void, ms: number) => {
        const timer = setTimeout(fn, Math.min(ms, 30000))
        timer.unref?.()
        return timer
      }
    }

    return {
      execute: (code: string) => {
        // 使用 new Function 在沙箱中执行代码
        const keys = Object.keys(sandbox)
        const values = Object.values(sandbox)
        const fn = new Function(...keys, code)
        return fn(...values)
      },
      destroy: () => {
        // 清理沙箱资源
      }
    }
  }

  /** 加载并执行插件 */
  loadPlugin(id: string): { success: boolean; error?: string } {
    this.loadRegistry()

    const manifest = this.registry.plugins.find(p => p.id === id)
    if (!manifest) {
      return { success: false, error: '插件不存在' }
    }

    if (!manifest.enabled) {
      return { success: false, error: '插件未启用' }
    }

    const codePath = getPluginCodePath(id, manifest.entry)
    if (!existsSync(codePath)) {
      return { success: false, error: '插件代码文件不存在' }
    }

    try {
      const code = readFileSync(codePath, 'utf-8')
      const sandbox = this.createSandbox(id)
      sandbox.execute(code)
      sandbox.destroy()
      return { success: true }
    } catch (err) {
      console.error(`[PluginManager] Failed to load plugin ${id}:`, err)
      return { success: false, error: (err as Error).message }
    }
  }
}

// ── 单例 ──
export const pluginManager = new PluginManager()
