import { BrowserWindow, screen, ipcMain } from 'electron'
import { join } from 'path'

let evolutionWindow: BrowserWindow | null = null

/** 创建自进化面板窗口 */
export function createEvolutionWindow(): BrowserWindow {
  if (evolutionWindow && !evolutionWindow.isDestroyed()) {
    evolutionWindow.focus()
    return evolutionWindow
  }

  const width = 800
  const height = 720

  const { workArea } = screen.getPrimaryDisplay()
  const x = workArea.x + Math.round((workArea.width - width) / 2)
  const y = workArea.y + Math.round((workArea.height - height) / 2)

  evolutionWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: true,
    minWidth: 560,
    minHeight: 500,
    show: false,
    skipTaskbar: false,
    alwaysOnTop: true,
    hasShadow: true,
    webPreferences: {
      preload: join(__dirname, '../preload/evolution.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    evolutionWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/evolution/index.html')
  } else {
    evolutionWindow.loadFile(join(__dirname, '../renderer/evolution/index.html'))
  }

  evolutionWindow.once('ready-to-show', () => {
    evolutionWindow?.show()
    evolutionWindow?.focus()
  })

  evolutionWindow.on('closed', () => {
    evolutionWindow = null
  })

  ipcMain.removeHandler('evolution:close')
  ipcMain.handle('evolution:close', async () => {
    evolutionWindow?.close()
    return { success: true }
  })

  return evolutionWindow
}

/** 显示自进化面板 */
export function showEvolutionWindow(): void {
  if (!evolutionWindow || evolutionWindow.isDestroyed()) {
    createEvolutionWindow()
  } else {
    evolutionWindow.show()
    evolutionWindow.focus()
  }
}

/** 获取自进化窗口 */
export function getEvolutionWindow(): BrowserWindow | null {
  return evolutionWindow
}
