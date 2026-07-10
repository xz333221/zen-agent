/**
 * Embedding 生成 — 向量化文本用于语义搜索
 *
 * 策略:
 * 1. LLM 已配置时，调用 OpenAI 兼容的 embeddings API
 * 2. LLM 未配置时，使用确定性哈希伪嵌入（用于测试/离线模式）
 * 3. 内置 LRU 缓存，避免重复文本多次调用 API
 *
 * 伪嵌入原理:
 * - 使用 DJB2 哈希将文本映射到固定维度（384 维）的向量
 * - 同一文本始终生成相同向量，相似文本有一定概率向量接近
 * - 仅用于功能测试，不具备真正的语义搜索能力
 */

import { llm } from '../providers/llm'
import { isLLMConfigured, isEmbeddingConfigured, getEmbeddingModelKey } from '../providers/llm-config'

/** 默认嵌入维度（与 OpenAI text-embedding-3-small 一致） */
export const EMBEDDING_DIM = 1536

/** 伪嵌入维度（节省内存） */
const PSEUDO_DIM = 384

/** 缓存大小 */
const CACHE_SIZE = 200

// ── LRU 缓存 ──
class LRUCache<K, V> {
  private map = new Map<K, V>()
  private maxSize: number

  constructor(maxSize: number) {
    this.maxSize = maxSize
  }

  get(key: K): V | undefined {
    const value = this.map.get(key)
    if (value !== undefined) {
      // 移到末尾（最近使用）
      this.map.delete(key)
      this.map.set(key, value)
    }
    return value
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key)
    } else if (this.map.size >= this.maxSize) {
      // 删除最旧的
      const firstKey = this.map.keys().next().value
      if (firstKey !== undefined) this.map.delete(firstKey)
    }
    this.map.set(key, value)
  }

  clear(): void {
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }
}

const embeddingCache = new LRUCache<string, number[]>(CACHE_SIZE)

/**
 * 生成文本的嵌入向量
 *
 * @param text 要向量化的文本
 * @param signal AbortSignal
 * @returns 嵌入向量（number 数组）
 */
export async function generateEmbedding(
  text: string,
  signal?: AbortSignal
): Promise<number[]> {
  if (!text || text.trim().length === 0) {
    return new Array(EMBEDDING_DIM).fill(0)
  }

  // 截断过长的文本（API 通常限制 8192 tokens）
  const truncated = text.length > 8000 ? text.slice(0, 8000) : text

  // 检查缓存
  const cacheKey = truncated.slice(0, 200) // 用前 200 字符作为缓存键
  const cached = embeddingCache.get(cacheKey)
  if (cached) return cached

  let embedding: number[]

  if (isEmbeddingConfigured()) {
    try {
      const embeddingModelKey = getEmbeddingModelKey()
      embedding = await llm.embed(truncated, embeddingModelKey)
    } catch (err) {
      console.warn('[Embeddings] LLM embedding failed, using pseudo-embedding:', err)
      embedding = generatePseudoEmbedding(truncated)
    }
  } else {
    // 未配置嵌入模型时直接使用伪嵌入，避免用聊天模型调用 embeddings API 导致错误
    if (isLLMConfigured()) {
      console.info('[Embeddings] No embedding model configured, using pseudo-embedding. Configure an embedding model in settings for semantic search.')
    }
    embedding = generatePseudoEmbedding(truncated)
  }

  embeddingCache.set(cacheKey, embedding)
  return embedding
}

/**
 * 批量生成嵌入向量
 *
 * @param texts 文本数组
 * @param signal AbortSignal
 * @returns 嵌入向量数组
 */
export async function generateEmbeddings(
  texts: string[],
  signal?: AbortSignal
): Promise<number[][]> {
  const results: number[][] = []
  for (const text of texts) {
    if (signal?.aborted) break
    results.push(await generateEmbedding(text, signal))
  }
  return results
}

/**
 * 生成伪嵌入向量（确定性哈希）
 *
 * 使用 DJB2 哈希 + 位置扰动生成固定维度的向量。
 * 同一文本始终生成相同向量，但不具备语义搜索能力。
 */
function generatePseudoEmbedding(text: string): number[] {
  const dim = PSEUDO_DIM
  const vec = new Array(dim).fill(0)

  // 对文本的不同片段进行哈希，生成伪随机但确定性的向量
  const chunkSize = Math.max(1, Math.ceil(text.length / 16))

  for (let i = 0; i < text.length; i += chunkSize) {
    const chunk = text.slice(i, i + chunkSize)
    const hash = djb2Hash(chunk)

    // 将哈希值映射到向量的不同位置
    const pos = (hash % dim + dim) % dim
    const value = ((hash % 1000) / 1000 - 0.5) * 2 // [-1, 1]

    vec[pos] += value
  }

  // 归一化
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0))
  if (norm > 0) {
    for (let i = 0; i < dim; i++) {
      vec[i] /= norm
    }
  }

  // 补零到标准维度
  while (vec.length < EMBEDDING_DIM) {
    vec.push(0)
  }

  return vec
}

/**
 * DJB2 哈希函数
 */
function djb2Hash(str: string): number {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0x7fffffff
  }
  return hash
}

/**
 * 清除嵌入缓存
 */
export function clearEmbeddingCache(): void {
  embeddingCache.clear()
}
