export type WorldDatasetId = 'peru-b2' | 'usk' | 'pantiacolla' | 'debug'

export interface WorldDatasetDefinition {
  id: WorldDatasetId
  label: string
  logicalDataset: string
  hasDonationShape: boolean
}

export const WORLD_DATASETS: readonly WorldDatasetDefinition[] = Object.freeze([
  { id: 'peru-b2', label: 'Peru B2', logicalDataset: 'peru-b2-globe', hasDonationShape: true },
  { id: 'usk', label: 'Usk', logicalDataset: '202508-usk-globe', hasDonationShape: false },
  { id: 'pantiacolla', label: 'Pantiacolla', logicalDataset: 'prio-z2-globe', hasDonationShape: false },
])

/** Keep ?dataset= as a single-dataset diagnostics mode. */
export function configuredWorldDatasets(datasetOverride: string | null): readonly WorldDatasetDefinition[] {
  if (!datasetOverride) return WORLD_DATASETS
  return [{
    id: 'debug',
    label: datasetOverride,
    logicalDataset: datasetOverride,
    hasDonationShape: datasetOverride === 'peru-b2-globe',
  }]
}
