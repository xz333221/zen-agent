/**
 * 全局快捷键管理
 *
 * 支持注册/注销全局快捷键，可在设置中自定义。
 */

import { globalShortcut, BrowserWindow } from 'electron'
import { getConfig, saveConfig } from '@agent/providers/llm-config'
import { IPC_CHANNELS } from '@shared/types'
import { getChatWindow, showChatWindow } from './windows/chat-window'
import { getPetWindow } from './windows/pet-window'

// ── 默认快捷键 ──
export const DEFAULT_SHORTCUTS: Record<string, string> = {
  toggleChat: 'CommandOrControl+Shift+Z',
  newSession: 'CommandOrControl+Shift+N',
  togglePet: 'CommandOrControl+Shift+P'
}

// ── 快捷键中文名称 ──
export const SHORTCUT_LABELS: Record<string, string> = {
  toggleChat: '显示/隐藏对话',
  newSession: '新建会话',
  togglePet: '显示/隐藏宠物'
}

// ── 当前注册的快捷键映射 ──
let registeredKeys: Map<string, string> = new Map()

/**
 * 获取快捷键配置
 */
export function getShortcutConfig(): Record<string, string> {
  const config = getConfig()
  return { ...DEFAULT_SHORTCUTS, ...(config as any).shortcuts || {} }
}

/**
 * 保存快捷键配置
 */
export function setShortcutConfig(shortcuts: Record<string, string>): void {
  const config = getConfig()
  ;(config as any).shortcuts = { ...DEFAULT_SHORTCUTS, ...shortcuts }
  saveConfig(config)
}

/**
 * 注册所有全局快捷键
 */
export function registerShortcuts(): void {
  // 先注销所有已注册的快捷键
  unregisterAll()

  const shortcuts = getShortcutConfig()

  for (const [action, accelerator] of Object.entries(shortcuts)) {
    if (!accelerator) continue

    try {
      const registered = globalShortcut.register(accelerator, () => {
        handleShortcutAction(action)
      })

      if (registered) {
        registeredKeys.set(action, accelerator)
      } else {
        console.error(`[Shortcuts] Failed to register: ${accelerator} for ${action}`)
      }
    } catch (err) {
      console.error(`[Shortcuts] Error registering ${accelerator}:`, err)
    }
  }
}

/**
 * 注销所有快捷键
 */
export function unregisterAll(): void {
  globalShortcut.unregisterAll()
  registeredKeys.clear()
}

/**
 * 重新注册快捷键（修改设置后调用）
 */
export function reregisterShortcuts(): void {
  registerShortcuts()
}

/**
 * 获取当前已注册的快捷键
 */
export function getRegisteredShortcuts(): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [action, accel] of registeredKeys.entries()) {
    result[action] = accel
  }
  return result
}

/**
 * 处理快捷键动作
 */
function handleShortcutAction(action: string): void {
  switch (action) {
    case 'toggleChat': {
      const chatWin = getChatWindow()
      if (chatWin && chatWin.isVisible()) {
        chatWin.hide()
      } else {
        showChatWindow()
      }
      break
    }
    case 'newSession': {
      showChatWindow()
      const chatWin = getChatWindow()
      if (chatWin) {
        chatWin.webContents.send(IPC_CHANNELS.CHAT_NEW_SESSION_NOTIFY)
      }
      break
    }
    case 'togglePet': {
      const petWin = getPetWindow()
      if (petWin) {
        if (petWin.isVisible()) {
          petWin.hide()
        } else {
          petWin.show()
        }
      }
      break
    }
  }
}
