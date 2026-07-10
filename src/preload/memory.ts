import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '@shared/types'

const memoryAPI = {
  /** 获取所有记忆（分页） */
  list: (params?: { type?: 'episodic' | 'semantic'; limit?: number; offset?: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_LIST, params),

  /** 语义搜索记忆 */
  search: (query: string, topK?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_SEARCH, query, topK),

  /** 获取单条记忆 */
  get: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_GET, id),

  /** 删除记忆 */
  remove: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_DELETE, id),

  /** 手动添加记忆 */
  create: (memory: {
    content: string
    type?: 'episodic' | 'semantic'
    importance?: number
    tags?: string[]
  }) => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_CREATE, memory),

  /** 获取记忆统计 */
  stats: () => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_STATS),

  /** 关闭窗口 */
  close: () => ipcRenderer.invoke('memory:close')
}

contextBridge.exposeInMainWorld('memoryAPI', memoryAPI)

export type MemoryAPI = typeof memoryAPI
