import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  HUE_LUMA_CURVE, HUE_SAT_CURVE, insertPoint, isDefaultToneCurve, isNeutralHueCurve, monotoneCurve, movePoint,
  nearestPoint, periodicCurve, periodicCurveFn, readHueTable, removePoint, sampleHueTable, sanitizeCurve, snapNeutral,
  TONE_CURVE, type Pt,
} from './grade-curves.ts'

/** mulberry32: the same seeded sequence on every run. */
function seeded(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** One-sided slopes by second-order differences, so the O(h) curvature term does not hide a kink. */
const slopeRight = (f: (x: number) => number, x: number, h = 1e-5) => (-3 * f(x) + 4 * f(x + h) - f(x + 2 * h)) / (2 * h)
const slopeLeft = (f: (x: number) => number, x: number, h = 1e-5) => (3 * f(x) - 4 * f(x - h) + f(x - 2 * h)) / (2 * h)

/** A sorted tone curve with ends at 0 and 1 and `interior` points at least 0.02 apart. */
function randomToneCurve(random: () => number, interior: number, monotone: boolean): Pt[] {
  const xs = new Set<number>()
  while (xs.size < interior) xs.add(Math.round((0.03 + random() * 0.94) * 50) / 50)
  const sortedX = [0, ...[...xs].sort((a, b) => a - b), 1]
  let ys = sortedX.map(() => random())
  if (monotone) ys = ys.sort((a, b) => a - b)
  // Some flat runs, the case where the spline must not wiggle.
  if (monotone && interior >= 3) ys[2] = ys[1]
  return sortedX.map((x, i) => [x, ys[i]])
}

test('monotoneCurve: the default curve is null; any other curve passes through every knot exactly', () => {
  assert.equal(monotoneCurve([[0, 0], [1, 1]]), null)
  assert.equal(monotoneCurve(TONE_CURVE.defaults), null)
  assert.notEqual(monotoneCurve([[0, 0], [1, 0.9]]), null, 'a two-point curve off the diagonal is not skipped')
  const random = seeded(7)
  for (let trial = 0; trial < 50; trial++) {
    const points = randomToneCurve(random, 1 + (trial % 10), trial % 2 === 0)
    const f = monotoneCurve(points)!
    for (const [x, y] of points) assert.equal(f(x), y, `knot ${x} of trial ${trial}`)
  }
  const line = monotoneCurve([[0, 0.1], [1, 0.9]])!
  assert.ok(Math.abs(line(0.25) - 0.3) < 1e-15, 'two points are a straight line')
})

test('monotoneCurve: monotone data gives monotone samples over 10⁴ points', () => {
  const random = seeded(11)
  for (let trial = 0; trial < 40; trial++) {
    const points = randomToneCurve(random, 1 + (trial % 10), true)
    const f = monotoneCurve(points)!
    let previous = -Infinity
    let dips = 0
    for (let i = 0; i <= 10_000; i++) {
      const y = f(i / 10_000)
      if (y < previous) dips++
      previous = y
    }
    assert.equal(dips, 0, `trial ${trial}: ${JSON.stringify(points)}`)
  }
  // Falling data falls.
  const falling = monotoneCurve([[0, 1], [0.3, 0.8], [0.35, 0.2], [1, 0]])!
  let rises = 0
  for (let i = 1; i <= 10_000; i++) if (falling(i / 10_000) > falling((i - 1) / 10_000)) rises++
  assert.equal(rises, 0)
})

test('monotoneCurve: step data stays inside [0, 1]', () => {
  const f = monotoneCurve([[0, 0], [0.5, 0], [0.51, 1], [1, 1]])!
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i <= 10_000; i++) {
    const y = f(i / 10_000)
    min = Math.min(min, y)
    max = Math.max(max, y)
  }
  assert.equal(min, 0)
  assert.equal(max, 1)
  assert.equal(f(0.25), 0, 'the flat run is exactly flat')
  assert.ok(f(0.505) > 0.4 && f(0.505) < 0.6)
  // Not monotone: a peak and a dip at knots, and the curve never passes either.
  const bump = monotoneCurve([[0, 0.2], [0.4, 0.8], [0.7, 0.3], [1, 0.6]])!
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i <= 10_000; i++) {
    lo = Math.min(lo, bump(i / 10_000))
    hi = Math.max(hi, bump(i / 10_000))
  }
  assert.equal(hi, 0.8, 'the peak is the knot')
  assert.ok(lo >= 0.2 && Math.abs(bump(0.7) - 0.3) < 1e-15, 'the dip is the knot')
  assert.ok(bump(0.69) > 0.3 && bump(0.71) > 0.3)
})

test('monotoneCurve: C1 at the knots, including where Fritsch–Carlson scales the tangents', () => {
  const curves: Pt[][] = [
    [[0, 0], [0.25, 0.4], [0.6, 0.55], [1, 1]],
    // A steep rise into a plateau: α² + β² > 9 on the steep segment, so both tangents are scaled.
    [[0, 0], [0.1, 0.05], [0.2, 0.9], [0.5, 0.95], [1, 1]],
    // Not monotone: the interior extremum gets a flat tangent.
    [[0, 0.2], [0.4, 0.8], [0.7, 0.3], [1, 0.6]],
  ]
  for (const points of curves) {
    const f = monotoneCurve(points)!
    for (const [x] of points) {
      const left = slopeLeft(f, x)
      const right = slopeRight(f, x)
      assert.ok(Math.abs(left - right) < 1e-6, `slope at ${x}: ${left} vs ${right}`)
    }
  }
})

/**
 * Plan 2.4 1d written out on its own, for sorted knots: secants d_k; tangents m_0 = d_0, m_last =
 * d_last, interior (d_{k−1} + d_k)/2 where the two share a sign, else 0; a flat secant zeroes both
 * of its tangents; a segment with α² + β² > 9 scales both by 3/√(α² + β²); the h00/h10/h01/h11
 * basis between knots, and a straight line with the end tangent beyond the ends.
 */
function planCurve(points: Pt[]): (x: number) => number {
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  const n = xs.length
  const d = xs.slice(1).map((x, k) => (ys[k + 1] - ys[k]) / (x - xs[k]))
  const m = xs.map((_, k) => (k === 0 ? d[0] : k === n - 1 ? d[n - 2] : d[k - 1] * d[k] > 0 ? (d[k - 1] + d[k]) / 2 : 0))
  d.forEach((dk, k) => {
    if (dk === 0) m[k] = m[k + 1] = 0
  })
  d.forEach((dk, k) => {
    if (dk === 0) return
    const alpha = m[k] / dk
    const beta = m[k + 1] / dk
    if (alpha ** 2 + beta ** 2 > 9) {
      const tau = 3 / Math.sqrt(alpha ** 2 + beta ** 2)
      m[k] = tau * alpha * dk
      m[k + 1] = tau * beta * dk
    }
  })
  return (x) => {
    if (x < xs[0]) return ys[0] + m[0] * (x - xs[0])
    if (x >= xs[n - 1]) return ys[n - 1] + m[n - 1] * (x - xs[n - 1])
    let k = 0
    while (x >= xs[k + 1]) k++
    const h = xs[k + 1] - xs[k]
    const t = (x - xs[k]) / h
    const h00 = 2 * t ** 3 - 3 * t ** 2 + 1
    const h10 = t ** 3 - 2 * t ** 2 + t
    const h01 = -2 * t ** 3 + 3 * t ** 2
    const h11 = t ** 3 - t ** 2
    return h00 * ys[k] + h10 * h * m[k] + h01 * ys[k + 1] + h11 * h * m[k + 1]
  }
}

test('monotoneCurve and periodicCurveFn are plan 2.4 1d: equal to it written out here', () => {
  const curves: Pt[][] = [
    // A steep rise into a plateau: both of its neighbours' segments get their tangents scaled.
    [[0, 0], [0.1, 0.05], [0.2, 0.9], [0.5, 0.95], [1, 1]],
    [[0, 0.2], [0.4, 0.8], [0.7, 0.3], [1, 0.6]],
    [[0, 0], [0.5, 0], [0.51, 1], [1, 1]],
    [[0, 0.05], [0.2, 0.1], [0.35, 0.6], [0.6, 0.62], [0.8, 0.95], [1, 1]],
  ]
  for (const points of curves) {
    const f = monotoneCurve(points)!
    const want = planCurve(points)
    let worst = 0
    for (let i = 0; i <= 600; i++) {
      const x = -0.25 + 1.5 * i / 600
      worst = Math.max(worst, Math.abs(f(x) - want(x)))
    }
    assert.ok(worst < 1e-12, `${JSON.stringify(points)}: ${worst}`)
  }
  // The scaled case really is one: off by 1.9 LSB at 0.3 with 2/√ in place of 3/√.
  assert.ok(Math.abs(monotoneCurve(curves[0])!(0.3) - 0.934833) < 1e-6)

  // Periodic: the points copied one period each side, then the same spline. This curve's steep
  // segment makes both neighbours scale, and the seam segment is flat-tangented on both ends.
  const hue: Pt[] = [[20, 0.2], [100, 0.25], [110, 1.9], [250, 1.95]]
  const extended = [...hue.map(([x, y]): Pt => [x - 360, y]), ...hue, ...hue.map(([x, y]): Pt => [x + 360, y])]
  const periodicWant = planCurve(extended)
  const periodic = periodicCurveFn(hue)!
  const table = periodicCurve(hue, 1)!
  let worst = 0
  for (let i = 0; i <= 720; i++) worst = Math.max(worst, Math.abs(periodic(i / 2) - periodicWant(i / 2)))
  assert.ok(worst < 1e-12, `periodic: ${worst}`)
  for (let i = 0; i <= 360; i++) assert.equal(table[i], Math.fround(periodicWant(i % 360)), `table[${i}]`)
})

test('monotoneCurve: a straight line with the end tangent beyond the ends', () => {
  const points: Pt[] = [[0, 0.1], [0.3, 0.5], [0.7, 0.6], [1, 0.95]]
  const f = monotoneCurve(points)!
  // Fritsch–Carlson's end tangents are the end secants (unscaled here).
  const m0 = (0.5 - 0.1) / 0.3
  const m1 = (0.95 - 0.6) / 0.3
  for (const x of [-0.25, -0.1, -0.01]) assert.ok(Math.abs(f(x) - (0.1 + m0 * x)) < 1e-12, `below 0 at ${x}`)
  for (const x of [1.01, 1.2, 1.5]) assert.ok(Math.abs(f(x) - (0.95 + m1 * (x - 1))) < 1e-12, `above 1 at ${x}`)
  // The line meets the spline with its slope: C1 at the ends too.
  assert.ok(Math.abs(slopeRight(f, 0) - m0) < 1e-6)
  assert.ok(Math.abs(slopeLeft(f, 1) - m1) < 1e-6)
})

test('periodicCurve: empty and neutral are null, flat and single points are exactly constant', () => {
  assert.equal(periodicCurve([], 1), null)
  assert.equal(periodicCurve([[40, 1], [200, 1]], 1), null, 'flat at neutral')
  assert.equal(periodicCurve([[40, 0]], 0), null)
  const flat = periodicCurve([[30, 1.3], [150, 1.3], [300, 1.3]], 1)!
  assert.equal(flat.length, 361)
  for (const value of flat) assert.equal(value, Math.fround(1.3))
  const one = periodicCurve([[100, 0.7]], 1)!
  for (const value of one) assert.equal(value, Math.fround(0.7))
  assert.equal(periodicCurveFn([[100, 0.7]])!(5), 0.7)
})

test('periodicCurve: the table is the curve at every degree, closed at 360, inside its points\' range', () => {
  const random = seeded(23)
  for (let trial = 0; trial < 30; trial++) {
    const count = 2 + (trial % 11)
    const xs = new Set<number>()
    while (xs.size < count) xs.add(Math.floor(random() * 72) * 5)
    const points: Pt[] = [...xs].sort((a, b) => a - b).map((x) => [x, random() * 2])
    const table = periodicCurve(points, 1)!
    const f = periodicCurveFn(points)!
    assert.equal(table[0], table[360], 't[0] === t[360]')
    for (let i = 0; i < 360; i++) assert.equal(table[i], Math.fround(f(i)))
    for (const [x, y] of points) assert.ok(Math.abs(f(x) - y) < 1e-12, 'through every knot')
    const ys = points.map((p) => p[1])
    const lo = Math.min(...ys)
    const hi = Math.max(...ys)
    for (let i = 0; i <= 360; i++) assert.ok(table[i] >= Math.fround(lo) && table[i] <= Math.fround(hi), 'no overshoot')
  }
})

test('periodicCurve: value and slope continuous across 0/360', () => {
  const cases: Pt[][] = [
    [[0, 1.4], [90, 0.6], [200, 1.2]],          // a knot on the seam
    [[20, 1.5], [100, 0.8], [340, 1.1]],        // the seam inside a segment
    [[10, 0.2], [350, 1.8]],                    // two points 20° apart across the seam
    [[0, 0.5], [3.6, 1.9], [180, 1], [356.4, 0.1]], // tight points either side of the seam
  ]
  for (const points of cases) {
    const f = periodicCurveFn(points)!
    assert.ok(Math.abs(f(0) - f(360 - 1e-9)) < 1e-6, 'value')
    assert.equal(f(0), f(360))
    assert.equal(f(-30), f(330), 'any hue wraps')
    const right = slopeRight(f, 0)
    const left = slopeLeft(f, 360)
    assert.ok(Math.abs(left - right) < 1e-6, `slope across the seam: ${left} vs ${right}`)
    for (const [x] of points) {
      if (x === 0) continue
      assert.ok(Math.abs(slopeLeft(f, x) - slopeRight(f, x)) < 1e-6, `C1 at ${x}`)
    }
  }
})

test('sampleHueTable reads linearly between whole degrees and wraps', () => {
  const table = periodicCurve([[0, 1.4], [90, 0.6], [200, 1.2]], 1)!
  assert.equal(sampleHueTable(table, 10), table[10])
  assert.ok(Math.abs(sampleHueTable(table, 10.25) - (0.75 * table[10] + 0.25 * table[11])) < 1e-7)
  assert.equal(sampleHueTable(table, 370), table[10])
  assert.equal(sampleHueTable(table, -350), table[10])
  assert.ok(Math.abs(sampleHueTable(table, 359.5) - (table[359] + table[360]) / 2) < 1e-7)
  // The bake's unwrapped read is the same read, bit for bit, on [0, 360).
  const random = seeded(31)
  for (let k = 0; k < 10_000; k++) {
    const hue = k === 0 ? 0 : k === 1 ? 360 - 2 ** -44 : random() * 360
    assert.equal(readHueTable(table, hue), sampleHueTable(table, hue), `${hue}`)
  }
})

test('the skip tests: what monotoneCurve and periodicCurve skip is exactly what isDefaultToneCurve and isNeutralHueCurve say', () => {
  const tone: Pt[][] = [
    [[0, 0], [1, 1]], [[0, 0], [1, 0.99]], [[0, 0.01], [1, 1]], [[0, 0], [0.5, 0.5], [1, 1]], [[0, -0], [1, 1]],
  ]
  for (const points of tone) assert.equal(isDefaultToneCurve(points), monotoneCurve(points) === null, JSON.stringify(points))
  assert.equal(isDefaultToneCurve(TONE_CURVE.defaults), true)
  assert.equal(isDefaultToneCurve([[0, 0], [0.5, 0.5], [1, 1]]), false, 'the diagonal through three knots is not the default')
  const hue: Array<[Pt[], number]> = [
    [[], 1], [[[40, 1]], 1], [[[40, 1], [200, 1.01]], 1], [[[40, 0], [200, 0]], 0], [[[40, 1]], 0], [[[10, -0]], 0],
  ]
  for (const [points, neutral] of hue) {
    assert.equal(isNeutralHueCurve(points, neutral), periodicCurve(points, neutral) === null, `${JSON.stringify(points)} at ${neutral}`)
  }
})

/** The invariants every edit must keep. */
function assertToneCurve(points: readonly Pt[], label: string) {
  assert.ok(points.length >= 2 && points.length <= 12, `${label}: count ${points.length}`)
  assert.equal(points[0][0], 0, `${label}: first end at 0`)
  assert.equal(points[points.length - 1][0], 1, `${label}: last end at 1`)
  for (let k = 1; k < points.length; k++) {
    assert.ok(points[k][0] - points[k - 1][0] >= 0.01 - 1e-9, `${label}: gap at ${k}`)
  }
  for (const [, y] of points) assert.ok(y >= 0 && y <= 1, `${label}: y in range`)
}

test('insertPoint: sorted, the gap to both neighbours and both ends, the cap, clamped y, input untouched', () => {
  const base: Pt[] = [[0, 0], [1, 1]]
  const added = insertPoint(base, 0.5, 0.6)!
  assert.deepEqual(added, { points: [[0, 0], [0.5, 0.6], [1, 1]], index: 1 })
  assert.deepEqual(base, [[0, 0], [1, 1]], 'the input is not changed')
  assert.equal(insertPoint(added.points, 0.505, 0.2), null, 'inside the gap of a neighbour')
  assert.equal(insertPoint(added.points, 0.005, 0.2), null, 'inside the gap of the 0 end')
  assert.equal(insertPoint(added.points, 0.995, 0.2), null, 'inside the gap of the 1 end')
  assert.equal(insertPoint(added.points, 1.2, 0.2), null, 'past the end')
  assert.equal(insertPoint(added.points, Number.NaN, 0.2), null)
  assert.deepEqual(insertPoint(added.points, 0.51, 0.2)?.index, 2, 'exactly the gap is allowed')
  assert.deepEqual(insertPoint(added.points, 0.2, 1.7)!.points[1], [0.2, 1], 'y clamped')
  let points: Pt[] = base
  for (let i = 1; i <= 10; i++) points = insertPoint(points, i / 11, i / 11)!.points
  assert.equal(points.length, 12)
  assertToneCurve(points, 'filled')
  assert.equal(insertPoint(points, 0.955, 0.5), null, 'capped at 12')
  assert.equal(insertPoint(added.points, 0.25, 0.25, 3), null, 'an explicit max')
})

test('movePoint: ends move in y only, interior points stop at the gap, the order never changes', () => {
  const points: Pt[] = [[0, 0], [0.3, 0.2], [0.6, 0.7], [1, 1]]
  assert.deepEqual(movePoint(points, 0, 0.4, 0.15)!.points[0], [0, 0.15], 'the 0 end keeps x')
  assert.deepEqual(movePoint(points, 3, 0.2, 2)!.points[3], [1, 1], 'the 1 end keeps x, y clamped')
  assert.deepEqual(movePoint(points, 1, 0.45, 0.4)!.points[1], [0.45, 0.4])
  const pushed = movePoint(points, 1, 0.9, 0.4)!
  assert.ok(Math.abs(pushed.points[1][0] - 0.59) < 1e-12, 'stops one gap short of its right neighbour')
  assert.equal(pushed.index, 1)
  const pulled = movePoint(points, 2, -1, -1)!
  assert.ok(Math.abs(pulled.points[2][0] - 0.31) < 1e-12, 'stops one gap short of its left neighbour')
  assert.equal(pulled.points[2][1], 0)
  assert.equal(movePoint(points, 4, 0.5, 0.5), null)
  assert.deepEqual(points, [[0, 0], [0.3, 0.2], [0.6, 0.7], [1, 1]], 'the input is not changed')
  // A random walk of drags keeps every invariant.
  const random = seeded(5)
  let walk: Pt[] = [[0, 0], [0.2, 0.3], [0.4, 0.5], [0.6, 0.55], [0.8, 0.9], [1, 1]]
  for (let step = 0; step < 2000; step++) {
    const i = Math.floor(random() * walk.length)
    walk = movePoint(walk, i, random() * 1.4 - 0.2, random() * 1.4 - 0.2)!.points
    assertToneCurve(walk, `step ${step}`)
  }
})

test('removePoint: never an end, never below the minimum, a new array', () => {
  const points: Pt[] = [[0, 0], [0.3, 0.2], [0.6, 0.7], [1, 1]]
  assert.equal(removePoint(points, 0), null)
  assert.equal(removePoint(points, 3), null)
  assert.equal(removePoint(points, 7), null)
  assert.deepEqual(removePoint(points, 1), [[0, 0], [0.6, 0.7], [1, 1]])
  assert.equal(points.length, 4)
  assert.equal(removePoint([[0, 0], [1, 1]], 1), null)
  // Hue curves have no ends and may go down to none.
  assert.deepEqual(removePoint([[30, 1.2]], 0, HUE_SAT_CURVE), [])
  assert.deepEqual(removePoint([[30, 1.2], [200, 0.5]], 0, HUE_SAT_CURVE), [[200, 0.5]])
})

test('nearestPoint: the hit ellipse, the nearest of several, and the seam on hue curves', () => {
  const points: Pt[] = [[0, 0], [0.3, 0.2], [0.34, 0.25], [1, 1]]
  assert.equal(nearestPoint(points, 0.305, 0.2, 0.02, 0.02), 1)
  assert.equal(nearestPoint(points, 0.325, 0.23, 0.05, 0.05), 2, 'the nearer of two in range')
  assert.equal(nearestPoint(points, 0.31, 0.21, 0.05, 0.05), 1)
  assert.equal(nearestPoint(points, 0.5, 0.5, 0.02, 0.02), -1, 'a miss')
  assert.equal(nearestPoint(points, 0.3, 0.215, 0.02, 0.01), -1, 'outside the y radius')
  assert.equal(nearestPoint(points, 0.3, 0.215, 0.01, 0.02), 1, 'inside it')
  assert.equal(nearestPoint(points, 0.3 + 0.0199, 0.2, 0.02, 0.02), 1, 'just inside the rim')
  assert.equal(nearestPoint(points, 0.3 + 0.0201, 0.19, 0.02, 0.02), -1, 'just outside it')
  // A 22 px touch radius on a 270 px canvas hits where a 10 px mouse radius misses.
  const lone: Pt[] = [[0, 0], [0.3, 0.2], [1, 1]]
  assert.equal(nearestPoint(lone, 0.3 + 15 / 270, 0.2, 22 / 270, 22 / 270), 1)
  assert.equal(nearestPoint(lone, 0.3 + 15 / 270, 0.2, 10 / 270, 10 / 270), -1)
  const hue: Pt[] = [[2, 1.2], [180, 0.5]]
  assert.equal(nearestPoint(hue, 358, 1.2, 5, 0.1, HUE_SAT_CURVE), 0, 'across the seam')
  assert.equal(nearestPoint(hue, 358, 1.2, 5, 0.1, TONE_CURVE), -1, 'not on an open curve')
})

test('hue curves: insert and move wrap, keep the gap across the seam and re-sort', () => {
  const d = HUE_SAT_CURVE
  const one = insertPoint([], 370, 1.4, undefined, d)!
  assert.deepEqual(one, { points: [[10, 1.4]], index: 0 }, '370° is 10°')
  const two = insertPoint([[1, 1.2], [180, 0.5]], 359, 1, undefined, d)
  assert.equal(two, null, '2° from the point at 1°, across the seam')
  const three = insertPoint([[1, 1.2], [180, 0.5]], 356, 1, undefined, d)!
  assert.deepEqual(three.points.map((p) => p[0]), [1, 180, 356])
  assert.equal(three.index, 2)
  assert.deepEqual(insertPoint([[10, 1]], 100, 3, undefined, d)!.points[1], [100, 2], 'y clamped to 0..2')
  assert.equal(insertPoint([[10, 0]], 100, -3, undefined, HUE_LUMA_CURVE)!.points[1][1], -1, 'stops: −1..1')

  // A point dragged left over 0° comes out at the end of the list.
  const points: Pt[] = [[20, 1.2], [150, 0.6], [250, 1.1]]
  const crossed = movePoint(points, 0, -10, 1.3, d)!
  assert.deepEqual(crossed.points, [[150, 0.6], [250, 1.1], [350, 1.3]])
  assert.equal(crossed.index, 2)
  // ... and stops one gap short of its neighbour across the seam.
  const stopped = movePoint(points, 0, -130, 1.3, d)!
  assert.ok(Math.abs(stopped.points[stopped.index][0] - (250 + 3.6)) < 1e-9)
  // A lone point goes anywhere.
  assert.deepEqual(movePoint([[20, 1]], 0, 725, 0.5, d)!.points, [[5, 0.5]])
  // A random walk keeps the circular order, the gap and the cap.
  const random = seeded(9)
  let walk: Pt[] = [[0, 1], [60, 1.2], [120, 0.8], [180, 1.5], [240, 0.4], [300, 1]]
  for (let step = 0; step < 2000; step++) {
    const i = Math.floor(random() * walk.length)
    const moved = movePoint(walk, i, walk[i][0] + (random() - 0.5) * 200, random() * 2, d)!
    walk = moved.points
    assert.equal(walk.length, 6)
    for (let k = 0; k < walk.length; k++) {
      const next = k + 1 < walk.length ? walk[k + 1][0] : walk[0][0] + 360
      assert.ok(next - walk[k][0] >= 3.6 - 1e-9, `step ${step}: gap after ${k}`)
      assert.ok(walk[k][0] >= 0 && walk[k][0] < 360)
    }
  }
})

test('snapNeutral: a dragged hue point within 0.01 of neutral lands on it', () => {
  assert.equal(snapNeutral(1.008, HUE_SAT_CURVE), 1)
  assert.equal(snapNeutral(0.991, HUE_SAT_CURVE), 1)
  assert.equal(snapNeutral(1.02, HUE_SAT_CURVE), 1.02)
  assert.equal(snapNeutral(-0.005, HUE_LUMA_CURVE), 0)
  assert.equal(snapNeutral(0.995, TONE_CURVE), 0.995, 'tone curves have no neutral y')
})

test('sanitizeCurve: sorted, clamped, ends pinned, close points dropped, capped, junk survived', () => {
  const warnings: string[] = []
  assert.deepEqual(sanitizeCurve([[1, 1], [0.5, 0.7], [0, 0]], TONE_CURVE, warnings, 'c'), [[0, 0], [0.5, 0.7], [1, 1]])
  assert.deepEqual(warnings, [], 'sorting alone is not worth a warning')
  assert.deepEqual(sanitizeCurve([[0.1, 0.2], [0.9, 0.8]], TONE_CURVE, warnings, 'c'), [[0, 0.2], [1, 0.8]])
  assert.equal(warnings.length, 1)
  const close = sanitizeCurve([[0, 0], [0.28, 0.3], [0.29, 0.31], [0.295, 0.4], [0.995, 0.9], [1, 1]], TONE_CURVE, [], 'c')
  assert.deepEqual(close, [[0, 0], [0.28, 0.3], [0.29, 0.31], [1, 1]], 'an exact 0.01 gap survives float error; the end wins')
  const many: Pt[] = Array.from({ length: 20 }, (_, i) => [i / 19, (i / 19) ** 2])
  const capped = sanitizeCurve(many, TONE_CURVE, [], 'c')
  assert.equal(capped.length, 12)
  assertToneCurve(capped, 'capped')
  assert.deepEqual(capped[11], [1, 1])
  for (const junk of [null, 3, 'x', {}, [[Number.NaN, 1]], [[0.5]], [['a', 'b']], [[0, 0]], []]) {
    const w: string[] = []
    assert.deepEqual(sanitizeCurve(junk, TONE_CURVE, w, 'c'), [[0, 0], [1, 1]])
    assert.ok(w.length > 0, `a warning for ${JSON.stringify(junk)}`)
  }
  assert.deepEqual(sanitizeCurve(undefined, TONE_CURVE, warnings, 'c'), [[0, 0], [1, 1]])
  const hue = sanitizeCurve([[360, 1.2], [370, 0.4], [-20, 3], [358, 1], [100, 1.1]], HUE_SAT_CURVE, warnings, 'h')
  assert.deepEqual(hue, [[0, 1.2], [10, 0.4], [100, 1.1], [340, 2]], '360 → 0, 370 → 10, −20 → 340; 358 is 2° from 0° across the seam')
})
