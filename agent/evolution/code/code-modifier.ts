/**
 * 代码修改器 — LLM 驱动的代码读取 + 修改 + 写入
 *
 * 工作流程:
 * 1. 读取目标文件内容
 * 2. 向 LLM 提供改进点 + 文件内容 + 之前失败的尝试
 * 3. LLM 返回修改后的完整文件内容
 * 4. 验证修改的合法性（白名单检查、基本语法检查）
 * 5. 写入修改后的内容
 *
 * 安全机制:
 * - 只修改白名单目录中的文件
 * - 禁止修改黑名单文件
 * - 修改前保留原始内容（供回滚）
 * - 验证 LLM 输出不是空的或过短的
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve, relative, isAbsolute } from 'path'
import { llm } from '../../providers/llm'
import { isLLMConfigured, getConfig } from '../../providers/llm-config'
import { getFailedEvolutionRecords } from './evolution-journal'
import type { ImprovementPoint, FileChange, SelfEvolutionConfig, ImprovementPlan } from './types'

/** 项目根目录 */
const PROJECT_ROOT = resolve(__dirname, '..', '..')

/**
 * 代码修改器
 */
export class CodeModifier {
  private config: SelfEvolutionConfig

  constructor(config: SelfEvolutionConfig) {
    this.config = config
  }

  /**
   * 根据改进点生成修改计划
   *
   * @param points 改进点列表
   * @param signal AbortSignal
   * @returns 修改计划（含文件变更列表）
   */
  async planImprovement(
    points: ImprovementPoint[],
    signal?: AbortSignal
  ): Promise<ImprovementPlan | null> {
    if (!isLLMConfigured()) {
      console.warn('[CodeModifier] LLM not configured, cannot plan improvement')
      return null
    }

    // 获取之前失败的尝试
    const failedRecords = getFailedEvolutionRecords(20)
    const failedSummary = failedRecords
      .map(r => `- 目标: ${r.goal.slice(0, 100)} 失败原因: ${(r.failureReason || '').slice(0, 100)}`)
      .join('\n')

    // 按严重度排序，取最严重的改进点
    const sorted = [...points].sort((a, b) => {
      const order = { critical: 0, high: 1, medium: 2, low: 3 }
      return order[a.severity] - order[b.severity]
    })

    const topPoints = sorted.slice(0, 3)

    // 如果有目标文件，先读取内容
    const fileContents = await this.readTargetFiles(topPoints)

    const prompt = `你是 Zen Agent 的代码自修改模块。根据分析出的改进点，生成具体的代码修改方案。

## 改进点
${topPoints.map((p, i) => `${i + 1}. [${p.severity}] ${p.type}: ${p.description}
   建议操作: ${p.suggestedAction}
   目标文件: ${p.targetFiles.join(', ') || '(未指定)'}`).join('\n\n')}

## 当前文件内容
${fileContents}

## 之前失败的尝试（避免重复相同方案）
${failedSummary || '无'}

## 要求
1. 只修改 ${this.config.allowedDirectories.join(', ')} 目录下的文件
2. 不要修改以下文件: ${this.config.forbiddenFiles.join(', ')}
3. 每个修改必须是完整可用的代码（不要省略、不要用 ...）
4. 修改要有明确的改进目的，不要做无关改动
5. 保持代码风格一致（TypeScript, 中文注释）

返回 JSON 格式:
{"goal": "本次改进的目标（一句话）", "expectedOutcome": "预期效果", "changes": [
  {"filePath": "agent/xxx.ts", "type": "modify", "newContent": "完整的文件内容", "description": "修改说明"}
]}

只返回 JSON，不要加额外说明。newContent 必须是完整的文件内容，不要省略任何部分。`

    const config = getConfig()
    const response = await llm.chat({
      messages: [
        { role: 'system', content: '你是代码修改助手，只返回 JSON 格式的修改方案。' },
        { role: 'user', content: prompt }
      ],
      modelKey: config.defaultModelKey,
      temperature: 0.2,
      maxTokens: 8000,
      signal,
      timeoutMs: 120 * 1000
    })

    // 解析 JSON
    const jsonMatch = response.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      console.warn('[CodeModifier] No JSON found in LLM response')
      return null
    }

    let parsed: { goal: string; expectedOutcome: string; changes: Array<{ filePath: string; type: string; newContent: string; description: string }> }
    try {
      parsed = JSON.parse(jsonMatch[0])
    } catch {
      console.warn('[CodeModifier] Failed to parse LLM JSON response')
      return null
    }

    // 验证和构建 FileChange 列表
    const changes: FileChange[] = []
    for (const c of parsed.changes || []) {
      // 安全校验
      if (!this.isPathAllowed(c.filePath)) {
        console.warn(`[CodeModifier] Skipping forbidden path: ${c.filePath}`)
        continue
      }

      if (!c.newContent || c.newContent.trim().length < 10) {
        console.warn(`[CodeModifier] Skipping empty content for: ${c.filePath}`)
        continue
      }

      const absPath = resolve(PROJECT_ROOT, c.filePath)
      let oldContent: string | undefined
      if (existsSync(absPath)) {
        try {
          oldContent = readFileSync(absPath, 'utf-8')
        } catch { /* ignore */ }
      }

      changes.push({
        filePath: c.filePath,
        type: c.type === 'create' ? 'create' : 'modify',
        oldContent,
        newContent: c.newContent,
        description: c.description || ''
      })
    }

    if (changes.length === 0) {
      console.warn('[CodeModifier] No valid changes generated')
      return null
    }

    const plan: ImprovementPlan = {
      id: `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      trigger: topPoints.map(p => p.description).join('; '),
      goal: parsed.goal || '改进 Agent 代码',
      changes,
      expectedOutcome: parsed.expectedOutcome || '',
      method: 'llm',
      createdAt: Date.now()
    }

    console.log(`[CodeModifier] Generated improvement plan: ${plan.id}`)
    console.log(`  Goal: ${plan.goal}`)
    console.log(`  Files to change: ${changes.map(c => c.filePath).join(', ')}`)

    return plan
  }

  /**
   * 应用修改计划 — 写入文件
   *
   * @param plan 修改计划
   * @returns 是否成功写入所有文件
   */
  applyPlan(plan: ImprovementPlan): boolean {
    let allSuccess = true

    for (const change of plan.changes) {
      try {
        const absPath = resolve(PROJECT_ROOT, change.filePath)

        // 再次检查安全
        if (!this.isPathAllowed(change.filePath)) {
          console.error(`[CodeModifier] Blocked write to forbidden path: ${change.filePath}`)
          allSuccess = false
          continue
        }

        // 确保目录存在
        const dir = require('path').dirname(absPath)
        require('fs').mkdirSync(dir, { recursive: true })

        // 写入文件
        writeFileSync(absPath, change.newContent, 'utf-8')
        console.log(`[CodeModifier] ✓ Written: ${change.filePath} (${change.newContent.length} chars)`)
      } catch (err) {
        console.error(`[CodeModifier] Failed to write ${change.filePath}:`, err)
        allSuccess = false
      }
    }

    return allSuccess
  }

  /**
   * 回滚修改 — 恢复原始内容
   */
  rollbackPlan(plan: ImprovementPlan): void {
    for (const change of plan.changes) {
      try {
        const absPath = resolve(PROJECT_ROOT, change.filePath)

        if (change.type === 'create' && !change.oldContent) {
          // 新创建的文件，删除它
          if (existsSync(absPath)) {
            require('fs').unlinkSync(absPath)
            console.log(`[CodeModifier] ✓ Deleted: ${change.filePath}`)
          }
        } else if (change.oldContent !== undefined) {
          // 修改的文件，恢复原始内容
          writeFileSync(absPath, change.oldContent, 'utf-8')
          console.log(`[CodeModifier] ✓ Reverted: ${change.filePath}`)
        }
      } catch (err) {
        console.error(`[CodeModifier] Failed to rollback ${change.filePath}:`, err)
      }
    }
  }

  /**
   * 检查路径是否在白名单中
   */
  private isPathAllowed(filePath: string): boolean {
    // 标准化路径（相对于项目根目录）
    const normalized = isAbsolute(filePath)
      ? relative(PROJECT_ROOT, filePath).replace(/\\/g, '/')
      : filePath.replace(/\\/g, '/')

    // 检查黑名单
    for (const forbidden of this.config.forbiddenFiles) {
      if (normalized.includes(forbidden)) {
        return false
      }
    }

    // 检查白名单
    return this.config.allowedDirectories.some(dir => {
      return normalized.startsWith(dir) || normalized.includes(dir)
    })
  }

  /**
   * 读取目标文件内容
   */
  private async readTargetFiles(points: ImprovementPoint[]): Promise<string> {
    const files = new Set<string>()
    for (const p of points) {
      for (const f of p.targetFiles) {
        if (this.isPathAllowed(f)) {
          files.add(f)
        }
      }
    }

    if (files.size === 0) {
      return '(未指定目标文件，请根据改进点选择合适的文件进行修改)'
    }

    const parts: string[] = []
    for (const file of Array.from(files).slice(0, 5)) {
      try {
        const absPath = resolve(PROJECT_ROOT, file)
        if (existsSync(absPath)) {
          const content = readFileSync(absPath, 'utf-8')
          // 截断过长的文件
          const truncated = content.length > 8000
            ? content.slice(0, 8000) + '\n... (截断，共 ' + content.length + ' 字符)'
            : content
          parts.push(`### 文件: ${file}\n\`\`\`\n${truncated}\n\`\`\``)
        }
      } catch (err) {
        parts.push(`### 文件: ${file}\n(读取失败: ${err})`)
      }
    }

    return parts.join('\n\n')
  }
}
