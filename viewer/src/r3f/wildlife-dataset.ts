import type { WorldDatasetDefinition } from './world-datasets'

export const WILDLIFE_LOGICAL_DATASET = 'prio-z2-globe'

export function supportsWildlifeDataset(dataset: Pick<WorldDatasetDefinition, 'logicalDataset'> | null | undefined): boolean {
  return dataset?.logicalDataset === WILDLIFE_LOGICAL_DATASET
}
