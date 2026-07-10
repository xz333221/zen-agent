/**
 * 插件管理窗口 (T-022)
 */

import { BrowserWindow, screen, ipcMain } from 'electron'
import { join } from 'path'

let pluginsWindow: BrowserWindow | null = null

/** 创建插件管理窗口 */
export function createPluginsWindow(): BrowserWindow {
  if (pluginsWindow && !pluginsWindow.isDestroyed()) {
    pluginsWindow.focus()
    return pluginsWindow
  }

  const width = 720
  const height = 600

  // 居中显示
  const { workArea } = screen.getPrimaryDisplay()
  const x = workArea.x + Math.round((workArea.width - width) / 2)
  const y = workArea.y + Math.round((workArea.height - height) / 2)

  pluginsWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: true,
    minWidth: 500,
    minHeight: 400,
    show: false,
    skipTaskbar: false,
    alwaysOnTop: true,
    hasShadow: true,
    webPreferences: {
      preload: join(__dirname, '../preload/plugins.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    pluginsWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/plugins/index.html')
  } else {
    pluginsWindow.loadFile(join(__dirname, '../renderer/plugins/index.html'))
  }

  pluginsWindow.once('ready-to-show', () => {
    pluginsWindow?.show()
    pluginsWindow?.focus()
  })

  // 关闭窗口时清理引用
  pluginsWindow.on('closed', () => {
    pluginsWindow = null
  })

  // 处理关闭请求（移除旧 handler 避免重复注册报错）
  ipcMain.removeHandler('plugins:close')
  ipcMain.handle('plugins:close', async () => {
    pluginsWindow?.close()
    return { success: true }
  })

  return pluginsWindow
}

/** 显示插件窗口 */
export function showPluginsWindow(): void {
  if (!pluginsWindow || pluginsWindow.isDestroyed()) {
    createPluginsWindow()
  } else {
    pluginsWindow.show()
    pluginsWindow.focus()
  }
}

/** 获取插件窗口 */
export function getPluginsWindow(): BrowserWindow | null {
  return pluginsWindow
}
