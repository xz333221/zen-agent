/**
 * Electron 测试辅助工具
 *
 * 启动构建后的 Electron 应用，返回 Playwright 的 Electron 实例和窗口 Page。
 */
import { _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { resolve, join } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'

export interface TestApp {
  app: ElectronApplication
  petWindow: Page
  chatWindow: Page
  /** 测试结束后可用来清理的临时目录 */
  tempDir: string
}

/**
 * 启动 Zen Agent 应用并等待两个窗口都就绪。
 * 每次启动使用独立的 userData 目录，避免配置和数据库相互污染。
 */
export async function launchApp(): Promise<TestApp> {
  const mainPath = resolve(process.cwd(), 'out/main/index.js')

  // 创建独立的临时 userData 目录
  const tempDir = mkdtempSync(join(tmpdir(), 'zen-agent-test-'))

  // 清除 ELECTRON_RUN_AS_NODE（CatPaw 环境会设置此变量）
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.NODE_ENV = 'test'

  const app = await electron.launch({
    executablePath: undefined,
    args: [mainPath, '--user-data-dir=' + tempDir],
    env,
    timeout: 30000
  })

  // 等待宠物窗口出现
  const petWindow = await app.firstWindow()
  await petWindow.waitForLoadState('domcontentloaded')

  // 等待 SVG 猫头鹰渲染（首次启动可能较慢）
  await petWindow.locator('[data-testid="zen-owl"]').waitFor({ state: 'visible', timeout: 30000 })

  // 对话窗口初始隐藏，需要点击宠物后才出现
  let chatWindow = app.windows().find(w => w.url().includes('chat')) || null

  if (!chatWindow) {
    await petWindow.locator('[data-testid="pet-root"]').click()
    chatWindow = await waitForChatWindow(app)
  }

  await chatWindow.waitForLoadState('domcontentloaded')
  await chatWindow.locator('[data-testid="chat-root"]').waitFor({ state: 'visible' })

  return { app, petWindow, chatWindow }
}

/** 等待对话窗口出现 */
async function waitForChatWindow(app: ElectronApplication, timeout = 10000): Promise<Page> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const win = app.windows().find(w => w.url().includes('chat'))
    if (win) return win
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error('Chat window did not appear within timeout')
}

/** 带超时的 Promise */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms))
  ])
}

/** 关闭应用 — 用 app.exit(0) 强制退出，确保不留残留进程 */
export async function closeApp(app: ElectronApplication): Promise<void> {
  // 策略 1: 通过 evaluate 调用 app.exit(0) — 绕过所有 quit 拦截器
  try {
    await withTimeout(
      app.evaluate(({ app: electronApp }) => {
        electronApp.exit(0)
      }),
      5000
    )
  } catch {
    // 策略 2: Playwright 的 close
    try { await withTimeout(app.close(), 5000) } catch {}
  }

  // 等待进程完全退出
  await new Promise(r => setTimeout(r, 500))
}
