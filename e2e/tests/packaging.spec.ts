/**
 * E2E 测试 — 应用打包与分发配置 (T-019)
 *
 * 测试范围:
 * - electron-builder.yml 配置文件存在且格式正确
 * - package.json 包含打包脚本
 * - 构建产物目录结构正确
 */
import { test, expect } from '@playwright/test'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

test.describe('应用打包与分发配置 (T-019)', () => {

  test('electron-builder.yml 配置文件存在', () => {
    const configPath = resolve(process.cwd(), 'electron-builder.yml')
    expect(existsSync(configPath)).toBe(true)
  })

  test('electron-builder.yml 配置内容正确', () => {
    const configPath = resolve(process.cwd(), 'electron-builder.yml')
    const content = readFileSync(configPath, 'utf-8')

    // 验证关键配置项
    expect(content).toContain('appId: com.zen-agent.app')
    expect(content).toContain('productName: Zen Agent')
    expect(content).toContain('nsis')
    expect(content).toContain('createDesktopShortcut: true')
    expect(content).toContain('createStartMenuShortcut: true')
  })

  test('package.json 包含打包脚本', () => {
    const pkgPath = resolve(process.cwd(), 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))

    expect(pkg.scripts.pack).toBeDefined()
    expect(pkg.scripts.dist).toBeDefined()
    expect(pkg.scripts['dist:win']).toBeDefined()
    expect(pkg.scripts.dist).toContain('electron-builder')
  })

  test('package.json 包含 electron-builder 依赖', () => {
    const pkgPath = resolve(process.cwd(), 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))

    expect(pkg.devDependencies['electron-builder']).toBeDefined()
  })

  test('package.json 包含 build 配置引用', () => {
    const pkgPath = resolve(process.cwd(), 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))

    expect(pkg.build).toBeDefined()
    expect(pkg.build.extends).toBe('electron-builder.yml')
  })

  test('build 目录存在', () => {
    const buildDir = resolve(process.cwd(), 'build')
    expect(existsSync(buildDir)).toBe(true)
  })
})
