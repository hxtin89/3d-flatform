import * as THREE from 'three'

export type WorldDatasetId = 'peru-b2' | 'usk' | 'pantiacolla' | 'manu-z2' | 'manu-z4' | 'manu-z5' | 'debug'

export interface WorldDatasetDefinition {
  id: WorldDatasetId
  label: string
  logicalDataset: string
  hasPeruContent: boolean
  overviewNeighbors?: readonly WorldDatasetId[]
}

export const WORLD_DATASETS: readonly WorldDatasetDefinition[] = Object.freeze([
  { id: 'peru-b2', label: 'Peru B2', logicalDataset: 'peru-b2-globe', hasPeruContent: true },
  { id: 'usk', label: 'Usk', logicalDataset: '202508-usk-globe', hasPeruContent: false },
  { id: 'pantiacolla', label: 'Pantiacolla', logicalDataset: 'prio-z2-globe', hasPeruContent: false },
  { id: 'manu-z2', label: 'Manu Z2', logicalDataset: '202606-manu-z2-globe', hasPeruContent: false,
    overviewNeighbors: ['manu-z4', 'manu-z5'] },
  { id: 'manu-z4', label: 'Manu Z4', logicalDataset: '202606-manu-z4-globe', hasPeruContent: false,
    overviewNeighbors: ['manu-z2', 'manu-z5'] },
  { id: 'manu-z5', label: 'Manu Z5', logicalDataset: '202606-manu-z5-globe', hasPeruContent: false,
    overviewNeighbors: ['manu-z4', 'manu-z2'] },
])

export function configuredWorldDatasets(override: string | null): readonly WorldDatasetDefinition[] {
  if (!override) return WORLD_DATASETS
  return [{ id: 'debug', label: override, logicalDataset: override, hasPeruContent: override === 'peru-b2-globe' }]
}

export function coverageDatasetIds(
  definitions: readonly WorldDatasetDefinition[], activeId: WorldDatasetId, tree: 'aph' | 'one-lod',
): readonly WorldDatasetId[] {
  if (tree !== 'aph') return [activeId]
  const active = definitions.find((definition) => definition.id === activeId)
  const allowed = new Set<WorldDatasetId>([activeId, ...(active?.overviewNeighbors ?? [])])
  return definitions.map((definition) => definition.id).filter((id) => allowed.has(id))
}

export interface WorldFootprint {
  id: WorldDatasetId
  status: 'loading' | 'ready' | 'failed'
  enuInverse: THREE.Matrix4 | null
  surveyBbox: readonly number[] | null
  overviewNeighbors: readonly WorldDatasetId[]
}

const candidateEnu = new THREE.Vector3()

/** Only a declared neighbour may take ownership; ECEF keeps the camera frame independent. */
export function handoffCandidate(
  active: WorldFootprint, sites: Partial<Record<WorldDatasetId, WorldFootprint>>, cameraEcef: THREE.Vector3,
): WorldDatasetId | null {
  const activeBox = active.surveyBbox
  if (active.enuInverse && activeBox?.length === 6) {
    candidateEnu.copy(cameraEcef).applyMatrix4(active.enuInverse)
    // Shared/overlapping footprints must keep their current owner. A neighbour
    // takes over only after the eye has actually left the active survey.
    if (candidateEnu.x >= activeBox[0] && candidateEnu.x <= activeBox[3]
      && candidateEnu.y >= activeBox[1] && candidateEnu.y <= activeBox[4]) return null
  }
  const matches: { id: WorldDatasetId; area: number }[] = []
  for (const id of active.overviewNeighbors) {
    const candidate = sites[id]
    const box = candidate?.surveyBbox
    if (candidate?.status !== 'ready' || !candidate.enuInverse || !box || box.length !== 6) continue
    candidateEnu.copy(cameraEcef).applyMatrix4(candidate.enuInverse)
    if (candidateEnu.x >= box[0] && candidateEnu.x <= box[3]
      && candidateEnu.y >= box[1] && candidateEnu.y <= box[4]) {
      matches.push({ id, area: (box[3] - box[0]) * (box[4] - box[1]) })
    }
  }
  matches.sort((a, b) => a.area - b.area || a.id.localeCompare(b.id))
  return matches[0]?.id ?? null
}

export class HandoffDwell {
  private id: WorldDatasetId | null = null
  private since = 0

  reset(): void { this.id = null; this.since = 0 }

  update(candidate: WorldDatasetId | null, now: number): WorldDatasetId | null {
    if (!candidate) { this.reset(); return null }
    if (candidate !== this.id) { this.id = candidate; this.since = now; return null }
    return now - this.since >= 500 ? candidate : null
  }
}

export interface WorldMemoryBudget { cacheBytes: number; gpuBytes: number }

export function allocateWorldMemoryBudget<T extends string>(
  total: WorldMemoryBudget, ids: readonly T[], activeId: T,
): Record<T, WorldMemoryBudget> {
  const backgrounds = Math.max(0, ids.length - 1)
  const activeShare = backgrounds ? 0.8 : 1
  let cacheLeft = total.cacheBytes
  let gpuLeft = total.gpuBytes
  return ids.reduce((out, id, index) => {
    const share = id === activeId ? activeShare : (1 - activeShare) / backgrounds
    const last = index === ids.length - 1
    const cacheBytes = last ? cacheLeft : Math.floor(total.cacheBytes * share)
    const gpuBytes = last ? gpuLeft : Math.floor(total.gpuBytes * share)
    cacheLeft -= cacheBytes
    gpuLeft -= gpuBytes
    out[id] = { cacheBytes, gpuBytes }
    return out
  }, {} as Record<T, WorldMemoryBudget>)
}
