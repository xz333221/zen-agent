import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '@shared/types'

const evolutionAPI = {
  /** 获取自进化状态 */
  getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.EVOLUTION_GET_STATUS),

  /** 启用/禁用自进化 */
  setEnabled: (enabled: boolean) => ipcRenderer.invoke(IPC_CHANNELS.EVOLUTION_SET_ENABLED, enabled),

  /** 手动触发一次进化 */
  runOnce: () => ipcRenderer.invoke(IPC_CHANNELS.EVOLUTION_RUN_ONCE),

  /** 获取进化记录列表 */
  getRecords: (limit: number = 20) => ipcRenderer.invoke(IPC_CHANNELS.EVOLUTION_GET_RECORDS, limit),

  /** 获取单条进化记录 */
  getRecord: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.EVOLUTION_GET_RECORD, id),

  /** 获取进化统计 */
  getStats: () => ipcRenderer.invoke(IPC_CHANNELS.EVOLUTION_GET_STATS),

  /** 获取进化配置 */
  getConfig: () => ipcRenderer.invoke(IPC_CHANNELS.EVOLUTION_GET_CONFIG),

  /** 更新进化配置 */
  setConfig: (config: Record<string, unknown>) => ipcRenderer.invoke(IPC_CHANNELS.EVOLUTION_SET_CONFIG, config),

  /** 获取 Token 预算 */
  getTokenBudget: () => ipcRenderer.invoke(IPC_CHANNELS.EVOLUTION_GET_TOKEN_BUDGET),

  /** 关闭窗口 */
  close: () => ipcRenderer.invoke('evolution:close')
}

contextBridge.exposeInMainWorld('evolutionAPI', evolutionAPI)

export type EvolutionAPI = typeof evolutionAPI
