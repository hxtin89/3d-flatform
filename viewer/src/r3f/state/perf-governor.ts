// Frame-rate governor. One stellgröße: how far the point cloud is drawn.
//
// The distance-lod taper already reduces density with distance, but it cannot
// know how expensive the current view is — a flat horizon view at 90 m draws a
// wedge several kilometres long, the same view pointed down draws a disc. So
// the cutoff (and with it the fog that hides its edge) is closed in until the
// frame budget is met, and opened again when there is headroom.
//
// The budget is relative to the measured refresh period (p10 of recent frame
// times), so 120 Hz and 60 Hz displays get the same treatment without knowing
// which one is attached.
import { EXPERIENCE_CONFIG } from '../../threejs-test/config'
import { frame } from './frame'

/** Tile uploads and their pipeline builds show up as isolated long frames.
 * They are transients, not overload, so the stutter share only counts while
 * the streamer is idle — otherwise the governor throttles the very loading it
 * caused and never settles. */
function streamingIdle(): boolean {
  return (frame.lastStreamStats?.progress ?? 1) >= 0.999
}

const cfg = EXPERIENCE_CONFIG.perf
const samples: number[] = []
/** Continuous internal state; the published values are quantised. */
let rawScale = 1
let rawSse = 1
let scale = 1
let sseFactor = 1
let lastChangeAt = 0
let lastSampleAt = 0
let warmUntil = 0
let refreshMs = 16.7
let budgetMs = 19.2
let lastMedian = 0
let lastStutter = 0

/** Restart the measurement — after a streamer rebuild or a camera jump the
 * first frames carry GPU uploads that say nothing about the steady state. */
export function resetPerfGovernor(): void {
  samples.length = 0
  lastSampleAt = 0
  lastChangeAt = 0
  warmUntil = frame.now + cfg.warmupMs
}

export function perfScale(): number {
  return scale
}

/** Second stage: multiplier on the streamer's error target (1 = untouched). */
export function perfSseFactor(): number {
  return sseFactor
}

export function perfDebug(): { scale: number; sse: number; refreshMs: number; budgetMs: number; medianMs: number; stutterShare: number } {
  return { scale, sse: sseFactor, refreshMs, budgetMs, medianMs: lastMedian, stutterShare: lastStutter }
}

/** Quantise: a moving target would re-select tiles every frame. */
function publish(): void {
  const steppedScale = Math.min(cfg.scaleMax, Math.max(cfg.scaleMin, Math.round(rawScale / cfg.scaleStep) * cfg.scaleStep))
  let steppedSse = cfg.sseSteps[0]
  for (const step of cfg.sseSteps) if (rawSse >= step - 1e-6) steppedSse = step
  if (steppedScale === scale && steppedSse === sseFactor) return
  if (frame.now - lastChangeAt < cfg.minChangeIntervalMs) return
  lastChangeAt = frame.now
  scale = steppedScale
  sseFactor = steppedSse
}

/** Call once per frame with the wall-clock delta. Returns the cutoff scale. */
export function updatePerfGovernor(dtMs: number): number {
  if (!cfg.enabled) return 1
  if (dtMs > 0 && dtMs < 200) samples.push(dtMs)
  while (samples.length > cfg.sampleWindow) samples.shift()
  if (samples.length < 20 || frame.now < warmUntil) return scale
  // Sample the decision at most ~8×/s: the cutoff is lerped anyway and a
  // per-frame decision would chase single hitches.
  if (frame.now - lastSampleAt < 125) return scale
  const elapsed = lastSampleAt ? Math.min(1, (frame.now - lastSampleAt) / 1000) : 0.125
  lastSampleAt = frame.now

  const sorted = samples.slice().sort((a, b) => a - b)
  // p10 is the display's own pace: with vsync the fastest frames sit exactly
  // on the refresh period, so it is the floor the budget cannot go below.
  refreshMs = sorted[Math.floor(sorted.length * 0.1)]
  const median = sorted[Math.floor(sorted.length * 0.5)]
  const stutterShare = sorted.filter((value) => value > cfg.stutterMs).length / sorted.length
  budgetMs = Math.max(1000 / cfg.targetFps, refreshMs * cfg.budgetFactor)
  lastMedian = median
  lastStutter = stutterShare

  const stuttering = streamingIdle() && stutterShare > cfg.stutterShareTighten
  if (median > budgetMs || stuttering) {
    // How badly over budget: a 2× overrun closes in twice as fast.
    const overrun = Math.min(3, Math.max(median / budgetMs, stuttering ? 1 + stutterShare * 4 : 1) - 1)
    const step = cfg.tightenPerSecond * elapsed * (0.4 + overrun)
    if (rawScale > cfg.scaleMin) rawScale = Math.max(cfg.scaleMin, rawScale - step)
    else rawSse = Math.min(cfg.sseFactorMax, rawSse + cfg.ssePerSecond * elapsed * (0.4 + overrun))
  } else if (median < budgetMs * cfg.relaxFactor && (!streamingIdle() ? true : stutterShare < cfg.stutterShareRelax)) {
    // Give the density back before the view distance: coarse points close by
    // are more visible than a slightly nearer horizon.
    if (rawSse > 1) rawSse = Math.max(1, rawSse - cfg.ssePerSecond * elapsed * 0.5)
    else rawScale = Math.min(cfg.scaleMax, rawScale + cfg.relaxPerSecond * elapsed)
  }
  publish()
  return scale
}
