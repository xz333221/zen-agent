import { describe, it, expect } from 'vitest'
import { cosineSimilarity } from '../agent/utils/vector-math'

describe('cosineSimilarity', () => {
  it('相同向量相似度为 1', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1)
  })

  it('正交向量相似度为 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
  })

  it('反向向量相似度为 -1', () => {
    expect(cosineSimilarity([1, 1], [-1, -1])).toBeCloseTo(-1)
  })

  it('零向量返回 0（不产生 NaN）', () => {
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0)
    expect(cosineSimilarity([], [])).toBe(0)
  })

  it('长度不同时按较短者计算', () => {
    expect(cosineSimilarity([1, 0, 999], [1, 0])).toBeCloseTo(1)
  })
})
