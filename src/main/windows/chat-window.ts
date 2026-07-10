import { BrowserWindow, screen, ipcMain } from 'electron'
import { join } from 'path'
import { getPetWindow } from './pet-window'

let chatWindow: BrowserWindow | null = null

export function createChatWindow(): BrowserWindow {
  if (chatWindow && !chatWindow.isDestroyed()) return chatWindow

  const { workArea } = screen.getPrimaryDisplay()

  // 根据屏幕工作区自适应窗口尺寸（4K/高分辨率屏幕自动放大）
  const width = Math.min(1400, Math.max(800, Math.round(workArea.width * 0.38)))
  const height = Math.min(1400, Math.max(820, Math.round(workArea.height * 0.85)))
  const minWidth = Math.min(760, Math.max(520, Math.round(workArea.width * 0.25)))
  const minHeight = Math.min(820, Math.max(600, Math.round(workArea.height * 0.6)))

  // 默认位置：宠物旁边（右下角偏左）
  const x = workArea.x + workArea.width - width - 240
  const y = workArea.y + workArea.height - height - 20

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
    skipTaskbar: true,
    alwaysOnTop: true,
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
    // 跟随宠物窗口位置
    const petWin = getPetWindowSafe()
    if (petWin) {
      const [petX, petY] = petWin.getPosition()
      const [petW] = petWin.getSize()
      const [chatW, chatH] = chatWindow.getSize()
      // 对话窗口出现在宠物左侧
      const chatX = petX - chatW + petW + 40
      const chatY = petY - 300
      const { workArea } = screen.getPrimaryDisplay()
      const clampedX = Math.max(workArea.x, Math.min(chatX, workArea.x + workArea.width - chatW))
      const clampedY = Math.max(workArea.y, Math.min(chatY, workArea.y + workArea.height - chatH))
      chatWindow.setPosition(clampedX, clampedY)
    }
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

function getPetWindowSafe() {
  try {
    return getPetWindow()
  } catch {
    return null
  }
}
