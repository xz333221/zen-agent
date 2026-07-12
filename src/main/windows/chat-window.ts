import { BrowserWindow, screen, ipcMain } from 'electron'
import { join } from 'path'
import { getConfig } from '@agent/providers/llm-config'

let chatWindow: BrowserWindow | null = null

export function createChatWindow(): BrowserWindow {
  if (chatWindow && !chatWindow.isDestroyed()) return chatWindow

  const { workArea } = screen.getPrimaryDisplay()

  // 根据屏幕工作区自适应窗口尺寸（4K/高分辨率屏幕自动放大）
  const width = Math.min(2000, Math.max(1200, Math.round(workArea.width * 0.55)))
  const height = Math.min(1800, Math.max(1000, Math.round(workArea.height * 0.92)))
  const minWidth = Math.min(1100, Math.max(800, Math.round(workArea.width * 0.32)))
  const minHeight = Math.min(1000, Math.max(760, Math.round(workArea.height * 0.7)))

  // 默认位置：屏幕右侧偏下
  const x = workArea.x + workArea.width - width - 40
  const y = workArea.y + Math.round((workArea.height - height) / 2)

  chatWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: true,
    minWidth,
    minHeight,
    show: false,
    skipTaskbar: false,
    alwaysOnTop: false,
    hasShadow: true,
    webPreferences: {
      preload: join(__dirname, '../preload/chat.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    chatWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/chat/index.html')
  } else {
    chatWindow.loadFile(join(__dirname, '../renderer/chat/index.html'))
  }

  // 应用保存的缩放比例
  chatWindow.webContents.once('did-finish-load', () => {
    try {
      const config = getConfig()
      const zoom = config.uiZoomFactor
      if (zoom && typeof zoom === 'number' && zoom > 0) {
        chatWindow?.webContents.setZoomFactor(Math.max(0.5, Math.min(3.0, zoom)))
      }
    } catch { /* ignore */ }
  })

  chatWindow.on('close', (e) => {
    if (process.env.NODE_ENV !== 'test') {
      e.preventDefault()
      chatWindow?.hide()
    }
  })

  // 处理关闭请求（移除旧 handler 避免重复注册报错）
  ipcMain.removeHandler('chat:close')
  ipcMain.handle('chat:close', async () => {
    chatWindow?.hide()
    return { success: true }
  })

  return chatWindow
}

export function showChatWindow(): void {
  if (!chatWindow) {
    createChatWindow()
  }
  if (chatWindow && !chatWindow.isVisible()) {
    chatWindow.show()
    chatWindow.focus()
  } else if (chatWindow) {
    chatWindow.focus()
  }
}

export function hideChatWindow(): void {
  chatWindow?.hide()
}

export function getChatWindow(): BrowserWindow | null {
  return chatWindow
}
