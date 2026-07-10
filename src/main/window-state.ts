/**
 * 窗口状态管理 — 持久化窗口位置和大小
 *
 * 存储在 app.getPath('userData')/window-state.json
 */

import { app, screen, BrowserWindow } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'

export interface WindowState {
  x: number
  y: number
  width: number
  height: number
}

interface AllWindowStates {
  pet?: WindowState
  chat?: WindowState
}

const DEFAULT_STATES: AllWindowStates = {}

let states: AllWindowStates = { ...DEFAULT_STATES }
let loaded = false

/** 获取配置文件路径 */
function getStatePath(): string {
  const userDataPath = app.getPath('userData')
  return join(userDataPath, 'window-state.json')
}

/** 加载窗口状态 */
export function loadWindowStates(): AllWindowStates {
  if (loaded) return states

  try {
    const statePath = getStatePath()
    if (existsSync(statePath)) {
      const raw = readFileSync(statePath, 'utf-8')
      states = JSON.parse(raw)
    }
  } catch (err) {
    console.error('[WindowState] Failed to load:', err)
  }

  loaded = true
  return states
}

/** 保存窗口状态到文件 */
function saveStates(): void {
  try {
    const statePath = getStatePath()
    writeFileSync(statePath, JSON.stringify(states, null, 2), 'utf-8')
  } catch (err) {
    console.error('[WindowState] Failed to save:', err)
  }
}

/** 获取指定窗口的保存状态 */
export function getWindowState(name: keyof AllWindowStates): WindowState | null {
  loadWindowStates()
  return states[name] ?? null
}

/** 保存指定窗口的状态 */
export function saveWindowState(name: keyof AllWindowStates, win: BrowserWindow): void {
  loadWindowStates()
  if (win.isDestroyed()) return

  const [x, y] = win.getPosition()
  const [width, height] = win.getSize()

  states[name] = { x, y, width, height }
  saveStates()
}

/**
 * 确保窗口位置在某个显示器的可视范围内
 * 支持多显示器：如果位置不在任何显示器内，回退到主显示器
 */
export function ensureVisibleBounds(state: WindowState): WindowState {
  const displays = screen.getAllDisplays()

  // 检查位置是否在任何显示器的可视区域内
  for (const display of displays) {
    const { workArea } = display
    if (
      state.x >= workArea.x &&
      state.x <= workArea.x + workArea.width - 50 && // 至少 50px 可见
      state.y >= workArea.y &&
      state.y <= workArea.y + workArea.height - 50
    ) {
      return state // 位置有效
    }
  }

  // 位置无效，回退到主显示器右下角
  const { workArea } = screen.getPrimaryDisplay()
  return {
    x: workArea.x + workArea.width - state.width - 20,
    y: workArea.y + workArea.height - state.height - 20,
    width: state.width,
    height: state.height
  }
}
