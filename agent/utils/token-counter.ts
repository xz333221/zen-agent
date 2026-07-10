/**
 * Token 计数器 — 估算文本和消息的 Token 数
 *
 * 策略:
 * 1. 基于字符类型的启发式估算（CJK vs ASCII）
 *    - CJK 字符: ~0.7 token/字（约 1.4 字/token）
 *    - ASCII 字符: ~0.25 token/字符（约 4 字符/token）
 *    - 标点和空格适当折算
 * 2. 消息级开销：每条消息约 4 token（role 标签、分隔符）
 * 3. 未来可替换为 tiktoken 等精确分词器
 */

/** 消息角色类型 */
type MessageRole = 'system' | 'user' | 'assistant'

/** 单条消息 */
export interface CountableMessage {
  role: MessageRole
  content: string
}

/** Token 计数结果 */
export interface TokenCountResult {
  /** 文本内容 token 数 */
  contentTokens: number
  /** 消息开销 token 数 */
  overheadTokens: number
  /** 总 token 数 */
  total: number
}

/** 每条消息的固定开销（role、分隔符等） */
const MESSAGE_OVERHEAD = 4

/** 对话级别的固定开销（<|im_start|>...<|im_end|> 等） */
const CONVERSATION_OVERHEAD = 3

// ── CJK Unicode 范围检测 ──

/** 检测字符是否为 CJK 字符 */
function isCJK(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||   // CJK 统一表意文字
    (code >= 0x3400 && code <= 0x4dbf) ||   // CJK 扩展 A
    (code >= 0x20000 && code <= 0x2a6df) || // CJK 扩展 B
    (code >= 0x2a700 && code <= 0x2b73f) || // CJK 扩展 C
    (code >= 0x2b740 && code <= 0x2b81f) || // CJK 扩展 D
    (code >= 0xf900 && code <= 0xfaff) ||   // CJK 兼容表意文字
    (code >= 0x3000 && code <= 0x30ff) ||   // CJK 标点 + 假名
    (code >= 0xff00 && code <= 0xffef)      // 全角字符
  )
}

/**
 * 估算纯文本的 Token 数
 *
 * @param text 要计数的文本
 * @returns 估算的 token 数
 */
export function countTextTokens(text: string): number {
  if (!text) return 0

  let cjkChars = 0
  let asciiChars = 0
  let otherChars = 0

  for (const char of text) {
    const code = char.codePointAt(0)!
    if (isCJK(code)) {
      cjkChars++
    } else if (code < 128) {
      asciiChars++
    } else {
      otherChars++
    }
  }

  // CJK: ~0.7 token/字, ASCII: ~0.25 token/字符, 其他: ~0.5 token/字符
  const cjkTokens = cjkChars * 0.7
  const asciiTokens = asciiChars * 0.25
  const otherTokens = otherChars * 0.5

  return Math.ceil(cjkTokens + asciiTokens + otherTokens)
}

/**
 * 估算单条消息的 Token 数（含开销）
 *
 * @param message 消息对象
 * @returns 计数结果
 */
export function countMessageTokens(message: CountableMessage): TokenCountResult {
  const contentTokens = countTextTokens(message.content)
  // role 名称也占 token（"system"/"user"/"assistant" 约 1-2 token）
  const roleTokens = countTextTokens(message.role)
  const overheadTokens = MESSAGE_OVERHEAD + roleTokens

  return {
    contentTokens,
    overheadTokens,
    total: contentTokens + overheadTokens
  }
}

/**
 * 估算消息列表的总 Token 数
 *
 * @param messages 消息列表
 * @returns 总 token 数（含对话级别开销）
 */
export function countMessagesTokens(messages: CountableMessage[]): number {
  if (messages.length === 0) return 0

  let total = CONVERSATION_OVERHEAD

  for (const msg of messages) {
    total += countMessageTokens(msg).total
  }

  return total
}

/**
 * 获取消息列表的详细 token 分布
 *
 * @param messages 消息列表
 * @returns 每条消息的计数 + 总计
 */
export function getMessagesTokenBreakdown(messages: CountableMessage[]): {
  messages: Array<CountableMessage & { tokens: number }>
  total: number
} {
  const breakdown = messages.map(msg => ({
    ...msg,
    tokens: countMessageTokens(msg).total
  }))

  const total = CONVERSATION_OVERHEAD + breakdown.reduce((sum, m) => sum + m.tokens, 0)

  return { messages: breakdown, total }
}

/**
 * 估算达到指定 token 预算时，从消息列表末尾可以保留多少条消息
 *
 * @param messages 消息列表（正序）
 * @param budget token 预算
 * @returns 可以保留的消息数量
 */
export function fitMessagesToBudget(
  messages: CountableMessage[],
  budget: number
): number {
  let usedTokens = CONVERSATION_OVERHEAD
  let count = 0

  // 从末尾向前扫描（保留最近的消息）
  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = countMessageTokens(messages[i]).total
    if (usedTokens + msgTokens > budget) break
    usedTokens += msgTokens
    count++
  }

  return count
}
