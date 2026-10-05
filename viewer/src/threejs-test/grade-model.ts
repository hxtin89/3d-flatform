// The colour grade's model (goal 4): the state the Colour grade section edits, the one table of
// its ranges and defaults, the tolerant reader for config, pastes and saves, the identity test
// that decides whether the grade is compiled in, and the small formulas grade-bake.ts builds its
// lattice from — pure maths, no three, no DOM, so it runs under `node --test`
// (grade-model.test.ts). The curves live in grade-curves.ts.
//
// Display-referred: a value is the sRGB-encoded colour of the displayed frame, after the film
// look (tone-mapping.ts), in [0, 1]; the grade runs on it as a 3D LUT in the output pass. Y' is
// Rec.709 luma on the values at hand, the same weights as the film and the point grade.
import { isIdentityLattice, type CubeLattice } from './cube-format.ts'
import {
  HUE_LUMA_CURVE, HUE_SAT_CURVE, isDefaultToneCurve, isNeutralHueCurve, sanitizeCurve, TONE_CURVE, type Pt,
} from './grade-curves.ts'

export type { CurveDomain, Pt } from './grade-curves.ts'

/** A colour puck in the unit disc: u towards Cb (blue, to the right on screen), v towards Cr
 *  (red, up on screen, so v = −puck y). (0, 0) is neutral. */
export interface Puck {
  u: number
  v: number
}

/** A primary wheel: its puck and its master value y, the range under the wheel. */
export interface Wheel extends Puck {
  y: number
}

export type WheelName = 'lift' | 'gamma' | 'gain' | 'offset'
export const WHEEL_NAMES: readonly WheelName[] = Object.freeze(['lift', 'gamma', 'gain', 'offset'] as const)

export type CurveChannel = 'master' | 'red' | 'green' | 'blue'
export const CURVE_CHANNELS: readonly CurveChannel[] = Object.freeze(['master', 'red', 'green', 'blue'] as const)

export interface GradeCurves {
  master: Pt[]
  red: Pt[]
  green: Pt[]
  blue: Pt[]
}

/** Split toning: a shadow and a highlight puck, where the split sits (balance) and how wide the
 *  hand-over is (blending). */
export interface GradeTones {
  shadows: Puck
  highlights: Puck
  balance: number
  blending: number
}

/** GradeState v1. Ranges and defaults: GRADE_RANGES; the meaning of each field: plan section 2. */
export interface GradeState {
  version: 1
  /** + warmer (Lightroom's sign), −100..100. */
  temperature: number
  /** + magenta, −100..100. */
  tint: number
  lift: Wheel
  /** y is log2 of the gamma; + brightens the mids. */
  gamma: Wheel
  gain: Wheel
  offset: Wheel
  contrast: number
  /** Contrast pivot as a display value; 0.4614 = OETF(0.18), sRGB code 118. */
  pivot: number
  saturation: number
  vibrance: number
  curves: GradeCurves
  /** [hue°, saturation factor] points; empty = flat at 1. */
  hueSat: Pt[]
  /** [hue°, stops] points; empty = flat at 0. */
  hueLuma: Pt[]
  tones: GradeTones
  /** Softens what the grade pushes past white; does nothing at a neutral grade. */
  rollOff: number
}

/** An imported or configured .cube look, held beside the state (not inside it); the undo
 *  history stores the two together. `key` names the parsed lattice the worker holds. */
export interface LookRef {
  key: string
  name: string
  /** The file under public/grades/, or null for a look imported in this session only. */
  file: string | null
  size: number
  /** 0..1, default 1: v = x + amount·(C(x) − x). */
  amount: number
}

/**
 * What isGradeIdentity needs to know about a look. `isIdentity` is the result of the cube's
 * isIdentityLattice(cube, 1e-5) (cube-format.ts), set by whoever parsed it (the worker's parse
 * result). Without it, a `cube` is checked here: grade-bake.ts's GradeLook { cube, amount } fits
 * as is, which is what the main-thread fallback holds. With neither, a look at an amount above 0
 * counts as a change and keeps the grade compiled in; a LookRef fits as is that way.
 */
export interface LookIdentity {
  readonly amount: number
  readonly isIdentity?: boolean
  readonly cube?: CubeLattice
}

/** How far a look's nodes may sit from their inputs and still count as no look (plan 2.5). */
const LOOK_IDENTITY_EPS = 1e-5

/** The grade's tuning constants (config grade.tuning), the k* of the plan. */
export interface GradeTuning {
  /** kTemp: stops of red up and blue down at temperature +100. */
  tempStops: number
  /** kTint: stops of green down (red and blue up by half as much) at tint +100. */
  tintStops: number
  /** kLift, kGamma, kGain, kOffset: how far a puck at radius 1 moves its wheel per channel. */
  liftChroma: number
  gammaChroma: number
  gainChroma: number
  offsetChroma: number
  /** kTone: how far a Tones puck at radius 1 tints. */
  toneChroma: number
  /** kHueGate: chroma under which hue curves fade out, so greys and haze never move. */
  hueChromaGate: number
  /** kVib: the relative chroma at which vibrance has half its effect. */
  vibranceChroma: number
  /** kGamut: where the soft gamut compression starts, as a distance from the brightest channel. */
  gamutThreshold: number
  /** kRollKnee: the roll-off knee drops from 1 by this much at rollOff 1. */
  rollOffKnee: number
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/** Equal to config grade.tuning (config.ts, plan 4.13); grade-model.test.ts checks the two agree. */
export const DEFAULT_GRADE_TUNING: Readonly<GradeTuning> = Object.freeze({
  tempStops: 0.5,
  tintStops: 0.4,
  liftChroma: 0.1,
  gammaChroma: 0.5,
  gainChroma: 0.25,
  offsetChroma: 0.1,
  toneChroma: 0.1,
  hueChromaGate: 0.05,
  vibranceChroma: 0.3,
  gamutThreshold: 0.8,
  rollOffKnee: 0.3,
})

/** One slider's limits. `default` is also the neutral value: every v1 default changes nothing. */
export interface GradeRange {
  readonly min: number
  readonly max: number
  readonly step: number
  readonly default: number
}

const range = (min: number, max: number, step: number, value: number): GradeRange => ({ min, max, step, default: value })

/**
 * The one table of limits, steps and defaults the editor's controls and parseGradeState read.
 * Scalar entries sit at the state's own path (`lift.y`, `tones.balance`, ...). `puck` holds for
 * every puck: radius 1, snapped to exactly 0 under `snap` (snapPuck), nudged by `step`. The curve
 * entries are their grade-curves.ts domains. `look.amount` is the LookRef's.
 */
export const GRADE_RANGES = deepFreeze({
  temperature: range(-100, 100, 1, 0),
  tint: range(-100, 100, 1, 0),
  lift: { y: range(-0.25, 0.25, 0.001, 0) },
  gamma: { y: range(-1, 1, 0.01, 0) },
  gain: { y: range(0.5, 2, 0.01, 1) },
  offset: { y: range(-0.25, 0.25, 0.001, 0) },
  contrast: range(0.5, 2, 0.01, 1),
  pivot: range(0.2, 0.7, 0.001, 0.4614),
  saturation: range(0, 2, 0.01, 1),
  vibrance: range(-1, 1, 0.01, 0),
  tones: { balance: range(-1, 1, 0.01, 0), blending: range(0, 1, 0.01, 0.5) },
  rollOff: range(0, 1, 0.01, 0),
  puck: { radius: 1, snap: 0.02, step: 0.01 },
  curves: TONE_CURVE,
  hueSat: HUE_SAT_CURVE,
  hueLuma: HUE_LUMA_CURVE,
  look: { amount: range(0, 1, 0.01, 1) },
})

const R = GRADE_RANGES

const neutralWheel = (name: WheelName): Wheel => ({ y: R[name].y.default, u: 0, v: 0 })
const copyPoints = (points: readonly (readonly [number, number])[]): Pt[] => points.map((p) => [p[0], p[1]])

function neutralState(): GradeState {
  return {
    version: 1,
    temperature: R.temperature.default,
    tint: R.tint.default,
    lift: neutralWheel('lift'),
    gamma: neutralWheel('gamma'),
    gain: neutralWheel('gain'),
    offset: neutralWheel('offset'),
    contrast: R.contrast.default,
    pivot: R.pivot.default,
    saturation: R.saturation.default,
    vibrance: R.vibrance.default,
    curves: {
      master: copyPoints(TONE_CURVE.defaults),
      red: copyPoints(TONE_CURVE.defaults),
      green: copyPoints(TONE_CURVE.defaults),
      blue: copyPoints(TONE_CURVE.defaults),
    },
    hueSat: copyPoints(HUE_SAT_CURVE.defaults),
    hueLuma: copyPoints(HUE_LUMA_CURVE.defaults),
    tones: { shadows: { u: 0, v: 0 }, highlights: { u: 0, v: 0 }, balance: R.tones.balance.default, blending: R.tones.blending.default },
    rollOff: R.rollOff.default,
  }
}

/** The neutral grade, deeply frozen: structuredClone it (or parseGradeState({})) to edit. */
export const NEUTRAL_GRADE: Readonly<GradeState> = deepFreeze(neutralState())

// ---- identity -------------------------------------------------------------------------------

const isNeutralPuck = (p: Puck) => p.u === 0 && p.v === 0

/**
 * True when the grade changes nothing, so it can be compiled out (plan 2.5): every control at
 * exactly its neutral value, every puck exactly 0, the four curves the default two points, each
 * hue curve empty or flat at exactly its neutral y (the same tests the bake skips them by,
 * grade-curves.ts), and the look null, at amount 0 (or below, as the bake clamps it), or an
 * identity lattice (LookIdentity). Ignored, because at the state where the rest is neutral they
 * do nothing and the bake gives the identity lattice bit for bit: rollOff (a neutral grade has
 * nothing above 1), pivot (contrast 1 is skipped) and the Tones balance and blending (both Tones
 * pucks at 0 add exactly 0). grade-bake.test.ts checks that this agrees with compileGrade.
 */
export function isGradeIdentity(state: GradeState, look: LookIdentity | null): boolean {
  if (state.temperature !== R.temperature.default || state.tint !== R.tint.default) return false
  for (const name of WHEEL_NAMES) {
    const wheel = state[name]
    if (wheel.y !== R[name].y.default || !isNeutralPuck(wheel)) return false
  }
  if (state.contrast !== R.contrast.default || state.saturation !== R.saturation.default
    || state.vibrance !== R.vibrance.default) return false
  for (const channel of CURVE_CHANNELS) if (!isDefaultToneCurve(state.curves[channel])) return false
  if (!isNeutralHueCurve(state.hueSat, HUE_SAT_CURVE.neutral!)
    || !isNeutralHueCurve(state.hueLuma, HUE_LUMA_CURVE.neutral!)) return false
  if (!isNeutralPuck(state.tones.shadows) || !isNeutralPuck(state.tones.highlights)) return false
  if (look === null || !(look.amount > 0)) return true
  if (look.isIdentity !== undefined) return look.isIdentity
  return look.cube !== undefined && isIdentityLattice(look.cube, LOOK_IDENTITY_EPS)
}

// ---- parsing --------------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
/** −0 → 0, so a JSON round trip (which writes −0 as 0) deep-equals. */
const plain = (x: number) => x + 0
/** A puck put on the rim can come out a rounding error over radius 1; it stays where it is, so
 *  snapPuck and parseGradeState give the same puck the second time. */
const RIM_EPS = 1e-12
/** A junk value for a warning, without JSON.stringify (which throws on cycles and BigInt). */
const describe = (value: unknown): string => typeof value === 'string' ? `"${value.slice(0, 40)}"`
  : value === null ? 'null' : typeof value === 'object' ? (Array.isArray(value) ? 'a list' : 'an object') : String(value)

/** The keys each level knows; any other is reported and ignored. */
const STATE_KEYS = ['version', 'temperature', 'tint', 'lift', 'gamma', 'gain', 'offset', 'contrast', 'pivot', 'saturation',
  'vibrance', 'curves', 'hueSat', 'hueLuma', 'tones', 'rollOff'] as const
const WHEEL_KEYS = ['y', 'u', 'v'] as const
const PUCK_KEYS = ['u', 'v'] as const
const TONES_KEYS = ['shadows', 'highlights', 'balance', 'blending'] as const

function readScalar(value: unknown, limits: GradeRange, label: string, warnings: string[]): number {
  if (value === undefined) return limits.default
  if (!isFiniteNumber(value)) {
    warnings.push(`${label}: ${describe(value)} is not a number, ${limits.default} used`)
    return limits.default
  }
  if (value < limits.min || value > limits.max) {
    const clamped = Math.min(Math.max(value, limits.min), limits.max)
    warnings.push(`${label}: ${value} clamped to ${clamped}`)
    return plain(clamped)
  }
  return plain(value)
}

function readPuck(value: unknown, label: string, warnings: string[]): Puck {
  if (value === undefined) return { u: 0, v: 0 }
  if (!isRecord(value)) {
    warnings.push(`${label}: not a {u, v} puck, reset`)
    return { u: 0, v: 0 }
  }
  warnUnknown(value, PUCK_KEYS, `${label}.`, warnings)
  const part = (key: 'u' | 'v') => {
    const x = value[key]
    if (x === undefined) return 0
    if (isFiniteNumber(x)) return x
    warnings.push(`${label}.${key}: not a number, 0 used`)
    return 0
  }
  const u = part('u')
  const v = part('v')
  if (Math.hypot(u, v) > R.puck.radius + RIM_EPS) warnings.push(`${label}: outside the unit disc, pulled onto its rim`)
  return snapPuck(u, v)
}

function readWheel(value: unknown, name: WheelName, warnings: string[]): Wheel {
  if (value === undefined) return neutralWheel(name)
  if (!isRecord(value)) {
    warnings.push(`${name}: not a {y, u, v} wheel, reset`)
    return neutralWheel(name)
  }
  warnUnknown(value, WHEEL_KEYS, `${name}.`, warnings)
  const { u, v } = readPuck({ u: value.u, v: value.v }, name, warnings)
  return { y: readScalar(value.y, R[name].y, `${name}.y`, warnings), u, v }
}

function warnUnknown(value: Record<string, unknown>, known: readonly string[], prefix: string, warnings: string[]) {
  for (const key of Object.keys(value)) if (!known.includes(key)) warnings.push(`${prefix}${key}: unknown, ignored`)
}

/**
 * A GradeState from anything: config grade.state, a pasted block, an old save. Tolerant, never
 * throws: missing fields get their defaults; numbers outside their range are clamped; pucks are
 * pulled into the unit disc and snapped (snapPuck); curves are sanitised (grade-curves.ts
 * sanitizeCurve: sorted, ends pinned, points closer than the gap dropped, capped at 12); unknown
 * keys are ignored. Everything changed or ignored is listed in `warnings`; a missing field is not.
 * The result is a fresh object sharing nothing with the input or NEUTRAL_GRADE, and reading it
 * again (also after a JSON round trip) gives the same state with no warnings.
 */
export function parseGradeState(input: unknown): { state: GradeState; warnings: string[] } {
  try {
    return readState(input)
  } catch {
    // Only a hostile input gets here (a throwing getter or Proxy); the reader itself does not throw.
    return { state: neutralState(), warnings: ['grade state: unreadable, neutral used'] }
  }
}

function readState(input: unknown): { state: GradeState; warnings: string[] } {
  const warnings: string[] = []
  const state = neutralState()
  if (input === undefined) return { state, warnings }
  if (!isRecord(input)) {
    warnings.push('grade state: not an object, neutral used')
    return { state, warnings }
  }
  warnUnknown(input, STATE_KEYS, '', warnings)
  if (input.version !== undefined && input.version !== 1) warnings.push(`version: ${describe(input.version)} read as 1`)
  state.temperature = readScalar(input.temperature, R.temperature, 'temperature', warnings)
  state.tint = readScalar(input.tint, R.tint, 'tint', warnings)
  for (const name of WHEEL_NAMES) state[name] = readWheel(input[name], name, warnings)
  state.contrast = readScalar(input.contrast, R.contrast, 'contrast', warnings)
  state.pivot = readScalar(input.pivot, R.pivot, 'pivot', warnings)
  state.saturation = readScalar(input.saturation, R.saturation, 'saturation', warnings)
  state.vibrance = readScalar(input.vibrance, R.vibrance, 'vibrance', warnings)
  if (input.curves !== undefined) {
    if (isRecord(input.curves)) {
      warnUnknown(input.curves, CURVE_CHANNELS, 'curves.', warnings)
      for (const channel of CURVE_CHANNELS) {
        state.curves[channel] = sanitizeCurve(input.curves[channel], TONE_CURVE, warnings, `curves.${channel}`)
      }
    } else warnings.push('curves: not an object, reset')
  }
  state.hueSat = sanitizeCurve(input.hueSat, HUE_SAT_CURVE, warnings, 'hueSat')
  state.hueLuma = sanitizeCurve(input.hueLuma, HUE_LUMA_CURVE, warnings, 'hueLuma')
  if (input.tones !== undefined) {
    if (isRecord(input.tones)) {
      const tones = input.tones
      warnUnknown(tones, TONES_KEYS, 'tones.', warnings)
      state.tones = {
        shadows: readPuck(tones.shadows, 'tones.shadows', warnings),
        highlights: readPuck(tones.highlights, 'tones.highlights', warnings),
        balance: readScalar(tones.balance, R.tones.balance, 'tones.balance', warnings),
        blending: readScalar(tones.blending, R.tones.blending, 'tones.blending', warnings),
      }
    } else warnings.push('tones: not an object, reset')
  }
  state.rollOff = readScalar(input.rollOff, R.rollOff, 'rollOff', warnings)
  return { state, warnings }
}

// ---- formulas -------------------------------------------------------------------------------

/** Where the per-channel formulas write their r, g, b: a plain array or a typed one, so the bake
 *  can reuse one scratch and allocate nothing per node. */
export type Vec3 = number[] | Float32Array | Float64Array

/** Rec.709 luma weights. */
const KR = 0.2126
const KG = 0.7152
const KB = 0.0722

/** Y' = 0.2126 R + 0.7152 G + 0.0722 B on the values at hand. */
export function luma(r: number, g: number, b: number): number {
  return KR * r + KG * g + KB * b
}

// The inverse Rec.709 Y'CbCr at Y' = 0, scaled so blue at u = 1 is 1. The green coefficients are
// derived from the luma weights (−Kb·2(1−Kb)/Kg and −Kr·2(1−Kr)/Kg) rather than the rounded
// 0.18732 and 0.46812, so luma(Δ̂) is 0 to rounding, not 1.6e-6.
const CB_SCALE = 2 * (1 - KB) // 1.8556
const CR_SCALE = 2 * (1 - KR) // 1.5748
const R_V = CR_SCALE / CB_SCALE // 1.5748 / 1.8556
const G_U = -KB / KG // −(Kb·1.8556/Kg) / 1.8556, the plan's −0.18732 / 1.8556
const G_V = -KR * CR_SCALE / KG / CB_SCALE // the plan's −0.46812 / 1.8556

/**
 * The colour a puck adds, per channel: Δ̂(u, v) = (1.5748 v, −0.18732 u − 0.46812 v, 1.8556 u)
 * / 1.8556. It has zero luma, so a wheel tints without brightening; blue at (1, 0) is exactly 1,
 * and no component leaves [−1, 1] on the unit disc. As a vectorscope reads it (angle from +u
 * towards +v), a pure red tint sits at 102.9°, green at 229.7°, blue at 354.8°.
 */
export function wheelDelta<T extends Vec3 = number[]>(u: number, v: number, out: T = [0, 0, 0] as unknown as T): T {
  out[0] = R_V * v
  out[1] = G_U * u + G_V * v
  out[2] = u
  return out
}

/** A puck as the editor stores it: pulled onto the unit disc's rim when outside, exactly (0, 0)
 *  under radius 0.02 so a puck dragged back home is neutral again, and (0, 0) for non-numbers.
 *  Applied on every set. */
export function snapPuck(u: number, v: number): Puck {
  if (!Number.isFinite(u) || !Number.isFinite(v)) return { u: 0, v: 0 }
  const r = Math.hypot(u, v)
  if (r < R.puck.snap) return { u: 0, v: 0 }
  if (r > R.puck.radius + RIM_EPS) return { u: plain(u / r * R.puck.radius), v: plain(v / r * R.puck.radius) }
  return { u: plain(u), v: plain(v) }
}

/**
 * A primary wheel's per-channel parameter (plan 2.4, stage 1b), the bake's and the readout's one
 * source: lift L_c = y + kLift·Δ̂_c, gain G_c = y·(1 + kGain·Δ̂_c), gamma g_c = clamp(y +
 * kGamma·Δ̂_c, −1, 1) (log2; the exponent is 2^−g_c), offset O_c = y + kOffset·Δ̂_c. At a neutral
 * puck each channel is exactly y.
 */
export function wheelChannels<T extends Vec3 = number[]>(name: WheelName, wheel: Readonly<Wheel>,
  tuning: Readonly<GradeTuning> = DEFAULT_GRADE_TUNING, out: T = [0, 0, 0] as unknown as T): T {
  const d = wheelDelta(wheel.u, wheel.v, out)
  for (let c = 0; c < 3; c++) {
    if (name === 'lift') out[c] = wheel.y + tuning.liftChroma * d[c]
    else if (name === 'gain') out[c] = wheel.y * (1 + tuning.gainChroma * d[c])
    else if (name === 'gamma') out[c] = Math.min(Math.max(wheel.y + tuning.gammaChroma * d[c], -1), 1)
    else out[c] = wheel.y + tuning.offsetChroma * d[c]
  }
  return out
}

/**
 * White balance as linear-light channel gains: exponents in stops (kTemp·t + kTint·τ/3,
 * −2·kTint·τ/3, −kTemp·t + kTint·τ/3) for t = temperature/100 and τ = tint/100, normalised so
 * grey keeps its luminance (luma of the gains is 1). (0, 0) is exactly [1, 1, 1]. The bake applies
 * them as srgbOetf(w_c · srgbEotf(y)).
 */
export function whiteBalanceGains<T extends Vec3 = number[]>(temperature: number, tint: number,
  tuning: Readonly<GradeTuning> = DEFAULT_GRADE_TUNING, out: T = [0, 0, 0] as unknown as T): T {
  if (temperature === 0 && tint === 0) {
    out[0] = 1
    out[1] = 1
    out[2] = 1
    return out
  }
  const t = temperature / 100
  const tau = tint / 100
  const r = 2 ** (tuning.tempStops * t + tuning.tintStops * tau / 3)
  const g = 2 ** (-2 * tuning.tintStops * tau / 3)
  const b = 2 ** (-tuning.tempStops * t + tuning.tintStops * tau / 3)
  const l = luma(r, g, b)
  out[0] = r / l
  out[1] = g / l
  out[2] = b / l
  return out
}

/** The toe of powC1: a power of two, so g = 1 is exact. */
const E = 1 / 64

/**
 * The C1 power for g in (0, 2]: t^g from E = 1/64 up, a quadratic toe E^g·((2−g)s + (g−1)s²)
 * with s = t/E below it, and the toe's tangent at 0 below 0. f(0) = 0, f(1) = 1, monotone, no
 * kink inside a LUT cell, and bitwise the identity at g = 1.
 */
export function powC1(t: number, g: number): number {
  if (t >= E) return t ** g
  const s = t / E
  const scale = E ** g
  if (t >= 0) return scale * ((2 - g) * s + (g - 1) * s * s)
  return scale * (2 - g) * s
}

/**
 * Contrast c about pivot p. c ≥ 1: an S of two powC1 halves that keeps 0, p and 1 fixed with
 * slope c at p (and continues C1 below 0 and above 1); c < 1: the straight fade p + c(x − p),
 * which has no infinite end slopes and lifts black to p(1 − c). c = 1 returns x bit for bit.
 */
export function contrastCurve(x: number, c: number, p: number): number {
  if (c === 1) return x
  if (c < 1) return p + c * (x - p)
  if (x <= p) return p * powC1(x / p, c)
  return 1 - (1 - p) * powC1((1 - x) / (1 - p), c)
}

/** Linear light below which the OETF is linear: 0.04045/12.92, the EOTF's own threshold mapped
 *  through it, so the pair is an exact inverse (the textbook 0.0031308 leaves 3e-8 at 0.04045). */
const OETF_LINEAR_BELOW = 0.04045 / 12.92

/** sRGB decode, the exact piecewise curve (0.04045, 12.92, 2.4), odd-extended: f(−x) = −f(x). */
export function srgbEotf(x: number): number {
  const a = Math.abs(x)
  const y = a <= 0.04045 ? a / 12.92 : ((a + 0.055) / 1.055) ** 2.4
  return x < 0 ? -y : y
}

/** sRGB encode, the inverse of srgbEotf, odd-extended. */
export function srgbOetf(x: number): number {
  const a = Math.abs(x)
  const y = a <= OETF_LINEAR_BELOW ? a * 12.92 : 1.055 * a ** (1 / 2.4) - 0.055
  return x < 0 ? -y : y
}

/** Hexcone hue in degrees, [0, 360): red 0, green 120, blue 240. 0 for a grey (C = 0), where the
 *  hue gate is 0 anyway, so no NaN reaches a hue curve. */
export function hexconeHue(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b)
  const c = max - Math.min(r, g, b)
  if (!(c > 0)) return 0
  let h: number
  if (max === r) h = (g - b) / c
  else if (max === g) h = (b - r) / c + 2
  else h = (r - g) / c + 4
  h *= 60
  if (h < 0) h += 360
  return h >= 360 ? h - 360 : h
}

/** GLSL smoothstep. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1)
  return t * t * (3 - 2 * t)
}
