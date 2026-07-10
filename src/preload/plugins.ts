import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '@shared/types'

const pluginsAPI = {
  /** 获取所有插件 */
  list: () => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_LIST),

  /** 获取单个插件 */
  get: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_GET, id),

  /** 安装插件 */
  install: (manifest: unknown) => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_INSTALL, manifest),

  /** 卸载插件 */
  uninstall: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_UNINSTALL, id),

  /** 启用/禁用插件 */
  toggle: (id: string, enabled: boolean) => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_TOGGLE, id, enabled),

  /** 关闭窗口 */
  close: () => ipcRenderer.invoke('plugins:close')
}

contextBridge.exposeInMainWorld('pluginsAPI', pluginsAPI)

export type PluginsAPI = typeof pluginsAPI
