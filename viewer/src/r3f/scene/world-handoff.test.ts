import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { HandoffDwell, handoffCandidate } from './world-handoff'
import type { DatasetRuntime } from '../state/scene-store'

function runtime(id: 'manu-z4' | 'manu-z5', bbox: [number, number, number, number, number, number]): DatasetRuntime {
  return {
    definition: {
      id, label: id, logicalDataset: id, hasDonationShape: false,
      overviewNeighbors: [id === 'manu-z4' ? 'manu-z5' : 'manu-z4'],
    },
    status: 'ready', error: null, manifest: null,
    frame: {
      enuFrame: new THREE.Matrix4(), enuInverse: new THREE.Matrix4(), enuUp: new THREE.Vector3(0, 0, 1),
      cloudCenterEnu: new THREE.Vector3(), zOffset: 0, areaMinZ: 0, navigationClearance: 0,
      navigationFloorZ: 0, navigationBoundsRadius: 1, canopyHeightM: 1,
      surveyBbox: bbox,
      surveyFootprintArea: (bbox[3] - bbox[0]) * (bbox[4] - bbox[1]),
    },
    uniforms: null, pointSource: null, activeSource: null, stream: null, stats: null, appliedHighPrecision: null,
  }
}

describe('world handoff', () => {
  it('chooses the declared neighbour whose footprint contains the ECEF camera', () => {
    const z4 = runtime('manu-z4', [-10, -10, 0, 10, 10, 1])
    const z5 = runtime('manu-z5', [20, 20, 0, 30, 30, 1])
    expect(handoffCandidate(z4, { 'manu-z4': z4, 'manu-z5': z5 }, new THREE.Vector3(25, 25, 0))).toBe('manu-z5')
    expect(handoffCandidate(z4, { 'manu-z4': z4, 'manu-z5': z5 }, new THREE.Vector3(15, 15, 0))).toBeNull()
  })

  it('requires continuous residency and resets when leaving the candidate', () => {
    const dwell = new HandoffDwell()
    expect(dwell.update('manu-z5', 0)).toBeNull()
    expect(dwell.update('manu-z5', 499)).toBeNull()
    expect(dwell.update(null, 500)).toBeNull()
    expect(dwell.update('manu-z5', 501)).toBeNull()
    expect(dwell.update('manu-z5', 1001)).toBe('manu-z5')
  })

  it('breaks overlaps by smallest footprint, then stable dataset ID', () => {
    const z4 = runtime('manu-z4', [-10, -10, 0, 10, 10, 1])
    const z5 = runtime('manu-z5', [-5, -5, 0, 5, 5, 1])
    z4.definition.overviewNeighbors = ['manu-z4', 'manu-z5']
    expect(handoffCandidate(z4, { 'manu-z4': z4, 'manu-z5': z5 }, new THREE.Vector3(0, 0, 0))).toBe('manu-z5')
    z5.frame!.surveyFootprintArea = z4.frame!.surveyFootprintArea
    expect(handoffCandidate(z4, { 'manu-z4': z4, 'manu-z5': z5 }, new THREE.Vector3(0, 0, 0))).toBe('manu-z4')
  })
})
