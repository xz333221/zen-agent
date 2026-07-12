import { BrowserWindow, screen, ipcMain, Menu, app } from 'electron'

// ── 拖拽状态（主进程轮询模式，避免 IPC 延迟导致卡顿） ──
let dragPollTimer: NodeJS.Timeout | null = null
let dragOffsetX = 0
let dragOffsetY = 0
import { join } from 'path'
import { IPC_CHANNELS } from '@shared/types'
import { isPetSleeping, updateTrayMenu } from '../tray'
import { getWindowState, saveWindowState, ensureVisibleBounds } from '../window-state'
import { showChatWindow, hideChatWindow, getChatWindow } from './chat-window'
import { showSkillsWindow } from './skills-window'
import { showMemoryWindow } from './memory-window'
import { showSettingsWindow } from './settings-window'

let petWindow: BrowserWindow | null = null

/** 获取屏幕右下角位置 */
function getBottomRightPosition(width: number, height: number): { x: number; y: number } {
  const { workArea } = screen.getPrimaryDisplay()
  return {
    x: workArea.x + workArea.width - width - 20,
    y: workArea.y + workArea.height - height - 20
  }
}

export function createPetWindow(): BrowserWindow {
  if (petWindow && !petWindow.isDestroyed()) return petWindow

  // 根据屏幕工作区自适应窗口尺寸（4K/高分辨率屏幕自动放大）
  const { workArea } = screen.getPrimaryDisplay()
  const width = Math.min(520, Math.max(340, Math.round(workArea.width * 0.16)))
  const height = Math.min(460, Math.max(300, Math.round(workArea.height * 0.22)))

  // 尝试从持久化存储中恢复位置
  const savedState = getWindowState('pet')
  let x: number, y: number
  if (savedState) {
    // 确保位置在某个显示器的可视范围内（多显示器支持）
    const valid = ensureVisibleBounds(savedState)
    x = valid.x
    y = valid.y
  } else {
    const { workArea: wa } = screen.getPrimaryDisplay()
    const pos = {
      x: wa.x + wa.width - width - 20,
      y: wa.y + wa.height - height - 20
    }
    x = pos.x
    y = pos.y
  }

  petWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    transparent: true,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/pet.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // 开发环境加载 dev server，生产环境加载打包文件
  if (process.env['ELECTRON_RENDERER_URL']) {
    petWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/pet/index.html')
  } else {
    petWindow.loadFile(join(__dirname, '../renderer/pet/index.html'))
  }

  petWindow.once('ready-to-show', () => {
    petWindow?.show()
  })

  // ── 拖拽支持（主进程轮询模式） ──
  // 渲染进程只发送拖拽开始/结束，拖拽过程中主进程自行轮询鼠标位置
  // 这样避免了每帧 IPC 通信的延迟，大幅提升流畅度
  ipcMain.on(IPC_CHANNELS.PET_DRAG, (_event, _deltaX: number, _deltaY: number) => {
    // 兼容旧接口：如果收到 delta，仍然处理（但主要走新的 start/end 模式）
    if (!petWindow) return
    const [currentX, currentY] = petWindow.getPosition()
    petWindow.setPosition(currentX + _deltaX, currentY + _deltaY)
  })

  // 拖拽开始：记录鼠标和窗口的偏移量，启动轮询定时器
  ipcMain.on(IPC_CHANNELS.PET_DRAG_START, () => {
    if (!petWindow) return
    const cursorPos = screen.getCursorScreenPoint()
    const [winX, winY] = petWindow.getPosition()
    dragOffsetX = winX - cursorPos.x
    dragOffsetY = winY - cursorPos.y

    // 停止之前的轮询（如果有）
    if (dragPollTimer) {
      clearInterval(dragPollTimer)
    }

    // 高频轮询鼠标位置，直接移动窗口（~60fps）
    dragPollTimer = setInterval(() => {
      if (!petWindow || petWindow.isDestroyed()) {
        if (dragPollTimer) {
          clearInterval(dragPollTimer)
          dragPollTimer = null
        }
        return
      }
      const pos = screen.getCursorScreenPoint()
      petWindow.setPosition(pos.x + dragOffsetX, pos.y + dragOffsetY)
    }, 16) // ~60fps
  })

  // ── 拖拽结束 → 停止轮询 + 保存位置 ──
  ipcMain.on(IPC_CHANNELS.PET_DRAG_END, () => {
    if (dragPollTimer) {
      clearInterval(dragPollTimer)
      dragPollTimer = null
    }
    if (!petWindow) return
    saveWindowState('pet', petWindow)
  })

  // ── 点击宠物 → 显示对话窗口 ──
  ipcMain.on(IPC_CHANNELS.PET_CLICK, () => {
    showChatWindow()
  })

  // ── 右键菜单 ──
  ipcMain.on(IPC_CHANNELS.PET_RIGHT_CLICK, () => {
    showContextMenu()
  })

  // 防止窗口被关闭（隐藏代替）—— 测试模式下允许关闭
  petWindow.on('close', (e) => {
    if (process.env.NODE_ENV !== 'test') {
      e.preventDefault()
      petWindow?.hide()
    }
  })

  return petWindow
}

function showContextMenu() {
  const sleeping = isPetSleeping()
  const menu = Menu.buildFromTemplate([
    {
      label: '打开对话',
      click: () => {
        showChatWindow()
      }
    },
    {
      label: '关闭对话',
      click: () => {
        hideChatWindow()
      }
    },
    {
      label: '新建会话',
      click: () => {
        showChatWindow()
        const chatWin = getChatWindow()
        if (chatWin) {
          chatWin.webContents.send(IPC_CHANNELS.CHAT_NEW_SESSION_NOTIFY)
        }
      }
    },
    { type: 'separator' },
    {
      label: '技能管理',
      click: () => {
        showSkillsWindow()
      }
    },
    {
      label: '记忆浏览',
      click: () => {
        showMemoryWindow()
      }
    },
    {
      label: '设置',
      click: () => {
        showSettingsWindow()
      }
    },
    { type: 'separator' },
    {
      label: sleeping ? '唤醒' : '休眠',
      click: () => {
        if (sleeping) {
          // 唤醒
          setPetState('idle')
          if (petWindow) {
            petWindow.webContents.send(IPC_CHANNELS.PET_SHOW_BUBBLE, {
              text: '我醒啦！有什么可以帮你的吗？',
              type: 'greeting'
            })
          }
        } else {
          // 休眠
          setPetState('sleeping')
          hideChatWindow()
          if (petWindow) {
            petWindow.webContents.send(IPC_CHANNELS.PET_SHOW_BUBBLE, {
              text: '晚安，我休息一下...',
              type: 'info'
            })
          }
        }
        updateTrayMenu()
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.quit()
      }
    }
  ])
  menu.popup()
}

export function getPetWindow(): BrowserWindow | null {
  return petWindow
}

/** 更新宠物状态（供 IPC 模块调用） */
export function setPetState(state: string, bubble?: unknown) {
  if (!petWindow) return
  petWindow.webContents.send(IPC_CHANNELS.PET_STATE_CHANGE, { state, bubble })
}
