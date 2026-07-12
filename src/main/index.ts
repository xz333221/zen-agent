import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
import { execSync } from 'child_process'
import { createPetWindow, getPetWindow } from './windows/pet-window'
import { createChatWindow, getChatWindow, showChatWindow, hideChatWindow } from './windows/chat-window'
import { registerIpcHandlers } from './ipc'
import { createTray } from './tray'
import { registerShortcuts, unregisterAll } from './shortcuts'
import { initTheme } from './theme'
import { PetState } from '@shared/types'

// ── Windows 控制台编码修复 ──
// 同步切换 CMD 代码页为 UTF-8 (65001)，解决中文显示乱码问题
// 必须同步执行，否则后续 console.log 仍然使用旧代码页
if (process.platform === 'win32') {
  try {
    execSync('chcp 65001', { stdio: 'ignore' })
    // 设置 stdout/stderr 为 UTF-8 编码
    if (process.stdout && typeof (process.stdout as any).setDefaultEncoding === 'function') {
      (process.stdout as any).setDefaultEncoding('utf-8')
    }
    if (process.stderr && typeof (process.stderr as any).setDefaultEncoding === 'function') {
      (process.stderr as any).setDefaultEncoding('utf-8')
    }
  } catch {
    // 忽略错误：在某些环境（如 CI）中可能无法切换代码页
  }
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
  tray?.destroy()
})

// ── 导出给 IPC 模块使用 ──
export { showChatWindow, hideChatWindow, getPetWindow, getChatWindow, tray }
