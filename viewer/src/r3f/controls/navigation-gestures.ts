// Adapted from Ann-Katrin Krenz's sbb/pivot-on-canopy (da6129e).
// Gesture geometry is sampled once, held through tile loads and translated
// through rebases. The analytic ellipsoid path stays in WildGlobeControls.
import * as THREE from 'three'
import type { MouseOrbitPivot } from '../../threejs-test/smoothed-globe-controls'

export function stopNavigationInertia(controls: any): void {
  controls?.rotationInertia?.set(0, 0)
  controls?.dragInertia?.set(0, 0, 0)
  controls?.globeInertia?.identity()
  if (controls) controls.globeInertiaFactor = 0
}

export interface NavigationOptions {
  controls: any
  camera: THREE.PerspectiveCamera
  canvas: HTMLElement
  mode: MouseOrbitPivot
  worldToEnu(value: THREE.Vector3, target: THREE.Vector3): THREE.Vector3
  enuToWorld(value: THREE.Vector3, target: THREE.Vector3): THREE.Vector3
  up: THREE.Vector3
  floorZ(): number
  canopySpan(): number
  sampleCanopy(x: number, y: number, radius: number): number | null
}

export function createNavigationGestures(opts: NavigationOptions) {
  const { controls, camera, canvas } = opts
  const tracker = controls.pointerTracker
  const events = canvas.ownerDocument.defaultView!
  const ray = new THREE.Raycaster()
  const raw = new THREE.Vector2()
  const shift = new THREE.Vector2()
  const ndc = new THREE.Vector2()
  const heldPivot = new THREE.Vector3()
  const cameraEnu = new THREE.Vector3()
  const hitEnu = new THREE.Vector3()
  const direction = new THREE.Vector3()
  const samplePoint = new THREE.Vector3()
  const corrected = new THREE.Vector3()
  const before = camera.position.clone()
  const beforeQuaternion = camera.quaternion.clone()
  const panStart = new THREE.Vector3()
  let kind = 0
  let mouseHeld = false
  let panArmed = false
  let panBudget = 0
  let stepBudget = 0
  let zooming = false
  let oldAdjustHeight = controls.adjustHeight
  const debug = { reason: 'idle', clamps: 0, pivot: heldPivot, held: false, panBudgetM: 0, sampleMs: 0 }
  const count = () => tracker.getPointerCount()
  const originalSetState = controls.setState.bind(controls)
  const originalCenter = tracker.getCenterPoint.bind(tracker)
  const finiteCamera = () => Number.isFinite(camera.position.x + camera.position.y + camera.position.z)
    && Number.isFinite(camera.quaternion.x + camera.quaternion.y + camera.quaternion.z + camera.quaternion.w)
  tracker.getCenterPoint = (target: THREE.Vector2, positions?: any) => {
    const result = originalCenter(target, positions)
    if (result && controls.state === 1) target.sub(shift)
    return result
  }

  const scaledHeight = (factor: number, minimum: number) => {
    const height = opts.worldToEnu(camera.position, cameraEnu).z - opts.floorZ()
    return Math.max(minimum, Math.max(0, height) * factor)
  }
  const screenHit = (x: number, y: number, target: THREE.Vector3, fallback = false) => {
    ray.setFromCamera(ndc.set(x, y), camera)
    const hit = controls._raycast(ray)
    if (hit && Number.isFinite(hit.distance) && hit.distance > 0) { target.copy(hit.point); return true }
    if (fallback) target.copy(camera.position).addScaledVector(ray.ray.direction, scaledHeight(5, 400))
    return false
  }
  const rawNdc = () => ndc.set(raw.x / Math.max(1, canvas.clientWidth) * 2 - 1, 1 - raw.y / Math.max(1, canvas.clientHeight) * 2)

  function liftCanopy(): void {
    opts.worldToEnu(camera.position, cameraEnu)
    opts.worldToEnu(controls.pivotPoint, hitEnu)
    direction.subVectors(hitEnu, cameraEnu).normalize()
    if (!(direction.z <= -0.25)) { debug.reason = 'shallow ray: terrain pivot'; return }
    samplePoint.copy(hitEnu)
    for (let pass = 0; pass < 3; pass++) {
      let z: number | null = null
      for (const radius of [20, 60, 180]) {
        z = opts.sampleCanopy(samplePoint.x, samplePoint.y, radius)
        if (z !== null) break
      }
      if (z === null || !(z > hitEnu.z) || z - hitEnu.z > Math.max(1, opts.canopySpan()) * 2) {
        debug.reason = 'no supported canopy: terrain pivot'
        return
      }
      const distance = (z - cameraEnu.z) / direction.z
      if (!(distance > 0)) return
      const moved = Math.abs(distance - samplePoint.distanceTo(cameraEnu))
      samplePoint.copy(cameraEnu).addScaledVector(direction, distance)
      if (moved < 0.5) break
    }
    opts.enuToWorld(samplePoint, controls.pivotPoint)
    debug.reason = 'canopy pivot'
  }

  function reaimPan(force = false): boolean {
    direction.subVectors(controls.pivotPoint, camera.position).normalize()
    const descent = -direction.dot(opts.up)
    ray.setFromCamera(ndc.set(0, 0), camera)
    const threshold = Math.max(0.3, -ray.ray.direction.dot(opts.up))
    if (!force && !(descent < threshold)) return true
    const x = rawNdc().x
    if (!screenHit(x, 0, corrected)) return false
    controls.pivotPoint.copy(corrected)
    shift.set(0, raw.y - canvas.clientHeight * 0.5)
    debug.reason = 'shallow pan: same column at view centre'
    return true
  }

  function begin(state: number): void {
    if (!count() || (state !== 1 && state !== 2)) return
    if (kind) { controls.pivotPoint.copy(heldPivot); return }
    shift.set(0, 0)
    debug.reason = state === 1 ? 'pan' : 'terrain pivot'
    if (state === 1) {
      reaimPan()
      panStart.copy(camera.position)
      panBudget = scaledHeight(10, 250)
      debug.panBudgetM = panBudget
      panArmed = true
    } else {
      panArmed = false
      if (opts.mode === 'canopy') {
        const started = performance.now()
        liftCanopy()
        debug.sampleMs = performance.now() - started
      }
    }
    heldPivot.copy(controls.pivotPoint)
    kind = state
    debug.held = true
  }
  controls.setState = (state?: number, fireEvent?: boolean) => {
    // A left mouse press always pans, including shift-left.
    if (state === 2 && tracker.getPointerType() === 'mouse' && !tracker.isRightClicked()) state = 1
    originalSetState(state, fireEvent)
    begin(controls.state)
  }

  const pointerDown = (event: Event) => {
    const e = event as PointerEvent
    if (!controls.enabled) return
    if (!count()) { kind = 0; shift.set(0, 0); debug.held = false }
    const rect = canvas.getBoundingClientRect()
    raw.set(e.clientX - rect.left, e.clientY - rect.top)
    if (e.pointerType === 'mouse') {
      mouseHeld = true
      try { canvas.setPointerCapture(e.pointerId) } catch { /* synthetic press */ }
    }
  }
  const pointerUp = (event: Event) => {
    if ((event as PointerEvent).pointerType === 'mouse') mouseHeld = (event as PointerEvent).buttons !== 0
  }
  const pointerMove = (event: Event) => {
    const e = event as PointerEvent
    if (e.pointerType === 'mouse' && mouseHeld && !e.buttons) {
      mouseHeld = false
      controls.resetState()
    }
  }
  const blur = () => { mouseHeld = false; kind = 0; debug.held = false; controls.resetState(); stopNavigationInertia(controls) }
  const edgeLeave = (event: Event) => {
    if ((event as PointerEvent).pointerType === 'mouse' && mouseHeld) event.stopImmediatePropagation()
  }
  const listeners: Array<[EventTarget, string, EventListener, boolean]> = [
    [canvas, 'pointerdown', pointerDown, true],
    [events, 'pointerup', pointerUp, true],
    [events, 'pointercancel', blur, true],
    [events, 'pointermove', pointerMove, true],
    [events, 'pointerleave', edgeLeave, true],
    [events, 'blur', blur, false],
  ]
  for (const [target, type, fn, capture] of listeners) target.addEventListener(type, fn, capture)

  return {
    debug,
    beforeUpdate() {
      if (finiteCamera()) {
        before.copy(camera.position)
        beforeQuaternion.copy(camera.quaternion)
      } else {
        camera.position.copy(before)
        camera.quaternion.copy(beforeQuaternion)
        camera.updateMatrixWorld()
        stopNavigationInertia(controls)
      }
      zooming = !!controls.zoomDelta || controls.state === 3
      stepBudget = scaledHeight(2, 30)
      if (!count()) { kind = 0; shift.set(0, 0); debug.held = false }
      if (!kind && count() && controls.state === 0 && controls.enabled) {
        const press = rawNdc().clone()
        if (screenHit(press.x, press.y, corrected)) {
          const rotate = tracker.isRightClicked() || count() >= 2
          if (rotate) {
            screenHit(0, 0, controls.pivotPoint, true)
            originalSetState(2)
            controls._rotationMode = 1
            begin(2)
          } else if (reaimPan(true)) {
            const panShift = shift.clone()
            originalSetState(1)
            begin(1)
            shift.copy(panShift)
          }
        } else debug.reason = 'sky press ignored'
      }
      begin(controls.state)
      if (kind && count()) controls.pivotPoint.copy(heldPivot)
      oldAdjustHeight = controls.adjustHeight
      controls.adjustHeight = !count() && controls.state === 0
      if (count()) controls.actionHeightOffset = 0
    },
    afterUpdate() {
      controls.adjustHeight = oldAdjustHeight
      if (!finiteCamera()) {
        camera.position.copy(before)
        camera.quaternion.copy(beforeQuaternion)
        stopNavigationInertia(controls)
      }
      // Zoom is intentionally exempt; it has its own distance-proportional gain.
      const moving = !zooming && (kind === 1 || kind === 2 || controls._inertiaNeedsUpdate?.())
      const moved = camera.position.distanceTo(before)
      if (moving && moved > stepBudget) {
        camera.position.lerpVectors(before, camera.position, stepBudget / moved)
        stopNavigationInertia(controls)
        debug.clamps++
      }
      if (panArmed) {
        const coasting = controls.dragInertia.lengthSq() > 0 || controls.globeInertiaFactor !== 0
        if (controls.state !== 1 && !coasting) panArmed = false
        else {
          const distance = camera.position.distanceTo(panStart)
          if (distance > panBudget) {
            camera.position.lerpVectors(panStart, camera.position, panBudget / distance)
            stopNavigationInertia(controls)
            debug.clamps++
          }
        }
      }
      if (kind && count()) controls.pivotPoint.copy(heldPivot)
      camera.updateMatrixWorld()
    },
    rebase(delta: THREE.Vector3) { heldPivot.add(delta); panStart.add(delta); before.add(delta) },
    dispose() {
      for (const [target, type, fn, capture] of listeners) target.removeEventListener(type, fn, capture)
      controls.setState = originalSetState
      tracker.getCenterPoint = originalCenter
    },
  }
}
