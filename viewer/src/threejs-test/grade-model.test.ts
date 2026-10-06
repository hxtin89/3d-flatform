import { test } from 'node:test'
import assert from 'node:assert/strict'

import { EXPERIENCE_CONFIG } from './config.ts'
import { identityLattice, type CubeLattice } from './cube-format.ts'
import {
  contrastCurve, CURVE_CHANNELS, DEFAULT_GRADE_TUNING, GRADE_RANGES, hexconeHue, isGradeIdentity, luma, NEUTRAL_GRADE,
  parseGradeState, powC1, smoothstep, snapPuck, srgbEotf, srgbOetf, WHEEL_NAMES, wheelChannels, wheelDelta,
  whiteBalanceGains, type GradeRange, type GradeState, type LookRef,
} from './grade-model.ts'

// The config check below runs once config.ts has a `grade` block (plan 4.13), which plan step C3
// adds; without one it is skipped.
const configGrade = (EXPERIENCE_CONFIG as unknown as { grade?: { state?: unknown; tuning?: unknown } }).grade

const fresh = (): GradeState => structuredClone(NEUTRAL_GRADE) as GradeState

/** One-sided slopes by second-order differences, so the O(h) curvature term does not hide a kink. */
const slopeRight = (f: (x: number) => number, x: number, h: number) => (-3 * f(x) + 4 * f(x + h) - f(x + 2 * h)) / (2 * h)
const slopeLeft = (f: (x: number) => number, x: number, h: number) => (3 * f(x) - 4 * f(x - h) + f(x - 2 * h)) / (2 * h)
const closeRelative = (a: number, b: number, rel: number) => Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b)) + 1e-12

/** Every GradeRange in GRADE_RANGES with its path in the state; `look` is the LookRef's, not the state's. */
function rangePaths(node: unknown, path: string[] = []): Array<{ path: string[]; range: GradeRange }> {
  if (node === null || typeof node !== 'object') return []
  if ('step' in node && 'default' in node && 'min' in node && 'max' in node) return [{ path, range: node as GradeRange }]
  return Object.entries(node).flatMap(([key, child]) => key === 'look' ? [] : rangePaths(child, [...path, key]))
}

function setPath(state: GradeState, path: string[], value: number) {
  let target = state as unknown as Record<string, unknown>
  for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown>
  target[path[path.length - 1]] = value
}

/** What every parsed state must satisfy, whatever went in. */
function assertValidState(state: GradeState, label: string) {
  assert.equal(state.version, 1, label)
  for (const { path, range } of rangePaths(GRADE_RANGES)) {
    let value: unknown = state
    for (const key of path) value = (value as Record<string, unknown>)[key]
    assert.ok(typeof value === 'number' && value >= range.min && value <= range.max, `${label}: ${path.join('.')} = ${value}`)
  }
  const pucks = [...WHEEL_NAMES.map((name) => state[name]), state.tones.shadows, state.tones.highlights]
  for (const puck of pucks) {
    const r = Math.hypot(puck.u, puck.v)
    assert.ok(r === 0 || (r >= 0.02 && r <= 1 + 1e-12), `${label}: puck radius ${r}`)
  }
  for (const channel of CURVE_CHANNELS) {
    const points = state.curves[channel]
    assert.ok(points.length >= 2 && points.length <= 12, `${label}: ${channel} count`)
    assert.equal(points[0][0], 0)
    assert.equal(points[points.length - 1][0], 1)
    for (let k = 1; k < points.length; k++) assert.ok(points[k][0] - points[k - 1][0] >= 0.01 - 1e-9, `${label}: ${channel} gap`)
    for (const [, y] of points) assert.ok(y >= 0 && y <= 1)
  }
  for (const [points, lo, hi] of [[state.hueSat, 0, 2], [state.hueLuma, -1, 1]] as const) {
    assert.ok(points.length <= 12, `${label}: hue count`)
    for (let k = 0; k < points.length; k++) {
      const [x, y] = points[k]
      assert.ok(x >= 0 && x < 360 && y >= lo && y <= hi, `${label}: hue point ${x}, ${y}`)
      const next = k + 1 < points.length ? points[k + 1][0] : points[0][0] + 360
      if (points.length > 1) assert.ok(next - x >= 3.6 - 1e-9, `${label}: hue gap`)
    }
  }
}

test('NEUTRAL_GRADE is identity, frozen, and what parseGradeState({}) gives', () => {
  assert.equal(isGradeIdentity(NEUTRAL_GRADE, null), true)
  assert.ok(Object.isFrozen(NEUTRAL_GRADE) && Object.isFrozen(NEUTRAL_GRADE.curves.master[0]) && Object.isFrozen(NEUTRAL_GRADE.tones.shadows))
  for (const input of [{}, undefined]) {
    const { state, warnings } = parseGradeState(input)
    assert.deepEqual(state, NEUTRAL_GRADE)
    assert.deepEqual(warnings, [])
    assert.notEqual(state.curves.master, NEUTRAL_GRADE.curves.master, 'nothing shared with the frozen neutral')
    state.curves.master.push([0.5, 0.5])
    state.lift.u = 0.5
    assert.equal(NEUTRAL_GRADE.curves.master.length, 2)
  }
  assert.equal(NEUTRAL_GRADE.pivot, 0.4614)
  assert.ok(Math.abs(srgbOetf(0.18) - NEUTRAL_GRADE.pivot) < 5e-5, 'the pivot is 18 % grey')
  assert.equal(Math.round(NEUTRAL_GRADE.pivot * 255), 118)
})

test('the config\'s grade state is identity and its tuning is DEFAULT_GRADE_TUNING', { skip: configGrade === undefined && 'config.grade not added yet' }, () => {
  const { state, warnings } = parseGradeState(configGrade!.state)
  assert.deepEqual(warnings, [])
  assert.equal(isGradeIdentity(state, null), true)
  assert.deepEqual(state, NEUTRAL_GRADE)
  assert.deepEqual(configGrade!.tuning, { ...DEFAULT_GRADE_TUNING })
})

test('isGradeIdentity: each field one step off neutral is not identity, table-driven over GRADE_RANGES', () => {
  const paths = rangePaths(GRADE_RANGES)
  assert.deepEqual(paths.map((p) => p.path.join('.')).sort(), [
    'contrast', 'gain.y', 'gamma.y', 'lift.y', 'offset.y', 'pivot', 'rollOff', 'saturation', 'temperature', 'tint',
    'tones.balance', 'tones.blending', 'vibrance',
  ], 'a new range needs a row here')
  // These do nothing while the rest is neutral, so they alone leave the bake the identity lattice
  // bit for bit: pivot (contrast 1 is skipped), balance and blending (both Tones pucks at 0 add
  // exactly 0), rollOff (nothing above 1).
  const inert = new Set(['pivot', 'tones.balance', 'tones.blending', 'rollOff'])
  for (const { path, range } of paths) {
    assert.ok(range.min <= range.default && range.default <= range.max && range.step > 0, path.join('.'))
    for (const direction of [1, -1]) {
      const value = range.default + direction * range.step
      if (value < range.min || value > range.max) continue
      const state = fresh()
      setPath(state, path, value)
      assert.equal(isGradeIdentity(state, null), inert.has(path.join('.')), `${path.join('.')} = ${value}`)
    }
  }
  // Each puck, both axes, just past the snap radius.
  for (const name of WHEEL_NAMES) {
    for (const axis of ['u', 'v'] as const) {
      const state = fresh()
      state[name][axis] = 0.021
      assert.equal(isGradeIdentity(state, null), false, `${name}.${axis}`)
    }
  }
  for (const tone of ['shadows', 'highlights'] as const) {
    for (const axis of ['u', 'v'] as const) {
      const state = fresh()
      state.tones[tone][axis] = -0.021
      assert.equal(isGradeIdentity(state, null), false, `tones.${tone}.${axis}`)
    }
  }
  // One added curve point, or a moved end, on each channel.
  for (const channel of CURVE_CHANNELS) {
    const added = fresh()
    added.curves[channel] = [[0, 0], [0.5, 0.52], [1, 1]]
    assert.equal(isGradeIdentity(added, null), false, `curves.${channel} point`)
    const end = fresh()
    end.curves[channel] = [[0, 0.01], [1, 1]]
    assert.equal(isGradeIdentity(end, null), false, `curves.${channel} end`)
  }
  // One hue point off neutral.
  const sat = fresh()
  sat.hueSat = [[100, 1.01]]
  assert.equal(isGradeIdentity(sat, null), false)
  const lumaCurve = fresh()
  lumaCurve.hueLuma = [[100, -0.01]]
  assert.equal(isGradeIdentity(lumaCurve, null), false)
})

test('isGradeIdentity: rollOff alone, inert controls and hue points exactly at neutral are identity; the look decides too', () => {
  const rolled = fresh()
  rolled.rollOff = 1
  assert.equal(isGradeIdentity(rolled, null), true)
  const flat = fresh()
  flat.hueSat = [[0, 1], [120, 1], [240, 1]]
  flat.hueLuma = [[60, 0]]
  flat.pivot = 0.3
  flat.tones.balance = -1
  flat.tones.blending = 1
  assert.equal(isGradeIdentity(flat, null), true)
  // Pivot is inert only at contrast 1: with contrast on it moves the curve.
  assert.notEqual(contrastCurve(0.3, 1.25, 0.3), contrastCurve(0.3, 1.25, NEUTRAL_GRADE.pivot))
  // The look: null, at amount 0, or a known identity lattice keeps it identity.
  assert.equal(isGradeIdentity(NEUTRAL_GRADE, { amount: 0 }), true)
  assert.equal(isGradeIdentity(NEUTRAL_GRADE, { amount: 1, isIdentity: true }), true)
  assert.equal(isGradeIdentity(NEUTRAL_GRADE, { amount: 1 }), false, 'an unchecked look counts as a change')
  assert.equal(isGradeIdentity(NEUTRAL_GRADE, { amount: 0.01, isIdentity: false }), false)
  const ref: LookRef = { key: 'k', name: 'Kodak', file: null, size: 33, amount: 1 }
  assert.equal(isGradeIdentity(NEUTRAL_GRADE, ref), false, 'a LookRef fits')
  assert.equal(isGradeIdentity(NEUTRAL_GRADE, { amount: -0.5 }), true, 'below 0 is no look, as the bake clamps it')
  // A look that carries its lattice (grade-bake.ts's GradeLook) is checked here, domain-aware.
  const unit: CubeLattice = { data: identityLattice(9), size: 9, domainMin: [0, 0, 0], domainMax: [1, 1, 1] }
  assert.equal(isGradeIdentity(NEUTRAL_GRADE, { cube: unit, amount: 1 }), true, 'an identity cube')
  const near = unit.data.slice()
  near[100] += 5e-6
  assert.equal(isGradeIdentity(NEUTRAL_GRADE, { cube: { ...unit, data: near }, amount: 1 }), true, 'within 1e-5')
  const off = unit.data.slice()
  off[100] += 1e-4
  const offCube = { ...unit, data: off }
  assert.equal(isGradeIdentity(NEUTRAL_GRADE, { cube: offCube, amount: 0.3 }), false, 'a real look')
  assert.equal(isGradeIdentity(NEUTRAL_GRADE, { cube: offCube, amount: 0 }), true, 'at amount 0')
  assert.equal(isGradeIdentity(NEUTRAL_GRADE, { cube: offCube, amount: 1, isIdentity: true }), true, 'a known flag wins')
  // The identity lattice of a wider domain is no look either; the same data read as unit is one.
  const wide: CubeLattice = {
    data: unit.data.map((x) => -0.1 + x * 1.3), size: 9, domainMin: [-0.1, -0.1, -0.1], domainMax: [1.2, 1.2, 1.2],
  }
  assert.equal(isGradeIdentity(NEUTRAL_GRADE, { cube: wide, amount: 1 }), true)
  assert.equal(isGradeIdentity(NEUTRAL_GRADE, { cube: { ...wide, domainMin: [0, 0, 0], domainMax: [1, 1, 1] }, amount: 1 }), false)
  // The identity lattice of a narrower domain is a look: it clamps black up to 0.1 and white down
  // to 0.9, so the grade cannot be compiled out.
  const narrow: CubeLattice = {
    data: unit.data.map((x) => 0.1 + x * 0.8), size: 9, domainMin: [0.1, 0.1, 0.1], domainMax: [0.9, 0.9, 0.9],
  }
  assert.equal(isGradeIdentity(NEUTRAL_GRADE, { cube: narrow, amount: 1 }), false, 'a domain inside [0, 1]')
  // The state still decides first.
  const warm = fresh()
  warm.temperature = 1
  assert.equal(isGradeIdentity(warm, { cube: unit, amount: 1 }), false)
})

test('parseGradeState clamps, snaps and reports', () => {
  const { state, warnings } = parseGradeState({
    temperature: 500, tint: -101, gain: { y: 0.1 }, gamma: { y: 3, u: 0.3, v: -0.2 }, contrast: -3, pivot: 0.9,
    saturation: 2.5, vibrance: -7, tones: { blending: 3, balance: -2, shadows: { u: 0.01, v: 0.01 }, highlights: { u: 3, v: 4 } },
    rollOff: 1.5, lift: { u: 0.019, v: 0 }, offset: { y: -0.3, u: 0.021 },
  })
  assert.equal(state.temperature, 100)
  assert.equal(state.tint, -100)
  assert.equal(state.gain.y, 0.5)
  assert.deepEqual(state.gamma, { y: 1, u: 0.3, v: -0.2 })
  assert.equal(state.contrast, 0.5)
  assert.equal(state.pivot, 0.7)
  assert.equal(state.saturation, 2)
  assert.equal(state.vibrance, -1)
  assert.equal(state.tones.blending, 1)
  assert.equal(state.tones.balance, -1)
  assert.deepEqual(state.tones.shadows, { u: 0, v: 0 }, 'snapped home under 0.02')
  assert.ok(Math.abs(state.tones.highlights.u - 0.6) < 1e-15 && Math.abs(state.tones.highlights.v - 0.8) < 1e-15, 'onto the rim')
  assert.equal(state.rollOff, 1)
  assert.deepEqual(state.lift, { y: 0, u: 0, v: 0 })
  assert.deepEqual(state.offset, { y: -0.25, u: 0.021, v: 0 })
  assert.equal(warnings.length, 13, warnings.join('\n'))
  assertValidState(state, 'clamped')
})

test('parseGradeState sorts curves, drops close points, pins ends and caps at 12', () => {
  const twenty = Array.from({ length: 20 }, (_, i) => [i / 19, Math.sqrt(i / 19)])
  const { state, warnings } = parseGradeState({
    curves: {
      master: [[1, 1], [0.5, 0.7], [0, 0]],
      red: [[0, 0], [0.5, 0.5], [0.505, 0.6], [1, 1]],
      green: [[0.1, 0.2], [0.9, 0.8]],
      blue: twenty,
    },
    hueSat: [[370, 1.2], [360, 0.5], [180, 1.4]],
    hueLuma: Array.from({ length: 20 }, (_, i) => [i * 18, 0.1]),
  })
  assert.deepEqual(state.curves.master, [[0, 0], [0.5, 0.7], [1, 1]])
  assert.deepEqual(state.curves.red, [[0, 0], [0.5, 0.5], [1, 1]])
  assert.deepEqual(state.curves.green, [[0, 0.2], [1, 0.8]])
  assert.equal(state.curves.blue.length, 12)
  assert.deepEqual(state.curves.blue[11], [1, 1])
  assert.deepEqual(state.hueSat, [[0, 0.5], [10, 1.2], [180, 1.4]], '360° is 0°, 370° is 10°')
  assert.equal(state.hueLuma.length, 12)
  assert.ok(warnings.some((w) => w.startsWith('curves.red')))
  assert.ok(warnings.some((w) => w.startsWith('curves.green')))
  assert.ok(warnings.some((w) => w.startsWith('curves.blue')))
  assert.ok(warnings.some((w) => w.startsWith('hueLuma')))
  assert.ok(!warnings.some((w) => w.startsWith('curves.master')), 'sorting alone is not a warning')
  assertValidState(state, 'curves')
})

test('parseGradeState ignores unknown keys and other versions, with a warning', () => {
  const { state, warnings } = parseGradeState({
    version: 2, saturaton: 1.4, lift: { y: 0, w: 1 }, curves: { alpha: [[0, 0], [1, 1]] }, tones: { mid: { u: 1 } },
  })
  assert.deepEqual(state, NEUTRAL_GRADE)
  for (const key of ['version', 'saturaton', 'lift.w', 'curves.alpha', 'tones.mid']) {
    assert.ok(warnings.some((w) => w.startsWith(key)), `${key}: ${warnings.join(' | ')}`)
  }
})

test('parseGradeState never throws on junk, and what comes out is always valid', () => {
  const cyclic: Record<string, unknown> = { temperature: 10 }
  cyclic.lift = cyclic
  cyclic.curves = { master: [cyclic, [0.5, 0.5]] }
  const getter = { get temperature(): number { throw new Error('no') } }
  const proxy = new Proxy({}, { get() { throw new Error('no') }, ownKeys() { throw new Error('no') } })
  const bare = Object.assign(Object.create(null), { contrast: 1.5 })
  const junk: unknown[] = [
    null, 0, 'grade', [], [1, 2], true, Symbol('s'), () => 1, 10n,
    { lift: 5 }, { lift: [1, 2, 3] }, { lift: { y: 'a', u: Number.NaN, v: Infinity } },
    { temperature: '12' }, { temperature: Number.NaN }, { temperature: -Infinity }, { temperature: 10n }, { temperature: {} },
    { curves: 5 }, { curves: [] }, { curves: { master: 'x' } }, { curves: { master: [[Number.NaN, 1], 'a', [0.5], null, [0.2, 0.3, 9]] } },
    { hueSat: {} }, { hueSat: [[Number.NaN, 1]] }, { hueLuma: [[10, 5], [12, -5]] },
    { tones: [] }, { tones: { shadows: 7, highlights: [1] } }, { tones: { balance: 'left' } },
    cyclic, getter, proxy,
  ]
  junk.forEach((input, index) => {
    // Labels by index: String() of the throwing Proxy would throw in the test itself.
    let result: ReturnType<typeof parseGradeState> | undefined
    assert.doesNotThrow(() => { result = parseGradeState(input) }, `junk ${index}`)
    assertValidState(result!.state, `junk ${index}`)
    assert.ok(result!.warnings.length > 0, `a warning for junk ${index}`)
  })
  const { state, warnings } = parseGradeState(bare)
  assert.equal(state.contrast, 1.5, 'a null-prototype object reads like any other')
  assert.deepEqual(warnings, [])
})

test('parseGradeState survives a JSON round trip deep-equal, with no warnings the second time', () => {
  const busy = parseGradeState({
    temperature: 23, tint: -7, lift: { y: -0.02, u: 0.1, v: -0.3 }, gamma: { y: 0.15, u: -0.4, v: 0.05 },
    gain: { y: 1.2, u: 0.2, v: 0.2 }, offset: { y: 0.01, u: -0.05, v: 0.06 }, contrast: 1.3, pivot: 0.42, saturation: 1.15,
    vibrance: 0.25, curves: { master: [[0, 0.02], [0.25, 0.2], [0.75, 0.82], [1, 0.97]], red: [[0, 0], [0.5, 0.53], [1, 1]] },
    hueSat: [[95, 1.2], [210, 0.8]], hueLuma: [[100, -0.2]],
    tones: { shadows: { u: 0.3, v: -0.1 }, highlights: { u: -0.2, v: 0.25 }, balance: 0.1, blending: 0.7 }, rollOff: 0.4,
  })
  assert.deepEqual(busy.warnings, [])
  assert.equal(isGradeIdentity(busy.state, null), false)
  const again = parseGradeState(JSON.parse(JSON.stringify(busy.state)))
  assert.deepEqual(again.state, busy.state)
  assert.deepEqual(again.warnings, [])
  // Also for what a clamp produced.
  const clamped = parseGradeState({ gain: { y: 9, u: 5, v: -5 }, curves: { blue: [[0.2, 0.3], [0.21, 0.4], [0.9, 2]] } }).state
  const clampedAgain = parseGradeState(JSON.parse(JSON.stringify(clamped)))
  assert.deepEqual(clampedAgain.state, clamped)
  assert.deepEqual(clampedAgain.warnings, [])
})

test('wheelDelta: zero luma, unit blue, the signs, and where the primaries sit', () => {
  let worstLuma = 0
  let worstComponent = 0
  for (let i = 0; i < 3600; i++) {
    const a = (i / 3600) * 2 * Math.PI
    for (const r of [1, 0.37]) {
      const [dr, dg, db] = wheelDelta(r * Math.cos(a), r * Math.sin(a))
      worstLuma = Math.max(worstLuma, Math.abs(luma(dr, dg, db)))
      if (r === 1) worstComponent = Math.max(worstComponent, Math.abs(dr), Math.abs(dg), Math.abs(db))
    }
  }
  assert.ok(worstLuma < 1e-12, `luma ${worstLuma}`)
  assert.ok(worstComponent <= 1 + 1e-12)
  assert.deepEqual(wheelDelta(1, 0).map(Math.abs).reduce((a, b) => Math.max(a, b)), 1)
  assert.equal(wheelDelta(1, 0)[2], 1, 'blue at u = 1 is exactly 1')
  assert.ok(wheelDelta(0, 0.5)[0] > 0, '+v adds red')
  assert.ok(wheelDelta(0.5, 0)[2] > 0, '+u adds blue')
  assert.deepEqual(wheelDelta(0, 0).map((x) => x + 0), [0, 0, 0])
  // The plan's rounded coefficients, to their 5 digits.
  const [r1, g1] = wheelDelta(0, 1)
  const [, g2] = wheelDelta(1, 0)
  assert.ok(Math.abs(r1 - 1.5748 / 1.8556) < 1e-12)
  assert.ok(Math.abs(g1 - -0.46812 / 1.8556) < 1e-5)
  assert.ok(Math.abs(g2 - -0.18732 / 1.8556) < 1e-5)
  // Angle (from +u towards +v) at which the tint is a pure primary: two channels equal, the third
  // highest. Independently, that is the primary's own (Cb, Cr) direction.
  const angleOf = (target: number) => {
    let best = 0
    let bestError = Infinity
    for (let i = 0; i < 360_00; i++) {
      const a = i / 100
      const d = wheelDelta(Math.cos(a * Math.PI / 180), Math.sin(a * Math.PI / 180))
      const error = Math.abs(((hexconeHue(0.5 + d[0], 0.5 + d[1], 0.5 + d[2]) - target + 540) % 360) - 180)
      if (error < bestError) {
        bestError = error
        best = a
      }
    }
    return best
  }
  const primaryAngle = (r: number, g: number, b: number) => {
    const y = luma(r, g, b)
    const degrees = Math.atan2((r - y) / 1.5748, (b - y) / 1.8556) * 180 / Math.PI
    return degrees < 0 ? degrees + 360 : degrees
  }
  // The plan lists 103 / 241 / 347°, the NTSC Y'UV vectorscope's figures; this Rec.709 Y'CbCr
  // wheel puts green and blue at 229.7° and 354.8°.
  for (const [hue, rgb, expected] of [[0, [1, 0, 0], 103], [120, [0, 1, 0], 229.7], [240, [0, 0, 1], 354.8]] as const) {
    const found = angleOf(hue)
    const own = primaryAngle(rgb[0], rgb[1], rgb[2])
    assert.ok(Math.abs(found - expected) <= 1, `hue ${hue} at ${found}°`)
    assert.ok(Math.abs(found - own) < 0.02, `hue ${hue}: ${found} vs ${own}`)
  }
})

test('snapPuck: home under 0.02, kept above, onto the rim beyond 1, 0 for non-numbers', () => {
  assert.deepEqual(snapPuck(0.019, 0), { u: 0, v: 0 })
  assert.deepEqual(snapPuck(0.021, 0), { u: 0.021, v: 0 })
  assert.deepEqual(snapPuck(0.014, -0.014), { u: 0, v: 0 }, 'by radius, not per axis')
  assert.deepEqual(snapPuck(-0.5, 0.5), { u: -0.5, v: 0.5 })
  const rim = snapPuck(3, -4)
  assert.ok(Math.abs(rim.u - 0.6) < 1e-15 && Math.abs(rim.v + 0.8) < 1e-15)
  assert.deepEqual(snapPuck(Number.NaN, 0.5), { u: 0, v: 0 })
  assert.deepEqual(snapPuck(-0, 0.3), { u: 0, v: 0.3 })
  assert.ok(Object.is(snapPuck(-0, 0.3).u, 0), 'no −0')
})

test('powC1: ends fixed, the identity at g = 1, monotone and C1 at the toe and at 0', () => {
  const E = 1 / 64
  for (const g of [0.5, 0.71, 1, 1.25, 1.41, 2]) {
    assert.equal(powC1(0, g), 0, `f(0) at ${g}`)
    assert.equal(powC1(1, g), 1, `f(1) at ${g}`)
    assert.equal(powC1(0.5, g), 0.5 ** g, 'a plain power above the toe')
  }
  let differing = 0
  for (let i = 0; i < 10_000; i++) {
    const t = -0.5 + (2 * i) / 9_999
    if (!Object.is(powC1(t, 1), t)) differing++
  }
  for (const t of [E, E / 3, -E / 7, 1e-9, -1e-9]) if (!Object.is(powC1(t, 1), t)) differing++
  assert.equal(differing, 0, 'bitwise identity at g = 1')
  for (const g of [0.5, 0.71, 1.25, 2]) {
    const f = (t: number) => powC1(t, g)
    let previous = -Infinity
    let dips = 0
    for (let i = 0; i <= 20_000; i++) {
      const y = f(-0.5 + (2 * i) / 20_000)
      if (y < previous) dips++
      previous = y
    }
    assert.equal(dips, 0, `monotone at ${g}`)
    for (const at of [E, 0]) {
      const h = 1e-7
      const left = slopeLeft(f, at, h)
      const right = slopeRight(f, at, h)
      assert.ok(closeRelative(left, right, 1e-4), `g ${g}: slope at ${at}: ${left} vs ${right}`)
    }
    assert.ok(closeRelative(slopeRight(f, E, 1e-7), g * E ** (g - 1), 1e-4), 'the power\'s own slope at E')
  }
})

test('contrastCurve: identity at 1, 0 p 1 fixed, slope c at the pivot, the linear fade below 1', () => {
  for (const p of [0.2, 0.4614, 0.7]) {
    let differing = 0
    for (let i = 0; i < 10_000; i++) {
      const x = -0.25 + (1.75 * i) / 9_999
      if (!Object.is(contrastCurve(x, 1, p), x)) differing++
    }
    assert.equal(differing, 0, `bitwise identity at c = 1, p ${p}`)
    for (const c of [1.25, 2]) {
      assert.equal(contrastCurve(0, c, p), 0)
      assert.equal(contrastCurve(p, c, p), p)
      assert.equal(contrastCurve(1, c, p), 1)
      const f = (x: number) => contrastCurve(x, c, p)
      const h = 1e-6
      assert.ok(Math.abs(slopeLeft(f, p, h) - c) < 1e-5, `slope below p, c ${c}`)
      assert.ok(Math.abs(slopeRight(f, p, h) - c) < 1e-5, `slope above p, c ${c}`)
      assert.ok(f(p / 2) < p / 2 && f((1 + p) / 2) > (1 + p) / 2, 'an S: darker below the pivot, brighter above')
      // Near 1 the values are near 1, so a step much under 1e-5 drowns the slope in rounding.
      for (const at of [0, 1]) {
        const left = slopeLeft(f, at, 1e-5)
        const right = slopeRight(f, at, 1e-5)
        assert.ok(Math.abs(left - right) < 1e-4 * Math.max(Math.abs(left), Math.abs(right)) + 1e-9, `C1 at ${at}: ${left} vs ${right}`)
      }
      let dips = 0
      let previous = -Infinity
      for (let i = 0; i <= 10_000; i++) {
        const y = f(-0.25 + (1.75 * i) / 10_000)
        if (y < previous) dips++
        previous = y
      }
      assert.equal(dips, 0, 'monotone')
    }
    for (const c of [0.5, 0.8]) {
      for (const x of [-0.1, 0, 0.3, p, 0.9, 1, 1.2]) assert.equal(contrastCurve(x, c, p), p + c * (x - p))
      assert.ok(Math.abs(contrastCurve(0, c, p) - p * (1 - c)) < 1e-15, 'black rises to p(1 − c)')
    }
  }
})

test('whiteBalanceGains: grey keeps its luminance, (0, 0) is exact, the signs and the stops', () => {
  assert.deepEqual(whiteBalanceGains(0, 0), [1, 1, 1])
  for (let temperature = -100; temperature <= 100; temperature += 12.5) {
    for (let tint = -100; tint <= 100; tint += 12.5) {
      const w = whiteBalanceGains(temperature, tint)
      assert.ok(Math.abs(luma(w[0], w[1], w[2]) - 1) < 1e-12, `luma at ${temperature}, ${tint}`)
    }
  }
  const warm = whiteBalanceGains(40, 0)
  assert.ok(warm[0] > 1 && warm[2] < 1, 'temperature > 0: red up, blue down')
  const cool = whiteBalanceGains(-40, 0)
  assert.ok(cool[0] < 1 && cool[2] > 1)
  const magenta = whiteBalanceGains(0, 30)
  assert.ok(magenta[1] < 1 && magenta[0] > 1 && magenta[2] > 1, 'tint > 0: green down')
  assert.ok(whiteBalanceGains(0, -30)[1] > 1)
  // At +100, kTemp 0.5 puts red one stop over blue; kTint 0.4 puts red 0.4 stops over green.
  const full = whiteBalanceGains(100, 0)
  assert.ok(Math.abs(full[0] / full[2] - 2) < 1e-12)
  const tinted = whiteBalanceGains(0, 100)
  assert.ok(Math.abs(tinted[0] / tinted[1] - 2 ** 0.4) < 1e-12)
  assert.ok(Math.abs(tinted[0] - tinted[2]) < 1e-15)
  const tuned = whiteBalanceGains(100, 0, { ...DEFAULT_GRADE_TUNING, tempStops: 1 })
  assert.ok(Math.abs(tuned[0] / tuned[2] - 4) < 1e-12, 'the tuning is used')
})

test('wheelChannels: exactly y at a neutral puck, the per-channel parameters, gamma clamped', () => {
  for (const name of WHEEL_NAMES) {
    const y = GRADE_RANGES[name].y.default + 0.1
    assert.deepEqual(wheelChannels(name, { y, u: 0, v: 0 }), [y, y, y], name)
  }
  const blue = (name: (typeof WHEEL_NAMES)[number], y: number) => wheelChannels(name, { y, u: 1, v: 0 })
  assert.ok(Math.abs(blue('lift', 0.02)[2] - 0.12) < 1e-15, 'lift: y + 0.1·Δ̂')
  assert.ok(Math.abs(blue('offset', 0)[2] - 0.1) < 1e-15)
  assert.ok(Math.abs(blue('gain', 1.2)[2] - 1.2 * 1.25) < 1e-15, 'gain: y·(1 + 0.25·Δ̂)')
  const gamma = blue('gamma', 0.9)
  assert.equal(gamma[2], 1, 'gamma clamped to ±1')
  assert.equal(gamma[0], 0.9)
  assert.ok(gamma[1] < 0.9)
})

test('srgbEotf and srgbOetf: an exact pair, odd, the textbook values', () => {
  let worst = 0
  for (let i = 0; i <= 100_000; i++) {
    const x = -1.5 + (3 * i) / 100_000
    worst = Math.max(worst, Math.abs(srgbOetf(srgbEotf(x)) - x), Math.abs(srgbEotf(srgbOetf(x)) - x))
  }
  // Right at the threshold too, where the textbook 0.0031308 would leave 3e-8.
  for (const x of [0.04045, 0.04045 + 1e-12, 0.04045 - 1e-12, 0.0031308, 0.04045 / 12.92]) {
    worst = Math.max(worst, Math.abs(srgbOetf(srgbEotf(x)) - x), Math.abs(srgbEotf(srgbOetf(x)) - x))
  }
  assert.ok(worst < 1e-12, `round trip ${worst}`)
  for (const x of [0.001, 0.03, 0.04045, 0.2, 0.5, 1, 1.3]) {
    assert.equal(srgbEotf(-x), -srgbEotf(x))
    assert.equal(srgbOetf(-x), -srgbOetf(x))
  }
  assert.equal(srgbEotf(0.02), 0.02 / 12.92)
  assert.equal(srgbEotf(1), 1)
  assert.ok(Math.abs(srgbOetf(1) - 1) < 1e-15)
  assert.ok(Math.abs(srgbEotf(0.5) - 0.214041140482232) < 1e-12)
  assert.ok(Math.abs(srgbOetf(0.18) - 0.461356129500442) < 1e-12)
  assert.ok(srgbEotf(0.04045 - 1e-9) < srgbEotf(0.04045) && srgbEotf(0.04045) < srgbEotf(0.04045 + 1e-9), 'monotone at the joint')
})

test('hexconeHue and smoothstep', () => {
  assert.equal(hexconeHue(1, 0, 0), 0)
  assert.equal(hexconeHue(1, 1, 0), 60)
  assert.equal(hexconeHue(0, 1, 0), 120)
  assert.equal(hexconeHue(0, 1, 1), 180)
  assert.equal(hexconeHue(0, 0, 1), 240)
  assert.equal(hexconeHue(1, 0, 1), 300)
  assert.equal(hexconeHue(0.4, 0.4, 0.4), 0, 'grey')
  const nearRed = hexconeHue(1, 0, 0.001)
  assert.ok(nearRed > 359.9 && nearRed < 360)
  // The canopy's measured band, 90–108°: a green with a little more red than blue.
  const canopy = hexconeHue(24 / 255, 51 / 255, 3 / 255)
  assert.ok(canopy > 90 && canopy < 108, `canopy ${canopy}`)
  assert.equal(smoothstep(0, 1, 0.5), 0.5)
  assert.equal(smoothstep(0, 0.05, -1), 0)
  assert.equal(smoothstep(0, 0.05, 1), 1)
  assert.ok(Math.abs(smoothstep(0, 0.05, 0.0125) - 0.15625) < 1e-15)
})
