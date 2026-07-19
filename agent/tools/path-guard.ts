/**
 * 路径保护守卫 — 共享给 file_writer 和 file_edit
 *
 * 防止 agent 写入系统关键路径（/etc, /boot, C:\Windows 等），
 * 避免误操作破坏系统。
 */

/** 受保护的系统路径模式列表 */
export const PROTECTED_PATH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^\/etc\//, reason: '系统配置目录 /etc' },
  { pattern: /^\/boot\//, reason: '系统启动目录 /boot' },
  { pattern: /^\/dev\//, reason: '设备文件目录 /dev' },
  { pattern: /^\/proc\//, reason: '进程信息目录 /proc' },
  { pattern: /^\/sys\//, reason: '内核 sysfs 目录 /sys' },
  { pattern: /^C:\\Windows\\/i, reason: 'Windows 系统目录' },
  { pattern: /^C:\\Program Files\\/i, reason: 'Program Files 目录' },
]

/**
 * 检查绝对路径是否受保护
 * @returns 命中时返回 reason，未命中返回 null
 */
export function checkProtectedPath(absPath: string): string | null {
  for (const { pattern, reason } of PROTECTED_PATH_PATTERNS) {
    if (pattern.test(absPath)) {
      return reason
    }
  }
  return null
}
