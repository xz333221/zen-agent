import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, PetStateData } from '@shared/types'

const petAPI = {
  /** 通知主进程：宠物被点击 */
  onClick: () => ipcRenderer.send(IPC_CHANNELS.PET_CLICK),

  /** 通知主进程：宠物被拖拽 */
  onDrag: (deltaX: number, deltaY: number) =>
    ipcRenderer.send(IPC_CHANNELS.PET_DRAG, deltaX, deltaY),

  /** 通知主进程：拖拽结束 */
  onDragEnd: () =>
    ipcRenderer.send(IPC_CHANNELS.PET_DRAG_END),

  /** 通知主进程：右键点击 */
  onRightClick: () => ipcRenderer.send(IPC_CHANNELS.PET_RIGHT_CLICK),

  /** 气泡动作点击 */
  onBubbleAction: (actionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PET_BUBBLE_ACTION, actionId),

  /** 监听状态变化 */
  onStateChange: (callback: (data: PetStateData) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: PetStateData) => callback(data)
    ipcRenderer.on(IPC_CHANNELS.PET_STATE_CHANGE, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PET_STATE_CHANGE, handler)
  },

  /** 监听气泡显示 */
  onShowBubble: (callback: (bubble: PetStateData['bubble']) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, bubble: PetStateData['bubble']) => callback(bubble)
    ipcRenderer.on(IPC_CHANNELS.PET_SHOW_BUBBLE, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PET_SHOW_BUBBLE, handler)
  },

  /** 获取主题模式 */
  getTheme: () => ipcRenderer.invoke(IPC_CHANNELS.SYS_GET_THEME),

  /** 监听主题变化 */
  onThemeChange: (callback: (data: { mode: string; effective: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { mode: string; effective: string }) => callback(data)
    ipcRenderer.on(IPC_CHANNELS.SYS_THEME_CHANGE, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SYS_THEME_CHANGE, handler)
  }
}

contextBridge.exposeInMainWorld('petAPI', petAPI)

export type PetAPI = typeof petAPI
