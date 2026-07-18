import { Tray, Menu, nativeImage, app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { IPC_CHANNELS } from '@shared/types'
import { getPetWindow, setPetState } from './windows/pet-window'
import { showChatWindow, hideChatWindow, getChatWindow } from './windows/chat-window'
import { showSkillsWindow } from './windows/skills-window'
import { showMemoryWindow } from './windows/memory-window'
import { showPluginsWindow } from './windows/plugins-window'
import { showSettingsWindow } from './windows/settings-window'
import { showEvolutionWindow } from './windows/evolution-window'

let tray: Tray | null = null

// ── 宠物休眠状态跟踪 ──
let isSleeping = false

export function isPetSleeping(): boolean {
  return isSleeping
}

/**
 * 创建托盘图标
 *
 * 优先使用 build/icon.png 或 build/icon.ico，
 * 如果不存在，则生成一个品牌色的圆形图标（猫头鹰眼睛造型）。
 */
function createTrayIcon(): Electron.NativeImage {
  // 尝试加载图标文件
  const iconPathPng = join(app.getAppPath(), 'build', 'icon.png')
  const iconPathIco = join(app.getAppPath(), 'build', 'icon.ico')
  const iconPathResPng = join(process.resourcesPath || '', 'build', 'icon.png')

  for (const p of [iconPathPng, iconPathIco, iconPathResPng]) {
    if (existsSync(p)) {
      try {
        const img = nativeImage.createFromPath(p)
        if (!img.isEmpty()) {
          // 缩放到 16x16 用于托盘
          return img.resize({ width: 16, height: 16 })
        }
      } catch { /* ignore */ }
    }
  }

  // 生成品牌色图标（16x16 RGBA）
  // 品牌色: #5BAA8A (91, 170, 138)
  const size = 16
  const buffer = Buffer.alloc(size * size * 4)

  // 品牌色 RGBA
  const r = 91, g = 170, b = 138, a = 255
  // 白色（眼睛）RGBA
  const wr = 255, wg = 255, wb = 255

  const center = 7.5  // 圆心
  const radius = 7.5   // 半径

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4
      const dx = x - center
      const dy = y - center
      const dist = Math.sqrt(dx * dx + dy * dy)

      if (dist <= radius) {
        // 在圆内 — 检查是否是眼睛
        // 左眼 (5, 5) 右眼 (10, 5)
        const leftEyeDx = x - 5, leftEyeDy = y - 5
        const rightEyeDx = x - 10, rightEyeDy = y - 5
        const leftEyeDist = Math.sqrt(leftEyeDx * leftEyeDx + leftEyeDy * leftEyeDy)
        const rightEyeDist = Math.sqrt(rightEyeDx * rightEyeDx + rightEyeDy * rightEyeDy)

        if (leftEyeDist <= 1.8 || rightEyeDist <= 1.8) {
          // 眼睛白色
          buffer[idx] = wr
          buffer[idx + 1] = wg
          buffer[idx + 2] = wb
          buffer[idx + 3] = a
        } else {
          // 品牌色背景
          buffer[idx] = r
          buffer[idx + 1] = g
          buffer[idx + 2] = b
          buffer[idx + 3] = a
        }
      } else {
        // 圆外 — 透明
        buffer[idx] = 0
        buffer[idx + 1] = 0
        buffer[idx + 2] = 0
        buffer[idx + 3] = 0
      }
    }
  }

  return nativeImage.createFromBuffer(buffer, { width: size, height: size })
}

/**
 * 创建系统托盘
 */
export function createTray(): Tray {
  const trayIcon = createTrayIcon()

  tray = new Tray(trayIcon)
  tray.setToolTip('Zen Agent — 智慧小猫头鹰')

  updateTrayMenu()

  // 点击托盘图标显示/隐藏宠物
  tray.on('click', () => {
    const petWin = getPetWindow()
    if (petWin) {
      if (petWin.isVisible()) {
        petWin.hide()
      } else {
        petWin.show()
      }
    }
  })

  return tray
}

/**
 * 更新托盘菜单（根据休眠状态动态变化）
 */
export function updateTrayMenu(): void {
  if (!tray) return

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示宠物',
      click: () => {
        const petWin = getPetWindow()
        petWin?.show()
      }
    },
    {
      label: '隐藏宠物',
      click: () => {
        getPetWindow()?.hide()
      }
    },
    { type: 'separator' },
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
      label: '自进化',
      click: () => {
        showEvolutionWindow()
      }
    },
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
      label: '插件管理',
      click: () => {
        showPluginsWindow()
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
      label: isSleeping ? '唤醒' : '休眠',
      click: () => {
        const petWin = getPetWindow()
        if (isSleeping) {
          isSleeping = false
          setPetState('idle')
          if (petWin) {
            petWin.webContents.send(IPC_CHANNELS.PET_SHOW_BUBBLE, {
              text: '我醒啦！有什么可以帮你的吗？',
              type: 'greeting'
            })
          }
        } else {
          isSleeping = true
          setPetState('sleeping')
          hideChatWindow()
          if (petWin) {
            petWin.webContents.send(IPC_CHANNELS.PET_SHOW_BUBBLE, {
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

  tray.setContextMenu(contextMenu)
}
