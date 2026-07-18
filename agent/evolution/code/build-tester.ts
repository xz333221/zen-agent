/**
 * 编译测试器 — 编译项目 + 运行测试 + 评估改进效果
 *
 * 工作流程:
 * 1. 运行 npm run build（TypeScript 编译检查）
 * 2. 如果配置了测试，运行 npm test
 * 3. 用预设的测试问题评估改进前后的回答质量
 *
 * 安全机制:
 * - 编译失败自动触发回滚
 * - 测试超时保护
 * - 输出截断（防止过长输出）
 */

import { exec } from 'child_process'
import { resolve } from 'path'
import { llm } from '../../providers/llm'
import { isLLMConfigured, getConfig } from '../../providers/llm-config'
import type { TestResult, EvaluationResult, SelfEvolutionConfig } from './types'

/** 项目根目录 */
const PROJECT_ROOT = resolve(__dirname, '..', '..')

/** 最大输出长度 */
const MAX_OUTPUT = 10000

/**
 * 编译测试器
 */
export class BuildTester {
  private config: SelfEvolutionConfig

  constructor(config: SelfEvolutionConfig) {
    this.config = config
  }

  /**
   * 运行编译
   */
  async runBuild(signal?: AbortSignal): Promise<{ passed: boolean; output: string; duration: number; errors: string[] }> {
    const startTime = Date.now()
    const isWin = process.platform === 'win32'
    const cmd = isWin ? 'npm run build 2>&1' : 'npm run build 2>&1'

    try {
      const result = await this.execCommand(cmd, PROJECT_ROOT, 120000, signal)
      const duration = Date.now() - startTime

      // 检查编译是否成功
      const passed = result.exitCode === 0

      // 提取错误信息
      const errors = passed ? [] : extractErrors(result.stdout + '\n' + result.stderr)

      console.log(`[BuildTester] Build ${passed ? '✓' : '✗'} ${duration}ms, errors: ${errors.length}`)

      return {
        passed,
        output: truncateOutput(result.stdout + '\n' + result.stderr),
        duration,
        errors
      }
    } catch (err) {
      const duration = Date.now() - startTime
      return {
        passed: false,
        output: `Build execution failed: ${(err as Error).message}`,
        duration,
        errors: [(err as Error).message]
      }
    }
  }

  /**
   * 运行测试
   */
  async runTests(signal?: AbortSignal): Promise<{ passed: boolean; output: string; duration: number; errors: string[] }> {
    if (!this.config.requireTestPass) {
      return { passed: true, output: '(测试跳过)', duration: 0, errors: [] }
    }

    const startTime = Date.now()
    const isWin = process.platform === 'win32'
    const cmd = isWin ? 'npm run typecheck 2>&1' : 'npm run typecheck 2>&1'

    try {
      const result = await this.execCommand(cmd, PROJECT_ROOT, 60000, signal)
      const duration = Date.now() - startTime

      const passed = result.exitCode === 0
      const errors = passed ? [] : extractErrors(result.stdout + '\n' + result.stderr)

      console.log(`[BuildTester] Test ${passed ? '✓' : '✗'} ${duration}ms, errors: ${errors.length}`)

      return {
        passed,
        output: truncateOutput(result.stdout + '\n' + result.stderr),
        duration,
        errors
      }
    } catch (err) {
      const duration = Date.now() - startTime
      return {
        passed: false,
        output: `Test execution failed: ${(err as Error).message}`,
        duration,
        errors: [(err as Error).message]
      }
    }
  }

  /**
   * 运行完整编译+测试
   */
  async runBuildAndTest(signal?: AbortSignal): Promise<TestResult> {
    // 编译
    const buildResult = await this.runBuild(signal)

    const errors: string[] = [...buildResult.errors]

    // 如果编译失败，不运行测试
    if (!buildResult.passed) {
      return {
        buildPassed: false,
        buildOutput: buildResult.output,
        testPassed: false,
        testOutput: '(编译失败，跳过测试)',
        buildDuration: buildResult.duration,
        testDuration: 0,
        errors
      }
    }

    // 测试
    const testResult = await this.runTests(signal)
    errors.push(...testResult.errors)

    return {
      buildPassed: buildResult.passed,
      buildOutput: buildResult.output,
      testPassed: testResult.passed,
      testOutput: testResult.output,
      buildDuration: buildResult.duration,
      testDuration: testResult.duration,
      errors
    }
  }

  /**
   * 评估改进效果 — 对比改进前后的回答质量
   *
   * @param beforeResponses 改进前的回答
   * @param afterResponses 改进后的回答
   * @param queries 测试问题
   * @param signal AbortSignal
   */
  async evaluate(
    beforeResponses: string[],
    afterResponses: string[],
    queries: string[],
    signal?: AbortSignal
  ): Promise<EvaluationResult> {
    // 如果没有 LLM，用简单规则评估
    if (!isLLMConfigured() || queries.length === 0) {
      return this.evaluateWithRules(beforeResponses, afterResponses, queries)
    }

    try {
      return await this.evaluateWithLLM(beforeResponses, afterResponses, queries, signal)
    } catch (err) {
      console.warn('[BuildTester] LLM evaluation failed, using rules:', err)
      return this.evaluateWithRules(beforeResponses, afterResponses, queries)
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  LLM 评估
  // ═══════════════════════════════════════════════════════════

  private async evaluateWithLLM(
    beforeResponses: string[],
    afterResponses: string[],
    queries: string[],
    signal?: AbortSignal
  ): Promise<EvaluationResult> {
    const config = getConfig()

    const pairs = queries.map((q, i) => ({
      query: q,
      before: (beforeResponses[i] || '(无回答)').slice(0, 500),
      after: (afterResponses[i] || '(无回答)').slice(0, 500)
    }))

    const prompt = `你是 Zen Agent 的改进评估器。对比改进前后的回答质量，判断是否有实质改进。

## 对比对
${pairs.map((p, i) => `### 问题 ${i + 1}: ${p.query}
改进前回答:
${p.before}

改进后回答:
${p.after}`).join('\n\n---\n\n')}

请评估：
1. 改进后的回答是否更好？（考虑准确性、完整性、相关性、简洁性）
2. 整体改进前后的评分（1-5 分）

返回 JSON:
{"beforeScore": 1-5, "afterScore": 1-5, "hasImprovement": true/false, "reason": "评估理由"}

只返回 JSON。`

    const response = await llm.chat({
      messages: [
        { role: 'system', content: '你是改进评估助手，只返回 JSON。' },
        { role: 'user', content: prompt }
      ],
      modelKey: config.defaultModelKey,
      temperature: 0.3,
      maxTokens: 500,
      signal,
      timeoutMs: 20000
    })

    const jsonMatch = response.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return this.evaluateWithRules(beforeResponses, afterResponses, queries)
    }

    try {
      const parsed = JSON.parse(jsonMatch[0])
      return {
        beforeScore: Math.max(1, Math.min(5, parsed.beforeScore || 3)),
        afterScore: Math.max(1, Math.min(5, parsed.afterScore || 3)),
        hasImprovement: parsed.hasImprovement ?? (parsed.afterScore > parsed.beforeScore),
        reason: parsed.reason || 'LLM 评估',
        testQueries: queries,
        beforeResponses,
        afterResponses
      }
    } catch {
      return this.evaluateWithRules(beforeResponses, afterResponses, queries)
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  规则评估
  // ═══════════════════════════════════════════════════════════

  private evaluateWithRules(
    beforeResponses: string[],
    afterResponses: string[],
    queries: string[]
  ): EvaluationResult {
    // 简单规则：对比回答长度和内容差异
    let beforeScore = 3
    let afterScore = 3

    if (beforeResponses.length > 0 && afterResponses.length > 0) {
      // 如果改进后回答更长且更详细，给更高分
      const beforeAvgLen = beforeResponses.reduce((s, r) => s + r.length, 0) / beforeResponses.length
      const afterAvgLen = afterResponses.reduce((s, r) => s + r.length, 0) / afterResponses.length

      // 长度差异
      if (afterAvgLen > beforeAvgLen * 1.2) {
        afterScore = 4
      } else if (afterAvgLen < beforeAvgLen * 0.8) {
        afterScore = 2
      }

      // 内容差异（简单检查是否有新内容）
      let diffCount = 0
      for (let i = 0; i < Math.min(beforeResponses.length, afterResponses.length); i++) {
        if (beforeResponses[i] !== afterResponses[i]) {
          diffCount++
        }
      }

      if (diffCount === 0) {
        // 没有任何变化
        return {
          beforeScore: 3,
          afterScore: 3,
          hasImprovement: false,
          reason: '改进前后回答完全相同，无实质改进',
          testQueries: queries,
          beforeResponses,
          afterResponses
        }
      }
    }

    return {
      beforeScore,
      afterScore,
      hasImprovement: afterScore > beforeScore,
      reason: `规则评估：改进前 ${beforeScore}/5，改进后 ${afterScore}/5`,
      testQueries: queries,
      beforeResponses,
      afterResponses
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  辅助
  // ═══════════════════════════════════════════════════════════

  /**
   * 执行命令（Promise 包装）
   */
  private execCommand(
    command: string,
    cwd: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolvePromise) => {
      const child = exec(
        command,
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024 * 5,
          env: { ...process.env },
          shell: process.platform === 'win32' ? process.env.COMSPEC || 'cmd.exe' : '/bin/bash'
        },
        (error, stdout, stderr) => {
          if (signal?.aborted) {
            resolvePromise({ stdout: '', stderr: 'aborted', exitCode: -1 })
            return
          }
          resolvePromise({
            stdout: stdout || '',
            stderr: stderr || '',
            exitCode: error ? (error.code as number || 1) : 0
          })
        }
      )

      if (signal) {
        signal.addEventListener('abort', () => {
          if (child && !child.killed) {
            child.kill('SIGTERM')
          }
        }, { once: true })
      }
    })
  }
}

// ── 辅助函数 ──

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT) return output
  const half = Math.floor(MAX_OUTPUT / 2)
  return output.slice(0, half) + `\n\n... (省略 ${output.length - MAX_OUTPUT} 字符) ...\n\n` + output.slice(-half)
}

function extractErrors(output: string): string[] {
  const errors: string[] = []
  const lines = output.split('\n')

  for (const line of lines) {
    // TypeScript 编译错误
    if (/error\s+TS\d+:/i.test(line)) {
      errors.push(line.trim())
    }
    // 一般错误
    else if (/error:/i.test(line) && !line.includes('0 errors')) {
      errors.push(line.trim())
    }
    // npm 错误
    else if (/npm ERR!/.test(line)) {
      errors.push(line.trim())
    }
  }

  return errors.slice(0, 20) // 最多 20 条
}
