import assert from 'node:assert/strict'
import test from 'node:test'
import {
  dropoutPressure,
  easePressure,
  planPointTrim,
  selectedPoints,
  solvePressure,
  type BudgetSample,
  type TrimCandidate,
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

test('spread evenly, the least refined tile is the first to go', () => {
  // Far-first off: every tile carries weight 1, so the order is error order and the tile
  // with the least slack over the target leaves first, wherever it happens to be. This is
  // the plain uniform error target, kept as the A/B against the horizon.
  const sharp: BudgetSample = { error: 64, weight: 1, points: 1_000_000 }
  const soft: BudgetSample = { error: 8, weight: 1, points: 1_000_000 }
  const solution = solvePressure([sharp, soft], { errorTarget: TARGET, budget: 1_000_000 })
  assert.ok(dropoutPressure(soft, TARGET) < dropoutPressure(sharp, TARGET))
  assert.equal(selectedPoints([sharp, soft], TARGET, solution.pressure), 1_000_000)
  assert.ok(dropoutPressure(sharp, TARGET) > solution.pressure, 'the sharper tile survives')
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

// ── the draw-side trim ──────────────────────────────────────────────────────────

/** Four tiles of 100k, at 100 m, 400 m, 900 m and 1600 m. */
const tiles: TrimCandidate[] = [
  { full: 100_000, depth: 100, fair: true },
  { full: 100_000, depth: 400, fair: true },
  { full: 100_000, depth: 900, fair: true },
  { full: 100_000, depth: 1600, fair: true },
]

test('a frame already under the cap is left whole', () => {
  const plan = planPointTrim(tiles, { maxPoints: 500_000, minKeep: 1 / 64 })
  assert.deepEqual(plan.keep, [1, 1, 1, 1])
  assert.equal(plan.shortfall, 0)
  assert.equal(plan.total, 400_000)
})

test('the trim takes from the back of the view first', () => {
  // 100k over the cap. The 1600 m tile pays first and goes all the way to its floor —
  // which is 1/64, so it can only give up 98,437 of its 100,000 — and the 1,563 it
  // cannot cover spills to the next one back. The two nearest are never touched.
  const plan = planPointTrim(tiles, { maxPoints: 300_000, minKeep: 1 / 64 })
  assert.deepEqual(plan.keep.slice(0, 2), [1, 1], 'the near field is left alone')
  assert.ok(Math.abs(plan.keep[3] - 1_563 / 100_000) < 1e-9, 'the farthest is at its floor')
  assert.ok(plan.keep[2] > 0.98 && plan.keep[2] < 1, 'and the spill is small')
  const drawn = tiles.reduce((sum, t, i) => sum + Math.round(t.full * plan.keep[i]), 0)
  assert.equal(drawn, 300_000)
  assert.equal(plan.shortfall, 0)
})

test('it empties one tile to its floor before starting on the next', () => {
  const plan = planPointTrim(tiles, { maxPoints: 250_000, minKeep: 0.1 })
  // The farthest is at its floor, the next one is part-way, the near two are whole.
  assert.ok(Math.abs(plan.keep[3] - 0.1) < 1e-9)
  assert.ok(plan.keep[2] > 0.1 && plan.keep[2] < 1)
  assert.deepEqual(plan.keep.slice(0, 2), [1, 1])
  const drawn = tiles.reduce((sum, t, i) => sum + Math.round(t.full * plan.keep[i]), 0)
  assert.equal(drawn, 250_000)
})

test('the floor is respected and what it costs is reported, not hidden', () => {
  // Every tile at a 10% floor leaves 40k drawn against a 20k cap — 20k it cannot take.
  const plan = planPointTrim(tiles, { maxPoints: 20_000, minKeep: 0.1 })
  for (const keep of plan.keep) assert.ok(Math.abs(keep - 0.1) < 1e-9)
  assert.equal(plan.shortfall, 20_000)
})

test('a tile whose order is not fair is drawn whole and skipped', () => {
  const mixed: TrimCandidate[] = [
    { full: 100_000, depth: 1600, fair: false },
    { full: 100_000, depth: 100, fair: true },
  ]
  const plan = planPointTrim(mixed, { maxPoints: 150_000, minKeep: 1 / 64 })
  assert.equal(plan.keep[0], 1, 'the unfair tile keeps every point')
  assert.ok(plan.keep[1] < 1, 'so the near tile pays instead')
  assert.equal(plan.shortfall, 0)
})

// ── far-first as a closing horizon ──────────────────────────────────────────────

/**
 * The weight far-first hands a refining tile. Mirrors `weightFor` in the module: the
 * tile's own error is put back into the weight so it cancels out of the dropout
 * quotient, leaving `reference / distance` — an order that is exactly distance order.
 */
const horizonWeight = (error: number, target: number, distanceM: number, referenceM = 1000) =>
  (error / target - 1) * (Math.max(distanceM, 1) / referenceM)

test('far-first drops refinements strictly from the back of the view', () => {
  // Wildly different errors, so error ordering and distance ordering disagree: the near
  // tile is the one screaming for detail, and it must still be the last to lose it.
  const near = { error: 2000, weight: horizonWeight(2000, TARGET, 50), points: 1 }
  const mid = { error: 40, weight: horizonWeight(40, TARGET, 500), points: 1 }
  const far = { error: 9, weight: horizonWeight(9, TARGET, 3000), points: 1 }
  const order = [near, mid, far].map((s) => dropoutPressure(s, TARGET))
  assert.ok(order[2] < order[1] && order[1] < order[0], `expected far→near, got ${order}`)
})

test('the pressure is a horizon distance, and a tile leaves when it reaches it', () => {
  // A tile at 250 m must give up its refinement exactly when the horizon closes to 250 m,
  // whatever its error is — that is what makes the number on the HUD mean something.
  for (const error of [8, 50, 400]) {
    const at = dropoutPressure({ error, weight: horizonWeight(error, TARGET, 250), points: 1 }, TARGET)
    assert.ok(Math.abs(1000 / at - 250) < 1e-6, `error ${error} left at a horizon of ${1000 / at} m`)
  }
})

test('the protected radius is what stops a tight cap flattening the near field', () => {
  // The ceiling the solver is given: the pressure whose horizon stands on nearM. Past it
  // the traversal would start taking detail from under the camera.
  const nearM = 60
  const maxPressure = 1000 / nearM
  const inside = { error: 500, weight: horizonWeight(500, TARGET, 40), points: 4_000_000 }
  const outside = { error: 20, weight: horizonWeight(20, TARGET, 900), points: 4_000_000 }
  const solution = solvePressure([inside, outside], {
    errorTarget: TARGET, budget: 1_000_000, maxPressure,
  })
  assert.equal(solution.reachable, false, 'it cannot fit, and says so')
  // The far one is gone, the near one is untouched — the trim takes it from here.
  assert.ok(dropoutPressure(outside, TARGET) <= solution.pressure)
  assert.ok(dropoutPressure(inside, TARGET) > solution.pressure)
  assert.equal(selectedPoints([inside, outside], TARGET, solution.pressure), 4_000_000)
})
