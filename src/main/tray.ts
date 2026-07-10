import { Tray, Menu, nativeImage, app } from 'electron'
import { join } from 'path'
import { IPC_CHANNELS } from '@shared/types'
import { getPetWindow, setPetState } from './windows/pet-window'
import { showChatWindow, hideChatWindow, getChatWindow } from './windows/chat-window'
import { showSkillsWindow } from './windows/skills-window'
import { showMemoryWindow } from './windows/memory-window'
import { showPluginsWindow } from './windows/plugins-window'
import { showSettingsWindow } from './windows/settings-window'

let tray: Tray | null = null

// ── 宠物休眠状态跟踪 ──
let isSleeping = false

export function isPetSleeping(): boolean {
  return isSleeping
}

/**
 * 创建系统托盘
 */
export function createTray(): Tray {
  // 创建一个简单的托盘图标（16x16 透明图标）
  const icon = nativeImage.createEmpty()
  // 临时方案：使用一个 1x1 像素的透明图标
  const size = 16
  const buffer = Buffer.alloc(size * size * 4, 0)
  const trayIcon = nativeImage.createFromBuffer(buffer, { width: size, height: size })

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
          // 通过 IPC 通知渲染进程新建会话
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
      label: isSleeping ? '☀️ 唤醒' : '🌙 休眠',
      click: () => {
        const petWin = getPetWindow()
        if (isSleeping) {
          // 唤醒
          isSleeping = false
          setPetState('idle')
          // 显示问候气泡
          if (petWin) {
            petWin.webContents.send(IPC_CHANNELS.PET_SHOW_BUBBLE, {
              text: '我醒啦！有什么可以帮你的吗？ 🦉',
              type: 'greeting'
            })
          }
        } else {
          // 休眠
          isSleeping = true
          setPetState('sleeping')
          // 隐藏对话窗口
          hideChatWindow()
          if (petWin) {
            petWin.webContents.send(IPC_CHANNELS.PET_SHOW_BUBBLE, {
              text: '晚安... Zzz 💤',
              type: 'info'
            })
          }
        }
        // 更新菜单显示
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
