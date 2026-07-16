/**
 * 本地文件索引器 — 启动时扫描常用目录，构建内存索引
 *
 * 设计理念：
 * - 像 Listary/Everything 一样快速搜索本地文件
 * - 启动时扫描常用目录（桌面、工作区、文档等）
 * - 识别项目标记（.git, package.json, pom.xml 等）
 * - 内存缓存 + 定期刷新
 * - 供 file_search 工具调用，Agent 不再需要每次从零扫描
 */

import { readdirSync, statSync, existsSync } from 'fs'
import { join, basename, extname, resolve } from 'path'
import { execSync } from 'child_process'
import { homedir, platform } from 'os'

// ── 索引条目 ──

export interface FileIndexEntry {
  path: string
  name: string
  type: 'file' | 'directory' | 'project'
  ext: string
  size: number
  modifiedAt: number
  /** 项目类型（如果识别为项目） */
  projectType?: string
  /** Git 远程仓库 URL（如果是 Git 项目） */
  gitRemote?: string
}

// ── 索引器 ──

export class FileIndexer {
  private index: Map<string, FileIndexEntry> = new Map()
  private nameMap: Map<string, Set<string>> = new Map()  // 名称 → 路径集合（快速按名搜索）
  private lastBuildTime = 0
  private building = false
  private buildProgress = ''

  /** 默认扫描的根目录 */
  private getScanRoots(): string[] {
    const roots: string[] = []
    const home = homedir()
    const isWin = platform() === 'win32'

    // 用户目录
    roots.push(join(home, 'Desktop'))
    roots.push(join(home, 'Documents'))
    roots.push(join(home, 'Downloads'))

    // Windows: 扫描所有盘符的 workspace 目录
    if (isWin) {
      for (const drive of ['C', 'D', 'E', 'F', 'G', 'H']) {
        const wsDir = `${drive}:\\workspace`
        if (existsSync(wsDir)) roots.push(wsDir)
        const projDir = `${drive}:\\projects`
        if (existsSync(projDir)) roots.push(projDir)
        const codeDir = `${drive}:\\code`
        if (existsSync(codeDir)) roots.push(codeDir)
        const devDir = `${drive}:\\dev`
        if (existsSync(devDir)) roots.push(devDir)
      }
    }

    // macOS/Linux
    if (!isWin) {
      roots.push(join(home, 'workspace'))
      roots.push(join(home, 'projects'))
      roots.push(join(home, 'code'))
      roots.push(join(home, 'dev'))
      roots.push('/workspace')
      roots.push('/projects')
    }

    return roots.filter(p => existsSync(p))
  }

  /** 跳过的目录名 */
  private readonly SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'out', 'build', '.next',
    '__pycache__', '.venv', 'venv', '.cache', '.idea', '.vscode',
    'target', '.gradle', '.m2', '.npm', '.cargo', '.rustup',
    'vendor', 'tmp', 'temp', '.tmp', 'coverage', '.nuxt'
  ])

  /** 项目标记文件 → 项目类型 */
  private readonly PROJECT_MARKERS: Record<string, string> = {
    '.git': 'git',
    'package.json': 'node',
    'tsconfig.json': 'typescript',
    'pom.xml': 'maven',
    'build.gradle': 'gradle',
    'Cargo.toml': 'rust',
    'go.mod': 'go',
    'requirements.txt': 'python',
    'pyproject.toml': 'python',
    'Gemfile': 'ruby',
    '*.csproj': 'csharp',
    '*.sln': 'csharp',
    'composer.json': 'php',
    'pubspec.yaml': 'flutter',
    'CMakeLists.txt': 'cmake',
    'Makefile': 'make',
    '.gitignore': 'git',
    'vue.config': 'vue',
    'vite.config': 'vite',
    'next.config': 'nextjs',
    'nuxt.config': 'nuxt'
  }

  /**
   * 构建索引（异步，不阻塞主线程）
   */
  async buildIndex(): Promise<void> {
    if (this.building) {
      console.log('[FileIndex] Already building, skipping')
      return
    }

    this.building = true
    this.index.clear()
    this.nameMap.clear()

    const roots = this.getScanRoots()
    console.log(`[FileIndex] Building index from ${roots.length} roots: ${roots.join(', ')}`)
    this.buildProgress = `Scanning ${roots.length} directories...`

    let totalEntries = 0

    for (const root of roots) {
      try {
        this.buildProgress = `Scanning ${root}...`
        const count = this.scanDirectory(root, 0, 4)
        totalEntries += count
      } catch (err) {
        // 权限不足或目录不存在，跳过
        console.warn(`[FileIndex] Failed to scan ${root}:`, (err as Error).message)
      }
    }

    this.lastBuildTime = Date.now()
    this.building = false
    this.buildProgress = ''

    const projectCount = Array.from(this.index.values()).filter(e => e.type === 'project').length
    console.log(`[FileIndex] Index built: ${totalEntries} entries, ${projectCount} projects`)
  }

  /**
   * 递归扫描目录
   */
  private scanDirectory(dirPath: string, depth: number, maxDepth: number): int {
    if (depth > maxDepth) return 0

    let count = 0

    let entries
    try {
      entries = readdirSync(dirPath, { withFileTypes: true })
    } catch {
      return 0
    }

    // 检测是否为项目目录
    const projectType = this.detectProjectType(entries)
    const gitRemote = this.getGitRemote(dirPath)

    if (projectType || gitRemote) {
      // 这是一个项目目录
      const stat = statSync(dirPath)
      const entry: FileIndexEntry = {
        path: dirPath,
        name: basename(dirPath),
        type: 'project',
        ext: '',
        size: 0,
        modifiedAt: stat.mtimeMs,
        projectType,
        gitRemote
      }
      this.addToIndex(entry)
      count++
    }

    // 扫描子条目
    for (const entry of entries) {
      if (this.SKIP_DIRS.has(entry.name)) continue

      const fullPath = join(dirPath, entry.name)

      try {
        if (entry.isDirectory()) {
          // 递归扫描子目录（但浅层扫描）
          count += this.scanDirectory(fullPath, depth + 1, maxDepth)
        } else if (entry.isFile()) {
          // 只索引有意义的文件
          const ext = extname(entry.name).toLowerCase()
          if (this.shouldIndexFile(entry.name, ext)) {
            const stat = statSync(fullPath)
            this.addToIndex({
              path: fullPath,
              name: entry.name,
              type: 'file',
              ext,
              size: stat.size,
              modifiedAt: stat.mtimeMs
            })
            count++
          }
        }
      } catch {
        // 跳过无法访问的文件
      }
    }

    return count
  }

  /**
   * 检测项目类型
   */
  private detectProjectType(entries: Array<{ name: string; isDirectory: boolean }>): string | undefined {
    const names = new Set(entries.map(e => e.name))

    // 检查精确匹配
    for (const [marker, type] of Object.entries(this.PROJECT_MARKERS)) {
      if (!marker.includes('*')) {
        if (names.has(marker)) return type
      }
    }

    // 检查通配符匹配
    if (names.size > 0) {
      // *.csproj / *.sln
      for (const name of names) {
        if (name.endsWith('.csproj')) return 'csharp'
        if (name.endsWith('.sln')) return 'csharp'
        if (name.endsWith('.xcodeproj')) return 'xcode'
      }
    }

    return undefined
  }

  /**
   * 获取 Git 远程仓库 URL
   */
  private getGitRemote(dirPath: string): string | undefined {
    const gitDir = join(dirPath, '.git')
    if (!existsSync(gitDir)) return undefined

    try {
      const url = execSync('git remote get-url origin', {
        cwd: dirPath,
        timeout: 2000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe']
      }).trim()
      return url || undefined
    } catch {
      return undefined
    }
  }

  /**
   * 判断文件是否值得索引
   */
  private shouldIndexFile(name: string, ext: string): boolean {
    // 配置文件
    const configFiles = [
      'package.json', 'tsconfig.json', 'vite.config.ts', 'vite.config.js',
      'electron.vite.config.ts', 'electron-builder.yml', '.env',
      'README.md', 'CHANGELOG.md', 'TASKS.md'
    ]
    if (configFiles.includes(name)) return true

    // 代码文件
    const codeExts = new Set([
      '.ts', '.tsx', '.js', '.jsx', '.vue', '.py', '.java', '.go',
      '.rs', '.rb', '.c', '.cpp', '.h', '.cs', '.swift', '.kt',
      '.sh', '.bat', '.ps1', '.sql'
    ])
    if (codeExts.has(ext)) return true

    // 配置/文档文件
    const docExts = new Set([
      '.json', '.yaml', '.yml', '.toml', '.ini', '.conf', '.config',
      '.md', '.txt', '.env'
    ])
    if (docExts.has(ext)) return true

    return false
  }

  /**
   * 添加到索引
   */
  private addToIndex(entry: FileIndexEntry): void {
    this.index.set(entry.path, entry)

    // 按名称建立索引（小写，用于快速搜索）
    const lowerName = entry.name.toLowerCase()
    if (!this.nameMap.has(lowerName)) {
      this.nameMap.set(lowerName, new Set())
    }
    this.nameMap.get(lowerName)!.add(entry.path)
  }

  // ═══════════════════════════════════════════════════════════
  //  搜索 API
  // ═══════════════════════════════════════════════════════════

  /**
   * 搜索文件/目录
   *
   * @param query 搜索关键词（文件名或目录名）
   * @param options 搜索选项
   * @returns 匹配的条目列表
   */
  search(
    query: string,
    options: {
      type?: 'file' | 'directory' | 'project' | 'all'
      maxResults?: number
    } = {}
  ): FileIndexEntry[] {
    const maxResults = options.maxResults ?? 30
    const lowerQuery = query.toLowerCase().trim()

    if (!lowerQuery) {
      // 返回所有项目
      const projects = Array.from(this.index.values())
        .filter(e => e.type === 'project')
        .sort((a, b) => b.modifiedAt - a.modifiedAt)
      return projects.slice(0, maxResults)
    }

    const results: FileIndexEntry[] = []

    // 1. 精确名称匹配
    if (this.nameMap.has(lowerQuery)) {
      for (const path of this.nameMap.get(lowerQuery)!) {
        const entry = this.index.get(path)
        if (entry && this.matchesType(entry, options.type)) {
          results.push(entry)
        }
      }
    }

    // 2. 名称包含匹配
    if (results.length < maxResults) {
      for (const [name, paths] of this.nameMap) {
        if (name !== lowerQuery && name.includes(lowerQuery)) {
          for (const path of paths) {
            const entry = this.index.get(path)
            if (entry && this.matchesType(entry, options.type) && !results.includes(entry)) {
              results.push(entry)
            }
          }
        }
      }
    }

    // 3. 路径包含匹配
    if (results.length < maxResults) {
      for (const entry of this.index.values()) {
        if (entry.path.toLowerCase().includes(lowerQuery) && !results.includes(entry)) {
          if (this.matchesType(entry, options.type)) {
            results.push(entry)
          }
        }
      }
    }

    // 按修改时间排序
    results.sort((a, b) => b.modifiedAt - a.modifiedAt)

    return results.slice(0, maxResults)
  }

  /**
   * 获取所有已知项目
   */
  getProjects(): FileIndexEntry[] {
    return Array.from(this.index.values())
      .filter(e => e.type === 'project')
      .sort((a, b) => b.modifiedAt - a.modifiedAt)
  }

  /**
   * 获取索引统计
   */
  getStats(): {
    totalEntries: number
    totalProjects: number
    totalFiles: number
    lastBuildTime: number
    building: boolean
    buildProgress: string
  } {
    let projects = 0
    let files = 0
    for (const entry of this.index.values()) {
      if (entry.type === 'project') projects++
      else if (entry.type === 'file') files++
    }
    return {
      totalEntries: this.index.size,
      totalProjects: projects,
      totalFiles: files,
      lastBuildTime: this.lastBuildTime,
      building: this.building,
      buildProgress: this.buildProgress
    }
  }

  /**
   * 检查是否需要刷新
   */
  isStale(): boolean {
    if (this.lastBuildTime === 0) return true
    // 30 分钟后过期
    return Date.now() - this.lastBuildTime > 30 * 60 * 1000
  }

  /**
   * 异步刷新索引
   */
  async refresh(): Promise<void> {
    return this.buildIndex()
  }

  private matchesType(entry: FileIndexEntry, type?: string): boolean {
    if (!type || type === 'all') return true
    if (type === 'project') return entry.type === 'project'
    if (type === 'directory') return entry.type === 'directory' || entry.type === 'project'
    if (type === 'file') return entry.type === 'file'
    return true
  }
}

// ── 单例 ──
export const fileIndexer = new FileIndexer()
