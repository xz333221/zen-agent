/**
 * 终端命令执行工具 — 在系统终端中执行命令
 *
 * 能力:
 * - 执行 shell 命令（git, npm, node, python, ls, dir 等）
 * - 捕获 stdout / stderr / exit code
 * - 工作目录设置
 * - 超时保护
 * - 危险命令拦截（仅拦截真正危险的命令，普通命令直接执行）
 */

import { exec } from 'child_process'
import { resolve } from 'path'
import type { ToolDef, ToolExecutor, ToolResult } from './types'

const IS_WIN = process.platform === 'win32'
const PLATFORM_NAME = IS_WIN ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux'
const SHELL_NAME = IS_WIN ? 'cmd.exe' : 'bash'
const PATH_SEP = IS_WIN ? '\\' : '/'
const LIST_CMD = IS_WIN ? 'dir' : 'ls -la'

const TERMINAL_DEF: ToolDef = {
  id: 'terminal',
  name: 'Terminal',
  description: `在用户${PLATFORM_NAME}电脑上执行${SHELL_NAME}命令。参数: command (命令, 不要包含 cd, 用 cwd 设置工作目录), cwd (工作目录, ${IS_WIN ? '如 e:\\project' : '如 /home/project'}, 可选), timeout (超时毫秒, 可选, 默认 30000)。注意: 当前系统是${PLATFORM_NAME}, 路径用${PATH_SEP}分隔符, 列出文件用 ${LIST_CMD}.`,
  category: 'builtin',
  schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: `要执行的命令（如 "git status", "npm install", "${LIST_CMD}"）。不要写 cd 命令，用 cwd 参数指定工作目录。`
      },
      cwd: {
        type: 'string',
        description: `工作目录（${IS_WIN ? 'Windows' : 'POSIX'}绝对路径，如 ${IS_WIN ? '"e:\\project"' : '"/home/project"'}）`,
        default: ''
      },
      timeout: {
        type: 'number',
        description: '执行超时（毫秒），默认 30000',
        default: 30000
      }
    },
    required: ['command']
  },
  requiresApproval: false,
  timeoutMs: 120000
}

// ── 最大输出长度（大模型上下文充足，不截断）──
const MAX_OUTPUT_LENGTH = 10 * 1024 * 1024 // 10MB — 仅防止极端情况下的内存溢出

/**
 * 真正危险的命令模式 — 这些命令会被拦截
 *
 * 判定标准：可能导致数据永久丢失、系统崩溃、或安全风险
 */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // ── 递归删除根目录 / 系统目录 ──
  { pattern: /rm\s+-rf\s+\/(\s|$)/, reason: '递归删除根目录' },
  { pattern: /rm\s+-rf\s+\/\*/, reason: '递归删除根目录下所有文件' },
  { pattern: /rm\s+-rf\s+~\s*$/m, reason: '递归删除用户主目录' },
  { pattern: /rm\s+-rf\s+\/home/i, reason: '递归删除 home 目录' },
  { pattern: /rm\s+-rf\s+\/usr/i, reason: '递归删除系统目录' },
  { pattern: /rm\s+-rf\s+\/etc/i, reason: '递归删除系统配置目录' },
  { pattern: /rm\s+-rf\s+\/var/i, reason: '递归删除系统数据目录' },
  { pattern: /rm\s+-rf\s+\/boot/i, reason: '递归删除启动目录' },
  // Windows
  { pattern: /(del|erase|rmdir|rd)\s+\/[fsq]+\s+C:\\/i, reason: '递归删除 Windows 系统盘文件' },
  { pattern: /(del|erase|rmdir|rd)\s+\/[fsq]+\s+\/S\s+C:\\/i, reason: '递归删除 Windows 系统盘目录' },
  { pattern: /format\s+[a-z]:/i, reason: '格式化磁盘' },

  // ── 磁盘级破坏 ──
  { pattern: /dd\s+.*of=\/dev\//i, reason: '直接写入磁盘设备（可能覆盖整个磁盘）' },
  { pattern: /mkfs/i, reason: '创建文件系统（会格式化分区）' },
  { pattern: />\s*\/dev\/sd[a-z]/i, reason: '覆盖磁盘设备' },

  // ── 系统关机/重启 ──
  { pattern: /\b(shutdown|reboot|halt|poweroff|init\s+0)\b/i, reason: '关闭或重启系统' },
  { pattern: /\bshutdown\s+\/[rs]/i, reason: 'Windows 关机或重启' },

  // ── Fork 炸弹 ──
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, reason: 'Fork 炸弹' },

  // ── 远程脚本执行（管道到 shell）──
  { pattern: /curl\s+.*\|\s*(sh|bash|zsh|fish)\b/i, reason: '从远程下载并执行脚本（安全风险）' },
  { pattern: /wget\s+.*\|\s*(sh|bash|zsh|fish)\b/i, reason: '从远程下载并执行脚本（安全风险）' },

  // ── 递归权限修改 ──
  { pattern: /chmod\s+-R\s+777\s+\/(\s|$)/, reason: '递归修改根目录权限为 777' },

  // ── Windows 注册表删除 ──
  { pattern: /reg\s+delete\s+\\.*\\(HKEY|HKLM|HKCR)/i, reason: '删除系统注册表项' },

  // ── 磁盘分区操作 ──
  { pattern: /\bdiskpart\b/i, reason: '磁盘分区管理工具（可能导致数据丢失）' },

  // ── 危险的进程终止 ──
  { pattern: /killall\s+-9/i, reason: '强制终止所有匹配进程' },
  { pattern: /taskkill\s+\/f\s+\/im\s+(explorer|svchost|csrss|wininit|lsass)/i, reason: '终止关键系统进程' },
]

/**
 * 检测命令是否危险
 */
function detectDangerousCommand(command: string): { dangerous: boolean; reason: string } {
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return { dangerous: true, reason }
    }
  }
  return { dangerous: false, reason: '' }
}

/**
 * 截断输出，保留头部和尾部
 */
function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_LENGTH) return output

  const half = Math.floor(MAX_OUTPUT_LENGTH / 2)
  const head = output.slice(0, half)
  const tail = output.slice(-half)
  const omitted = output.length - MAX_OUTPUT_LENGTH
  return `${head}\n\n... (省略 ${omitted} 字符) ...\n\n${tail}`
}

export const terminal: ToolExecutor = {
  def: TERMINAL_DEF,
  async execute(params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const startTime = Date.now()
    const command = String(params.command || '').trim()
    const cwd = params.cwd ? String(params.cwd) : ''
    const timeoutMs = Number(params.timeout) || 30000

    if (!command) {
      return {
        callId: `term-${Date.now()}`,
        success: false,
        result: null,
        resultType: 'error',
        resultSummary: '缺少命令参数',
        duration: Date.now() - startTime,
        error: 'Command parameter is required'
      }
    }

    if (signal?.aborted) {
      return {
        callId: `term-${Date.now()}`,
        success: false,
        result: null,
        resultType: 'error',
        resultSummary: '执行被中止',
        duration: Date.now() - startTime,
        error: 'aborted'
      }
    }

    // ── 危险命令检测 ──
    const dangerCheck = detectDangerousCommand(command)
    if (dangerCheck.dangerous) {
      return {
        callId: `term-${Date.now()}`,
        success: false,
        result: null,
        resultType: 'error',
        resultSummary: `⚠️ 危险命令已拦截: ${dangerCheck.reason}。如需执行，请手动在终端中运行。`,
        duration: Date.now() - startTime,
        error: `Blocked dangerous command: ${dangerCheck.reason}`
      }
    }

    // ── 平台路径格式检查 ──
    // 检测 Linux 风格路径在 Windows 上的误用
    if (IS_WIN) {
      // 检测 cd /e/... 或 cd /c/... 等 MSYS/Git Bash 路径
      const msysPathMatch = command.match(/\bcd\s+\/[a-z]\//i)
      if (msysPathMatch) {
        return {
          callId: `term-${Date.now()}`,
          success: false,
          result: null,
          resultType: 'error',
          resultSummary: `路径格式错误：当前系统是 Windows，不要使用 "/e/" 这样的 Linux 路径。请使用 Windows 路径（如 e:\\project），并通过 cwd 参数设置工作目录，不要在 command 中写 cd。`,
          duration: Date.now() - startTime,
          error: `Invalid path format for Windows: ${msysPathMatch[0]}`
        }
      }
      // 检测 ls 命令（Windows 应该用 dir）
      if (/^\s*ls\b/.test(command) && !command.includes('wsl')) {
        // 不阻止，但在结果中会提示
      }
    }

    // 解析工作目录
    const workDir = cwd ? resolve(cwd) : undefined

    return new Promise<ToolResult>((resolvePromise) => {
      // 创建 AbortController 用于超时和外部取消
      const child = exec(
        command,
        {
          cwd: workDir,
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024 * 50, // 50MB — 大模型上下文充足，放宽限制
          env: { ...process.env },
          shell: process.platform === 'win32' ? process.env.COMSPEC || 'cmd.exe' : process.env.SHELL || '/bin/bash'
        },
        (error, stdout, stderr) => {
          const duration = Date.now() - startTime
          const truncatedStdout = truncateOutput(stdout || '')
          const truncatedStderr = truncateOutput(stderr || '')

          // 判断是否被信号中止
          if (signal?.aborted) {
            resolvePromise({
              callId: `term-${Date.now()}`,
              success: false,
              result: null,
              resultType: 'error',
              resultSummary: '执行被中止',
              duration,
              error: 'aborted'
            })
            return
          }

          if (error) {
            // 命令执行失败（非零退出码或执行错误）
            const isTimeout = error.killed === true && error.signal === 'SIGTERM'
            const exitCode = error.code !== undefined ? error.code : (isTimeout ? -1 : 1)

            // 构建错误提示，附带平台信息帮助 LLM 修正
            let platformHint = ''
            if (IS_WIN) {
              if (truncatedStderr.includes('not recognized') || truncatedStderr.includes('is not recognized')) {
                platformHint = `\n[提示] 当前系统是 Windows (${SHELL_NAME})，请确认命令在 Windows 上可用。列出文件用 dir，不要用 ls。`
              }
              if (truncatedStderr.includes('The system cannot find the path specified')) {
                platformHint = `\n[提示] 路径不存在。Windows 路径使用反斜杠（如 e:\\project），不要用正斜杠或 /e/ 格式。`
              }
            }

            resolvePromise({
              callId: `term-${Date.now()}`,
              success: false,
              result: {
                stdout: truncatedStdout,
                stderr: truncatedStderr + platformHint,
                exitCode,
                command,
                cwd: workDir || process.cwd(),
                platform: PLATFORM_NAME,
                shell: SHELL_NAME,
                timedOut: isTimeout
              },
              resultType: 'text',
              resultSummary: isTimeout
                ? `命令超时 (${timeoutMs}ms): ${command}`
                : `命令失败 (exit ${exitCode}): ${command}${platformHint}`,
              duration,
              error: isTimeout ? `Command timed out after ${timeoutMs}ms` : `Exit code ${exitCode}`
            })
          } else {
            // 成功
            const exitCode = 0
            const summary = truncatedStdout
              ? `命令执行成功 (exit ${exitCode}, ${duration}ms): ${command}`
              : `命令执行成功 (exit ${exitCode}, ${duration}ms, 无输出): ${command}`

            resolvePromise({
              callId: `term-${Date.now()}`,
              success: true,
              result: {
                stdout: truncatedStdout,
                stderr: truncatedStderr,
                exitCode,
                command,
                cwd: workDir || process.cwd(),
                platform: PLATFORM_NAME,
                shell: SHELL_NAME,
                timedOut: false
              },
              resultType: 'text',
              resultSummary: summary,
              duration
            })
          }
        }
      )

      // 外部取消信号
      if (signal) {
        const onAbort = () => {
          if (child && !child.killed) {
            child.kill('SIGTERM')
          }
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }
}
