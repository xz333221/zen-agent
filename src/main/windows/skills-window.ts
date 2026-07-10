import { BrowserWindow, screen, ipcMain } from 'electron'
import { join } from 'path'

let skillsWindow: BrowserWindow | null = null

/** 创建技能管理窗口 */
export function createSkillsWindow(): BrowserWindow {
  if (skillsWindow && !skillsWindow.isDestroyed()) {
    skillsWindow.focus()
    return skillsWindow
  }

  const width = 720
  const height = 680

  // 居中显示
  const { workArea } = screen.getPrimaryDisplay()
  const x = workArea.x + Math.round((workArea.width - width) / 2)
  const y = workArea.y + Math.round((workArea.height - height) / 2)

  skillsWindow = new BrowserWindow({
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
      preload: join(__dirname, '../preload/skills.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    skillsWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/skills/index.html')
  } else {
    skillsWindow.loadFile(join(__dirname, '../renderer/skills/index.html'))
  }

  skillsWindow.once('ready-to-show', () => {
    skillsWindow?.show()
    skillsWindow?.focus()
  })

  // 关闭窗口时清理引用
  skillsWindow.on('closed', () => {
    skillsWindow = null
  })

  // 处理关闭请求（移除旧 handler 避免重复注册报错）
  ipcMain.removeHandler('skills:close')
  ipcMain.handle('skills:close', async () => {
    skillsWindow?.close()
    return { success: true }
  })

  return skillsWindow
}

/** 显示技能窗口 */
export function showSkillsWindow(): void {
  if (!skillsWindow || skillsWindow.isDestroyed()) {
    createSkillsWindow()
  } else {
    skillsWindow.show()
    skillsWindow.focus()
  }
}

/** 获取技能窗口 */
export function getSkillsWindow(): BrowserWindow | null {
  return skillsWindow
}
