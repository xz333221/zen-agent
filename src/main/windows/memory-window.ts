import { BrowserWindow, screen, ipcMain } from 'electron'
import { join } from 'path'

let memoryWindow: BrowserWindow | null = null

/** 创建记忆浏览窗口 */
export function createMemoryWindow(): BrowserWindow {
  if (memoryWindow && !memoryWindow.isDestroyed()) {
    memoryWindow.focus()
    return memoryWindow
  }

  const width = 720
  const height = 680

  // 居中显示
  const { workArea } = screen.getPrimaryDisplay()
  const x = workArea.x + Math.round((workArea.width - width) / 2)
  const y = workArea.y + Math.round((workArea.height - height) / 2)

  memoryWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: true,
    minWidth: 500,
    minHeight: 500,
    show: false,
    skipTaskbar: false,
    alwaysOnTop: true,
    hasShadow: true,
    webPreferences: {
      preload: join(__dirname, '../preload/memory.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    memoryWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/memory/index.html')
  } else {
    memoryWindow.loadFile(join(__dirname, '../renderer/memory/index.html'))
  }

  memoryWindow.once('ready-to-show', () => {
    memoryWindow?.show()
    memoryWindow?.focus()
  })

  // 关闭窗口时清理引用
  memoryWindow.on('closed', () => {
    memoryWindow = null
  })

  // 处理关闭请求（移除旧 handler 避免重复注册报错）
  ipcMain.removeHandler('memory:close')
  ipcMain.handle('memory:close', async () => {
    memoryWindow?.close()
    return { success: true }
  })

  return memoryWindow
}

/** 显示记忆窗口 */
export function showMemoryWindow(): void {
  if (!memoryWindow || memoryWindow.isDestroyed()) {
    createMemoryWindow()
  } else {
    memoryWindow.show()
    memoryWindow.focus()
  }
}

/** 获取记忆窗口 */
export function getMemoryWindow(): BrowserWindow | null {
  return memoryWindow
}
