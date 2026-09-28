import { describe, expect, it } from 'vitest'
import { configuredWorldDatasets, coverageDatasetIds, WORLD_DATASETS } from './world-datasets'

describe('unified world datasets', () => {
  it('uses Peru B2 first in the normal world', () => {
    expect(WORLD_DATASETS.map((dataset) => dataset.logicalDataset)).toEqual([
      'peru-b2-globe', '202508-usk-globe', 'prio-z2-globe',
      '202606-manu-z4-globe', '202606-manu-z5-globe',
    ])
    expect(configuredWorldDatasets(null)[0].id).toBe('peru-b2')
  })

  it('keeps ?dataset as a single-dataset debug escape hatch', () => {
    expect(configuredWorldDatasets('custom-globe')).toEqual([{
      id: 'debug', label: 'custom-globe', logicalDataset: 'custom-globe', hasDonationShape: false,
    }])
  })

  it('mounts only the active Manu pair for APH coverage', () => {
    expect(coverageDatasetIds(WORLD_DATASETS, 'manu-z4', 'aph')).toEqual(['manu-z4', 'manu-z5'])
    expect(coverageDatasetIds(WORLD_DATASETS, 'manu-z5', 'aph')).toEqual(['manu-z4', 'manu-z5'])
    expect(coverageDatasetIds(WORLD_DATASETS, 'peru-b2', 'aph')).toEqual(['peru-b2'])
  })

  it('does not apply neighbour coverage to One LOD', () => {
    expect(coverageDatasetIds(WORLD_DATASETS, 'manu-z4', 'one-lod')).toEqual(['manu-z4'])
  })
})
