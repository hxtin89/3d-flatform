import { afterEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import type { GlobeManifest } from '../../threejs-test/manifest'

vi.mock('../../threejs-test/donation-shape-data', () => ({
  assetUrl: (path: string) => path,
  fetchDonationShape: vi.fn().mockResolvedValue(null),
}))

afterEach(() => vi.unstubAllGlobals())

function manifest(transform: number[]): GlobeManifest {
  return {
    rootTransform: transform,
    enuOriginLonLat: [0, 0, 0],
    oneLodTreeDataset: '', oneLodTreeTilesetFile: 'tileset-one-lod-tree.json',
    adaptiveHierarchyDataset: '', adaptiveHierarchyTilesetFile: 'tileset.json',
    areaBbox: [0, 0, 10, 100, 200, 80], surveyBbox: [0, 0, 10, 100, 200, 80],
    areaVerticalSpan: 70, globalDatasets: {}, areas: [],
  }
}

describe('survey frames', () => {
  it('keeps ENU transforms independent for each dataset', async () => {
    vi.resetModules()
    vi.stubGlobal('location', { search: '', hostname: 'localhost' })
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    const { createSurveyFrame } = await import('./survey-frames')
    const peru = createSurveyFrame(manifest(new THREE.Matrix4().identity().toArray()))
    const uskMatrix = new THREE.Matrix4().makeTranslation(1000, 2000, 3000)
    const usk = createSurveyFrame(manifest(uskMatrix.toArray()))
    expect(peru.cloudCenterEnu).not.toBe(usk.cloudCenterEnu)
    expect(new THREE.Vector3(0, 0, 0).applyMatrix4(usk.enuFrame)).toEqual(new THREE.Vector3(1000, 2000, 3000))
    expect(new THREE.Vector3(1000, 2000, 3000).applyMatrix4(usk.enuInverse)).toEqual(new THREE.Vector3(0, 0, 0))
  })
})
