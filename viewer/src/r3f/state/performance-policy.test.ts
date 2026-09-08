import { describe, expect, it } from 'vitest'
import { EXPERIENCE_CONFIG } from '../../threejs-test/config'
import { installDistanceLod } from '../../threejs-test/distance-lod'
import { createStreamingBudget } from '../../threejs-test/streaming-budget'
import { PerformanceGovernor } from './performance-policy'
import * as THREE from 'three'
import { TilesRenderer } from '3d-tiles-renderer'

describe('quality recovery', () => {
  function simulation() {
    const governor = new PerformanceGovernor(EXPERIENCE_CONFIG.perf)
    let now = 0
    return { governor, run(duration: number, frameMs: number, active = true, streaming = false) {
      const end = now + duration
      while (now < end) {
        now += frameMs
        governor.update({ now, frameMs, active, streaming })
      }
      return governor.state
    } }
  }
  for (const fps of [60, 120]) {
    it(`keeps and restores full quality at ${fps} Hz`, () => {
      const { run } = simulation()
      expect(run(15000, 1000 / fps)).toMatchObject({ scale: 1, sse: 1, effects: 0 })
      expect(run(35000, 1000 / 30).scale).toBeLessThan(1)
      expect(run(90000, 1000 / fps)).toMatchObject({ scale: 1, sse: 1, effects: 0 })
    })
  }
  it('spends effect quality before far detail, even while tiles stream', () => {
    const { run } = simulation()
    expect(run(4000, 40, true, true)).toMatchObject({ scale: 1, sse: 1, effects: 1 })
    expect(run(3500, 40, true, true)).toMatchObject({ scale: 1, sse: 1, effects: 2 })
    expect(run(3500, 40, true, true).sse).toBeGreaterThan(1)
  })
  it('does not interpret a shader/upload hitch or a hidden tab as sustained load', () => {
    const { run } = simulation()
    run(3000, 1000 / 60)
    run(300, 300)
    expect(run(7000, 1000 / 60)).toMatchObject({ scale: 1, sse: 1, effects: 0 })
    run(10000, 1000, false)
    expect(run(7000, 1000 / 60)).toMatchObject({ scale: 1, sse: 1, effects: 0 })
  })
  it('retains long frame measurements and resets previous pressure for a new source', () => {
    const { run, governor } = simulation()
    expect(run(15000, 250).sse).toBeGreaterThan(1)
    expect(governor.state.medianMs).toBe(250)
    governor.reset(20000)
    expect(governor.state).toMatchObject({ scale: 1, sse: 1, effects: 0 })
  })
})

describe('near detail', () => {
  function setup() {
    const tiles = { errorTarget: 16, calculateTileViewError(tile: any, out: any) { Object.assign(out, tile) } }
    const lod = installDistanceLod(tiles)
    lod.setCutoff(1500, 200)
    lod.setNearDetail({ rangeM: 250, sse: 4, farFactor: 4 })
    const sample = (distance: number, error = 16, inView = true) => {
      const out = { distanceFromCamera: 0, error: 0, inView: false }
      tiles.calculateTileViewError({ distanceFromCamera: distance, error, inView }, out)
      return out
    }
    return { sample, lod }
  }
  it('protects all bounds intersecting 250 m, including an ancestor containing the camera', () => {
    const { sample } = setup()
    for (const d of [0, 80, 186, 250]) expect(sample(d).error).toBe(64)
    expect(sample(251).error).toBeCloseTo(64, -1)
    expect(sample(500).error).toBeLessThan(16)
  })
  it('never changes additive leaf errors or resurrects out-of-frustum tiles', () => {
    const { sample } = setup()
    expect(sample(80, 0).error).toBe(0)
    expect(sample(80, 16, false)).toMatchObject({ error: 16, inView: false })
    expect(sample(1500)).toMatchObject({ error: 0, inView: false })
  })
  it('releases the protection for the separate boot/flight policy', () => {
    const { sample, lod } = setup()
    lod.setNearDetail(null)
    expect(sample(80).error).toBe(16)
  })
  it('uses the installed TilesRenderer distance contract, not a synthetic distance field', () => {
    const tiles = new TilesRenderer()
    const camera = new THREE.PerspectiveCamera()
    tiles.setCamera(camera)
    ;(tiles as any).cameraInfo = [{ isOrthographic: false, position: new THREE.Vector3(), sseDenominator: 1, frustum: new THREE.Frustum() }]
    tiles.errorTarget = 16
    const lod = installDistanceLod(tiles)
    lod.setCutoff(1500, 200)
    lod.setNearDetail({ rangeM: 250, sse: 4, farFactor: 4 })
    const measure = (distance: number) => {
      const out = {} as any
      tiles.calculateTileViewError({ geometricError: distance * 16, engineData: { boundingVolume: {
        distanceToPoint: () => distance, intersectsFrustum: () => true,
      } } } as any, out)
      return out
    }
    expect(measure(186)).toMatchObject({ inView: true, distanceFromCamera: 186, error: 64 })
    expect(measure(500).error).toBeLessThan(16)
    expect(measure(1500)).toMatchObject({ inView: false, error: 0 })
    lod.dispose(); tiles.dispose()
  })
})

describe('streaming admissions', () => {
  it('admits detail throughout a drag without draining both queues in one frame', () => {
    let processed = 0
    const makeQueue = () => ({ autoUpdate: true, maxJobs: 3, currJobs: 0, items: [1, 2, 3, 4],
      tryRunJobs() { for (let n = 0; n < this.maxJobs && this.items.length; n++) { this.items.pop(); processed++ } } })
    const queues = [makeQueue(), makeQueue()]
    const budget = createStreamingBudget(queues, () => 0)
    budget.pump(0, true, 16)
    expect(processed).toBe(1)
    budget.pump(16, true, 16)
    expect(processed).toBe(1)
    budget.pump(100, true, 16)
    expect(processed).toBe(2)
    budget.pump(200, true, 40)
    expect(processed).toBe(2)
    budget.pump(350, true, 40)
    expect(processed).toBe(3)
    expect(queues.every(q => !q.autoUpdate && q.maxJobs === 0)).toBe(true)
    budget.dispose()
    expect(queues.every(q => q.autoUpdate && q.maxJobs === 3)).toBe(true)
  })
})
