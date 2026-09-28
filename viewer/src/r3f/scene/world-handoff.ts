import * as THREE from 'three'
import type { DatasetRuntime } from '../state/scene-store'
import type { WorldDatasetId } from '../world-datasets'

export const HANDOFF_DWELL_MS = 500

const candidateEnu = new THREE.Vector3()

/** Pick the smallest declared-neighbour footprint containing the ECEF camera. */
export function handoffCandidate(
  active: DatasetRuntime | undefined,
  datasets: Partial<Record<WorldDatasetId, DatasetRuntime>>,
  cameraEcef: THREE.Vector3,
): WorldDatasetId | null {
  const neighborIds = active?.definition.overviewNeighbors ?? []
  const matches: DatasetRuntime[] = []
  for (const id of neighborIds) {
    const candidate = datasets[id]
    const bbox = candidate?.frame?.surveyBbox
    if (candidate?.status !== 'ready' || !bbox) continue
    candidateEnu.copy(cameraEcef).applyMatrix4(candidate.frame!.enuInverse)
    if (candidateEnu.x >= bbox[0] && candidateEnu.x <= bbox[3]
      && candidateEnu.y >= bbox[1] && candidateEnu.y <= bbox[4]) matches.push(candidate)
  }
  matches.sort((a, b) => a.frame!.surveyFootprintArea - b.frame!.surveyFootprintArea
    || a.definition.id.localeCompare(b.definition.id))
  return matches[0]?.definition.id ?? null
}

/** Candidate residency must be continuous; changing or leaving it resets dwell. */
export class HandoffDwell {
  private id: WorldDatasetId | null = null
  private since = 0

  reset(): void {
    this.id = null
    this.since = 0
  }

  update(candidate: WorldDatasetId | null, now: number): WorldDatasetId | null {
    if (!candidate) { this.reset(); return null }
    if (candidate !== this.id) {
      this.id = candidate
      this.since = now
      return null
    }
    return now - this.since >= HANDOFF_DWELL_MS ? candidate : null
  }
}
