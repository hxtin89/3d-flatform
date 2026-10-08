import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import {
  WORLD_DATASETS, HandoffDwell, allocateWorldMemoryBudget, configuredWorldDatasets,
  coverageDatasetIds, handoffCandidate,
} from './world-datasets.ts'
import type { WorldFootprint } from './world-datasets.ts'

test('six locations boot at Peru and dataset override stays single-site', () => {
  assert.equal(WORLD_DATASETS.length, 6)
  assert.equal(configuredWorldDatasets(null)[0].id, 'peru-b2')
  assert.deepEqual(configuredWorldDatasets('202606-manu-z4-globe').map((site) => site.logicalDataset),
    ['202606-manu-z4-globe'])
})

test('APH keeps Manu neighbours at overview, one-LOD keeps only the active site', () => {
  assert.deepEqual(coverageDatasetIds(WORLD_DATASETS, 'manu-z4', 'aph'),
    ['manu-z2', 'manu-z4', 'manu-z5'])
  assert.deepEqual(coverageDatasetIds(WORLD_DATASETS, 'manu-z4', 'one-lod'), ['manu-z4'])
})

test('Z2 to Z4 handoff waits until the camera leaves Z2, then dwells 500 ms', () => {
  const footprint = (id: WorldFootprint['id'], min: number, max: number,
    neighbours: WorldFootprint['overviewNeighbors']): WorldFootprint => ({
    id, status: 'ready', enuInverse: new THREE.Matrix4(),
    surveyBbox: [min, 0, 0, max, 10, 10], overviewNeighbors: neighbours,
  })
  const z2 = footprint('manu-z2', 0, 10, ['manu-z4'])
  const z4 = footprint('manu-z4', 8, 20, ['manu-z2'])
  const sites = { 'manu-z2': z2, 'manu-z4': z4 }
  assert.equal(handoffCandidate(z2, sites, new THREE.Vector3(9, 5, 0)), null)
  assert.equal(handoffCandidate(z2, sites, new THREE.Vector3(11, 5, 0)), 'manu-z4')
  const dwell = new HandoffDwell()
  assert.equal(dwell.update('manu-z4', 1000), null)
  assert.equal(dwell.update('manu-z4', 1499), null)
  assert.equal(dwell.update('manu-z4', 1500), 'manu-z4')
  assert.equal(handoffCandidate(z4, sites, new THREE.Vector3(11, 5, 0)), null)
})

test('active site gets 80 percent cache and GPU while neighbours share 20 percent', () => {
  const shares = allocateWorldMemoryBudget(
    { cacheBytes: 1000, gpuBytes: 500 }, ['manu-z2', 'manu-z4', 'manu-z5'], 'manu-z4',
  )
  assert.deepEqual(shares['manu-z4'], { cacheBytes: 800, gpuBytes: 400 })
  assert.equal(Object.values(shares).reduce((total, share) => total + share.cacheBytes, 0), 1000)
  assert.equal(Object.values(shares).reduce((total, share) => total + share.gpuBytes, 0), 500)
})
