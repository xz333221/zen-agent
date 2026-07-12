import { BrowserWindow, screen, ipcMain } from 'electron'
import { join } from 'path'
import { getConfig } from '@agent/providers/llm-config'

let settingsWindow: BrowserWindow | null = null

/** 创建设置窗口 */
export function createSettingsWindow(): BrowserWindow {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus()
    return settingsWindow
  }

  const { workArea } = screen.getPrimaryDisplay()

  // 根据屏幕工作区自适应窗口尺寸（4K/高分辨率屏幕自动放大）
  const width = Math.min(1300, Math.max(860, Math.round(workArea.width * 0.42)))
  const height = Math.min(1400, Math.max(800, Math.round(workArea.height * 0.88)))
  const minWidth = Math.min(860, Math.max(640, Math.round(workArea.width * 0.3)))
  const minHeight = Math.min(900, Math.max(640, Math.round(workArea.height * 0.65)))

  // 居中显示
  const x = workArea.x + Math.round((workArea.width - width) / 2)
  const y = workArea.y + Math.round((workArea.height - height) / 2)

  settingsWindow = new BrowserWindow({
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
      preload: join(__dirname, '../preload/settings.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    settingsWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/settings/index.html')
  } else {
    settingsWindow.loadFile(join(__dirname, '../renderer/settings/index.html'))
  }

  settingsWindow.once('ready-to-show', () => {
    settingsWindow?.show()
    settingsWindow?.focus()

    // 应用保存的缩放比例
    try {
      const config = getConfig()
      const zoom = config.uiZoomFactor
      if (zoom && typeof zoom === 'number' && zoom > 0) {
        settingsWindow?.webContents.setZoomFactor(Math.max(0.5, Math.min(3.0, zoom)))
      }
    } catch { /* ignore */ }
  })

  // 关闭窗口时清理引用（设置窗口可以被真正关闭）
  settingsWindow.on('closed', () => {
    settingsWindow = null
  })

  // 处理关闭请求（移除旧 handler 避免重复注册报错）
  ipcMain.removeHandler('settings:close')
  ipcMain.handle('settings:close', async () => {
    settingsWindow?.close()
    return { success: true }
  })

  return settingsWindow
}

/** 显示设置窗口 */
export function showSettingsWindow(): void {
  if (!settingsWindow || settingsWindow.isDestroyed()) {
    createSettingsWindow()
  } else {
    settingsWindow.show()
    settingsWindow.focus()
  }
}

/** 获取设置窗口 */
export function getSettingsWindow(): BrowserWindow | null {
  return settingsWindow
}
