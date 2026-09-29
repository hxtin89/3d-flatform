import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EAGLE_FADE_FLIGHT_FRACTION,
  EAGLE_RANDOM_SEED,
  EAGLE_SPAWN_MIN_RADIUS,
  assemblyProgressForLoad,
  checksumFloat32Arrays,
  completedPointCount,
  createSeededRandom,
  pointFlightState,
  positionOnStraightFlight,
  spawnEllipseRadius,
  spawnPointFromSamples,
  settledPointCountForLoad,
  BENCH_BUCKET_WINDOW,
  BENCH_QUIET_MS,
  benchVerdict,
  benchVerdictSettled,
  benchStageSummary,
} from './eagle-bench-motion.ts'

const checkpoints = [0, 0.25, 0.5, 0.75, 1]

test('settled point counts match assembly progress exactly', () => {
  assert.deepEqual(checkpoints.map((progress) => completedPointCount(progress, 60_000)), [0, 15_000, 30_000, 45_000, 60_000])
  assert.deepEqual(checkpoints.map((progress) => completedPointCount(progress, 36_000)), [0, 9_000, 18_000, 27_000, 36_000])
})

test('late assembly maps the former 25% visual state to 80% load', () => {
  assert.ok(Math.abs(assemblyProgressForLoad(0.8) - 0.25) < 1e-12)
  assert.deepEqual(
    [0, 0.25, 0.5, 0.75, 0.8, 0.9, 1].map((progress) => settledPointCountForLoad(progress, 60_000)),
    [0, 10, 809, 10_045, 15_000, 31_180, 60_000],
  )
  assert.equal(settledPointCountForLoad(0.8, 36_000), 9_000)
})

test('points fade early and follow one straight cubic-eased segment', () => {
  const state = pointFlightState(41_999, 60_000, 0.625)
  assert.ok(state.linear > 0 && state.linear < 1)
  assert.ok(state.eased > state.linear)
  assert.equal(pointFlightState(41_999, 60_000, state.start).opacity, 0)
  assert.equal(pointFlightState(41_999, 60_000, state.start + (state.arrival - state.start) * EAGLE_FADE_FLIGHT_FRACTION).opacity, 1)

  const spawn = [-7, 3, 1] as const
  const target = [2, -1, -0.5] as const
  const position = positionOnStraightFlight(spawn, target, state.eased)
  for (let axis = 0; axis < 3; axis++) {
    const ratio = (position[axis] - spawn[axis]) / (target[axis] - spawn[axis])
    assert.ok(Math.abs(ratio - state.eased) < 1e-12)
  }
})

test('every generated spawn lies outside the full eagle bounding box', () => {
  const random = createSeededRandom(EAGLE_RANDOM_SEED)
  const aspect = 82 / 49
  for (let index = 0; index < 10_000; index++) {
    const point = spawnPointFromSamples(aspect, random(), random(), random())
    assert.ok(spawnEllipseRadius(point, aspect) >= EAGLE_SPAWN_MIN_RADIUS - 1e-12)
    assert.ok(Math.abs(point[0] / aspect) > 1 || Math.abs(point[1]) > 1)
  }
})

test('seeded buffers retain the same checksum across runs', () => {
  const makeBuffer = (seed: number) => {
    const random = createSeededRandom(seed)
    return Float32Array.from({ length: 4_096 }, () => random())
  }
  const first = checksumFloat32Arrays(makeBuffer(EAGLE_RANDOM_SEED))
  const second = checksumFloat32Arrays(makeBuffer(EAGLE_RANDOM_SEED))
  const different = checksumFloat32Arrays(makeBuffer(EAGLE_RANDOM_SEED + 1))
  assert.equal(first, second)
  assert.notEqual(first, different)
})

const SETTINGS = { targetFps: 60, minSamples: 60, strongFraction: 0.95, strongMinPoints: 2_400_000, mediumFraction: 0.5 }
const bucketsWith = (ms: (bucket: number) => number | null, count = 20) =>
  Array.from({ length: 13 }, (_, bucket) => {
    const value = ms(bucket)
    return value === null ? [] : Array.from({ length: count }, () => value)
  })

test('the verdict picks the preset from the highest bucket that held the target', () => {
  // Every bucket at 16 ms: full density holds, and 2.5M clears the strong gate.
  assert.equal(benchVerdict(bucketsWith(() => 16), 2_500_000, 260, SETTINGS).preset, 'strong')
  // Full density at 20 ms, bucket 11 at 16: 11/12 is under 0.95, so medium.
  assert.equal(benchVerdict(bucketsWith((b) => (b === 12 ? 20 : 16)), 2_500_000, 260, SETTINGS).preset, 'medium')
  // Only buckets up to 5 hold: 5/12 is under 0.5, so constrained.
  assert.equal(benchVerdict(bucketsWith((b) => (b <= 5 ? 16 : 25)), 2_500_000, 260, SETTINGS).preset, 'constrained')
  // A phone's 900k can never be strong, however fast.
  assert.equal(benchVerdict(bucketsWith(() => 10), 900_000, 260, SETTINGS).preset, 'medium')
  // Too few samples overall: no preset at all, and the caller falls back.
  assert.equal(benchVerdict(bucketsWith(() => 16), 2_500_000, 59, SETTINGS).preset, null)
  // A bucket with fewer than 8 frames does not count.
  assert.equal(benchVerdict(bucketsWith((b) => (b === 12 ? 16 : 30), 7), 2_500_000, 260, SETTINGS).pointsAtTarget, 0)
  // 17.67 ms is the tolerance: 17.6 holds, 17.7 does not.
  assert.equal(benchVerdict(bucketsWith(() => 17.6), 2_500_000, 260, SETTINGS).preset, 'strong')
  assert.equal(benchVerdict(bucketsWith(() => 17.7), 2_500_000, 260, SETTINGS).preset, 'constrained')
})

test('the verdict settles once the full bucket holds a whole quiet window', () => {
  assert.equal(benchVerdictSettled(BENCH_BUCKET_WINDOW - 1, 1000, 60), false)
  assert.equal(benchVerdictSettled(BENCH_BUCKET_WINDOW, 1000, 60), true)
  assert.equal(benchVerdictSettled(BENCH_BUCKET_WINDOW, 59, 60), false)
  // Past the Start screen's CSS animations (loader-pulse ends at 5.95 s).
  assert.ok(BENCH_QUIET_MS >= 5950)
})

test('the stage summary reports each stage: its points, median frame and sample count', () => {
  const buckets = Array.from({ length: 13 }, (_, b) => (b === 0 ? [] : b === 12 ? [20, 14, 16] : [15, 17]))
  const stages = benchStageSummary(buckets, 2_400_000)
  assert.equal(stages.length, 13)
  assert.deepEqual(stages[0], { points: 0, medianMs: null, samples: 0 })
  assert.deepEqual(stages[6], { points: 1_200_000, medianMs: 17, samples: 2 })
  // The same median the verdict reads: the upper middle of the sorted frames.
  assert.deepEqual(stages[12], { points: 2_400_000, medianMs: 16, samples: 3 })
})
