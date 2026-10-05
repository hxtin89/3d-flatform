// The colour grade's bake (goal 4): a GradeState, and optionally an imported .cube look, turned
// into the n³ lattice of half floats the output pass samples with one trilinear 3D-texture tap
// (grade-output.ts) — pure maths, no three, no DOM, so it runs under `node --test`
// (grade-bake.test.ts), in grade-bake.worker.ts and, without a Worker, on the main thread.
//
// Per lattice node x = (i, j, k)/(n − 1), red fastest like a .cube (plan 2.4):
//   0  the look: v = x + amount·(C(x) − x), C the cube's own trilinear over its domain;
//   1  per channel: white balance, lift/gain/offset with gamma, contrast, the curves. Without a
//      look these are exact tables at the n node values; with one, tables of 4096 entries over
//      [−0.25, 1.5], read linearly, and exact where they bend too hard for that and outside them;
//   2  across channels: saturation, vibrance and hue vs sat in one affine step, hue vs luma,
//      split toning, and a soft gamut compression relative to the stage input v;
//   3  the highlight roll-off, a second pass once the brightest node is known;
//   4  storage: half floats, round-to-nearest-even, clamped to ±16 but not to [0, 1] (the 8-bit
//      canvas clamps per pixel after interpolation), alpha 1.
// Every step is skipped at its neutral value, so a neutral grade is the identity lattice bit for
// bit, and bakeGradeTexels only copies the cached identityTexels for it. evaluateGrade is the same
// maths per pixel with no stage-1 tables and no skips: the tests' oracle.
//
// While a control is dragged and the last final bake was slow, a draft bakes every
// draftStride-th node and fills the rest with the trilinear a coarse texture would render.
// createBakeScheduler keeps one bake in flight and lets the newest request win;
// createBufferPool recycles the texel buffers that travel to the worker and back.
import { CUBE_3D_SIZE_MAX, identityLattice, nodeCoordinate, sampleLattice, type CubeLattice } from './cube-format.ts'
import { monotoneCurve, periodicCurve, readHueTable, sampleHueTable } from './grade-curves.ts'
import {
  contrastCurve, DEFAULT_GRADE_TUNING, hexconeHue, luma, powC1, smoothstep, srgbEotf, srgbOetf, wheelChannels,
  wheelDelta, whiteBalanceGains, type GradeState, type GradeTuning, type Vec3,
} from './grade-model.ts'

/** An imported look as the bake needs it: the parsed lattice and how much of it. The worker
 *  builds it from its parsed CubeFile and the job's { key, amount }. */
export interface GradeLook {
  /** A parsed 3D cube (cube-format.ts parseCube): N³ RGB nodes, red fastest, over its domain. */
  readonly cube: CubeLattice
  /** 0..1, clamped: v = x + amount·(C(x) − x). 0 is no look. */
  readonly amount: number
}

/** Which steps a compiled grade runs. A step at its neutral value is off, unless compiled with
 *  forceStages. */
export interface GradeStages {
  look: boolean
  whiteBalance: boolean
  /** Lift, gain and offset, the linear part of 1b, on at least one channel. */
  levels: boolean
  gamma: boolean
  contrast: boolean
  curves: boolean
  /** 2a: saturation, vibrance and hue vs sat. */
  saturation: boolean
  hueLuma: boolean
  tones: boolean
  /** 2d: whenever stage 1 or 2 changes anything (with y = v it is a no-op). */
  gamut: boolean
  /** Stage 3 is asked for; it still does nothing unless the peak is above 1. */
  rollOff: boolean
}

/**
 * A grade ready to bake: its stage flags, tables and closures, built once per bake so the loop
 * over the nodes allocates nothing. Only `stages`, `identity` and `rollOff` are meant to be read;
 * the rest is the bake's.
 */
export interface CompiledGrade {
  readonly stages: Readonly<GradeStages>
  /** Nothing to do: no look and every step off. The bake is the identity lattice. */
  readonly identity: boolean
  readonly rollOff: number
  readonly tuning: Readonly<GradeTuning>
  /** Stage 1 on channel c (0 r, 1 g, 2 b), exact. */
  readonly channel: (c: number, y: number) => number
  /** Per channel: does stage 1 change it at all. */
  readonly channelOn: readonly [boolean, boolean, boolean]
  /** Stage 2's parameters (crossChannel); null when it is off. */
  readonly cross: CrossStage | null
  /** The look, its amount clamped; null when there is none or at amount 0. */
  readonly look: { readonly cube: CubeLattice; readonly amount: number } | null
  /** With a look: stage 1 tabulated, DENSE_SIZE entries per channel; null when stage 1 is off. */
  readonly dense: Float64Array | null
  /** With `dense`: 1 for each table cell where stage 1 bends too hard to read linearly, which
   *  the bake evaluates exactly instead (denseBends). */
  readonly denseExact: Uint8Array | null
  /** Without a look: stage 1 at the n node values, 3n entries, built on first use per n. */
  readonly nodeTables: Map<number, Float64Array>
  /** One RGB of scratch for the loop. */
  readonly work: Float64Array
}

/** Stage 1's tables with a look: 4096 entries over [−0.25, 1.5], entry k at −0.25 + k/2340, read
 *  linearly. A linear read misses by up to h²/8·|f''|, which is 0.33 LSB in a step curve's
 *  0.01-wide rise, 0.012 LSB in the gamma toe at gain 2, and 1.5 LSB with the toe, contrast 2 and
 *  a step together. So the cells next to any entry whose second difference |T[k−1] − 2T[k] +
 *  T[k+1]|/8 is over DENSE_BEND are marked (denseBends) and evaluated exactly. Measured on those
 *  grades: under 7e-4 LSB everywhere, with at most 2.5 % of the cells exact. */
const DENSE_SIZE = 4096
const DENSE_LO = -0.25
const DENSE_HI = 1.5
const DENSE_SCALE = (DENSE_SIZE - 1) / (DENSE_HI - DENSE_LO)
const DENSE_LAST = DENSE_SIZE - 1
/** About 2.6e-4 LSB: a cell whose neighbourhood bends more is evaluated exactly. */
const DENSE_BEND = 1e-6

/** The last dense tables and their exact cells, by the stage-1 inputs they were built from. */
let denseCache: { key: string; tables: Float64Array; exact: Uint8Array } | null = null

/**
 * The cells of the dense tables (c·DENSE_SIZE + k, between entries k and k + 1) that a linear
 * read cannot be trusted in: the two next to an entry whose second difference over 8 — the
 * linear read's error where the curvature is even — is above DENSE_BEND, and one more on each
 * side, which catches an inflection or a knot between entries whose own differences are small.
 */
function denseBends(dense: Float64Array): Uint8Array {
  const exact = new Uint8Array(3 * DENSE_SIZE)
  for (let c = 0; c < 3; c++) {
    const t = c * DENSE_SIZE
    for (let k = 1; k < DENSE_LAST; k++) {
      const bend = Math.abs(dense[t + k - 1] - 2 * dense[t + k] + dense[t + k + 1])
      if (!(bend <= 8 * DENSE_BEND)) {
        for (let q = Math.max(k - 2, 0); q <= Math.min(k + 1, DENSE_LAST - 1); q++) exact[t + q] = 1
      }
    }
  }
  return exact
}

/** Stage 4: what a texel may hold, and alpha 1 in half bits. */
const STORE_LIMIT = 16
const HALF_ONE = 0x3c00

/** 2d skips below this channel maximum, where the compression has no direction. */
const GAMUT_FLOOR = 1e-6

/** The largest lattice a texture or a .cube may have: the .cube format's own 3D limit, so every
 *  baked lattice can be exported. */
const LATTICE_MAX = CUBE_3D_SIZE_MAX

const clamp01 = (x: number) => (x > 0 ? (x < 1 ? x : 1) : 0)

/** Stage 2's parameters, compiled once. One object shape and one function for every grade, so
 *  the bake loop stays monomorphic (a closure built per grade measured about a fifth slower). */
export interface CrossStage {
  /** 2a or 2b runs, so the stage input's luma, hue and hue gate are needed. */
  readonly hueOn: boolean
  readonly saturationOn: boolean
  readonly vibranceOn: boolean
  readonly tonesOn: boolean
  readonly hueSat: Float32Array | null
  readonly hueLuma: Float32Array | null
  readonly saturation: number
  readonly vibrance: number
  /** kVib². */
  readonly vibrance2: number
  readonly hueGate: number
  readonly toneChroma: number
  /** The Tones hand-over S = smoothstep(mc − bw/2, mc + bw/2, Y''). Both weights carry the black
   *  ramp B = smoothstep(0, 0.06, Y''): w_h = S·B, w_s = (1 − S)·B. Plan 2.4 2c has w_h = S, which
   *  tints black (up to 2.4 LSB) wherever balance and blending put the lower edge below 0, against
   *  its own "true black stays black"; B changes w_h only where that edge is below 0.06. */
  readonly splitLo: number
  readonly splitHi: number
  /** Δ̂ of the shadow and highlight pucks. */
  readonly shadows: Float64Array
  readonly highlights: Float64Array
  readonly gamutThreshold: number
}

/** 2d for one channel. With d = (a − y)/a, d_v = (a_v − v)/a_v and t = max(kGamut, d_v), only a
 *  channel with d > t and t < 1 is compressed; the reciprocals of a and a_v spare a division.
 *  t ≥ 1 means v ≤ 0: an input channel at or past the clip is left alone, at exactly 0 too, where
 *  the limit from inside would be 0. So a lattice face (i, j or k = 0) keeps the negative the
 *  grade gives it, which is what interpolation needs: trilinear from it to the compressed node
 *  inside, clamped by the canvas, follows the grade's steep rise off 0; a face at 0 renders
 *  saturation 1.1 on dark canopy greens up to 1.1 LSB off, against 0.25 LSB as it is. */
function compress(y: number, v: number, a: number, ia: number, iav: number, threshold: number): number {
  const d = 1 - y * ia
  if (!(d > threshold)) return y
  const dv = 1 - v * iav
  const t = dv > threshold ? dv : threshold
  if (d > t && t < 1) return a * (1 - (t + (1 - t) * Math.tanh((d - t) / (1 - t))))
  return y
}

/**
 * Stage 2 in place on y = (r, g, b): saturation, vibrance and hue vs sat as one affine step
 * about the luma, hue vs luma, split toning, then the soft gamut compression against the stage
 * input v. Luma, hue and the hue gate come from the stage-2 input. Allocates nothing.
 */
function crossChannel(p: CrossStage, y: Float64Array, v0: number, v1: number, v2: number): void {
  let r = y[0]
  let g = y[1]
  let b = y[2]
  if (p.hueOn) {
    const lum = luma(r, g, b)
    const hueSat = p.hueSat
    const hueLuma = p.hueLuma
    let hue = 0
    let gate = 0
    if (hueSat || hueLuma) {
      const max = r > g ? (r > b ? r : b) : (g > b ? g : b)
      const min = r < g ? (r < b ? r : b) : (g < b ? g : b)
      hue = hexconeHue(r, g, b)
      gate = smoothstep(0, p.hueGate, max - min)
    }
    if (p.saturationOn) {
      let s = p.saturation
      if (p.vibranceOn) {
        const rg = r - g
        const gb = g - b
        const br = b - r
        const base = (lum > 0 ? lum : 0) + 0.02
        const chroma2 = (rg * rg + gb * gb + br * br) / (2 * base * base)
        s *= 1 + p.vibrance / (1 + chroma2 / p.vibrance2)
      }
      if (s < 0) s = 0
      if (hueSat) s *= 1 + gate * (readHueTable(hueSat, hue) - 1)
      r = lum + s * (r - lum)
      g = lum + s * (g - lum)
      b = lum + s * (b - lum)
    }
    if (hueLuma) {
      const shift = lum * (2 ** (gate * readHueTable(hueLuma, hue)) - 1)
      r += shift
      g += shift
      b += shift
    }
  }
  if (p.tonesOn) {
    const lum = luma(r, g, b)
    const black = smoothstep(0, 0.06, lum)
    const split = smoothstep(p.splitLo, p.splitHi, lum)
    const wh = split * black
    const ws = (1 - split) * black
    const k = p.toneChroma
    r += k * (ws * p.shadows[0] + wh * p.highlights[0])
    g += k * (ws * p.shadows[1] + wh * p.highlights[1])
    b += k * (ws * p.shadows[2] + wh * p.highlights[2])
  }
  const a = r > g ? (r > b ? r : b) : (g > b ? g : b)
  const av = v0 > v1 ? (v0 > v2 ? v0 : v2) : (v1 > v2 ? v1 : v2)
  if (a > GAMUT_FLOOR && av > GAMUT_FLOOR) {
    const ia = 1 / a
    const iav = 1 / av
    const threshold = p.gamutThreshold
    r = compress(r, v0, a, ia, iav, threshold)
    g = compress(g, v1, a, ia, iav, threshold)
    b = compress(b, v2, a, ia, iav, threshold)
  }
  y[0] = r
  y[1] = g
  y[2] = b
}

/** Under forceStages a default curve still runs: the diagonal through a third knot, which
 *  monotoneCurve does not recognise as the default. */
const FORCED_CURVE = monotoneCurve([[0, 0], [0.5, 0.5], [1, 1]])!

function checkLook(look: GradeLook): void {
  const { size, data, domainMin, domainMax } = look.cube
  if (!Number.isInteger(size) || size < 2 || data.length < 3 * size ** 3) {
    throw new RangeError(`grade look: ${data.length} values do not hold a ${size}³ lattice`)
  }
  for (let c = 0; c < 3; c++) {
    if (!(domainMax[c] > domainMin[c])) throw new RangeError(`grade look: empty domain on ${'RGB'[c]}`)
  }
}

/**
 * Compiles a grade for bakeLattice: which steps run (each is off at its neutral value), the
 * per-channel parameters, the curve closures, the hue tables and, with a look, stage 1 as dense
 * tables. `forceStages` (debug) runs every step even at neutral; a neutral grade must still bake
 * to the identity, bit for bit. Throws a RangeError for a look whose lattice does not fit its size.
 */
export function compileGrade(state: GradeState, tuning: Readonly<GradeTuning> = DEFAULT_GRADE_TUNING,
  look: GradeLook | null = null, options: { forceStages?: boolean } = {}): CompiledGrade {
  const force = options.forceStages === true
  const amount = look ? clamp01(look.amount) : 0
  const lookOn = look !== null && amount > 0
  if (lookOn) checkLook(look)

  // Stage 1: the per-channel parameters.
  const whiteBalance = force || state.temperature !== 0 || state.tint !== 0
  const gains = whiteBalanceGains(state.temperature, state.tint, tuning, new Float64Array(3))
  const lift = wheelChannels('lift', state.lift, tuning, new Float64Array(3))
  const gain = wheelChannels('gain', state.gain, tuning, new Float64Array(3))
  const gamma = wheelChannels('gamma', state.gamma, tuning, new Float64Array(3))
  const offset = wheelChannels('offset', state.offset, tuning, new Float64Array(3))
  const slope = new Float64Array(3)
  const exponent = new Float64Array(3)
  const levelsOn = [false, false, false]
  const gammaOn = [false, false, false]
  for (let c = 0; c < 3; c++) {
    slope[c] = gain[c] - lift[c]
    exponent[c] = 2 ** -gamma[c]
    levelsOn[c] = force || gain[c] !== 1 || lift[c] !== 0 || offset[c] !== 0
    gammaOn[c] = force || gamma[c] !== 0
  }
  const contrast = state.contrast
  const pivot = state.pivot
  const contrastOn = force || contrast !== 1
  const master = monotoneCurve(state.curves.master) ?? (force ? FORCED_CURVE : null)
  const curves = [state.curves.red, state.curves.green, state.curves.blue]
    .map((points) => monotoneCurve(points) ?? (force ? FORCED_CURVE : null))
  const channelOn: [boolean, boolean, boolean] = [false, false, false]
  for (let c = 0; c < 3; c++) {
    channelOn[c] = whiteBalance || levelsOn[c] || gammaOn[c] || contrastOn || master !== null || curves[c] !== null
  }
  const stage1 = channelOn[0] || channelOn[1] || channelOn[2]

  const channel = (c: number, y: number): number => {
    if (whiteBalance) y = srgbOetf(gains[c] * srgbEotf(y))
    if (levelsOn[c]) y = y * slope[c] + lift[c] + offset[c]
    if (gammaOn[c]) y = powC1(y, exponent[c])
    if (contrastOn) y = contrastCurve(y, contrast, pivot)
    if (master) y = master(y)
    const curve = curves[c]
    if (curve) y = curve(y)
    return y
  }

  let dense: Float64Array | null = null
  let denseExact: Uint8Array | null = null
  if (lookOn && stage1) {
    // 12288 evaluations of stage 1, a few ms; a drag of a stage-2 control or the look amount
    // leaves them as they were, so the last set is kept.
    const key = JSON.stringify([state.temperature, state.tint, state.lift, state.gamma, state.gain, state.offset,
      contrast, pivot, state.curves, tuning, force])
    if (denseCache && denseCache.key === key) {
      dense = denseCache.tables
      denseExact = denseCache.exact
    } else {
      dense = new Float64Array(3 * DENSE_SIZE)
      for (let c = 0; c < 3; c++) {
        for (let k = 0; k < DENSE_SIZE; k++) {
          const y = DENSE_LO + k / DENSE_SCALE
          dense[c * DENSE_SIZE + k] = channelOn[c] ? channel(c, y) : y
        }
      }
      denseExact = denseBends(dense)
      denseCache = { key, tables: dense, exact: denseExact }
    }
  }

  // Stage 2.
  const hueSat = periodicCurve(state.hueSat, 1) ?? (force ? new Float32Array(361).fill(1) : null)
  const hueLuma = periodicCurve(state.hueLuma, 0) ?? (force ? new Float32Array(361) : null)
  const vibranceOn = force || state.vibrance !== 0
  const saturationOn = force || state.saturation !== 1 || vibranceOn || hueSat !== null
  const { shadows, highlights } = state.tones
  const tonesOn = force || shadows.u !== 0 || shadows.v !== 0 || highlights.u !== 0 || highlights.v !== 0
  const gamutOn = stage1 || saturationOn || hueSat !== null || hueLuma !== null || tonesOn
  const splitCentre = 0.5 + 0.25 * state.tones.balance
  const splitWidth = 0.2 + 0.6 * state.tones.blending
  const cross: CrossStage | null = !gamutOn ? null : {
    hueOn: saturationOn || hueLuma !== null,
    saturationOn,
    vibranceOn,
    tonesOn,
    hueSat,
    hueLuma,
    saturation: state.saturation,
    vibrance: state.vibrance,
    vibrance2: tuning.vibranceChroma * tuning.vibranceChroma,
    hueGate: tuning.hueChromaGate,
    toneChroma: tuning.toneChroma,
    splitLo: splitCentre - splitWidth / 2,
    splitHi: splitCentre + splitWidth / 2,
    shadows: wheelDelta(shadows.u, shadows.v, new Float64Array(3)),
    highlights: wheelDelta(highlights.u, highlights.v, new Float64Array(3)),
    gamutThreshold: tuning.gamutThreshold,
  }

  const stages: GradeStages = {
    look: lookOn,
    whiteBalance,
    levels: levelsOn[0] || levelsOn[1] || levelsOn[2],
    gamma: gammaOn[0] || gammaOn[1] || gammaOn[2],
    contrast: contrastOn,
    curves: master !== null || curves.some((curve) => curve !== null),
    saturation: saturationOn,
    hueLuma: hueLuma !== null,
    tones: tonesOn,
    gamut: gamutOn,
    rollOff: state.rollOff > 0,
  }
  return {
    stages: Object.freeze(stages),
    identity: !lookOn && !stage1 && cross === null,
    rollOff: state.rollOff,
    tuning,
    channel,
    channelOn,
    cross,
    look: lookOn ? { cube: look.cube, amount } : null,
    dense,
    denseExact,
    nodeTables: new Map(),
    work: new Float64Array(3),
  }
}

function checkLattice(n: number, stride: number, length: number, perNode: number, what: string): void {
  if (!Number.isInteger(n) || n < 2 || n > LATTICE_MAX) throw new RangeError(`${what}: size ${n} is outside 2..${LATTICE_MAX}`)
  if (!Number.isInteger(stride) || stride < 1 || (n - 1) % stride !== 0) {
    throw new RangeError(`${what}: stride ${stride} does not divide ${n - 1}`)
  }
  if (length < perNode * n ** 3) throw new RangeError(`${what}: ${length} values hold fewer than ${n}³ nodes`)
}

const axisCache = new Map<number, Float64Array>()
/** i/(n − 1) for i = 0..n−1, the same divisions identityLattice makes. */
function axisValues(n: number): Float64Array {
  let axis = axisCache.get(n)
  if (!axis) {
    axis = new Float64Array(n)
    for (let i = 0; i < n; i++) axis[i] = i / (n - 1)
    axisCache.set(n, axis)
  }
  return axis
}

function nodeTablesFor(compiled: CompiledGrade, n: number): Float64Array {
  let tables = compiled.nodeTables.get(n)
  if (!tables) {
    const axis = axisValues(n)
    tables = new Float64Array(3 * n)
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < n; i++) tables[c * n + i] = compiled.channelOn[c] ? compiled.channel(c, axis[i]) : axis[i]
    }
    compiled.nodeTables.set(n, tables)
  }
  return tables
}

/** Stage 1 through a dense table; exact in the cells denseBends marked, outside the table and
 *  for NaN, which falls through. The unary + on the exact value tells V8 it is a number: without
 *  it, once marked cells are read, a 65³ bake with a look ran 10 to 15 % slower. */
function denseChannel(compiled: CompiledGrade, dense: Float64Array, exact: Uint8Array, c: number, y: number): number {
  const p = (y - DENSE_LO) * DENSE_SCALE
  if (p >= 0 && p < DENSE_LAST) {
    const k = Math.floor(p)
    const at = c * DENSE_SIZE + k
    if (exact[at] === 0) return dense[at] + (p - k) * (dense[at + 1] - dense[at])
  }
  return +compiled.channel(c, y)
}

/**
 * Where the cube is read along one axis for every lattice node of that axis: the node's input
 * mapped onto the cube's domain, then clamped and snapped by sampleLattice's own nodeCoordinate
 * (cube-format.ts), then the cell's offset into the data, the fraction f inside it and 1 − f —
 * the same arithmetic sampleLattice does per call, so the bake's stage 0 and evaluateGrade's
 * agree bit for bit.
 */
function lookAxis(n: number, size: number, min: number, max: number, unit: number) {
  const axis = axisValues(n)
  const cell = new Int32Array(n)
  const frac = new Float64Array(n)
  const rest = new Float64Array(n)
  const s = size - 1
  for (let i = 0; i < n; i++) {
    const at = nodeCoordinate((axis[i] - min) / (max - min), s)
    const i0 = Math.min(Math.floor(at), s - 1)
    cell[i] = i0 * unit
    frac[i] = at - i0
    rest[i] = 1 - frac[i]
  }
  return { cell, frac, rest }
}

/**
 * Stages 0–2 for every stride-th node of an n³ lattice (all of them at stride 1), written as RGB
 * into `scratch` (3n³ floats, red fastest); the nodes between are left for fillLattice. Returns
 * the peak, the largest channel value of any baked node (stage 3's white point; 0 if none is
 * finite). Allocates nothing per node.
 */
export function bakeLattice(compiled: CompiledGrade, n: number, stride: number, scratch: Float32Array): number {
  checkLattice(n, stride, scratch.length, 3, 'bakeLattice')
  const s = n - 1
  const axis = axisValues(n)
  const y = compiled.work
  const cross = compiled.cross
  let peak = -Infinity
  const look = compiled.look
  if (!look) {
    const t = nodeTablesFor(compiled, n)
    for (let k = 0; k <= s; k += stride) {
      const yb = t[2 * n + k]
      for (let j = 0; j <= s; j += stride) {
        const yg = t[n + j]
        let p = 3 * n * (j + n * k)
        for (let i = 0; i <= s; i += stride, p += 3 * stride) {
          let r = t[i]
          let g = yg
          let b = yb
          if (cross) {
            y[0] = r
            y[1] = g
            y[2] = b
            crossChannel(cross, y, axis[i], axis[j], axis[k])
            r = y[0]
            g = y[1]
            b = y[2]
          }
          scratch[p] = r
          scratch[p + 1] = g
          scratch[p + 2] = b
          if (r > peak) peak = r
          if (g > peak) peak = g
          if (b > peak) peak = b
        }
      }
    }
    return peak > -Infinity ? peak : 0
  }

  const { cube, amount } = look
  const size = cube.size
  const data = cube.data
  const dy = 3 * size
  const dz = 3 * size * size
  const ar = lookAxis(n, size, cube.domainMin[0], cube.domainMax[0], 3)
  const ag = lookAxis(n, size, cube.domainMin[1], cube.domainMax[1], dy)
  const ab = lookAxis(n, size, cube.domainMin[2], cube.domainMax[2], dz)
  const dense = compiled.dense
  const exact = compiled.denseExact
  const [onR, onG, onB] = compiled.channelOn
  for (let k = 0; k <= s; k += stride) {
    const fz = ab.frac[k]
    const gz = ab.rest[k]
    for (let j = 0; j <= s; j += stride) {
      const fy = ag.frac[j]
      const gy = ag.rest[j]
      const row = ag.cell[j] + ab.cell[k]
      let p = 3 * n * (j + n * k)
      for (let i = 0; i <= s; i += stride, p += 3 * stride) {
        const fx = ar.frac[i]
        const gx = ar.rest[i]
        const base = row + ar.cell[i]
        for (let c = 0; c < 3; c++) {
          const q = base + c
          const c00 = gx * data[q] + fx * data[q + 3]
          const c10 = gx * data[q + dy] + fx * data[q + dy + 3]
          const c01 = gx * data[q + dz] + fx * data[q + dz + 3]
          const c11 = gx * data[q + dz + dy] + fx * data[q + dz + dy + 3]
          const c0 = gy * c00 + fy * c10
          const c1 = gy * c01 + fy * c11
          const sample = gz * c0 + fz * c1
          const x = c === 0 ? axis[i] : c === 1 ? axis[j] : axis[k]
          y[c] = amount === 1 ? sample : x + amount * (sample - x)
        }
        const v0 = y[0]
        const v1 = y[1]
        const v2 = y[2]
        if (dense && exact) {
          if (onR) y[0] = denseChannel(compiled, dense, exact, 0, v0)
          if (onG) y[1] = denseChannel(compiled, dense, exact, 1, v1)
          if (onB) y[2] = denseChannel(compiled, dense, exact, 2, v2)
        }
        if (cross) crossChannel(cross, y, v0, v1, v2)
        const r = y[0]
        const g = y[1]
        const b = y[2]
        scratch[p] = r
        scratch[p + 1] = g
        scratch[p + 2] = b
        if (r > peak) peak = r
        if (g > peak) peak = g
        if (b > peak) peak = b
      }
    }
  }
  return peak > -Infinity ? peak : 0
}

/** The roll-off's knee, white point and power for a peak, or null when it does nothing. */
function rollOffCurve(rollOff: number, peak: number, tuning: Readonly<GradeTuning>) {
  if (!(rollOff > 0)) return null
  const white = Math.max(1, peak)
  const knee = 1 - tuning.rollOffKnee * rollOff
  if (!(white > 1) || !(white > knee) || !(knee < 1)) return null
  return { knee, white, power: (white - knee) / (1 - knee) }
}

/** The factor that rolls a node with channel maximum m off (1 below the knee). */
function rollOffScale(m: number, curve: { knee: number; white: number; power: number }): number {
  const { knee, white, power } = curve
  if (!(m > knee) || !(m > 0)) return 1
  const t = Math.min((m - knee) / (white - knee), 1)
  return (knee + (1 - knee) * (1 - (1 - t) ** power)) / m
}

/**
 * Stage 3, on the stride-th nodes of a baked lattice: with k = 1 − kRollKnee·rollOff and
 * W = max(1, peak), a node whose largest channel m is above k is scaled by m'/m, m' = k +
 * (1 − k)·(1 − (1 − t)^((W − k)/(1 − k))), t = min((m − k)/(W − k), 1) — the film shoulder's form:
 * hue kept, C1 at the knee, the peak landing on 1. Nothing happens at rollOff 0 or a peak ≤ 1.
 * Runs before fillLattice, so a draft's filled nodes interpolate rolled-off values.
 */
export function applyRollOff(scratch: Float32Array, n: number, stride: number, rollOff: number, peak: number,
  tuning: Readonly<GradeTuning> = DEFAULT_GRADE_TUNING): void {
  const curve = rollOffCurve(rollOff, peak, tuning)
  if (!curve) return
  checkLattice(n, stride, scratch.length, 3, 'applyRollOff')
  const s = n - 1
  for (let k = 0; k <= s; k += stride) {
    for (let j = 0; j <= s; j += stride) {
      let p = 3 * n * (j + n * k)
      for (let i = 0; i <= s; i += stride, p += 3 * stride) {
        const r = scratch[p]
        const g = scratch[p + 1]
        const b = scratch[p + 2]
        const m = r > g ? (r > b ? r : b) : (g > b ? g : b)
        if (m > curve.knee) {
          const scale = rollOffScale(m, curve)
          scratch[p] = r * scale
          scratch[p + 1] = g * scale
          scratch[p + 2] = b * scale
        }
      }
    }
  }
}

/**
 * Fills the nodes a stride-s bake skipped with the separable multilinear of the baked ones,
 * along r, then g, then b — what a coarse ((n − 1)/s + 1)³ texture renders at those points, in
 * the order sampleLattice interpolates. Nothing to do at stride 1.
 */
export function fillLattice(scratch: Float32Array, n: number, stride: number): void {
  checkLattice(n, stride, scratch.length, 3, 'fillLattice')
  if (stride === 1) return
  const s = n - 1
  const dj = 3 * n
  const dk = 3 * n * n
  const lerp = (at: number, a: number, b: number, f: number) => {
    for (let c = 0; c < 3; c++) {
      const lo = scratch[a + c]
      scratch[at + c] = lo + f * (scratch[b + c] - lo)
    }
  }
  // r: along the rows of baked (j, k).
  for (let k = 0; k <= s; k += stride) {
    for (let j = 0; j <= s; j += stride) {
      const row = dj * j + dk * k
      for (let i0 = 0; i0 < s; i0 += stride) {
        for (let t = 1; t < stride; t++) lerp(row + 3 * (i0 + t), row + 3 * i0, row + 3 * (i0 + stride), t / stride)
      }
    }
  }
  // g: whole rows, in the planes of baked k.
  for (let k = 0; k <= s; k += stride) {
    for (let j0 = 0; j0 < s; j0 += stride) {
      for (let t = 1; t < stride; t++) {
        const f = t / stride
        const at = dj * (j0 + t) + dk * k
        const lo = dj * j0 + dk * k
        const hi = dj * (j0 + stride) + dk * k
        for (let i = 0; i <= s; i++) lerp(at + 3 * i, lo + 3 * i, hi + 3 * i, f)
      }
    }
  }
  // b: whole planes.
  for (let k0 = 0; k0 < s; k0 += stride) {
    for (let t = 1; t < stride; t++) {
      const f = t / stride
      const at = dk * (k0 + t)
      const lo = dk * k0
      const hi = dk * (k0 + stride)
      for (let q = 0; q < dk; q += 3) lerp(at + q, lo + q, hi + q, f)
    }
  }
}

// ---- half floats ------------------------------------------------------------------------------

/** Round half to even, for a non-negative double below 2^52. */
function roundEven(x: number): number {
  const f = Math.floor(x)
  const d = x - f
  return d > 0.5 || (d === 0.5 && f % 2 === 1) ? f + 1 : f
}

/**
 * The IEEE half nearest x, as its 16 bits, round-to-nearest-even — what Math.f16round and a
 * Float16Array store, for any double (not via float32, which would round twice). ±0 keep their
 * sign, overflow (from 65520 up) is ±Infinity, NaN is 0x7e00. three's DataUtils.toHalfFloat
 * truncates and is not used.
 */
export function floatToHalfBits(x: number): number {
  if (x !== x) return 0x7e00
  const sign = x < 0 || (x === 0 && 1 / x < 0) ? 0x8000 : 0
  const a = Math.abs(x)
  if (a >= 65520) return sign | 0x7c00
  // Subnormal: units of 2^-24; 1024 of them is the smallest normal, whose bits are 0x0400.
  if (a < 2 ** -14) return sign | roundEven(a * 2 ** 24)
  let e = Math.floor(Math.log2(a))
  if (2 ** e > a) e--
  else if (2 ** (e + 1) <= a) e++
  // a·2^(10−e) is exact (a power of two), in [1024, 2048); a carry to 2048 moves the exponent.
  return sign | (((e + 15) << 10) + roundEven(a * 2 ** (10 - e)) - 1024)
}

/** The value of a half's 16 bits. */
export function halfBitsToFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1
  const e = (bits >> 10) & 0x1f
  const m = bits & 0x3ff
  if (e === 0) return sign * m * 2 ** -24
  if (e === 31) return m ? NaN : sign * Infinity
  return sign * (1024 + m) * 2 ** (e - 25)
}

/** A float32's bits to a half's, round-to-nearest-even: the integer packer. */
function halfFromFloat32Bits(f: number): number {
  const sign = (f >>> 16) & 0x8000
  const a = f & 0x7fffffff
  if (a >= 0x7f800000) return a > 0x7f800000 ? 0x7e00 : sign | 0x7c00
  if (a >= 0x477ff000) return sign | 0x7c00 // 65520 and up
  if (a >= 0x38800000) {
    // Normal: rebias the exponent (127 → 15) and round off the low 13 mantissa bits.
    const base = a - 0x38000000
    let h = base >>> 13
    const rest = base & 0x1fff
    if (rest > 0x1000 || (rest === 0x1000 && h & 1)) h++
    return sign | h
  }
  if (a <= 0x33000000) return sign // up to 2^-25, the tie with 0, rounds to 0
  // Subnormal half: the mantissa with its implicit bit, in units of 2^-24.
  const shift = 126 - (a >>> 23)
  const m = (a & 0x7fffff) | 0x800000
  let h = m >>> shift
  const rest = m & ((1 << shift) - 1)
  const half = 1 << (shift - 1)
  if (rest > half || (rest === half && h & 1)) h++
  return sign | h
}

type Float16View = { set(source: ArrayLike<number>): void }
type Float16ArrayConstructor = new (buffer: ArrayBufferLike, byteOffset?: number, length?: number) => Float16View
/** Node 24 and current browsers have it; older Safari does not, and gets the integer packer. */
const Float16 = (globalThis as { Float16Array?: Float16ArrayConstructor }).Float16Array
export const HAS_FLOAT16_ARRAY = typeof Float16 === 'function'

function checkPack(scratch: Float32Array, out: Uint16Array): number {
  const nodes = scratch.length / 3
  if (!Number.isInteger(nodes) || out.length < 4 * nodes) {
    throw new RangeError(`packHalf: ${scratch.length} floats need ${4 * Math.ceil(nodes)} texels, out has ${out.length}`)
  }
  return nodes
}

/** The RGBA floats packHalfFloat16 stages, kept for the largest lattice packed so far. */
let staging = new Float32Array(0)

/**
 * packHalf through a Float16Array, which rounds to nearest even as it converts: the clamped
 * values are staged as RGBA floats and converted in one set(), a third faster in node 24 than
 * storing element by element. Throws where there is no Float16Array.
 */
export function packHalfFloat16(scratch: Float32Array, out: Uint16Array): number {
  if (!Float16) throw new Error('packHalfFloat16: no Float16Array here')
  const nodes = checkPack(scratch, out)
  if (staging.length < 4 * nodes) staging = new Float32Array(4 * nodes)
  const stage = staging
  let replaced = 0
  for (let node = 0, p = 0, q = 0; node < nodes; node++, p += 3, q += 4) {
    for (let c = 0; c < 3; c++) {
      let x = scratch[p + c]
      if (x !== x) {
        x = 0
        replaced++
      } else if (x > STORE_LIMIT) {
        if (x === Infinity) replaced++
        x = STORE_LIMIT
      } else if (x < -STORE_LIMIT) {
        if (x === -Infinity) replaced++
        x = -STORE_LIMIT
      }
      stage[q + c] = x
    }
    stage[q + 3] = 1
  }
  const view = new Float16(out.buffer, out.byteOffset, 4 * nodes)
  view.set(stage.length === 4 * nodes ? stage : stage.subarray(0, 4 * nodes))
  return replaced
}

/** packHalf on the floats' bits through a Uint32Array view: bit-identical to packHalfFloat16,
 *  for engines without Float16Array. */
export function packHalfBits(scratch: Float32Array, out: Uint16Array): number {
  const nodes = checkPack(scratch, out)
  const bits = new Uint32Array(scratch.buffer, scratch.byteOffset, scratch.length)
  let replaced = 0
  for (let node = 0, p = 0, q = 0; node < nodes; node++, p += 3, q += 4) {
    for (let c = 0; c < 3; c++) {
      const f = bits[p + c]
      const a = f & 0x7fffffff
      if (a > 0x7f800000) {
        out[q + c] = 0
        replaced++
      } else if (a > 0x41800000) {
        // Beyond ±16 (0x41800000), infinities included: ±16 is 0x4c00.
        if (a === 0x7f800000) replaced++
        out[q + c] = ((f >>> 16) & 0x8000) | 0x4c00
      } else {
        out[q + c] = halfFromFloat32Bits(f)
      }
    }
    out[q + 3] = HALF_ONE
  }
  return replaced
}

/**
 * Stage 4: an RGB float lattice (3 per node) into RGBA half texels (4 per node), each value
 * rounded to the nearest half (ties to even), clamped to ±16, never to [0, 1]; NaN becomes 0.
 * Alpha is 1 (0x3c00). The Float16Array path where there is one, else the integer packer, which
 * gives the same bits. Returns how many values were not finite.
 */
export function packHalf(scratch: Float32Array, out: Uint16Array): number {
  return HAS_FLOAT16_ARRAY ? packHalfFloat16(scratch, out) : packHalfBits(scratch, out)
}

const identityTexelCache = new Map<number, Uint16Array>()
const identityFloatCache = new Map<number, Float32Array>()

function identityFloats(n: number): Float32Array {
  let lattice = identityFloatCache.get(n)
  if (!lattice) {
    lattice = identityLattice(n)
    identityFloatCache.set(n, lattice)
  }
  return lattice
}

/**
 * The identity lattice as texels, node (i, j, k) = (i, j, k)/(n − 1) rounded to half, alpha 1:
 * exactly what a neutral bake packs. Exact in half for n = 17, 33, 65. Cached: the same array
 * every call, so callers copy it (`.slice()`) and never hand it to three or transfer it.
 */
export function identityTexels(n: number): Uint16Array {
  let texels = identityTexelCache.get(n)
  if (!texels) {
    checkLattice(n, 1, 3 * n ** 3, 3, 'identityTexels')
    texels = new Uint16Array(4 * n ** 3)
    packHalf(identityFloats(n), texels)
    identityTexelCache.set(n, texels)
  }
  return texels
}

const isIdentityBuffer = (buffer: ArrayBufferLike) => {
  for (const texels of identityTexelCache.values()) if (texels.buffer === buffer) return true
  return false
}

// ---- the per-pixel reference --------------------------------------------------------------------

export interface EvaluateOptions {
  tuning?: Readonly<GradeTuning>
  /** The lattice peak bakeLattice found. Stage 3's white point is the brightest node, which one
   *  pixel cannot know: without it, evaluateGrade stops after stage 2. */
  peak?: number
}

/**
 * The grade for one colour at a time, for tests and spot checks: every stage of plan 2.4 in
 * order, straight from the formulas — no tables for stage 1, the look through sampleLattice,
 * and no step skipped at neutral (a neutral step must change nothing either way). Returns
 * `(rgb, out?) => out` with the state compiled once; the state must not change meanwhile.
 */
export function createGradeEvaluator(state: GradeState, look: GradeLook | null = null,
  options: EvaluateOptions = {}): <T extends Vec3>(rgb: ArrayLike<number>, out?: T) => T {
  const tuning = options.tuning ?? DEFAULT_GRADE_TUNING
  const amount = look ? clamp01(look.amount) : 0
  const cube = look && amount > 0 ? look.cube : null
  if (cube) checkLook(look!)
  const gains = whiteBalanceGains(state.temperature, state.tint, tuning)
  const lift = wheelChannels('lift', state.lift, tuning)
  const gain = wheelChannels('gain', state.gain, tuning)
  const gamma = wheelChannels('gamma', state.gamma, tuning)
  const offset = wheelChannels('offset', state.offset, tuning)
  const master = monotoneCurve(state.curves.master)
  const curves = [monotoneCurve(state.curves.red), monotoneCurve(state.curves.green), monotoneCurve(state.curves.blue)]
  const hueSat = periodicCurve(state.hueSat, 1)
  const hueLuma = periodicCurve(state.hueLuma, 0)
  const shadows = wheelDelta(state.tones.shadows.u, state.tones.shadows.v)
  const highlights = wheelDelta(state.tones.highlights.u, state.tones.highlights.v)
  const mc = 0.5 + 0.25 * state.tones.balance
  const bw = 0.2 + 0.6 * state.tones.blending
  const roll = options.peak === undefined ? null : rollOffCurve(state.rollOff, options.peak, tuning)
  const u = [0, 0, 0]
  const sample = [0, 0, 0]
  const v = [0, 0, 0]
  const y = [0, 0, 0]
  return <T extends Vec3>(rgb: ArrayLike<number>, out: T = [0, 0, 0] as unknown as T): T => {
    // 0: the look.
    for (let c = 0; c < 3; c++) v[c] = rgb[c]
    if (cube) {
      for (let c = 0; c < 3; c++) u[c] = clamp01((rgb[c] - cube.domainMin[c]) / (cube.domainMax[c] - cube.domainMin[c]))
      sampleLattice(cube.data, cube.size, u, sample)
      for (let c = 0; c < 3; c++) v[c] = amount === 1 ? sample[c] : rgb[c] + amount * (sample[c] - rgb[c])
    }
    // 1: per channel.
    for (let c = 0; c < 3; c++) {
      let t = srgbOetf(gains[c] * srgbEotf(v[c]))
      t = t * (gain[c] - lift[c]) + lift[c] + offset[c]
      t = powC1(t, 2 ** -gamma[c])
      t = contrastCurve(t, state.contrast, state.pivot)
      if (master) t = master(t)
      const curve = curves[c]
      if (curve) t = curve(t)
      y[c] = t
    }
    // 2: across channels, from the stage-2 input.
    const max = Math.max(y[0], y[1], y[2])
    const min = Math.min(y[0], y[1], y[2])
    const lum = luma(y[0], y[1], y[2])
    const hue = hexconeHue(y[0], y[1], y[2])
    const gate = smoothstep(0, tuning.hueChromaGate, max - min)
    const chroma2 = ((y[0] - y[1]) ** 2 + (y[1] - y[2]) ** 2 + (y[2] - y[0]) ** 2) / (2 * (Math.max(lum, 0) + 0.02) ** 2)
    const weight = 1 / (1 + chroma2 / tuning.vibranceChroma ** 2)
    // 2a
    const fs = hueSat ? sampleHueTable(hueSat, hue) : 1
    const s = Math.max(state.saturation * (1 + state.vibrance * weight), 0) * (1 + gate * (fs - 1))
    for (let c = 0; c < 3; c++) y[c] = lum + s * (y[c] - lum)
    // 2b
    const fl = hueLuma ? sampleHueTable(hueLuma, hue) : 0
    for (let c = 0; c < 3; c++) y[c] = y[c] + lum * (2 ** (gate * fl) - 1)
    // 2c
    const lum2 = luma(y[0], y[1], y[2])
    const black = smoothstep(0, 0.06, lum2)
    const split = smoothstep(mc - bw / 2, mc + bw / 2, lum2)
    const wh = split * black
    const ws = (1 - split) * black
    for (let c = 0; c < 3; c++) y[c] = y[c] + tuning.toneChroma * (ws * shadows[c] + wh * highlights[c])
    // 2d
    const a = Math.max(y[0], y[1], y[2])
    const av = Math.max(v[0], v[1], v[2])
    if (a > GAMUT_FLOOR && av > GAMUT_FLOOR) {
      for (let c = 0; c < 3; c++) {
        const d = (a - y[c]) / a
        const dv = (av - v[c]) / av
        const t = Math.max(tuning.gamutThreshold, dv)
        if (d > t && t < 1) y[c] = a * (1 - (t + (1 - t) * Math.tanh((d - t) / (1 - t))))
      }
    }
    // 3, given the lattice's peak.
    if (roll) {
      const scale = rollOffScale(Math.max(y[0], y[1], y[2]), roll)
      for (let c = 0; c < 3; c++) y[c] *= scale
    }
    out[0] = y[0]
    out[1] = y[1]
    out[2] = y[2]
    return out
  }
}

/** The grade at one colour (createGradeEvaluator, once): the tests' oracle. */
export function evaluateGrade<T extends Vec3>(state: GradeState, look: GradeLook | null, rgb: ArrayLike<number>,
  out: T, options: EvaluateOptions = {}): T {
  return createGradeEvaluator(state, look, options)(rgb, out)
}

// ---- lattice size and draft -------------------------------------------------------------------

export interface LatticeSize {
  n: number
  /** The lattice reproduces the look's own trilinear exactly (or there is no look). */
  exact: boolean
  /** Lattice cells per cube cell: n − 1 = refinement·(N − 1) for an exact look of size N, whose
   *  nodes are then every refinement-th lattice node. 1 without a look and for a resampled one.
   *  draftStride takes it, and so does a BakeJob. */
  refinement: number
  /** Why it is not 1:1, for the Look status line. */
  warning?: string
}

const clampSize = (x: number, lo: number, hi: number) => Math.min(Math.max(Math.round(Number.isFinite(x) ? x : lo), lo), hi)

/**
 * The lattice to bake (plan 2.6): `base` (config grade.lutSize) without a look; for a 3D look of
 * size N over the unit domain the smallest k(N − 1) + 1 ≥ base, on which trilinear reproduces the
 * cube's own trilinear exactly — 17 → 33, 21 → 41, 16 → 46, 32 → 63, 64 → 64 — with that k as
 * the refinement. Over `cap` (config grade.maxLattice) the cube is resampled onto `cap`³, and
 * with any other domain onto `base`³, both with a "not 1:1" warning.
 */
export function latticeSizeFor(size: number | null, base: number, cap: number, unitDomain = true): LatticeSize {
  const limit = clampSize(cap, 2, LATTICE_MAX)
  const own = clampSize(base, 2, limit)
  if (size === null) return { n: own, exact: true, refinement: 1 }
  if (!Number.isInteger(size) || size < 2) {
    return {
      n: own, exact: false, refinement: 1,
      warning: `This look has no usable 3D table (size ${size}); resampled onto ${own}³, not 1:1.`,
    }
  }
  if (!unitDomain) {
    return {
      n: own, exact: false, refinement: 1,
      warning: `This look's input domain is not 0..1, so it is resampled onto ${own}³: not 1:1.`,
    }
  }
  const refinement = Math.max(1, Math.ceil((own - 1) / (size - 1)))
  const refined = refinement * (size - 1) + 1
  if (refined <= limit) return { n: refined, exact: true, refinement }
  return {
    n: limit,
    exact: false,
    refinement: 1,
    warning: `This ${size}³ look needs a ${refined}³ lattice to stay exact, above the limit of ${limit}³; `
      + `it is resampled onto ${limit}³: not 1:1.`,
  }
}

/** True for the default 0..1 domain on all three channels. */
export function isUnitDomain(cube: Pick<CubeLattice, 'domainMin' | 'domainMax'>): boolean {
  return cube.domainMin.every((x) => x === 0) && cube.domainMax.every((x) => x === 1)
}

/**
 * The draft's stride for an n³ lattice: the smallest s ≥ 2 that divides n − 1 and still leaves
 * (n − 1)/s + 1 ≥ 9 nodes a side, else 1 (no draft). 33 → 2 (17³ nodes). On a refined lattice
 * (`refinement` from latticeSizeFor, above 1) s must divide the refinement too, so every node of
 * the look is a draft node and the draft shows the look exactly: 41 for a 21³ look → 2 (21 a
 * side), 46 for 16³ → 3 (16), 37 for 13³ → 3 (13, where 2 would miss the look's nodes); 34 for a
 * 4³ look (refinement 11) has no such s, so it is never drafted.
 */
export function draftStride(n: number, refinement = 1): number {
  const refined = Number.isInteger(refinement) && refinement > 1
  for (let s = 2; (n - 1) / s + 1 >= 9; s++) {
    if ((n - 1) % s === 0 && (!refined || refinement % s === 0)) return s
  }
  return 1
}

// ---- whole bakes -------------------------------------------------------------------------------

export interface BakeOptions {
  tuning?: Readonly<GradeTuning>
  /** Debug: run every step even at its neutral value (compileGrade). */
  forceStages?: boolean
  /** The float lattice to bake into (3n³), e.g. the worker's kept export lattice; else a new one. */
  scratch?: Float32Array
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/** Stages 0–3 of a compiled grade into `lattice`, the draft filled; the identity is copied. */
function bakeFloats(compiled: CompiledGrade, n: number, stride: number, lattice: Float32Array, what: string): number {
  checkLattice(n, stride, lattice.length, 3, what)
  if (compiled.identity) {
    lattice.set(identityFloats(n))
    return 1
  }
  const peak = bakeLattice(compiled, n, stride, lattice)
  applyRollOff(lattice, n, stride, compiled.rollOff, peak, compiled.tuning)
  fillLattice(lattice, n, stride)
  return peak
}

/**
 * Stages 0–3 into a float lattice (3n³, red fastest; `out`, else options.scratch, else a new
 * one), the draft filled at stride > 1: what the worker keeps for Export .cube. A grade that does
 * nothing copies the identity. `peak` is before the roll-off; `ms` is the whole bake.
 */
export function bakeGradeFloat(state: GradeState, look: GradeLook | null, n: number, stride = 1, out?: Float32Array,
  options: BakeOptions = {}): { lattice: Float32Array; peak: number; ms: number } {
  const start = now()
  const lattice = out ?? options.scratch ?? new Float32Array(3 * n ** 3)
  const compiled = compileGrade(state, options.tuning, look, { forceStages: options.forceStages })
  const peak = bakeFloats(compiled, n, stride, lattice, 'bakeGradeFloat')
  return { lattice, peak, ms: now() - start }
}

/**
 * A whole bake into texels (4n³ half bits, RGBA; `out`, else a new array): bakeGradeFloat, then
 * packHalf. A grade that does nothing copies the cached identityTexels, so it costs a copy.
 * `lattice` is the float lattice the texels came from (options.scratch when given), for export.
 * `ms` includes the pack.
 */
export function bakeGradeTexels(state: GradeState, look: GradeLook | null, n: number, stride = 1, out?: Uint16Array,
  options: BakeOptions = {}): { texels: Uint16Array; lattice: Float32Array; peak: number; ms: number } {
  const start = now()
  const texels = out ?? new Uint16Array(4 * n ** 3)
  if (texels.length < 4 * n ** 3) throw new RangeError(`bakeGradeTexels: ${texels.length} texels hold fewer than ${n}³ nodes`)
  if (isIdentityBuffer(texels.buffer)) throw new RangeError('bakeGradeTexels: never bake into the cached identityTexels')
  const lattice = options.scratch ?? new Float32Array(3 * n ** 3)
  const compiled = compileGrade(state, options.tuning, look, { forceStages: options.forceStages })
  const peak = bakeFloats(compiled, n, stride, lattice, 'bakeGradeTexels')
  if (compiled.identity) texels.set(identityTexels(n))
  else packHalf(lattice.length === 3 * n ** 3 ? lattice : lattice.subarray(0, 3 * n ** 3), texels)
  return { texels, lattice, peak, ms: now() - start }
}

// ---- scheduling the worker ---------------------------------------------------------------------

/** The look as a bake job names it: the worker holds the parsed lattice under `key`. */
export interface BakeLookKey {
  key: string
  amount: number
}

/** What the editor asks for: the grade, the look and the lattice size. */
export interface BakeJob {
  state: GradeState
  look: BakeLookKey | null
  n: number
  /** latticeSizeFor's refinement for the look on n, so a draft lands on the look's nodes
   *  (draftStride). Default 1: no look, or a resampled one. */
  refinement?: number
}

/** To the worker: bake `job` at `stride` into `out` (8n³ bytes, transferred). */
export interface BakeMessage extends BakeJob {
  kind: 'bake'
  seq: number
  stride: number
  out: ArrayBuffer
}

/** From the worker: the texels in `out` (transferred back). */
export interface BakedMessage {
  kind: 'baked'
  seq: number
  n: number
  stride: number
  ms: number
  peak: number
  out: ArrayBuffer
}

export interface BakeResult {
  seq: number
  n: number
  stride: number
  /** Stride 1: every node baked. */
  final: boolean
  ms: number
  peak: number
  texels: Uint16Array
}

export interface BakeSchedulerOptions {
  /** Posts to the worker, transferring message.out (or bakes it at once, without a worker). */
  post(message: BakeMessage): void
  /** Drags bake drafts only while the last final bake took longer than this (config
   *  grade.draftWhenFinalOverMs). */
  draftThresholdMs: number
  /** A texel buffer of 8n³ bytes to bake into (BufferPool.take). Default: a new one. */
  take?(n: number): ArrayBuffer
  /** Where the buffer of a dropped result goes (BufferPool.give). */
  give?(buffer: ArrayBuffer): void
}

export interface BakeScheduler {
  /**
   * Asks for a bake of `job`: a final one on commit (a 'change', a pointerup, the end of a
   * keyboard nudge), else a draft if the last final was slow. One bake is in flight at a time;
   * while it runs, the newest request waits and replaces any older one, so a commit promotes a
   * waiting draft. A request for what the newest posted bake already shows (or a draft of what it
   * shows finally) is skipped. Returns 'posted', 'queued' or 'skipped'.
   */
  request(job: BakeJob, options?: { commit?: boolean }): 'posted' | 'queued' | 'skipped'
  /** A worker message for the bake in flight: its result, and the waiting request posted. Null
   *  for a stale seq, whose buffer goes to `give`. */
  onResult(message: BakedMessage): BakeResult | null
  /** The last final bake's time, for the draft decision; onResult keeps it up to date itself. */
  setLastFinalMs(ms: number): void
  readonly lastFinalMs: number
  /** A bake is in flight. */
  readonly busy: boolean
  /** Forgets the bake in flight and the waiting request, e.g. after a worker error; a result
   *  that still arrives is stale. */
  reset(): void
}

const jobHash = (job: BakeJob) => `${JSON.stringify(job.state)}|${job.look ? JSON.stringify([job.look.key, job.look.amount]) : '-'}|${job.n}`

export function createBakeScheduler(options: BakeSchedulerOptions): BakeScheduler {
  const take = options.take ?? ((n: number) => new ArrayBuffer(8 * n ** 3))
  let seq = 0
  let inFlight = 0
  let waiting: { job: BakeJob; hash: string; commit: boolean } | null = null
  /** The newest bake posted: what the texture shows once its result is applied. */
  let newest: { hash: string; final: boolean } | null = null
  let lastFinalMs = 0

  const strideOf = (job: BakeJob) => draftStride(job.n, job.refinement ?? 1)
  const isFinal = (job: BakeJob, commit: boolean) => commit || !(lastFinalMs > options.draftThresholdMs) || strideOf(job) === 1
  const covered = (hash: string, final: boolean) => newest !== null && newest.hash === hash && (newest.final || !final)

  const send = (job: BakeJob, hash: string, commit: boolean): 'posted' | 'skipped' => {
    const final = isFinal(job, commit)
    if (covered(hash, final)) return 'skipped'
    const stride = final ? 1 : strideOf(job)
    const out = take(job.n)
    seq++
    inFlight = seq
    newest = { hash, final }
    options.post({ kind: 'bake', seq, state: job.state, look: job.look, n: job.n, stride, out })
    return 'posted'
  }

  return {
    request(job, { commit = false } = {}) {
      const hash = jobHash(job)
      if (covered(hash, isFinal(job, commit))) {
        waiting = null
        return 'skipped'
      }
      if (inFlight) {
        waiting = { job, hash, commit }
        return 'queued'
      }
      return send(job, hash, commit)
    },
    onResult(message) {
      if (!inFlight || message.seq !== inFlight) {
        if (message.out && options.give) options.give(message.out)
        return null
      }
      inFlight = 0
      const final = message.stride === 1
      if (final && Number.isFinite(message.ms)) lastFinalMs = message.ms
      if (waiting) {
        const next = waiting
        waiting = null
        send(next.job, next.hash, next.commit)
      }
      return {
        seq: message.seq, n: message.n, stride: message.stride, final, ms: message.ms, peak: message.peak,
        texels: new Uint16Array(message.out),
      }
    },
    setLastFinalMs(ms) {
      if (Number.isFinite(ms)) lastFinalMs = ms
    },
    get lastFinalMs() { return lastFinalMs },
    get busy() { return inFlight !== 0 },
    reset() {
      inFlight = 0
      waiting = null
      newest = null
    },
  }
}

// ---- texel buffers -----------------------------------------------------------------------------

export interface BufferPool {
  /** The lattice size its buffers fit (8n³ bytes). */
  readonly n: number
  /** Buffers held. */
  readonly count: number
  /** A held buffer, or a new one. */
  take(): ArrayBuffer
  /** Keeps a buffer for later; drops one of another size (a detached buffer is 0 bytes), one
   *  already held, a cached identityTexels buffer and any beyond the limit. True when kept. */
  give(buffer: ArrayBufferLike | null | undefined): boolean
  clear(): void
}

/**
 * Recycles the texel buffers that go to the worker and come back, for one lattice size: a size
 * change takes a new pool. The editor never gives it the array the texture holds; the pool
 * itself refuses identityTexels' cached ones.
 */
export function createBufferPool(n: number, limit = 3): BufferPool {
  const bytes = 8 * n ** 3
  const held: ArrayBuffer[] = []
  return {
    n,
    get count() { return held.length },
    take() { return held.pop() ?? new ArrayBuffer(bytes) },
    give(buffer) {
      if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== bytes || held.length >= limit) return false
      if (held.includes(buffer) || isIdentityBuffer(buffer)) return false
      held.push(buffer)
      return true
    },
    clear() { held.length = 0 },
  }
}
