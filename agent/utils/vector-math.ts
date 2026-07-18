/**
 * 向量数学工具 — 纯函数，无任何外部依赖
 *
 * 从 vector-store.ts 中抽出，使不依赖数据库的模块
 * （如 pattern-detector）可以直接使用，避免拖入 sql.js 依赖链。
 */

/**
 * 计算余弦相似度
 *
 * cos(A, B) = (A · B) / (|A| * |B|)
 *
 * 结果范围 [-1, 1]，1 表示方向相同（最相似）
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length)
  if (len === 0) return 0

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < len; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  if (denominator === 0) return 0

  return dotProduct / denominator
}
