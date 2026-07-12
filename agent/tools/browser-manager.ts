/**
 * 浏览器管理器 — 管理 Puppeteer 浏览器实例
 *
 * 功能:
 * 1. 启动/关闭有头 Chrome 浏览器（优先使用系统安装的 Google Chrome）
 * 2. 维护页面实例，支持多标签页
 * 3. 提供页面内容提取（文本、HTML、截图）
 * 4. 自动处理浏览器崩溃和重启
 *
 * 使用 Puppeteer 实现完整的浏览器自动化能力。
 */

import type { Browser, Page } from 'puppeteer'
import { existsSync } from 'fs'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { getBrowserConfig } from '../providers/llm-config'

/** 获取应用专用浏览器数据目录（小禅专属） */
function getAppBrowserDataDir(): string {
  // 使用 Electron 的 userData 目录下的子目录
  const electronUserData = process.env['ELECTRON_USER_DATA']
  if (electronUserData) {
    return join(electronUserData, 'browser-profile')
  }
  // 回退方案：使用系统临时目录
  const tmpDir = process.env['TEMP'] || process.env['TMP'] || '/tmp'
  return join(tmpDir, 'zen-agent', 'browser-profile')
}

export interface BrowserLaunchOptions {
  headless?: boolean
  /** 自定义 Chrome 可执行文件路径，留空则使用配置或自动检测 */
  executablePath?: string
  /** 用户数据目录（加载登录态） */
  userDataDir?: string
  /** 窗口大小 */
  width?: number
  height?: number
}

class BrowserManagerClass {
  private browser: Browser | null = null
  private pages: Map<string, Page> = new Map()
  private activePageId: string | null = null

  /**
   * 检查浏览器是否仍连接（兼容 Puppeteer v22+ 的 connected 属性和旧版的 isConnected() 方法）
   */
  private isBrowserConnected(): boolean {
    if (!this.browser) return false
    // Puppeteer v22+ 使用 connected 属性（getter），v25 移除了 isConnected() 方法
    if (typeof (this.browser as any).connected === 'boolean') {
      return (this.browser as any).connected
    }
    // 旧版 Puppeteer 使用 isConnected() 方法
    if (typeof (this.browser as any).isConnected === 'function') {
      return (this.browser as any).isConnected()
    }
    // 无法确定连接状态时，假设已连接（browser 对象存在即认为可用）
    return true
  }

  /** 浏览器是否正在运行 */
  isRunning(): boolean {
    return this.browser !== null && this.isBrowserConnected()
  }

  /**
   * 检测系统安装的 Google Chrome 路径
   * 优先使用系统 Chrome，因为它有用户的登录态和扩展
   */
  private findSystemChrome(): string | null {
    const platform = process.platform
    const candidates: string[] = []

    if (platform === 'win32') {
      // Windows 常见 Chrome 安装路径
      const programFiles = process.env['PROGRAMFILES'] || 'C:\\Program Files'
      const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'
      const localAppData = process.env['LOCALAPPDATA'] || ''

      candidates.push(
        join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        // Edge 浏览器作为备选
        join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
      )
    } else if (platform === 'darwin') {
      candidates.push(
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
      )
    } else if (platform === 'linux') {
      candidates.push(
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/microsoft-edge'
      )
    }

    for (const path of candidates) {
      if (existsSync(path)) {
        console.log(`[BrowserManager] Found system browser: ${path}`)
        return path
      }
    }

    console.log('[BrowserManager] No system Chrome found, will use Puppeteer bundled Chromium')
    return null
  }

  /**
   * 检测系统 Chrome 用户数据目录
   * 返回找到的路径或 null
   */
  findChromeUserDataDir(): { path: string; browser: string; profiles: string[] } | null {
    const platform = process.platform
    const candidates: Array<{ path: string; browser: string }> = []

    if (platform === 'win32') {
      const localAppData = process.env['LOCALAPPDATA'] || ''
      const home = process.env['USERPROFILE'] || ''
      if (localAppData) {
        candidates.push({ path: join(localAppData, 'Google', 'Chrome', 'User Data'), browser: 'Chrome' })
        candidates.push({ path: join(localAppData, 'Microsoft', 'Edge', 'User Data'), browser: 'Edge' })
      }
      // 有些用户可能将用户数据放在 roaming 目录
      if (home) {
        candidates.push({ path: join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data'), browser: 'Chrome' })
      }
    } else if (platform === 'darwin') {
      const home = process.env['HOME'] || ''
      if (home) {
        candidates.push({ path: join(home, 'Library', 'Application Support', 'Google', 'Chrome'), browser: 'Chrome' })
        candidates.push({ path: join(home, 'Library', 'Application Support', 'Microsoft Edge'), browser: 'Edge' })
      }
    } else if (platform === 'linux') {
      const home = process.env['HOME'] || ''
      if (home) {
        candidates.push({ path: join(home, '.config', 'google-chrome'), browser: 'Chrome' })
        candidates.push({ path: join(home, '.config', 'chromium'), browser: 'Chromium' })
        candidates.push({ path: join(home, '.config', 'Microsoft', 'Edge'), browser: 'Edge' })
      }
    }

    for (const candidate of candidates) {
      if (existsSync(candidate.path)) {
        // 检测有哪些 Profile
        const profiles: string[] = []
        const defaultProfile = join(candidate.path, 'Default')
        if (existsSync(defaultProfile)) {
          profiles.push('Default')
        }
        // 检测 Profile 1, Profile 2, ...
        for (let i = 1; i <= 10; i++) {
          const profilePath = join(candidate.path, `Profile ${i}`)
          if (existsSync(profilePath)) {
            profiles.push(`Profile ${i}`)
          }
        }
        // Edge 的 profile 目录名不同
        if (profiles.length === 0 && candidate.browser === 'Edge') {
          const edgeProfile = join(candidate.path, 'Default')
          if (existsSync(edgeProfile)) {
            profiles.push('Default')
          }
        }

        console.log(`[BrowserManager] Found user data dir: ${candidate.path} (${candidate.browser}, profiles: ${profiles.join(', ')})`)
        return { path: candidate.path, browser: candidate.browser, profiles }
      }
    }

    console.log('[BrowserManager] No Chrome user data directory found')
    return null
  }

  /** 启动浏览器 */
  async launch(options: BrowserLaunchOptions = {}): Promise<Page> {
    // 如果浏览器已在运行，直接返回当前页面
    if (this.browser && this.isBrowserConnected()) {
      const page = this.getActivePage()
      if (page) return page
    }

    // 动态导入 puppeteer
    const puppeteer = await import('puppeteer')

    // 从配置加载浏览器设置
    const config = getBrowserConfig()

    const launchOptions: Record<string, unknown> = {
      headless: options.headless ?? config.headless,
      defaultViewport: {
        width: options.width ?? config.width,
        height: options.height ?? config.height
      },
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-infobars',
        `--window-size=${options.width ?? config.width},${options.height ?? config.height}`,
        '--lang=zh-CN',
        '--disable-blink-features=AutomationControlled'
      ]
    }

    // 用户数据目录 — 根据模式决定
    // 1. temporary: 不设置 userDataDir，Puppeteer 自动创建临时目录
    // 2. app-dedicated: 使用小禅专用目录（持久化，不会与用户 Chrome 冲突）
    // 3. custom: 使用用户指定的目录（可能需要先关闭 Chrome）
    let userDataDir = ''
    const mode = config.userDataMode || 'app-dedicated'

    if (mode === 'app-dedicated') {
      userDataDir = getAppBrowserDataDir()
    } else if (mode === 'custom') {
      userDataDir = options.userDataDir || config.userDataDir
    }
    // mode === 'temporary' 时不设置 userDataDir

    if (userDataDir) {
      // 确保目录存在
      try {
        mkdirSync(userDataDir, { recursive: true })
      } catch { /* 目录可能已存在 */ }
      launchOptions.userDataDir = userDataDir

      // 如果配置了 profile，添加到 args
      if (config.profile && config.profile !== 'Default') {
        ;(launchOptions.args as string[]).push(`--profile-directory=${config.profile}`)
      }

      console.log(`[BrowserManager] Using user data directory: ${userDataDir} (mode: ${mode}, profile: ${config.profile})`)
    } else {
      console.log(`[BrowserManager] Using temporary user data directory (mode: ${mode})`)
    }

    // Chrome 可执行文件路径 — 优先级: launch options > config > 自动检测
    const chromePath = options.executablePath || config.executablePath || this.findSystemChrome()
    if (chromePath) {
      launchOptions.executablePath = chromePath
    }

    console.log(`[BrowserManager] Launching browser (headless: ${launchOptions.headless}, path: ${chromePath || 'bundled Chromium'}, userDataDir: ${userDataDir || 'temporary'})`)

    this.browser = await puppeteer.default.launch(launchOptions)

    // 监听断开事件
    this.browser.on('disconnected', () => {
      console.log('[BrowserManager] Browser disconnected')
      this.browser = null
      this.pages.clear()
      this.activePageId = null
    })

    // 创建第一个页面
    const page = await this.browser.newPage()
    const pageId = 'tab-1'
    this.pages.set(pageId, page)
    this.activePageId = pageId

    // 设置超时
    page.setDefaultNavigationTimeout(30000)
    page.setDefaultTimeout(15000)

    console.log('[BrowserManager] Browser launched successfully')
    return page
  }

  /** 获取当前活跃页面 */
  getActivePage(): Page | null {
    if (!this.activePageId) return null
    return this.pages.get(this.activePageId) || null
  }

  /** 获取或创建页面 */
  async getPage(): Promise<Page> {
    if (!this.browser || !this.isBrowserConnected()) {
      return await this.launch()
    }
    const page = this.getActivePage()
    if (page) return page
    return await this.launch()
  }

  /** 创建新标签页 */
  async newPage(): Promise<{ pageId: string; page: Page }> {
    if (!this.browser) {
      const page = await this.launch()
      return { pageId: this.activePageId!, page }
    }
    const page = await this.browser.newPage()
    const pageId = `tab-${this.pages.size + 1}`
    this.pages.set(pageId, page)
    this.activePageId = pageId
    page.setDefaultNavigationTimeout(30000)
    page.setDefaultTimeout(15000)
    return { pageId, page }
  }

  /** 切换标签页 */
  switchPage(pageId: string): boolean {
    if (this.pages.has(pageId)) {
      this.activePageId = pageId
      return true
    }
    return false
  }

  /** 获取所有标签页 ID */
  getPageIds(): string[] {
    return Array.from(this.pages.keys())
  }

  /** 关闭浏览器 */
  async close(): Promise<void> {
    if (this.browser) {
      try {
        await this.browser.close()
      } catch (err) {
        console.warn('[BrowserManager] Error closing browser:', err)
      }
      this.browser = null
      this.pages.clear()
      this.activePageId = null
      console.log('[BrowserManager] Browser closed')
    }
  }

  /** 获取页面文本内容（截取前 N 字符） */
  async getPageText(maxLength: number = 3000): Promise<string> {
    const page = await this.getPage()
    const text = await page.evaluate(() => document.body.innerText)
    if (text.length > maxLength) {
      return text.slice(0, maxLength) + '\n...(内容过长，已截断)'
    }
    return text
  }

  /** 获取页面标题 */
  async getTitle(): Promise<string> {
    const page = await this.getPage()
    return await page.title()
  }

  /** 获取当前 URL */
  async getUrl(): Promise<string> {
    const page = await this.getPage()
    return page.url()
  }
}

// 单例
export const browserManager = new BrowserManagerClass()
