import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { createNavigationGestures } from './navigation-gestures'

function setup() {
  const camera = new THREE.PerspectiveCamera(60, 1, 1, 10000)
  camera.up.set(0, 0, 1)
  camera.position.set(0, -100, 100)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld()
  const events = new EventTarget()
  const canvas = Object.assign(new EventTarget(), {
    ownerDocument: { defaultView: events }, clientWidth: 1000, clientHeight: 1000,
    getBoundingClientRect: () => ({ left: 0, top: 0 }), setPointerCapture() {},
  }) as unknown as HTMLElement
  let pointers = 1
  let right = true
  let samples = 0
  const tracker = {
    getPointerCount: () => pointers, getPointerType: () => 'mouse', isRightClicked: () => right,
    getCenterPoint(target: THREE.Vector2) { return target.set(500, 500) },
  }
  const controls = {
    enabled: true, state: 0, pointerTracker: tracker, pivotPoint: new THREE.Vector3(),
    adjustHeight: true, actionHeightOffset: 0, zoomDelta: 0, _rotationMode: 0,
    rotationInertia: new THREE.Vector2(), dragInertia: new THREE.Vector3(),
    globeInertia: new THREE.Quaternion(), globeInertiaFactor: 0,
    _inertiaNeedsUpdate: () => false,
    _raycast: (_ray: THREE.Raycaster): { point: THREE.Vector3; distance: number } | null => ({ point: new THREE.Vector3(), distance: 140 }),
    setState(state = 0) { this.state = state },
    resetState() { this.state = 0; pointers = 0 },
  }
  const nav = createNavigationGestures({
    controls, camera, canvas, mode: 'canopy', up: camera.up,
    worldToEnu: (p, t) => t.copy(p), enuToWorld: (p, t) => t.copy(p),
    floorZ: () => 0, canopySpan: () => 74,
    sampleCanopy: () => { samples++; return 60 },
  })
  return { camera, controls, nav, events, samples: () => samples, left: () => { right = false } }
}

describe('Anni canopy gestures', () => {
  it('lifts along the press ray and holds that pivot through loads and state changes', () => {
    const { controls, nav, samples } = setup()
    controls.setState(2)
    expect(controls.pivotPoint.toArray()).toEqual([0, -60, 60])
    const initialSamples = samples()
    for (let i = 0; i < 10; i++) {
      controls.pivotPoint.set(999, 999, 999)
      nav.beforeUpdate()
      nav.afterUpdate()
      expect(controls.pivotPoint.toArray()).toEqual([0, -60, 60])
    }
    controls.setState(1)
    expect(controls.pivotPoint.toArray()).toEqual([0, -60, 60])
    expect(samples()).toBe(initialSamples)
    nav.dispose()
  })
  it('translates held pivots through a floating-origin rebase', () => {
    const { controls, nav, camera } = setup()
    controls.setState(2)
    const delta = new THREE.Vector3(3000, -4000, 1000)
    nav.rebase(delta)
    camera.position.add(delta)
    controls.pivotPoint.add(delta)
    nav.beforeUpdate()
    nav.afterUpdate()
    expect(controls.pivotPoint.toArray()).toEqual([3000, -4060, 1060])
    nav.dispose()
  })
  it('keeps left-drag a pan, without sampling or lifting the canopy', () => {
    const { controls, nav, samples, left } = setup()
    left()
    controls.setState(2) // library's shift-left interpretation
    expect(controls.state).toBe(1)
    expect(samples()).toBe(0)
    expect(controls.pivotPoint.z).toBe(0)
    nav.dispose()
  })
  it('ignores a sky press and clears a lost gesture on blur', () => {
    const { controls, nav, events } = setup()
    controls._raycast = () => null
    nav.beforeUpdate()
    expect(controls.state).toBe(0)
    expect(nav.debug.reason).toBe('sky press ignored')
    controls.setState(2)
    controls.rotationInertia.set(1, 1)
    events.dispatchEvent(new Event('blur'))
    expect(controls.state).toBe(0)
    expect(controls.rotationInertia.length()).toBe(0)
    nav.dispose()
  })
  it('bounds a runaway step and recovers a non-finite camera', () => {
    const { controls, nav, camera } = setup()
    controls.setState(2)
    const start = camera.position.clone()
    nav.beforeUpdate()
    camera.position.x += 2000
    nav.afterUpdate()
    expect(camera.position.distanceTo(start)).toBeLessThanOrEqual(200.00001)
    nav.beforeUpdate()
    const safe = camera.position.clone()
    camera.position.x = NaN
    nav.afterUpdate()
    expect(camera.position.toArray()).toEqual(safe.toArray())
    camera.quaternion.x = NaN
    nav.beforeUpdate()
    nav.afterUpdate()
    expect(camera.quaternion.toArray().every(Number.isFinite)).toBe(true)
    nav.dispose()
  })

  it('retains the pan budget through coasting and exempts wheel zoom from the step limit', () => {
    const { controls, nav, camera, left, events } = setup()
    left(); controls.setState(1)
    const start = camera.position.clone()
    // Each individual step is below the frame bound; their sum exceeds 10×height.
    for (let i = 0; i < 14; i++) {
      nav.beforeUpdate(); camera.position.x += 100; nav.afterUpdate()
    }
    expect(camera.position.distanceTo(start)).toBeCloseTo(1000)
    controls.state = 0; controls.dragInertia.set(10, 0, 0)
    nav.beforeUpdate(); camera.position.x += 100; nav.afterUpdate()
    expect(camera.position.distanceTo(start)).toBeCloseTo(1000)
    events.dispatchEvent(new Event('blur'))
    controls.zoomDelta = 1
    nav.beforeUpdate(); camera.position.x += 500; controls.zoomDelta = 0; nav.afterUpdate()
    expect(camera.position.distanceTo(start)).toBeCloseTo(1500)
    nav.dispose()
  })
})
