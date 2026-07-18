import { describe, it, expect } from 'vitest'
import { PatternDetector, type EmbedFn } from '../agent/evolution/interaction/pattern-detector'

/**
 * 确定性的测试用 embedding：
 * 预先为每个文本指定向量，完全控制相似度关系。
 */
function makeEmbed(vectors: Record<string, number[]>): EmbedFn {
  return async (text: string) => vectors[text] ?? [0, 0, 1]
}

// 三个高度相似的查询（向量方向一致）
const SIMILAR_VECTORS = {
  '查一下上证指数': [1, 0, 0],
  '帮我查上证指数': [1, 0.01, 0],
  '上证指数查一下': [0.99, 0.02, 0],
  '今天天气怎么样': [0, 1, 0]
}

describe('PatternDetector', () => {
  it('相似查询达到阈值时检测到模式', async () => {
    const detector = new PatternDetector(
      { threshold: 3, similarityThreshold: 0.9 },
      makeEmbed(SIMILAR_VECTORS)
    )

    await detector.recordQuery('查一下上证指数', 'question', [], 's1')
    await detector.recordQuery('帮我查上证指数', 'question', [], 's1')
    await detector.recordQuery('上证指数查一下', 'question', [], 's1')

    const result = detector.detect()
    expect(result.detected).toBe(true)
    expect(result.patterns.length).toBeGreaterThan(0)
    expect(result.patterns[0].occurrences.length).toBeGreaterThanOrEqual(3)
  })

  it('查询数不足阈值时不检测', async () => {
    const detector = new PatternDetector(
      { threshold: 3 },
      makeEmbed(SIMILAR_VECTORS)
    )
    await detector.recordQuery('查一下上证指数', 'question', [], 's1')
    await detector.recordQuery('帮我查上证指数', 'question', [], 's1')

    const result = detector.detect()
    expect(result.detected).toBe(false)
  })

  it('不相似的查询不会形成模式', async () => {
    const detector = new PatternDetector(
      { threshold: 3, similarityThreshold: 0.9 },
      makeEmbed(SIMILAR_VECTORS)
    )
    await detector.recordQuery('查一下上证指数', 'question', [], 's1')
    await detector.recordQuery('今天天气怎么样', 'question', [], 's1')
    await detector.recordQuery('帮我查上证指数', 'question', [], 's1')

    const result = detector.detect()
    expect(result.detected).toBe(false)
  })

  it('同一模式不会重复触发', async () => {
    const detector = new PatternDetector(
      { threshold: 3, similarityThreshold: 0.9 },
      makeEmbed(SIMILAR_VECTORS)
    )
    for (const q of ['查一下上证指数', '帮我查上证指数', '上证指数查一下']) {
      await detector.recordQuery(q, 'question', [], 's1')
    }
    expect(detector.detect().detected).toBe(true)
    // 第二次 detect：模式已标记，不再重复触发
    expect(detector.detect().detected).toBe(false)
  })

  it('超出 maxRecords 时淘汰最旧记录', async () => {
    const detector = new PatternDetector(
      { threshold: 3, maxRecords: 2 },
      makeEmbed(SIMILAR_VECTORS)
    )
    await detector.recordQuery('查一下上证指数', 'question', [], 's1')
    await detector.recordQuery('帮我查上证指数', 'question', [], 's1')
    await detector.recordQuery('上证指数查一下', 'question', [], 's1')

    expect(detector.getStats().totalQueries).toBe(2)
  })

  it('clear() 清空历史与已检测模式', async () => {
    const detector = new PatternDetector(
      { threshold: 3, similarityThreshold: 0.9 },
      makeEmbed(SIMILAR_VECTORS)
    )
    for (const q of ['查一下上证指数', '帮我查上证指数', '上证指数查一下']) {
      await detector.recordQuery(q, 'question', [], 's1')
    }
    detector.detect()
    detector.clear()

    const stats = detector.getStats()
    expect(stats.totalQueries).toBe(0)
    expect(stats.detectedPatterns).toBe(0)
  })

  it('实例之间状态隔离（回归：历史上是模块级共享状态）', async () => {
    const embed = makeEmbed(SIMILAR_VECTORS)
    const detectorA = new PatternDetector({ threshold: 3 }, embed)
    const detectorB = new PatternDetector({ threshold: 3 }, embed)

    await detectorA.recordQuery('查一下上证指数', 'question', [], 's1')
    await detectorA.recordQuery('帮我查上证指数', 'question', [], 's1')

    // B 不应看到 A 的记录
    expect(detectorB.getStats().totalQueries).toBe(0)
  })

  it('embedding 生成失败时静默跳过（不抛异常）', async () => {
    const failingEmbed: EmbedFn = async () => {
      throw new Error('embedding service down')
    }
    const detector = new PatternDetector({ threshold: 1 }, failingEmbed)
    await expect(
      detector.recordQuery('test', 'question', [], 's1')
    ).resolves.toBeUndefined()
    expect(detector.getStats().totalQueries).toBe(0)
  })
})
