import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type Skill } from '@shared/types'

const skillsAPI = {
  /** 获取所有技能 */
  list: () => ipcRenderer.invoke(IPC_CHANNELS.SKILL_LIST),

  /** 获取单个技能 */
  get: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.SKILL_GET, id),

  /** 创建技能 */
  create: (skill: {
    name: string
    description: string
    content: string
    status?: Skill['status']
  }) => ipcRenderer.invoke(IPC_CHANNELS.SKILL_CREATE, skill),

  /** 更新技能 */
  update: (id: string, updates: {
    name?: string
    description?: string
    content?: string
    status?: Skill['status']
  }) => ipcRenderer.invoke(IPC_CHANNELS.SKILL_UPDATE, id, updates),

  /** 删除技能 */
  remove: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.SKILL_DELETE, id),

  /** 关闭窗口 */
  close: () => ipcRenderer.invoke('skills:close')
}

contextBridge.exposeInMainWorld('skillsAPI', skillsAPI)

export type SkillsAPI = typeof skillsAPI
