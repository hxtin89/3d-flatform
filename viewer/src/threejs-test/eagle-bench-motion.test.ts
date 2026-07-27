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
