export type WorldDatasetId = 'peru-b2' | 'usk' | 'pantiacolla' | 'manu-z4' | 'manu-z5' | 'debug'

export interface WorldDatasetDefinition {
  id: WorldDatasetId
  label: string
  logicalDataset: string
  hasDonationShape: boolean
  /** Sites whose p001 APH context remains mounted while this site is active. */
  overviewNeighbors?: readonly WorldDatasetId[]
}

export const WORLD_DATASETS: readonly WorldDatasetDefinition[] = Object.freeze([
  { id: 'peru-b2', label: 'Peru B2', logicalDataset: 'peru-b2-globe', hasDonationShape: true },
  { id: 'usk', label: 'Usk', logicalDataset: '202508-usk-globe', hasDonationShape: false },
  { id: 'pantiacolla', label: 'Pantiacolla', logicalDataset: 'prio-z2-globe', hasDonationShape: false },
  {
    id: 'manu-z4', label: 'Manu Z4', logicalDataset: '202606-manu-z4-globe', hasDonationShape: false,
    overviewNeighbors: ['manu-z5'],
  },
  {
    id: 'manu-z5', label: 'Manu Z5', logicalDataset: '202606-manu-z5-globe', hasDonationShape: false,
    overviewNeighbors: ['manu-z4'],
  },
])

/** The active APH site and its explicitly declared overview neighbours. */
export function coverageDatasetIds(
  datasets: readonly WorldDatasetDefinition[],
  activeId: WorldDatasetId,
  tree: 'aph' | 'one-lod',
): readonly WorldDatasetId[] {
  if (tree !== 'aph') return [activeId]
  const active = datasets.find((dataset) => dataset.id === activeId)
  const allowed = new Set<WorldDatasetId>([activeId, ...(active?.overviewNeighbors ?? [])])
  return datasets.map((dataset) => dataset.id).filter((id) => allowed.has(id))
}

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
