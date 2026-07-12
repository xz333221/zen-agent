/**
 * 系统资源监控器 — 实时监控 CPU 和内存使用率
 *
 * 工作原理:
 * 1. 使用 os.cpus() 计算 CPU 使用率（两次采样之间的差值）
 * 2. 使用 os.totalmem() / os.freemem() 计算内存使用率
 * 3. 每 2 秒采样一次，通过 IPC 推送给宠物窗口
 * 4. 根据资源压力等级计算动画速度倍率
 *
 * 压力等级:
 * - calm     (CPU < 50%, Mem < 70%):  正常速度
 * - moderate (CPU < 70%, Mem < 85%):  略快
 * - high     (CPU < 90%, Mem < 90%):  较快
 * - critical (CPU >= 90% 或 Mem >= 90%): 最快！宠物急速运动
 */

import { cpus, totalmem, freemem } from 'os'
import { BrowserWindow } from 'electron'
import { IPC_CHANNELS, type SystemResourceStatus } from '@shared/types'
import { getPetWindow } from './windows/pet-window'

/** 采样间隔 (ms) */
const SAMPLE_INTERVAL = 2000

/** CPU 上一次采样的空闲时间统计 */
let prevCpuTimes: { idle: number; total: number } | null = null

/** 监控定时器 */
let monitorTimer: ReturnType<typeof setInterval> | null = null

/**
 * 计算 CPU 使用率
 *
 * 通过对比两次 os.cpus() 采样的时间差值计算:
 * - idle 差值 = 所有核心空闲时间的增量
 * - total 差值 = 所有核心总时间的增量
 * - CPU 使用率 = 1 - idle/total
 */
function calculateCpuPercent(): number {
  const cpuInfos = cpus()

  let idle = 0
  let total = 0

  for (const cpu of cpuInfos) {
    const { user, nice, sys, idle: cpuIdle, irq } = cpu.times
    idle += cpuIdle
    total += user + nice + sys + cpuIdle + irq
  }

  if (!prevCpuTimes) {
    prevCpuTimes = { idle, total }
    return 0 // 第一次采样无法计算差值
  }

  const idleDiff = idle - prevCpuTimes.idle
  const totalDiff = total - prevCpuTimes.total

  prevCpuTimes = { idle, total }

  if (totalDiff === 0) return 0

  const usage = 1 - idleDiff / totalDiff
  return Math.round(usage * 100)
}

/**
 * 计算内存使用率
 */
function calculateMemoryPercent(): number {
  const total = totalmem()
  const free = freemem()
  const used = total - free
  return Math.round((used / total) * 100)
}

/**
 * 根据资源使用率计算压力等级和动画速度
 *
 * 动画速度映射:
 * - calm:     1.0x (正常)
 * - moderate: 1.3x (略快，像小跑)
 * - high:     1.8x (较快，像快走)
 * - critical: 3.0x (最快！急速扇翅，像在报警)
 */
function calculatePressure(
  cpuPercent: number,
  memoryPercent: number
): { pressureLevel: SystemResourceStatus['pressureLevel']; animationSpeed: number } {
  const maxUsage = Math.max(cpuPercent, memoryPercent)

  if (maxUsage >= 90) {
    return { pressureLevel: 'critical', animationSpeed: 3.0 }
  }
  if (maxUsage >= 70) {
    return { pressureLevel: 'high', animationSpeed: 1.8 }
  }
  if (maxUsage >= 50) {
    return { pressureLevel: 'moderate', animationSpeed: 1.3 }
  }
  return { pressureLevel: 'calm', animationSpeed: 1.0 }
}

/**
 * 采样一次系统资源并推送到宠物窗口
 */
function sampleAndPush(): void {
  const cpuPercent = calculateCpuPercent()
  const memoryPercent = calculateMemoryPercent()
  const { pressureLevel, animationSpeed } = calculatePressure(cpuPercent, memoryPercent)

  const status: SystemResourceStatus = {
    cpuPercent,
    memoryPercent,
    pressureLevel,
    animationSpeed,
  }

  // 推送到宠物窗口
  const petWin = getPetWindow()
  if (petWin && !petWin.isDestroyed()) {
    petWin.webContents.send(IPC_CHANNELS.PET_RESOURCE_UPDATE, status)
  }

  // 压力变化时在控制台输出（方便调试）
  if (pressureLevel === 'critical') {
    console.warn(
      `[ResourceMonitor] ⚠ CPU=${cpuPercent}%, MEM=${memoryPercent}% — ` +
      `pressure=${pressureLevel}, speed=${animationSpeed}x`
    )
  }
}

/**
 * 启动系统资源监控
 *
 * 在 app.whenReady() 后调用，每 2 秒采样一次。
 */
export function startResourceMonitor(): void {
  if (monitorTimer) {
    console.warn('[ResourceMonitor] Already running')
    return
  }

  // 第一次采样初始化 CPU 基线（不推送）
  calculateCpuPercent()

  console.log('[ResourceMonitor] Started — sampling every 2s')

  monitorTimer = setInterval(() => {
    try {
      sampleAndPush()
    } catch (err) {
      console.error('[ResourceMonitor] Sample failed:', err)
    }
  }, SAMPLE_INTERVAL)

  // 不阻止进程退出
  monitorTimer.unref?.()
}

/**
 * 停止系统资源监控
 */
export function stopResourceMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer)
    monitorTimer = null
    console.log('[ResourceMonitor] Stopped')
  }
}

/**
 * 获取当前资源状态（单次采样）
 */
export function getCurrentResourceStatus(): SystemResourceStatus {
  const cpuPercent = calculateCpuPercent()
  const memoryPercent = calculateMemoryPercent()
  const { pressureLevel, animationSpeed } = calculatePressure(cpuPercent, memoryPercent)

  return {
    cpuPercent,
    memoryPercent,
    pressureLevel,
    animationSpeed,
  }
}
