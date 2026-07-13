import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
import { execSync } from 'child_process'
import { createPetWindow, getPetWindow } from './windows/pet-window'
import { createChatWindow, getChatWindow, showChatWindow, hideChatWindow } from './windows/chat-window'
import { registerIpcHandlers } from './ipc'
import { createTray } from './tray'
import { registerShortcuts, unregisterAll } from './shortcuts'
import { initTheme } from './theme'
import { startResourceMonitor, stopResourceMonitor } from './system-resource-monitor'
import { PetState } from '@shared/types'

// ── Windows 控制台编码修复 ──
// Node.js 在启动时缓存控制台代码页，chcp 65001 无法改变已启动进程的输出编码。
// 方案：monkey-patch console 方法，将非 GBK 兼容的 Unicode 符号替换为 ASCII 等价物。
// 中文字符不受影响（GBK 支持中文），只有 emoji 和特殊符号会乱码。
if (process.platform === 'win32') {
  // 尝试切换代码页（可能在某些终端环境下生效）
  try {
    execSync('chcp 65001', { stdio: 'ignore' })
  } catch {
    // 忽略
  }

  // Unicode → ASCII 替换映射（仅替换 GBK 不支持的符号）
  const UNICODE_TO_ASCII: Record<string, string> = {
    '✓': 'OK', '✅': 'OK', '✔': 'OK',
    '✗': 'FAIL', '❌': 'FAIL', '✖': 'FAIL',
    '→': '->', '←': '<-', '↑': '^', '↓': 'v',
    '━': '=', '─': '-', '│': '|', '┌': '+', '┐': '+', '└': '+', '┘': '+',
    '·': '-', '—': '--', '–': '-',
    '\u201c': '"', '\u201d': '"', '\u2018': "'", '\u2019': "'",
    '…': '...',
    '⚠': '!', '⚡': '!',
    '🔍': '[search]', '✨': '[new]', '💡': '[tip]', '🔧': '[fix]', '🛠': '[tool]',
    '📋': '[list]', '📦': '[pkg]', '🔑': '[key]', '🔒': '[lock]',
    '✅': 'OK', '❎': 'OK',
    '⏱': '[time]', '⏰': '[alarm]',
    '📊': '[chart]', '📈': '[up]', '📉': '[down]',
    '🎉': '[done]', '🚀': '[go]',
  }

  const sanitize = (text: string): string => {
    let result = text
    for (const [unicode, ascii] of Object.entries(UNICODE_TO_ASCII)) {
      result = result.split(unicode).join(ascii)
    }
    // 移除其他非 GBK 兼容字符（保留中文、日文、韩文等 CJK 字符）
    // CJK 统一汉字范围：U+4E00-U+9FFF，U+3400-U+4DBF
    // 基本拉丁：U+0020-U+007E
    // 常用标点：U+3000-U+303F（中文标点）
    result = result.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/gu, (m) => UNICODE_TO_ASCII[m] || '?')
    return result
  }

  const origLog = console.log
  const origError = console.error
  const origWarn = console.warn
  const origInfo = console.info

  console.log = (...args: unknown[]) => origLog(...args.map(a => typeof a === 'string' ? sanitize(a) : a))
  console.error = (...args: unknown[]) => origError(...args.map(a => typeof a === 'string' ? sanitize(a) : a))
  console.warn = (...args: unknown[]) => origWarn(...args.map(a => typeof a === 'string' ? sanitize(a) : a))
  console.info = (...args: unknown[]) => origInfo(...args.map(a => typeof a === 'string' ? sanitize(a) : a))
}

// ── 全局引用 ──
let tray: Tray | null = null

// ── 测试模式检测 ──
const isTestMode = process.env.NODE_ENV === 'test'

// ── 单实例锁（测试模式下跳过）──
if (!isTestMode) {
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    app.quit()
  }

  app.on('second-instance', () => {
    // 第二实例尝试启动时，显示已有窗口
    const petWin = getPetWindow()
    if (petWin) {
      if (petWin.isMinimized()) petWin.restore()
      petWin.show()
      petWin.focus()
    }
  })
}

// ── 应用就绪 ──
app.whenReady().then(async () => {
  // 设置环境变量，让 agent 层能获取应用数据目录（用于浏览器专用 Profile）
  process.env['ELECTRON_USER_DATA'] = app.getPath('userData')

  // 创建宠物窗口（常驻）
  createPetWindow()

  // 创建对话窗口（隐藏，点击宠物时显示）
  createChatWindow()

  // 注册 IPC 处理器（异步：内部需要先初始化数据库）
  await registerIpcHandlers()

  // 创建系统托盘
  tray = createTray()

  // 注册全局快捷键
  registerShortcuts()

  // 初始化主题
  initTheme()

  // 启动系统资源监控（宠物动画速度根据 CPU/内存 使用率动态变化）
  startResourceMonitor()

  // macOS: 点击 dock 图标时重新显示
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createPetWindow()
      createChatWindow()
    }
  })
})

// ── 窗口关闭行为 ──
app.on('window-all-closed', () => {
  // 测试模式下直接退出
  if (isTestMode) {
    app.quit()
    return
  }
  // 所有窗口关闭时不退出应用（因为有托盘）
  // macOS 上也不退出
  // 用户通过托盘菜单退出
  if (process.platform === 'darwin') {
    // macOS: 保持应用活跃
  } else {
    // Windows/Linux: 隐藏到托盘
    const petWin = getPetWindow()
    const chatWin = getChatWindow()
    petWin?.hide()
    chatWin?.hide()
  }
})

// ── 退出前清理 ──
app.on('before-quit', () => {
  unregisterAll()
  stopResourceMonitor()
  tray?.destroy()
})

// ── 导出给 IPC 模块使用 ──
export { showChatWindow, hideChatWindow, getPetWindow, getChatWindow, tray }
