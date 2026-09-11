import { describe, expect, it } from 'vitest'
import { allocateWorldMemoryBudget } from './world-memory-budget'

describe('allocateWorldMemoryBudget', () => {
  it('keeps the original total while favouring the active dataset', () => {
    const result = allocateWorldMemoryBudget({ cacheBytes: 1000, gpuBytes: 500 }, ['peru', 'usk', 'panti'] as const, 'usk')
    expect(result.usk).toEqual({ cacheBytes: 800, gpuBytes: 400 })
    expect(result.peru.cacheBytes + result.usk.cacheBytes + result.panti.cacheBytes).toBe(1000)
    expect(result.peru.gpuBytes + result.usk.gpuBytes + result.panti.gpuBytes).toBe(500)
  })
})
