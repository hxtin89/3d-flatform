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
    expect(usk.surveyFootprintArea).toBe(20_000)
  })

  it('keeps ECEF camera, orientation, and control pivots stable across a frame handoff', async () => {
    vi.resetModules()
    vi.stubGlobal('location', { search: '', hostname: 'localhost' })
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    const { activateSurveyFrame, createSurveyFrame } = await import('./survey-frames')
    const { onRebase, renderToEcef } = await import('../../threejs-test/origin')
    const first = createSurveyFrame(manifest(new THREE.Matrix4().identity().toArray()))
    const second = createSurveyFrame(manifest(new THREE.Matrix4().makeTranslation(10_000, 20_000, 30_000).toArray()))
    activateSurveyFrame(first)

    const camera = new THREE.PerspectiveCamera()
    camera.position.set(30, -40, 50)
    camera.quaternion.setFromEuler(new THREE.Euler(0.2, -0.4, 0.1))
    const pivot = new THREE.Vector3(10, 20, 30)
    const zoomPoint = new THREE.Vector3(11, 21, 31)
    const orientation = camera.quaternion.clone()
    const cameraEcef = renderToEcef(camera.position)
    const pivotEcef = renderToEcef(pivot)
    const unsubscribe = onRebase((delta) => {
      camera.position.add(delta)
      pivot.add(delta)
      zoomPoint.add(delta)
    })

    activateSurveyFrame(second)
    unsubscribe()
    expect(renderToEcef(camera.position).distanceTo(cameraEcef)).toBeLessThan(1e-8)
    expect(renderToEcef(pivot).distanceTo(pivotEcef)).toBeLessThan(1e-8)
    expect(camera.quaternion.angleTo(orientation)).toBeLessThan(1e-7)
  })
})
