import { describe, expect, it } from 'vitest'
import fixture from '../../public/mock/wildlife-features.json'
import { createMockFeatureApi, FEATURE_KINDS, type FeatureFixture } from './wildlife-api'
import { supportsWildlifeDataset } from './wildlife-dataset'

const query = (band: 'overview' | 'explore' | 'detail') => ({
  center: { longitude: -71.2425, latitude: -12.651 }, rangeM: 2_000, band, types: [...FEATURE_KINDS],
})

describe('Pantiacolla wildlife mock', () => {
  it('maps all 22 animal assets to generated thumbnails', () => {
    expect(fixture.animals).toHaveLength(22)
    expect(fixture.animals.every((animal) => /^mock\/wildlife-assets\/animals\/animal-\d+\.webp$/.test(animal.thumbnailUrl))).toBe(true)
  })

  it('returns spatial clusters at overview and individual animals at detail', async () => {
    const api = createMockFeatureApi({ loadFixture: async () => fixture as FeatureFixture, latencyMs: 0 })
    const controller = new AbortController()
    const overview = await api.fetchFeatures(query('overview'), controller.signal)
    const detail = await api.fetchFeatures(query('detail'), controller.signal)
    expect(overview.clusters).toHaveLength(3)
    expect(overview.clusters.reduce((total, cluster) => total + cluster.count, 0)).toBe(22)
    expect(overview.animals).toEqual([])
    expect(detail.clusters).toEqual([])
    expect(detail.animals).toHaveLength(22)
  })

  it('only enables wildlife for the prio-z2 logical dataset', () => {
    expect(supportsWildlifeDataset({ logicalDataset: 'prio-z2-globe' })).toBe(true)
    expect(supportsWildlifeDataset({ logicalDataset: 'peru-b2-globe' })).toBe(false)
    expect(supportsWildlifeDataset(undefined)).toBe(false)
  })
})
