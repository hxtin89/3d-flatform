import { describe, expect, it } from 'vitest'
import { configuredWorldDatasets, WORLD_DATASETS } from './world-datasets'

describe('unified world datasets', () => {
  it('uses Peru B2 first in the normal world', () => {
    expect(WORLD_DATASETS.map((dataset) => dataset.logicalDataset)).toEqual([
      'peru-b2-globe', '202508-usk-globe', 'prio-z2-globe',
    ])
    expect(configuredWorldDatasets(null)[0].id).toBe('peru-b2')
  })

  it('keeps ?dataset as a single-dataset debug escape hatch', () => {
    expect(configuredWorldDatasets('custom-globe')).toEqual([{
      id: 'debug', label: 'custom-globe', logicalDataset: 'custom-globe', hasDonationShape: false,
    }])
  })
})
