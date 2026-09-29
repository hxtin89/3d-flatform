export const EAGLE_MIN_ASSEMBLY_SECONDS = 3.2
export const EAGLE_FLIGHT_PROGRESS_SPAN = 0.15
export const EAGLE_FADE_FLIGHT_FRACTION = 1 / 3
/** Maps the former 25% visual state to 80% loader progress. */
export const EAGLE_ASSEMBLY_CURVE_EXPONENT = Math.log(0.25) / Math.log(0.8)
export const EAGLE_RANDOM_SEED = 0x57494c44
export const EAGLE_SPAWN_MIN_RADIUS = 1.65
export const EAGLE_SPAWN_MAX_RADIUS = 4.2

export type Point3 = readonly [number, number, number]

export interface PointFlightState {
  arrival: number
  start: number
  linear: number
  eased: number
  opacity: number
}

export function clampProgress(progress: number): number {
  return Math.min(1, Math.max(0, progress))
}

export function arrivalProgress(index: number, pointCount: number): number {
  return (index + 1) / pointCount
}

export function completedPointCount(progress: number, pointCount: number): number {
  return Math.floor(clampProgress(progress) * pointCount)
}

export function assemblyProgressForLoad(loadProgress: number): number {
  const progress = clampProgress(loadProgress)
  if (progress === 0 || progress === 1) return progress
  return progress ** EAGLE_ASSEMBLY_CURVE_EXPONENT
}

export function settledPointCountForLoad(loadProgress: number, pointCount: number): number {
  return completedPointCount(assemblyProgressForLoad(loadProgress), pointCount)
}

export function cubicEaseOut(progress: number): number {
  const clamped = clampProgress(progress)
  return 1 - (1 - clamped) ** 3
}

export function pointFlightState(
  index: number,
  pointCount: number,
  progress: number,
  span = EAGLE_FLIGHT_PROGRESS_SPAN,
): PointFlightState {
  const arrival = arrivalProgress(index, pointCount)
  const start = Math.max(0, arrival - span)
  const duration = Math.max(Number.EPSILON, arrival - start)
  const linear = clampProgress((clampProgress(progress) - start) / duration)
  const fade = clampProgress(linear / EAGLE_FADE_FLIGHT_FRACTION)
  const opacity = fade * fade * (3 - 2 * fade)
  return { arrival, start, linear, eased: cubicEaseOut(linear), opacity }
}

export function positionOnStraightFlight(
  spawn: Point3,
  target: Point3,
  easedProgress: number,
): Point3 {
  const progress = clampProgress(easedProgress)
  return [
    spawn[0] + (target[0] - spawn[0]) * progress,
    spawn[1] + (target[1] - spawn[1]) * progress,
    spawn[2] + (target[2] - spawn[2]) * progress,
  ]
}

export function spawnPointFromSamples(
  aspect: number,
  angleSample: number,
  radiusSample: number,
  depthSample: number,
): Point3 {
  const angle = clampProgress(angleSample) * Math.PI * 2
  const radius = EAGLE_SPAWN_MIN_RADIUS
    + (EAGLE_SPAWN_MAX_RADIUS - EAGLE_SPAWN_MIN_RADIUS) * Math.sqrt(clampProgress(radiusSample))
  return [
    Math.cos(angle) * aspect * radius,
    Math.sin(angle) * radius,
    (clampProgress(depthSample) - 0.5) * 2.4,
  ]
}

export function spawnEllipseRadius(point: Point3, aspect: number): number {
  return Math.hypot(point[0] / aspect, point[1])
}

/** Mulberry32: compact, fast and stable across browsers and renderer backends. */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

export function checksumFloat32Arrays(...arrays: Float32Array[]): string {
  let hash = 0x811c9dc5
  for (const array of arrays) {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength)
    for (const byte of bytes) {
      hash ^= byte
      hash = Math.imul(hash, 0x01000193)
    }
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** How many frame times each density bucket keeps: the last this many. */
export const BENCH_BUCKET_WINDOW = 240

/**
 * How long after full stress is reached before its frame times count towards the freeze.
 * Full stress coincides with the Start screen appearing, which plays two CSS animations on
 * top of the measurement: loader-rise (.55 s) and loader-pulse (2.6 s twice after .75 s,
 * so over at 5.95 s) — threejs-test.html. A visitor who waits longer than that is measured
 * today on frames without them, so the frozen verdict is taken from frames without them too.
 */
export const BENCH_QUIET_MS = 6000

export type BenchPresetName = 'strong' | 'medium' | 'constrained'

export interface BenchVerdictSettings {
  targetFps: number
  minSamples: number
  strongFraction: number
  strongMinPoints: number
  mediumFraction: number
}

export interface BenchVerdict {
  /** Highest sampled point count whose median frame rate held the target. */
  pointsAtTarget: number
  maxPoints: number
  samples: number
  preset: BenchPresetName | null
}

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[sorted.length >> 1]
}

/**
 * The benchmark's verdict from its frame-time buckets — bucket b holds frames sampled at
 * b/(buckets-1) of `maxPoints`. The highest bucket whose median frame held the target
 * (with a small tolerance) sets `pointsAtTarget`; its share of `maxPoints` picks the preset.
 */
export function benchVerdict(
  buckets: readonly (readonly number[])[],
  maxPoints: number,
  totalSamples: number,
  settings: BenchVerdictSettings,
): BenchVerdict {
  const densityBuckets = buckets.length - 1
  const targetDelta = 1000 / settings.targetFps * 1.06 // small tolerance around 60 fps
  let pointsAtTarget = 0
  for (let bucket = 0; bucket <= densityBuckets; bucket++) {
    const samples = buckets[bucket]
    if (samples.length < 8) continue
    const bucketPoints = (bucket / densityBuckets) * maxPoints
    if (medianOf(samples) <= targetDelta) pointsAtTarget = Math.max(pointsAtTarget, bucketPoints)
  }
  let preset: BenchPresetName | null = null
  if (totalSamples >= settings.minSamples) {
    const fraction = pointsAtTarget / maxPoints
    preset = fraction >= settings.strongFraction && pointsAtTarget >= settings.strongMinPoints
      ? 'strong'
      : fraction >= settings.mediumFraction ? 'medium' : 'constrained'
  }
  return { pointsAtTarget, maxPoints, samples: totalSamples, preset }
}

/**
 * Whether the verdict can no longer change: the full-stress bucket holds a whole window
 * of frames, every one of them taken after the Start screen's animations, and there are
 * enough samples overall for a preset. From here each new frame only slides that window
 * over more frames of the same steady state, so the verdict is taken now and kept — it is
 * the one a click at this moment gets today.
 */
export function benchVerdictSettled(
  quietFullSamples: number,
  totalSamples: number,
  minSamples: number,
  window = BENCH_BUCKET_WINDOW,
): boolean {
  return quietFullSamples >= window && totalSamples >= minSamples
}

export interface BenchStage {
  /** Stress points drawn in this stage. */
  points: number
  /** Median frame time of its kept frames, in ms; null while it has none. */
  medianMs: number | null
  samples: number
}

/**
 * One line per stage — the stress point count, the median frame and how many frames it
 * holds — for the log a calibration run reads. The verdict only asks which stages held
 * the target; re-tuning its bars needs the times themselves, per device.
 */
export function benchStageSummary(buckets: readonly (readonly number[])[], maxPoints: number): BenchStage[] {
  const densityBuckets = buckets.length - 1
  return buckets.map((samples, bucket) => ({
    points: Math.round((bucket / densityBuckets) * maxPoints),
    medianMs: samples.length ? medianOf(samples) : null,
    samples: samples.length,
  }))
}
