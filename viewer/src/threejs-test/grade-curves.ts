// The colour grade's curves (grade-model.ts): the four tone curves, the two hue curves, and the
// point edits the curve widgets make, so those are testable too — pure maths, no three, no DOM,
// so it runs under `node --test` (grade-curves.test.ts). grade-bake.ts samples what this returns.
//
// Both kinds are Fritsch–Carlson monotone cubic Hermite splines: between two knots the curve
// never overshoots them, so a curve that only rises never dips, and a step stays inside its two
// levels. A tone curve has its ends pinned at x = 0 and 1 (they move in y only) and continues
// past them in a straight line with the end tangent. A hue curve is periodic over 360° of
// hexcone hue, has no ends, and is tabulated for the bake.

/** One curve point: [in, out] on a tone curve, [hue°, value] on a hue curve. */
export type Pt = [number, number]

/** The limits one kind of curve is edited and parsed within. */
export interface CurveDomain {
  /** x range. A periodic domain wraps x into [xMin, xMax), its period is xMax − xMin. */
  readonly xMin: number
  readonly xMax: number
  readonly yMin: number
  readonly yMax: number
  /** Smallest x distance between neighbours; on a periodic curve across the seam too. */
  readonly gap: number
  readonly minPoints: number
  readonly maxPoints: number
  /** True: no ends, x wraps (hue curves). False: the first and last point sit at xMin and xMax. */
  readonly periodic: boolean
  /** The points a reset gives. */
  readonly defaults: readonly (readonly [number, number])[]
  /** Hue curves: the y that changes nothing, and how close a dragged point snaps onto it
   *  (snapNeutral). Tone curves have no neutral y; their neutral is the diagonal. */
  readonly neutral?: number
  readonly snap?: number
}

/** The four tone curves: 2–12 points, ends pinned, interior gap 0.01 (2.7 px on the widget). */
export const TONE_CURVE: CurveDomain = Object.freeze({
  xMin: 0, xMax: 1, yMin: 0, yMax: 1, gap: 0.01, minPoints: 2, maxPoints: 12, periodic: false,
  defaults: Object.freeze([Object.freeze([0, 0] as const), Object.freeze([1, 1] as const)]),
})

/** Hue vs saturation: a saturation factor 0–2 per hue, 1 neutral. The gap is the tone curves'
 *  0.01 of the width, 3.6°. */
export const HUE_SAT_CURVE: CurveDomain = Object.freeze({
  xMin: 0, xMax: 360, yMin: 0, yMax: 2, gap: 3.6, minPoints: 0, maxPoints: 12, periodic: true,
  defaults: Object.freeze([]), neutral: 1, snap: 0.01,
})

/** Hue vs luma: −1 to +1 stops per hue, 0 neutral. */
export const HUE_LUMA_CURVE: CurveDomain = Object.freeze({
  xMin: 0, xMax: 360, yMin: -1, yMax: 1, gap: 3.6, minPoints: 0, maxPoints: 12, periodic: true,
  defaults: Object.freeze([]), neutral: 0, snap: 0.01,
})

/** Gaps are compared with this slack: 0.29 − 0.28 is 0.00999999999999995 in floats. */
const GAP_EPS = 1e-9

const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi)
/** −0 → 0, so a JSON round trip (which writes −0 as 0) deep-equals. */
const plain = (x: number) => x + 0

/** x wrapped into a periodic domain's [xMin, xMax). */
function wrapX(x: number, d: CurveDomain): number {
  const period = d.xMax - d.xMin
  let w = (x - d.xMin) % period
  if (w < 0) w += period
  if (w >= period) w -= period
  return plain(d.xMin + w)
}

const copyPoints = (points: readonly (readonly [number, number])[]): Pt[] => points.map((p) => [p[0], p[1]])

/**
 * Fritsch–Carlson tangents for knots with strictly increasing x. Secants d_k; interior tangents
 * the mean of the two secants where they share a sign, else 0; the ends of an open curve take
 * their one secant; a flat secant flattens both of its knots; a segment with α² + β² > 9 has both
 * tangents scaled by 3/√(α² + β²). A periodic curve closes the last segment onto the first knot
 * one period on, so every knot has the one tangent and the curve is C1 across the seam.
 */
function tangents(xs: Float64Array, ys: Float64Array, periodic: boolean, period: number): Float64Array {
  const n = xs.length
  const segments = periodic ? n : n - 1
  const d = new Float64Array(segments)
  for (let k = 0; k < segments; k++) {
    const x1 = k + 1 < n ? xs[k + 1] : xs[0] + period
    const y1 = k + 1 < n ? ys[k + 1] : ys[0]
    d[k] = (y1 - ys[k]) / (x1 - xs[k])
  }
  const m = new Float64Array(n)
  for (let k = 0; k < n; k++) {
    if (!periodic && k === 0) m[k] = d[0]
    else if (!periodic && k === n - 1) m[k] = d[segments - 1]
    else {
      const a = d[(k - 1 + segments) % segments]
      const b = d[k % segments]
      m[k] = a * b > 0 ? (a + b) / 2 : 0
    }
  }
  for (let k = 0; k < segments; k++) {
    if (d[k] === 0) {
      m[k] = 0
      m[(k + 1) % n] = 0
    }
  }
  for (let k = 0; k < segments; k++) {
    if (d[k] === 0) continue
    const k1 = (k + 1) % n
    const alpha = m[k] / d[k]
    const beta = m[k1] / d[k]
    const s = alpha * alpha + beta * beta
    if (s > 9) {
      const tau = 3 / Math.sqrt(s)
      m[k] = tau * alpha * d[k]
      m[k1] = tau * beta * d[k]
    }
  }
  return m
}

/** Cubic Hermite between (x0, y0, m0) and (x1, y1, m1). Written as y0 plus increments, so a flat
 *  segment returns y0 exactly and t = 0 returns the knot exactly. */
function hermite(x: number, x0: number, x1: number, y0: number, y1: number, m0: number, m1: number): number {
  const h = x1 - x0
  const t = (x - x0) / h
  const u = 1 - t
  // h01 = t²(3 − 2t), h10 = t(1 − t)², h11 = t²(t − 1)
  return y0 + (y1 - y0) * (t * t * (3 - 2 * t)) + h * (m0 * t * u * u - m1 * t * t * u)
}

/** Sorted x, ys and their spline tangents; points with an x not above the previous are skipped. */
function knots(points: readonly (readonly [number, number])[], periodic: boolean, period: number) {
  const sorted = points.slice().sort((a, b) => a[0] - b[0])
  const xsList: number[] = []
  const ysList: number[] = []
  for (const [x, y] of sorted) {
    if (xsList.length && x <= xsList[xsList.length - 1]) continue
    xsList.push(x)
    ysList.push(y)
  }
  const xs = Float64Array.from(xsList)
  const ys = Float64Array.from(ysList)
  return { xs, ys, m: tangents(xs, ys, periodic, period) }
}

/** The segment k with xs[k] ≤ x < xs[k + 1], for xs[0] ≤ x < xs[n − 1]. */
function segmentOf(xs: Float64Array, x: number): number {
  let lo = 0
  let hi = xs.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (xs[mid] <= x) lo = mid
    else hi = mid
  }
  return lo
}

/** True for the default tone curve [[0, 0], [1, 1]], exactly: monotoneCurve skips it, and
 *  isGradeIdentity (grade-model.ts) asks the same question, so the two always agree. */
export function isDefaultToneCurve(points: readonly (readonly [number, number])[]): boolean {
  return points.length === 2 && points[0][0] === 0 && points[0][1] === 0 && points[1][0] === 1 && points[1][1] === 1
}

/** True for a hue curve that changes nothing: no points, or every point exactly at `neutral` (1
 *  for hue vs sat, 0 for hue vs luma). periodicCurve skips it, and isGradeIdentity asks the same. */
export function isNeutralHueCurve(points: readonly (readonly [number, number])[], neutral: number): boolean {
  return points.every((p) => p[1] === neutral)
}

/**
 * A tone curve as a function, or null for the default [[0, 0], [1, 1]] (the bake skips it) and
 * for fewer than two points. Passes through every knot exactly, C1, and beyond the end knots a
 * straight line with the end tangent, so values the grade pushes past 0 or 1 stay smooth.
 * No allocation per call.
 */
export function monotoneCurve(points: readonly (readonly [number, number])[]): ((x: number) => number) | null {
  if (points.length < 2 || isDefaultToneCurve(points)) return null
  const { xs, ys, m } = knots(points, false, 0)
  const n = xs.length
  if (n < 2) return null
  const x0 = xs[0]
  const xn = xs[n - 1]
  return (x: number) => {
    if (x < x0) return ys[0] + m[0] * (x - x0)
    if (x >= xn) return ys[n - 1] + m[n - 1] * (x - xn)
    const k = segmentOf(xs, x)
    return hermite(x, xs[k], xs[k + 1], ys[k], ys[k + 1], m[k], m[k + 1])
  }
}

/**
 * A hue curve as a periodic function of hue in degrees (any value, wrapped into [0, period)), or
 * null without points. One point is a constant. The widget draws with it; periodicCurve
 * tabulates it for the bake.
 */
export function periodicCurveFn(points: readonly (readonly [number, number])[], period = 360): ((hue: number) => number) | null {
  if (points.length === 0) return null
  const wrapped = points.map((p): Pt => {
    let x = p[0] % period
    if (x < 0) x += period
    if (x >= period) x -= period
    return [x, p[1]]
  })
  const { xs, ys, m } = knots(wrapped, true, period)
  const n = xs.length
  if (n === 1) {
    const c = ys[0]
    return () => c
  }
  const first = xs[0]
  const last = xs[n - 1]
  return (hue: number) => {
    let x = hue % period
    if (x < 0) x += period
    if (x >= period) x -= period
    // Before the first knot and after the last: the segment over the seam.
    if (x < first) return hermite(x, last - period, first, ys[n - 1], ys[0], m[n - 1], m[0])
    if (x >= last) return hermite(x, last, first + period, ys[n - 1], ys[0], m[n - 1], m[0])
    const k = segmentOf(xs, x)
    return hermite(x, xs[k], xs[k + 1], ys[k], ys[k + 1], m[k], m[k + 1])
  }
}

/**
 * A hue curve tabulated at every whole degree, t[i] = f(i°) for i = 0..360 with t[360] = t[0],
 * read linearly between entries (sampleHueTable). Null when there is nothing to do: no points,
 * or every point exactly at `neutral` (1 for hue vs sat, 0 for hue vs luma). A curve whose points
 * all share one y — one point included — is exactly that constant.
 */
export function periodicCurve(points: readonly (readonly [number, number])[], neutral: number): Float32Array | null {
  if (isNeutralHueCurve(points, neutral)) return null
  const table = new Float32Array(361)
  const y0 = points[0][1]
  if (points.every((p) => p[1] === y0)) return table.fill(y0)
  const f = periodicCurveFn(points, 360)!
  for (let i = 0; i < 360; i++) table[i] = f(i)
  table[360] = table[0]
  return table
}

/** Linear read of a periodicCurve table at any hue in degrees. */
export function sampleHueTable(table: Float32Array, hue: number): number {
  let h = hue % 360
  if (h < 0) h += 360
  if (h >= 360) h -= 360
  return readHueTable(table, h)
}

/** sampleHueTable for a hue already in [0, 360), as hexconeHue gives it: the same linear read,
 *  bit for bit, without the wrap's float modulo. The bake reads its hue tables per node with it. */
export function readHueTable(table: Float32Array, hue: number): number {
  const i = Math.floor(hue)
  return table[i] + (hue - i) * (table[i + 1] - table[i])
}

/** A dragged hue-curve y within `snap` of neutral lands exactly on it, so a curve dragged back
 *  flat is identity again. Keyboard nudges skip this, or a 1/255 nudge could never leave it. */
export function snapNeutral(y: number, domain: CurveDomain): number {
  if (domain.neutral === undefined || !domain.snap) return y
  return Math.abs(y - domain.neutral) <= domain.snap ? domain.neutral : y
}

/** The x range a point may move in without passing a neighbour's gap (unwrapped for periodic). */
function freeRange(points: readonly (readonly [number, number])[], i: number, d: CurveDomain): [number, number] {
  const n = points.length
  if (!d.periodic) {
    if (i === 0) return [d.xMin, d.xMin]
    if (i === n - 1) return [d.xMax, d.xMax]
    return [points[i - 1][0] + d.gap, points[i + 1][0] - d.gap]
  }
  const period = d.xMax - d.xMin
  if (n === 1) return [-Infinity, Infinity]
  const prev = i > 0 ? points[i - 1][0] : points[n - 1][0] - period
  const next = i < n - 1 ? points[i + 1][0] : points[0][0] + period
  return [prev + d.gap, next - d.gap]
}

/**
 * Adds a point at (x, y), y clamped to the domain, keeping the points sorted. Null when the curve
 * already holds `max` points (default the domain's 12), when x lies within the gap of a
 * neighbour (or, on a tone curve, of either end), or for a non-finite input. A periodic x wraps.
 * Returns new arrays; the input is never changed.
 */
export function insertPoint(points: readonly (readonly [number, number])[], x: number, y: number, max?: number,
  domain: CurveDomain = TONE_CURVE): { points: Pt[]; index: number } | null {
  const n = points.length
  if (n >= (max ?? domain.maxPoints) || !Number.isFinite(x) || !Number.isFinite(y)) return null
  const px = domain.periodic ? wrapX(x, domain) : plain(x)
  let index = 0
  while (index < n && points[index][0] < px) index++
  let lo: number
  let hi: number
  if (domain.periodic) {
    const period = domain.xMax - domain.xMin
    lo = n ? (index > 0 ? points[index - 1][0] : points[n - 1][0] - period) : -Infinity
    hi = n ? (index < n ? points[index][0] : points[0][0] + period) : Infinity
  } else {
    lo = index > 0 ? points[index - 1][0] : domain.xMin
    hi = index < n ? points[index][0] : domain.xMax
  }
  if (px - lo < domain.gap - GAP_EPS || hi - px < domain.gap - GAP_EPS) return null
  const out = copyPoints(points)
  out.splice(index, 0, [px, plain(clamp(y, domain.yMin, domain.yMax))])
  return { points: out, index }
}

/**
 * Moves point i towards (x, y): y is clamped to the domain, x to the room between its neighbours
 * less the gap, so the order never changes. A tone curve's ends keep their x and move in y only.
 * A periodic point may cross the seam: it is wrapped and the points re-sorted, and `index` is
 * where it went. Null for an index out of range. Returns new arrays.
 */
export function movePoint(points: readonly (readonly [number, number])[], i: number, x: number, y: number,
  domain: CurveDomain = TONE_CURVE): { points: Pt[]; index: number } | null {
  const n = points.length
  if (!Number.isInteger(i) || i < 0 || i >= n) return null
  const out = copyPoints(points)
  const py = Number.isFinite(y) ? plain(clamp(y, domain.yMin, domain.yMax)) : points[i][1]
  const [lo, hi] = freeRange(points, i, domain)
  if (!domain.periodic) {
    out[i] = [plain(Number.isFinite(x) ? clamp(x, lo, hi) : points[i][0]), py]
    return { points: out, index: i }
  }
  const period = domain.xMax - domain.xMin
  let px = points[i][0]
  if (Number.isFinite(x)) {
    // The copy of x one period over that lies nearest the point, then the room it has.
    const cur = points[i][0]
    px = clamp(x + period * Math.round((cur - x) / period), lo, hi)
  }
  const moved: Pt = [wrapX(px, domain), py]
  out[i] = moved
  out.sort((a, b) => a[0] - b[0])
  return { points: out, index: out.indexOf(moved) }
}

/** Removes point i. Null for a tone curve's end, an index out of range, or a curve already at its
 *  fewest points. Returns a new array. */
export function removePoint(points: readonly (readonly [number, number])[], i: number,
  domain: CurveDomain = TONE_CURVE): Pt[] | null {
  const n = points.length
  if (!Number.isInteger(i) || i < 0 || i >= n || n <= domain.minPoints) return null
  if (!domain.periodic && (i === 0 || i === n - 1)) return null
  const out = copyPoints(points)
  out.splice(i, 1)
  return out
}

/**
 * The point nearest (x, y) inside the hit ellipse with radii rx, ry (curve units: the widget
 * divides its 22 px touch or 10 px mouse radius by the canvas scale), or −1. Distances are
 * measured in radii, so the ellipse is the hit area; on a periodic curve across the seam too.
 */
export function nearestPoint(points: readonly (readonly [number, number])[], x: number, y: number, rx: number, ry: number,
  domain: CurveDomain = TONE_CURVE): number {
  const period = domain.xMax - domain.xMin
  let best = -1
  let bestDistance = Infinity
  for (let i = 0; i < points.length; i++) {
    let dx = x - points[i][0]
    if (domain.periodic) dx -= period * Math.round(dx / period)
    const dy = y - points[i][1]
    const distance = (dx / rx) ** 2 + (dy / ry) ** 2
    if (distance <= 1 && distance < bestDistance) {
      best = i
      bestDistance = distance
    }
  }
  return best
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/**
 * A curve read from config, a paste or an old save, made valid for its domain. Tolerant: never
 * throws. Malformed points are dropped, x and y clamped, a periodic x wrapped (360° is 0°),
 * points sorted, a tone curve's first and last point moved onto x = 0 and 1, points closer than
 * the gap dropped (the ends win), and the count capped (the ends and the lowest-x interior points
 * are kept). Anything worth telling the user goes to `warnings`, prefixed with `label`. A list
 * that leaves too few points falls back to the domain's defaults.
 */
export function sanitizeCurve(input: unknown, domain: CurveDomain, warnings: string[], label: string): Pt[] {
  const fallback = () => copyPoints(domain.defaults)
  if (input === undefined) return fallback()
  if (!Array.isArray(input)) {
    warnings.push(`${label}: not a list of points, reset`)
    return fallback()
  }
  const period = domain.xMax - domain.xMin
  const points: Pt[] = []
  let malformed = 0
  let clamped = 0
  for (const item of input) {
    if (!Array.isArray(item) || item.length < 2 || !isFiniteNumber(item[0]) || !isFiniteNumber(item[1])) {
      malformed++
      continue
    }
    let x = item[0]
    if (domain.periodic) {
      if (x < domain.xMin || x > domain.xMax) clamped++
      x = wrapX(x, domain)
    } else if (x < domain.xMin || x > domain.xMax) {
      clamped++
      x = clamp(x, domain.xMin, domain.xMax)
    }
    let y = item[1]
    if (y < domain.yMin || y > domain.yMax) {
      clamped++
      y = clamp(y, domain.yMin, domain.yMax)
    }
    points.push([plain(x), plain(y)])
  }
  if (malformed) warnings.push(`${label}: ${malformed} malformed point(s) dropped`)
  if (clamped) warnings.push(`${label}: ${clamped} value(s) outside the range clamped`)
  points.sort((a, b) => a[0] - b[0])
  if (points.length < Math.max(domain.minPoints, domain.periodic ? 0 : 2)) {
    warnings.push(`${label}: fewer than ${domain.minPoints} points, reset`)
    return fallback()
  }
  let dropped = 0
  let out: Pt[]
  if (!domain.periodic) {
    const first = points[0]
    const last = points[points.length - 1]
    if (first[0] !== domain.xMin || last[0] !== domain.xMax) warnings.push(`${label}: ends moved onto x = ${domain.xMin} and ${domain.xMax}`)
    first[0] = domain.xMin
    last[0] = domain.xMax
    out = [first]
    for (let k = 1; k < points.length - 1; k++) {
      const p = points[k]
      if (p[0] - out[out.length - 1][0] >= domain.gap - GAP_EPS && domain.xMax - p[0] >= domain.gap - GAP_EPS) out.push(p)
      else dropped++
    }
    out.push(last)
    if (out.length > domain.maxPoints) {
      warnings.push(`${label}: ${out.length} points, capped at ${domain.maxPoints}`)
      out = [...out.slice(0, domain.maxPoints - 1), last]
    }
  } else {
    out = []
    for (const p of points) {
      if (out.length && p[0] - out[out.length - 1][0] < domain.gap - GAP_EPS) dropped++
      else out.push(p)
    }
    // The seam: the last point against the first one period on.
    while (out.length > 1 && out[0][0] + period - out[out.length - 1][0] < domain.gap - GAP_EPS) {
      out.pop()
      dropped++
    }
    if (out.length > domain.maxPoints) {
      warnings.push(`${label}: ${out.length} points, capped at ${domain.maxPoints}`)
      out = out.slice(0, domain.maxPoints)
    }
  }
  if (dropped) warnings.push(`${label}: ${dropped} point(s) closer than ${domain.gap} to a neighbour dropped`)
  return out
}
