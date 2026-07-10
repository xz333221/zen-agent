/**
 * 主题管理器
 *
 * 支持跟随系统主题、手动切换亮/暗模式。
 * 主题变更时通知所有窗口更新。
 */

import { app, nativeTheme, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '@shared/types'
import { getConfig, saveConfig } from '@agent/providers/llm-config'

export type ThemeMode = 'light' | 'dark' | 'system'

let currentMode: ThemeMode = 'system'

/**
 * 初始化主题
 */
export function initTheme(): void {
  const config = getConfig()
  currentMode = (config as any).theme || 'system'
  applyTheme(currentMode)

  // 监听系统主题变化
  nativeTheme.on('updated', () => {
    if (currentMode === 'system') {
      notifyAllWindows()
    }
  })
}

/**
 * 获取当前主题模式
 */
export function getThemeMode(): ThemeMode {
  return currentMode
}

/**
 * 设置主题模式
 */
export function setThemeMode(mode: ThemeMode): void {
  currentMode = mode
  const config = getConfig()
  ;(config as any).theme = mode
  saveConfig(config)
  applyTheme(mode)
  notifyAllWindows()
}

/**
 * 获取实际生效的主题（将 system 解析为 light/dark）
 */
export function getEffectiveTheme(): 'light' | 'dark' {
  if (currentMode === 'system') {
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  }
  return currentMode
}

/**
 * 应用主题到 Electron nativeTheme
 */
function applyTheme(mode: ThemeMode): void {
  switch (mode) {
    case 'light':
      nativeTheme.themeSource = 'light'
      break
    case 'dark':
      nativeTheme.themeSource = 'dark'
      break
    case 'system':
      nativeTheme.themeSource = 'system'
      break
  }
}

/**
 * 通知所有窗口主题变化
 */
function notifyAllWindows(): void {
  const effective = getEffectiveTheme()
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC_CHANNELS.SYS_THEME_CHANGE, { mode: currentMode, effective })
  }
}
