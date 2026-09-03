// Ease the mouse position the controls read, once per frame.
//
// EnvironmentControls turns (pointer now − pointer at the previous frame) into
// rotation or pan once per frame. A mouse reports whole device pixels at its
// own rate (125 Hz on most office mice); against a 120–160 Hz display most
// frames see no movement and the occasional one sees a whole pixel step — the
// one-pixel judder on right-drag orbit and left-drag pan. The keyboard, being
// time-integrated, never had it.
//
// Fix (after A. Beck's postmortem "The One-Pixel Judder"): the raw position
// becomes a target; the stored position walks toward it by a time-based
// fraction each frame. The library's own `previous = current` bookkeeping
// stays in place, so both sides of its subtraction remain eased values.
//
// Beyond the original patch:
//   • mouse only — touch pinch/rotate classification reads positions outside
//     update() and must stay raw;
//   • targets cleared on tracker.reset() too (pointerleave, disable), or the
//     next press eases toward a stale target and the view jumps;
//   • controls.needsUpdate is set while easing has work left, so an eventless
//     frame still advances — the library otherwise skips its update body;
//   • optionally (mouseInertia: false) a mouse release zeroes the library's
//     inertia. The library seeds it from the last frame's pointer delta / dt
//     with a 0.15 s half-life, which is the stock AMMOS fling (tens of degrees
//     mid-move) — with easing the seed is if anything smaller, so the default
//     keeps it. Touch always keeps its swipe momentum. The same switch covers
//     the cursor leaving the window mid-drag, where the library resets without
//     deletePointer;
//   • an immediate share of every raw delta is applied in the same frame so a
//     fast pull does not trail the cursor by tens of pixels; the rest eases.
//
// Bound to 3d-tiles-renderer 0.4.28 PointerTracker internals.
import * as THREE from 'three'

export interface PointerEasing {
  setResponseMs(ms: number): void
  responseMs(): number
  dispose(): void
}

/** Residual below which the eased position snaps onto the target, CSS px. */
const SNAP_PX = 0.05
export function installPointerEasing(
  controls: any,
  options: { responseMs: number; immediateShare?: number; mouseInertia?: boolean },
): PointerEasing {
  const tracker = controls.pointerTracker
  const targets = new Map<number, THREE.Vector2>()
  const immediateShare = THREE.MathUtils.clamp(options.immediateShare ?? 0, 0, 1)
  let responseMs = Math.max(0, options.responseMs)
  const mouseInertia = options.mouseInertia ?? true
  let mouseActive = false
  const _delta = new THREE.Vector2()

  const killInertia = () => {
    controls.rotationInertia?.set(0, 0)
    controls.dragInertia?.set(0, 0, 0)
    if ('globeInertiaFactor' in controls) controls.globeInertiaFactor = 0
  }
  let lastFrame = 0

  const original = {
    addPointer: tracker.addPointer.bind(tracker) as (e: PointerEvent) => void,
    updatePointer: tracker.updatePointer.bind(tracker) as (e: PointerEvent) => boolean,
    deletePointer: tracker.deletePointer.bind(tracker) as (e: PointerEvent) => void,
    updateFrame: tracker.updateFrame.bind(tracker) as () => void,
    reset: tracker.reset.bind(tracker) as () => void,
  }

  const isMouse = (e: PointerEvent) => e.pointerType === 'mouse'

  tracker.addPointer = (e: PointerEvent) => {
    original.addPointer(e)
    targets.delete(e.pointerId)
    if (isMouse(e)) mouseActive = true
  }

  tracker.updatePointer = (e: PointerEvent) => {
    if (responseMs <= 0 || !isMouse(e)) return original.updatePointer(e)
    const live: THREE.Vector2 | undefined = tracker.pointerPositions[e.pointerId]
    if (!live) return original.updatePointer(e)
    const eased = live.clone()
    const ok = original.updatePointer(e)
    if (!ok) return ok
    let target = targets.get(e.pointerId)
    if (!target) {
      target = new THREE.Vector2().copy(eased)
      targets.set(e.pointerId, target)
    }
    // Raw delta since the last report → part of it lands right away.
    _delta.subVectors(live, target).multiplyScalar(immediateShare)
    target.copy(live)
    live.copy(eased).add(_delta)
    return ok
  }

  tracker.deletePointer = (e: PointerEvent) => {
    const mouseRelease = isMouse(e) && !mouseInertia
    original.deletePointer(e)
    targets.delete(e.pointerId)
    if (tracker.getPointerCount() === 0) mouseActive = false
    // No fling for the mouse: the drag ends exactly where the button goes up.
    // With inertia on, the eased residual is simply dropped with the pointer.
    if (mouseRelease) killInertia()
  }

  tracker.reset = () => {
    const wasMouse = mouseActive && !mouseInertia
    original.reset()
    targets.clear()
    mouseActive = false
    if (wasMouse) killInertia()
  }

  tracker.updateFrame = () => {
    original.updateFrame()
    const now = performance.now()
    const elapsed = lastFrame ? Math.min(now - lastFrame, 100) : 0
    lastFrame = now
    if (responseMs <= 0 || elapsed <= 0 || targets.size === 0) return
    const alpha = 1 - Math.exp(-elapsed / responseMs)
    let pending = false
    for (const [id, target] of targets) {
      const live: THREE.Vector2 | undefined = tracker.pointerPositions[id]
      if (!live) continue
      if (live.distanceToSquared(target) <= SNAP_PX * SNAP_PX) {
        live.copy(target)
        continue
      }
      live.lerp(target, alpha)
      pending = true
    }
    if (pending) controls.needsUpdate = true
  }

  const flush = () => {
    for (const [id, target] of targets) tracker.pointerPositions[id]?.copy(target)
  }

  return {
    setResponseMs(ms) {
      responseMs = Math.max(0, ms)
      // Turning it down mid-drag must not leave a stale offset behind.
      if (responseMs <= 0) flush()
    },
    responseMs: () => responseMs,
    dispose() {
      flush()
      targets.clear()
      Object.assign(tracker, original)
    },
  }
}
