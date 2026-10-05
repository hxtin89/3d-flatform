/**
 * Whether the point-cloud traversal has to run this frame, or would only repeat the last one.
 *
 * On a still frame `tiles.update()` walks the whole tile tree again and arrives at the same
 * selection — 0.5 to 2.5 ms of main thread in the desktop test browser depending on the
 * view (the most while the landing view's point-of-view load is pricing its radius), and
 * several times that on a phone. The traversal reads only what `StillFrameInputs` holds, so
 * when none of it has moved since the traversal last ran, and nothing is loading, it can be
 * skipped. Anything
 * that changes the selection some other way calls `invalidate()`, and a heartbeat reruns it
 * every `heartbeatMs` regardless, so an input missed here is at worst that late.
 *
 * Inputs are compared with the traversal that last ran, not the previous frame, so slow
 * drift adds up and triggers a run once it passes a tolerance. The tolerances are far below
 * anything the selection can see: the camera controls re-decompose the camera matrix every
 * frame after a wheel zoom, which moves it by float noise, and an exact test would never
 * let the gate close there.
 */
export interface StillFrameInputs {
  /** The camera's pose in the tiles' frame: tiles.group.matrixWorld⁻¹ × camera.matrixWorld. */
  view: ArrayLike<number>
  projection: ArrayLike<number>
  errorTarget: number
  /** Every sphere the traversal reads (mask, point-of-view eye), as x, y, z, radius each. */
  spheres: ArrayLike<number>
  /** Everything discrete, as one key: modes switching on or off change the selection. */
  mode: string
}

export interface StillFrameTolerances {
  heartbeatMs: number
  /** Rotation terms of the camera pose, unitless. */
  rotation: number
  /** The camera position, and sphere centres and radii, in metres. */
  metres: number
  /** Projection terms, relative. */
  projection: number
}

export const STILL_FRAME_TOLERANCES: StillFrameTolerances = {
  heartbeatMs: 500,
  // A 1e-6 rad turn moves the farthest tiles, 460 m off, by half a millimetre.
  rotation: 1e-6,
  metres: 1e-3,
  projection: 1e-9,
}

export type StillFrameReason = 'first' | 'bypass' | 'busy' | 'invalidated' | 'moved' | 'heartbeat'

export interface StillFrameGate {
  /** Run the traversal on the next frame whatever the inputs say. */
  invalidate(): void
  /** True when the traversal has to run: the inputs moved, it was invalidated, tiles are
   *  loading (`busy`), the gate is bypassed, or the heartbeat is due. */
  decide(inputs: StillFrameInputs, now: number, busy: boolean, bypass: boolean): boolean
  stats(): { frames: number; runs: number; skipped: number; byReason: Record<StillFrameReason, number> }
}

export function createStillFrameGate(tolerances: StillFrameTolerances = STILL_FRAME_TOLERANCES): StillFrameGate {
  const last = {
    view: new Float64Array(16),
    projection: new Float64Array(16),
    errorTarget: NaN,
    spheres: new Float64Array(0),
    mode: '',
  }
  let hasRun = false
  let dirty = false
  let wasBypassed = false
  let lastRunAt = -Infinity
  let frames = 0
  let runs = 0
  const byReason: Record<StillFrameReason, number> = {
    first: 0, bypass: 0, busy: 0, invalidated: 0, moved: 0, heartbeat: 0,
  }

  function moved(inputs: StillFrameInputs): boolean {
    if (inputs.errorTarget !== last.errorTarget || inputs.mode !== last.mode) return true
    if (inputs.spheres.length !== last.spheres.length) return true
    for (let i = 0; i < inputs.spheres.length; i++) {
      if (Math.abs(inputs.spheres[i] - last.spheres[i]) > tolerances.metres) return true
    }
    for (let i = 0; i < 16; i++) {
      const delta = Math.abs(inputs.view[i] - last.view[i])
      // Column-major: 12-14 are the translation, the rest rotation and the fixed row.
      if (delta > (i >= 12 && i <= 14 ? tolerances.metres : tolerances.rotation)) return true
    }
    for (let i = 0; i < 16; i++) {
      const reference = Math.max(Math.abs(last.projection[i]), 1)
      if (Math.abs(inputs.projection[i] - last.projection[i]) > tolerances.projection * reference) return true
    }
    return false
  }

  function record(inputs: StillFrameInputs, now: number, reason: StillFrameReason): true {
    for (let i = 0; i < 16; i++) {
      last.view[i] = inputs.view[i]
      last.projection[i] = inputs.projection[i]
    }
    last.errorTarget = inputs.errorTarget
    if (last.spheres.length !== inputs.spheres.length) last.spheres = new Float64Array(inputs.spheres.length)
    for (let i = 0; i < inputs.spheres.length; i++) last.spheres[i] = inputs.spheres[i]
    last.mode = inputs.mode
    hasRun = true
    dirty = false
    lastRunAt = now
    runs++
    byReason[reason]++
    return true
  }

  return {
    invalidate() { dirty = true },
    decide(inputs, now, busy, bypass) {
      frames++
      // Leaving a bypass counts as a change: whatever the bypassed tool did to the
      // selection has to be undone by one more run.
      const leftBypass = wasBypassed && !bypass
      wasBypassed = bypass
      if (bypass) return record(inputs, now, 'bypass')
      if (!hasRun) return record(inputs, now, 'first')
      if (busy) return record(inputs, now, 'busy')
      if (dirty || leftBypass) return record(inputs, now, 'invalidated')
      if (moved(inputs)) return record(inputs, now, 'moved')
      if (now - lastRunAt >= tolerances.heartbeatMs) return record(inputs, now, 'heartbeat')
      return false
    },
    stats() {
      return { frames, runs, skipped: frames - runs, byReason: { ...byReason } }
    },
  }
}
