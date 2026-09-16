import assert from 'node:assert/strict'
import test from 'node:test'
import {
  dropoutPressure,
  easePressure,
  selectedPoints,
  solvePressure,
  type BudgetSample,
} from './point-budget.ts'

const TARGET = 4

/** Four decisions of 1M points each, from the closest (error 64) to the horizon (5). */
const evenlyWeighted: BudgetSample[] = [
  { error: 64, weight: 1, points: 1_000_000 },
  { error: 32, weight: 1, points: 1_000_000 },
  { error: 16, weight: 1, points: 1_000_000 },
  { error: 5, weight: 1, points: 1_000_000 },
]

test('a decision leaves at the pressure that lifts its tile to the target', () => {
  // error 8 against target 4 is one doubling of slack, so a full-weight tile leaves at 1.
  assert.equal(dropoutPressure({ error: 8, weight: 1, points: 1 }, TARGET), 1)
  // A quarter share needs four times the pressure to cover the same distance.
  assert.equal(dropoutPressure({ error: 8, weight: 0.25, points: 1 }, TARGET), 4)
  // A protected tile never moves: in if it is already in, out if it is already out.
  assert.equal(dropoutPressure({ error: 8, weight: 0, points: 1 }, TARGET), Infinity)
  assert.equal(dropoutPressure({ error: 2, weight: 0, points: 1 }, TARGET), -Infinity)
})

test('the selection only ever shrinks as the pressure rises', () => {
  let previous = Infinity
  for (const pressure of [0, 0.25, 1, 3, 7, 15, 64]) {
    const points = selectedPoints(evenlyWeighted, TARGET, pressure)
    assert.ok(points <= previous, `${points} > ${previous} at pressure ${pressure}`)
    previous = points
  }
  assert.equal(selectedPoints(evenlyWeighted, TARGET, 0), 4_000_000)
  assert.equal(selectedPoints(evenlyWeighted, TARGET, 64), 0)
})

test('the solved pressure is the least one that fits, and one step finer does not', () => {
  const solution = solvePressure(evenlyWeighted, { errorTarget: TARGET, budget: 2_500_000 })
  assert.ok(solution.reachable)
  assert.ok(selectedPoints(evenlyWeighted, TARGET, solution.pressure) <= 2_500_000)
  assert.ok(selectedPoints(evenlyWeighted, TARGET, solution.pressure - 1e-6) > 2_500_000)
})

test('a frame already under budget is left alone', () => {
  const solution = solvePressure(evenlyWeighted, { errorTarget: TARGET, budget: 9_000_000 })
  assert.equal(solution.pressure, 0)
  assert.equal(solution.points, 4_000_000)
  assert.ok(solution.reachable)
})

test('far-first spends the far field before the near field', () => {
  // Same error, so nothing but the distance ramp separates them: the far tile carries a
  // full share and the near one a quarter, exactly as weightFor hands them out.
  const near: BudgetSample = { error: 16, weight: 0.25, points: 1_000_000 }
  const far: BudgetSample = { error: 16, weight: 1, points: 1_000_000 }
  const solution = solvePressure([near, far], { errorTarget: TARGET, budget: 1_000_000 })
  assert.ok(dropoutPressure(far, TARGET) < dropoutPressure(near, TARGET))
  assert.equal(selectedPoints([near, far], TARGET, solution.pressure), 1_000_000)
  // The survivor is the near one.
  assert.ok(dropoutPressure(near, TARGET) > solution.pressure)
})

test('points no multiplier can remove are reported rather than chased', () => {
  const solution = solvePressure(evenlyWeighted, {
    errorTarget: TARGET,
    budget: 500_000,
    fixedPoints: 2_000_000,
    maxPressure: 64,
  })
  assert.equal(solution.reachable, false)
  assert.equal(solution.pressure, 64)
  assert.equal(solution.points, 2_000_000)
})

test('fill reaches past the target for detail the traversal did not offer', () => {
  // A candidate below the target: the traversal stopped before it, so it is out at
  // pressure 0 and only arrives at a negative one — which is what `fill` may reach for.
  const affordable: BudgetSample = { error: 2, weight: 1, points: 1_500_000 }
  const samples = [...evenlyWeighted, affordable]
  assert.equal(selectedPoints(samples, TARGET, 0), 4_000_000)

  const capped = solvePressure(samples, { errorTarget: TARGET, budget: 6_000_000 })
  assert.equal(capped.pressure, 0, 'ceiling never goes below zero pressure')
  assert.equal(capped.points, 4_000_000, 'and so leaves the headroom unspent')

  const filled = solvePressure(samples, {
    errorTarget: TARGET, budget: 6_000_000, minPressure: -0.8,
  })
  assert.equal(filled.pressure, -0.8, 'the whole reach is available when it fits')
  assert.equal(filled.points, 5_500_000)
})

test('fill stops at the step it cannot afford rather than overshooting', () => {
  // The same candidate, now too expensive: 4M + 3M is over the cap, so the answer is the
  // exact pressure at which it drops back out — the least pressure whose set still fits.
  const tooDear: BudgetSample = { error: 2, weight: 1, points: 3_000_000 }
  const samples = [...evenlyWeighted, tooDear]
  const filled = solvePressure(samples, {
    errorTarget: TARGET, budget: 6_000_000, minPressure: -0.8,
  })
  assert.equal(filled.pressure, dropoutPressure(tooDear, TARGET))
  assert.equal(filled.points, 4_000_000)
  assert.ok(selectedPoints(samples, TARGET, filled.pressure - 1e-6) > 6_000_000)
})

test('a frame over the cap can only be solved upward', () => {
  // The guard the live loop relies on: while the frame is over budget the solve starts at
  // the pressure in force, so it can never answer with a release whose cost is not in the
  // sample set. Without it the frame settles a few percent above the slider for good.
  const held = 3
  const solution = solvePressure(evenlyWeighted, {
    errorTarget: TARGET, budget: 1_500_000, minPressure: held,
  })
  assert.ok(solution.pressure >= held)
  assert.ok(selectedPoints(evenlyWeighted, TARGET, solution.pressure) <= 1_500_000)
})

test('the ease arrives, so the cap is not held one tile above the slider', () => {
  // Within half a percent it snaps. An exponential otherwise stops a hair short of the
  // solved pressure, and that pressure is exactly where a tile leaves the frame — so the
  // tile stays and the frame settles permanently over the cap.
  let p = 13.9
  for (let frame = 0; frame < 8; frame++) p = easePressure(p, 14, 16, 120, 600)
  assert.equal(p, 14, 'a few frames of 16 ms must land on it, not approach it forever')
  const solution = solvePressure(evenlyWeighted, { errorTarget: TARGET, budget: 2_500_000 })
  const settled = easePressure(solution.pressure * 0.999, solution.pressure, 16, 120, 600)
  assert.equal(settled, solution.pressure)
  assert.ok(selectedPoints(evenlyWeighted, TARGET, settled) <= 2_500_000)
})

test('the ease tightens faster than it releases', () => {
  const up = easePressure(0, 1, 100, 120, 600)
  const down = easePressure(1, 0, 100, 120, 600)
  assert.ok(up > 0.5, `expected a quick tighten, got ${up}`)
  assert.ok(down > 0.8, `expected a slow release, got ${down}`)
  // No time, no movement — a stalled frame must not snap the pressure to its target.
  assert.equal(easePressure(0.4, 1, 0, 120, 600), 0.4)
})
