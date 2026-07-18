/**
 * electron 模块的 vitest mock
 *
 * agent 层模块（llm-config、database 等）在 import 时会访问
 * app.getPath('userData') 等 Electron API。测试环境下用
 * 临时目录替代，避免依赖 Electron 运行时。
 */

import { tmpdir } from 'os'
import { join } from 'path'
import { mkdirSync } from 'fs'

const testUserData = join(tmpdir(), 'zen-agent-test')
mkdirSync(testUserData, { recursive: true })

export const app = {
  getPath: (_name: string): string => testUserData,
  getName: (): string => 'zen-agent-test',
  getVersion: (): string => '0.0.0-test',
  isPackaged: false,
  on: (): void => {},
  whenReady: (): Promise<void> => Promise.resolve()
}

export const ipcMain = {
  handle: (): void => {},
  on: (): void => {}
}

export const BrowserWindow = class {}

export const shell = {
  openExternal: (): Promise<void> => Promise.resolve()
}

export const screen = {
  getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } })
}

export const globalShortcut = {
  register: (): boolean => true,
  unregisterAll: (): void => {}
}

export default { app, ipcMain, BrowserWindow, shell, screen, globalShortcut }
