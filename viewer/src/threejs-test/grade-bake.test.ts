import { test } from 'node:test'
import assert from 'node:assert/strict'

import { identityLattice, sampleLattice, type CubeLattice, type CubeRgb } from './cube-format.ts'
import { monotoneCurve } from './grade-curves.ts'
import {
  applyRollOff, bakeGradeFloat, bakeGradeTexels, bakeLattice, compileGrade, createBakeScheduler, createBufferPool,
  createGradeEvaluator, draftStride, evaluateGrade, fillLattice, floatToHalfBits, HAS_FLOAT16_ARRAY, halfBitsToFloat,
  identityTexels, isUnitDomain, latticeSizeFor, packHalf, packHalfBits, packHalfFloat16,
  type BakedMessage, type BakeMessage, type BakeResult, type GradeLook,
} from './grade-bake.ts'
import { GRADE_RANGES, isGradeIdentity, NEUTRAL_GRADE, parseGradeState, type GradeState } from './grade-model.ts'

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

/** A state from a partial one, which must parse without a warning. */
function grade(partial: unknown): GradeState {
  const { state, warnings } = parseGradeState(partial)
  assert.deepEqual(warnings, [], 'the test grade is valid')
  return state
}

/** Every control on, at strengths a grade might really use. */
const BUSY = grade({
  temperature: 18, tint: -7,
  lift: { y: 0.015, u: 0.12, v: -0.06 }, gamma: { y: 0.18, u: -0.1, v: 0.08 },
  gain: { y: 1.08, u: 0.06, v: 0.1 }, offset: { y: -0.008, u: 0.03, v: 0.05 },
  contrast: 1.25, pivot: 0.43, saturation: 1.15, vibrance: 0.35,
  curves: {
    master: [[0, 0], [0.25, 0.21], [0.75, 0.8], [1, 1]], red: [[0, 0.01], [0.5, 0.52], [1, 1]],
    green: [[0, 0], [0.4, 0.38], [1, 0.98]], blue: [[0, 0.02], [0.6, 0.6], [1, 1]],
  },
  hueSat: [[30, 1.15], [110, 1.25], [220, 0.85]], hueLuma: [[40, 0.1], [115, -0.2], [230, 0.15]],
  tones: { shadows: { u: 0.25, v: -0.15 }, highlights: { u: -0.2, v: 0.25 }, balance: 0.1, blending: 0.6 },
  rollOff: 0.5,
})

/** Stage 1 only: stage 2 is neutral, so only the gamut compression runs there. */
const PER_CHANNEL = grade({
  temperature: -25, tint: 12,
  lift: { y: 0.02, u: -0.2, v: 0.1 }, gamma: { y: -0.3, u: 0.15, v: 0 },
  gain: { y: 1.2, u: 0, v: -0.1 }, offset: { y: 0.01, u: 0.05, v: 0.05 },
  contrast: 1.4, pivot: 0.5,
  curves: { master: [[0, 0.03], [0.5, 0.45], [1, 0.97]], green: [[0, 0], [0.3, 0.35], [1, 1]] },
})

/** A smooth look with some grain, values a little outside [0, 1] at the corners, every channel
 *  depending on the others, like a film emulation cube. */
function syntheticCube(size: number, seed: number, domainMin: CubeRgb = [0, 0, 0], domainMax: CubeRgb = [1, 1, 1]): CubeLattice {
  const random = seeded(seed)
  const data = new Float32Array(3 * size ** 3)
  let p = 0
  for (let k = 0; k < size; k++) {
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const r = i / (size - 1)
        const g = j / (size - 1)
        const b = k / (size - 1)
        data[p++] = 0.03 + 0.92 * r ** 1.12 + 0.06 * g * b + 0.02 * (random() - 0.5)
        data[p++] = 0.02 + 0.95 * g ** 0.94 - 0.04 * r * (1 - g) + 0.02 * (random() - 0.5)
        data[p++] = 0.05 + 0.86 * b + 0.08 * r * g + 0.02 * (random() - 0.5)
      }
    }
  }
  return { data, size, domainMin, domainMax }
}

const nodeOf = (n: number, i: number, j: number, k: number) => i + n * (j + n * k)

/** Calls f(i, j, k, node) for every node of an n³ lattice, red fastest. */
function eachNode(n: number, f: (i: number, j: number, k: number, node: number) => void) {
  for (let k = 0, node = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++, node++) f(i, j, k, node)
}

function differing(a: Uint16Array, b: Uint16Array): number {
  assert.equal(a.length, b.length)
  let count = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) count++
  return count
}

/** The largest |lattice − f(node)| over every node. */
function worstAtNodes(lattice: Float32Array, n: number, f: (rgb: number[], out: number[]) => number[]): number {
  const out = [0, 0, 0]
  let worst = 0
  eachNode(n, (i, j, k, node) => {
    f([i / (n - 1), j / (n - 1), k / (n - 1)], out)
    for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(lattice[3 * node + c] - out[c]))
  })
  return worst
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

test('identityTexels(17/33/65) decode to exactly i/(n−1) with alpha 1, from a cache', () => {
  for (const n of [17, 33, 65]) {
    const texels = identityTexels(n)
    assert.equal(texels.length, 4 * n ** 3)
    assert.equal(identityTexels(n), texels, 'the same cached array every call')
    let bad = 0
    eachNode(n, (i, j, k, node) => {
      const q = 4 * node
      if (halfBitsToFloat(texels[q]) !== i / (n - 1) || halfBitsToFloat(texels[q + 1]) !== j / (n - 1)
        || halfBitsToFloat(texels[q + 2]) !== k / (n - 1) || texels[q + 3] !== 0x3c00) bad++
    })
    assert.equal(bad, 0, `${n}³`)
  }
})

test('a neutral bake is identityTexels bit for bit, also with every stage forced on', () => {
  const identityCube: CubeLattice = { data: identityLattice(17), size: 17, domainMin: [0, 0, 0], domainMax: [1, 1, 1] }
  for (const n of [17, 33, 41, 65]) {
    const copied = bakeGradeTexels(NEUTRAL_GRADE, null, n)
    assert.equal(differing(copied.texels, identityTexels(n)), 0, `${n}³ copy`)
    assert.notEqual(copied.texels, identityTexels(n), 'a copy, never the cache')
    assert.equal(copied.peak, 1)

    // The bake loop itself, not the copy.
    const compiled = compileGrade(NEUTRAL_GRADE)
    assert.equal(compiled.identity, true)
    const scratch = new Float32Array(3 * n ** 3)
    bakeLattice(compiled, n, 1, scratch)
    const texels = new Uint16Array(4 * n ** 3)
    packHalf(scratch, texels)
    assert.equal(differing(texels, identityTexels(n)), 0, `${n}³ bake loop`)

    const forced = compileGrade(NEUTRAL_GRADE, undefined, null, { forceStages: true })
    const { look, rollOff, ...steps } = forced.stages
    assert.ok(Object.values(steps).every(Boolean), 'every step runs')
    const scratchForced = new Float32Array(3 * n ** 3)
    bakeLattice(forced, n, 1, scratchForced)
    packHalf(scratchForced, texels)
    assert.equal(differing(texels, identityTexels(n)), 0, `${n}³ forced`)
  }
  // Forced through the look path too: an identity cube at amount 1 and 0.5 makes stage 1 run on
  // its 4096-entry tables.
  for (const amount of [1, 0.5]) {
    const forced = bakeGradeTexels(NEUTRAL_GRADE, { cube: identityCube, amount }, 33, 1, undefined, { forceStages: true })
    assert.equal(differing(forced.texels, identityTexels(33)), 0, `forced, identity look at ${amount}`)
  }
  // What isGradeIdentity ignores bakes to the identity as well.
  const ignored = grade({ rollOff: 1, pivot: 0.3, tones: { balance: 0.7, blending: 0.1 } })
  assert.equal(compileGrade(ignored).identity, true)
  assert.equal(differing(bakeGradeTexels(ignored, null, 33).texels, identityTexels(33)), 0)
})

test('compileGrade turns a step on only off its neutral value', () => {
  const cases: Array<[unknown, keyof ReturnType<typeof compileGrade>['stages']]> = [
    [{ temperature: 1 }, 'whiteBalance'], [{ tint: -1 }, 'whiteBalance'], [{ lift: { y: 0.001 } }, 'levels'],
    [{ gain: { u: 0.1, v: 0 } }, 'levels'], [{ offset: { v: -0.05 } }, 'levels'], [{ gamma: { y: 0.01 } }, 'gamma'],
    [{ contrast: 1.01 }, 'contrast'], [{ contrast: 0.99 }, 'contrast'], [{ curves: { blue: [[0, 0], [1, 0.99]] } }, 'curves'],
    [{ saturation: 0.99 }, 'saturation'], [{ vibrance: 0.01 }, 'saturation'], [{ hueSat: [[90, 1.01]] }, 'saturation'],
    [{ hueLuma: [[90, 0.01]] }, 'hueLuma'], [{ tones: { highlights: { u: 0.05, v: 0 } } }, 'tones'],
  ]
  for (const [partial, stage] of cases) {
    const compiled = compileGrade(grade(partial))
    assert.equal(compiled.identity, false, JSON.stringify(partial))
    assert.equal(compiled.stages[stage], true, `${JSON.stringify(partial)} turns ${stage} on`)
    assert.equal(compiled.stages.gamut, true, 'any change runs the gamut compression')
  }
  assert.equal(compileGrade(grade({ hueSat: [[90, 1], [200, 1]], hueLuma: [[10, 0]] })).identity, true, 'hue points at neutral')
  const cube = syntheticCube(9, 1)
  assert.equal(compileGrade(NEUTRAL_GRADE, undefined, { cube, amount: 0 }).identity, true, 'a look at amount 0')
  const looked = compileGrade(NEUTRAL_GRADE, undefined, { cube, amount: 0.5 })
  assert.equal(looked.identity, false)
  assert.equal(looked.stages.look, true)
  assert.equal(looked.stages.gamut, false, 'the look alone leaves y = v')
  assert.throws(() => compileGrade(NEUTRAL_GRADE, undefined, { cube: { ...cube, size: 10 }, amount: 1 }), RangeError)
})

test('floatToHalfBits rounds like Math.f16round: 2·10⁶ seeded float32 values, doubles and the edges', () => {
  const f16round = (Math as unknown as { f16round(x: number): number }).f16round
  const same = (bits: number, x: number) => {
    const expected = f16round(x)
    return Number.isNaN(expected) ? bits === 0x7e00 : Object.is(halfBitsToFloat(bits), expected)
  }
  const random = seeded(7)
  const f32 = new Float32Array(1)
  const u32 = new Uint32Array(f32.buffer)
  let mismatches = 0
  for (let n = 0; n < 2_000_000; n++) {
    // Half of them anywhere in float32, half with an exponent around the half range (2^-27..2^18).
    const word = (random() * 4294967296) >>> 0
    u32[0] = n & 1 ? word : (word & 0x807fffff) | ((100 + Math.floor(random() * 46)) << 23)
    if (!same(floatToHalfBits(f32[0]), f32[0])) mismatches++
  }
  assert.equal(mismatches, 0)
  for (let n = 0; n < 100_000; n++) {
    const x = (random() - 0.5) * 2 ** (Math.floor(random() * 50) - 30)
    if (!same(floatToHalfBits(x), x)) mismatches++
  }
  assert.equal(mismatches, 0, 'doubles, rounded once')
  const edges: Array<[number, number]> = [
    [0, 0x0000], [-0, 0x8000], [NaN, 0x7e00], [Infinity, 0x7c00], [-Infinity, 0xfc00], [1, 0x3c00], [-2, 0xc000],
    [2 ** -24, 0x0001], [2 ** -25, 0x0000], [2 ** -25 * (1 + 2 ** -23), 0x0001], [1.5 * 2 ** -24, 0x0002],
    [2.5 * 2 ** -24, 0x0002], [2 ** -14, 0x0400], [2 ** -14 - 2 ** -25, 0x0400], [2 ** -14 - 2 ** -24, 0x03ff],
    [65504, 0x7bff], [65519.99, 0x7bff], [65520, 0x7c00], [3.4e38, 0x7c00], [1e-45, 0x0000],
    [1 + 2 ** -11, 0x3c00], [1 + 3 * 2 ** -11, 0x3c02], [1 + 2 ** -11 + 2 ** -40, 0x3c01], [16, 0x4c00],
  ]
  for (const [x, bits] of edges) {
    assert.equal(floatToHalfBits(x), bits, `${x}`)
    assert.ok(same(bits, x), `${x} as f16round`)
  }
  // Every half comes back as itself.
  for (let bits = 0; bits < 0x10000; bits++) {
    const x = halfBitsToFloat(bits)
    if (Number.isNaN(x)) assert.equal((bits & 0x7c00) === 0x7c00 && (bits & 0x3ff) !== 0, true)
    else assert.equal(floatToHalfBits(x), bits, `0x${bits.toString(16)}`)
  }
})

test('the Float16Array packer and the integer packer give the same bits', { skip: !HAS_FLOAT16_ARRAY }, () => {
  const random = seeded(11)
  const nodes = 200_000
  const scratch = new Float32Array(3 * nodes)
  const u32 = new Uint32Array(scratch.buffer)
  for (let i = 0; i < scratch.length; i++) {
    const pick = random()
    if (pick < 0.6) scratch[i] = (random() - 0.2) * 1.6
    else if (pick < 0.8) u32[i] = ((random() * 4294967296) >>> 0 & 0x807fffff) | ((95 + Math.floor(random() * 40)) << 23)
    else scratch[i] = [NaN, Infinity, -Infinity, -0, 0, 16, -16, 16.001, -40, 1e-30, 2 ** -25, 65520][Math.floor(random() * 12)]
  }
  const viaF16 = new Uint16Array(4 * nodes)
  const viaBits = new Uint16Array(4 * nodes)
  const replacedF16 = packHalfFloat16(scratch, viaF16)
  const replacedBits = packHalfBits(scratch, viaBits)
  assert.equal(differing(viaF16, viaBits), 0)
  assert.equal(replacedF16, replacedBits)
  assert.ok(replacedF16 > 0)
  for (let node = 0; node < nodes; node++) {
    assert.equal(viaBits[4 * node + 3], 0x3c00)
    for (let c = 0; c < 3; c++) {
      const x = scratch[3 * node + c]
      const stored = Number.isNaN(x) ? 0 : Math.min(Math.max(x, -16), 16)
      if (viaBits[4 * node + c] !== floatToHalfBits(stored)) assert.fail(`node ${node}: ${x}`)
    }
  }
  assert.equal(floatToHalfBits(16), 0x4c00)
})

test('a red-only curve changes R along i only, R fastest', (t) => {
  const points: [number, number][] = [[0, 0], [0.5, 0.6], [1, 1]]
  const state = grade({ curves: { red: points } })
  const curve = monotoneCurve(points)!
  const n = 17
  const { lattice } = bakeGradeFloat(state, null, n)
  let rBad = 0
  let gbBad = 0
  let lifted = 0
  let lift = 0
  eachNode(n, (i, j, k, node) => {
    const r = lattice[3 * node]
    const g = lattice[3 * node + 1]
    const b = lattice[3 * node + 2]
    if (r !== Math.fround(curve(i / (n - 1)))) rBad++
    const x = [Math.fround(j / (n - 1)), Math.fround(k / (n - 1))]
    // G and B keep their input wherever the compression has no reason to act: both at least a
    // fifth of the brightest channel. Elsewhere, where the raised red adds chroma to a colour
    // that was already saturated, it may only lift them, and only softly.
    const top = Math.max(r, g, b)
    if (g >= 0.2 * top && b >= 0.2 * top) {
      if (g !== x[0] || b !== x[1]) gbBad++
    } else if (g < x[0] || b < x[1]) gbBad++
    else if (g !== x[0] || b !== x[1]) {
      lifted++
      lift = Math.max(lift, g - x[0], b - x[1])
    }
  })
  assert.equal(rBad, 0, 'R is the curve of i alone')
  assert.equal(gbBad, 0, 'G and B are their own inputs, or lifted by the gamut compression')
  t.diagnostic(`gamut compression lifted G or B at ${lifted} of ${n ** 3} nodes, by at most ${(lift * 255).toFixed(3)} LSB`)
  assert.ok(lift * 255 < 0.5, `lifted by ${(lift * 255).toFixed(3)} LSB`)
})

test('the bake equals evaluateGrade at every node within 1e-6', (t) => {
  for (const [name, state] of [['per channel', PER_CHANNEL], ['busy', BUSY]] as const) {
    for (const n of [17, 33]) {
      const { lattice, peak } = bakeGradeFloat(state, null, n)
      const worst = worstAtNodes(lattice, n, createGradeEvaluator(state, null, { peak }))
      assert.ok(worst <= 1e-6, `${name} ${n}³: ${worst}`)
      if (n === 33) t.diagnostic(`${name} at 33³: worst ${worst.toExponential(2)} (peak ${peak.toFixed(4)})`)
    }
  }
  // With a look, stage 1 runs on its 4096-entry tables: the error of their linear read.
  const look: GradeLook = { cube: syntheticCube(17, 3), amount: 0.8 }
  const { lattice, peak } = bakeGradeFloat(BUSY, look, 33)
  const worst = worstAtNodes(lattice, 33, createGradeEvaluator(BUSY, look, { peak }))
  t.diagnostic(`busy with a 17³ look at 33³: worst ${worst.toExponential(2)} = ${(worst * 255).toFixed(5)} LSB`)
  assert.ok(worst * 255 <= 0.002, 'the dense tables stay well under 0.01 LSB')
})

/** A 2³ look that mixes the channels a little: R = −0.0012 + 0.9701 r + 0.0313 g + 0.0011 b and
 *  likewise rotated, so the stage-1 inputs of a 33³ bake's nodes cover −0.0012..1.0013 on every
 *  channel about every 3.4e-5, a dozen to each cell of the 4096-entry tables. */
function mixingLook(): GradeLook {
  const weights = [[0.9701, 0.0313, 0.0011], [0.0011, 0.9701, 0.0313], [0.0313, 0.0011, 0.9701]]
  const data = new Float32Array(24)
  for (let p = 0; p < 8; p++) {
    const x = [p & 1, (p >> 1) & 1, (p >> 2) & 1]
    for (let c = 0; c < 3; c++) data[3 * p + c] = -0.0012 + weights[c][0] * x[0] + weights[c][1] * x[1] + weights[c][2] * x[2]
  }
  return { cube: { data, size: 2, domainMin: [0, 0, 0], domainMax: [1, 1, 1] }, amount: 1 }
}

test('with a look, stage 1 stays within 0.002 LSB of the exact grade, also where it bends hardest', (t) => {
  // Read linearly, the tables miss these by up to 0.33 LSB (the step), 0.012 (the toe at gain 2)
  // and 1.5 LSB (toe, contrast and step together); the cells around such bends are exact.
  const look = mixingLook()
  const step: [number, number][] = [[0, 0], [0.5, 0], [0.51, 1], [1, 1]]
  const cases: Array<[string, GradeState]> = [
    ['a 0.01-wide step curve', grade({ curves: { master: step } })],
    ['a steep S on green', grade({ curves: { green: [[0, 0], [0.3, 0.1], [0.32, 0.6], [0.34, 0.9], [1, 1]] } })],
    ['gamma +1, gain 2', grade({ gamma: { y: 1 }, gain: { y: 2 } })],
    ['gamma +1, gain 2, lift −0.25', grade({ gamma: { y: 1 }, gain: { y: 2 }, lift: { y: -0.25 } })],
    ['gamma +1, contrast 2, a red step', grade({ gamma: { y: 1 }, contrast: 2, pivot: 0.2, curves: { red: step } })],
    ['temperature +100', grade({ temperature: 100 })],
    ['busy', BUSY],
  ]
  for (const [name, state] of cases) {
    const { lattice, peak } = bakeGradeFloat(state, look, 33)
    const worst = worstAtNodes(lattice, 33, createGradeEvaluator(state, look, { peak }))
    t.diagnostic(`${name}: ${(worst * 255).toFixed(5)} LSB`)
    assert.ok(worst * 255 <= 0.002, `${name}: ${(worst * 255).toFixed(4)} LSB`)
  }
})

// ---- each control against plan 2.3/2.4, computed here ----------------------------------------
// evaluateGrade is a second copy of the bake's formulas in grade-bake.ts, so the bake agreeing
// with it says nothing about whether either reads the plan right. These expectations are the
// plan's formulas written out in the test; a colour on the 33³ grid is checked in the bake too.

const planLuma = (rgb: number[]) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
const planSmoothstep = (lo: number, hi: number, x: number) => {
  const t = Math.min(Math.max((x - lo) / (hi - lo), 0), 1)
  return t * t * (3 - 2 * t)
}
const planEotf = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)
const planOetf = (x: number) => (x <= 0.04045 / 12.92 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055)
/** Δ̂(u, v) as plan 2.2 writes it. */
const planDelta = (u: number, v: number) => [1.5748 * v, -0.18732 * u - 0.46812 * v, 1.8556 * u].map((x) => x / 1.8556)
/** Y' + s·(y − Y'). */
const aboutLuma = (rgb: number[], s: number) => rgb.map((x) => planLuma(rgb) + s * (x - planLuma(rgb)))
const greyOf = (x: number) => [x, x, x]

/** evaluateGrade and, for a colour on the 33³ grid, the bake's node both give `want`. */
function expectGrade(label: string, state: GradeState, rgb: number[], want: number[], tolerance = 1e-9) {
  const got = evaluateGrade(state, null, rgb, [0, 0, 0])
  const off = (values: ArrayLike<number>) => Math.max(...[0, 1, 2].map((c) => Math.abs(values[c] - want[c])))
  assert.ok(off(got) <= tolerance, `${label}: evaluateGrade gives ${got}, the plan ${want}`)
  const at = rgb.map((x) => x * 32)
  if (at.every((x) => Number.isInteger(x) && x >= 0 && x <= 32)) {
    const node = nodeOf(33, at[0], at[1], at[2])
    const baked = bakeGradeFloat(state, null, 33).lattice.subarray(3 * node, 3 * node + 3)
    assert.ok(off(baked) <= Math.max(tolerance, 1e-6), `${label}: the bake gives ${baked}, the plan ${want}`)
  }
}

test('stage 1 against the plan: white balance in linear light, lift, gain, offset, gamma, contrast', () => {
  // 1b gamma: y^(2^−g), so + brightens the mids.
  expectGrade('gamma +0.5', grade({ gamma: { y: 0.5 } }), greyOf(0.5), greyOf(0.5 ** (2 ** -0.5)))
  expectGrade('gamma −0.5', grade({ gamma: { y: -0.5 } }), greyOf(0.5), greyOf(0.5 ** (2 ** 0.5)))
  assert.ok(0.5 ** (2 ** -0.5) > 0.6)
  // 1b lift, gain, offset: y·(G − L) + L + O.
  expectGrade('lift 0.1', grade({ lift: { y: 0.1 } }), greyOf(0.5), greyOf(0.5 * 0.9 + 0.1))
  expectGrade('lift 0.1 at black', grade({ lift: { y: 0.1 } }), greyOf(0), greyOf(0.1))
  expectGrade('lift 0.1 at white', grade({ lift: { y: 0.1 } }), greyOf(1), greyOf(1))
  expectGrade('gain 2', grade({ gain: { y: 2 } }), greyOf(0.25), greyOf(0.5))
  expectGrade('offset +0.1', grade({ offset: { y: 0.1 } }), greyOf(0.5), greyOf(0.6))
  expectGrade('offset −0.1', grade({ offset: { y: -0.1 } }), greyOf(0.5), greyOf(0.4))
  // 1c contrast c about pivot p: p·(y/p)^c below it, 1 − (1 − p)·((1 − y)/(1 − p))^c above, a
  // straight fade p + c·(y − p) for c < 1.
  expectGrade('contrast 2 below the pivot', grade({ contrast: 2, pivot: 0.5 }), greyOf(0.25), greyOf(0.5 * 0.5 ** 2))
  expectGrade('contrast 2 above the pivot', grade({ contrast: 2, pivot: 0.5 }), greyOf(0.75), greyOf(1 - 0.5 * 0.5 ** 2))
  expectGrade('contrast 0.5', grade({ contrast: 0.5, pivot: 0.5 }), greyOf(0.25), greyOf(0.5 + 0.5 * (0.25 - 0.5)))
  // 1a white balance: stops (kTemp·t + kTint·τ/3, −2·kTint·τ/3, −kTemp·t + kTint·τ/3), kTemp 0.5,
  // kTint 0.4, normalised to keep grey's luminance, and applied to linear light.
  for (const [temperature, tint] of [[100, 0], [-60, 0], [0, 100], [40, -50]]) {
    const t = temperature / 100
    const tau = tint / 100
    const stops = [0.5 * t + 0.4 * tau / 3, -2 * 0.4 * tau / 3, -0.5 * t + 0.4 * tau / 3]
    const norm = planLuma(stops.map((e) => 2 ** e))
    const want = stops.map((e) => planOetf(2 ** e / norm * planEotf(0.5)))
    expectGrade(`temperature ${temperature}, tint ${tint}`, grade({ temperature, tint }), greyOf(0.5), want)
  }
})

test('stage 2 against the plan: saturation and vibrance about the luma, hue curves behind the chroma gate, Tones', () => {
  // 2a saturation and vibrance: s = saturation·(1 + vibrance·w_v), w_v = 1/(1 + Cq²/kVib²),
  // kVib 0.3; y ← Y' + s·(y − Y').
  const soft = [16 / 32, 15 / 32, 13 / 32]
  expectGrade('saturation 0', grade({ saturation: 0 }), soft, aboutLuma(soft, 0))
  expectGrade('saturation 1.5', grade({ saturation: 1.5 }), soft, aboutLuma(soft, 1.5))
  const lum = planLuma(soft)
  const cq2 = ((soft[0] - soft[1]) ** 2 + (soft[1] - soft[2]) ** 2 + (soft[2] - soft[0]) ** 2) / (2 * (lum + 0.02) ** 2)
  const wv = 1 / (1 + cq2 / 0.3 ** 2)
  assert.ok(wv > 0.7 && wv < 0.8, `w_v ${wv}`)
  expectGrade('vibrance +1', grade({ vibrance: 1 }), soft, aboutLuma(soft, 1 + wv))
  expectGrade('vibrance −1', grade({ vibrance: -1 }), soft, aboutLuma(soft, 1 - wv))

  // 2a hue vs sat and 2b hue vs luma at full chroma (q = 1): s·f_s, and y + Y'·(2^f_l − 1) on
  // every channel alike. One point is a constant. This green sits at hue 100°.
  const green = [10 / 32, 14 / 32, 8 / 32]
  const lift = (rgb: number[], stops: number) => rgb.map((x) => x + planLuma(rgb) * (2 ** stops - 1))
  expectGrade('hue vs sat 1.5', grade({ hueSat: [[100, 1.5]] }), green, aboutLuma(green, 1.5))
  expectGrade('hue vs luma +0.5', grade({ hueLuma: [[100, 0.5]] }), green, lift(green, 0.5))
  expectGrade('hue vs luma −0.5', grade({ hueLuma: [[100, -0.5]] }), green, lift(green, -0.5))
  // The gate q = smoothstep(0, kHueGate 0.05, C): a grey never moves, haze of chroma 1/32 gets q.
  expectGrade('hue curves on a grey', grade({ hueSat: [[0, 2]], hueLuma: [[0, 1]] }), greyOf(0.5), greyOf(0.5), 1e-12)
  const haze = [22 / 32, 22 / 32, 23 / 32]
  const q = planSmoothstep(0, 0.05, 1 / 32)
  expectGrade('hue vs sat on haze', grade({ hueSat: [[0, 2]] }), haze, aboutLuma(haze, 1 + q * (2 - 1)))
  expectGrade('hue vs luma on haze', grade({ hueLuma: [[0, 1]] }), haze, lift(haze, q))

  // 2c Tones: mc = 0.5 + 0.25·balance, bw = 0.2 + 0.6·blending, w_h = smoothstep(mc − bw/2,
  // mc + bw/2, Y''), w_s = (1 − w_h)·smoothstep(0, 0.06, Y''); y + kTone 0.1·(w_s·Δ̂(shadows) +
  // w_h·Δ̂(highlights)). Greys well above black, where the plan's w_h and the bake's agree.
  type Puck = { u: number; v: number }
  const toned = (rgb: number[], balance: number, blending: number, shadows: Puck, highlights: Puck) => {
    const y = planLuma(rgb)
    const mc = 0.5 + 0.25 * balance
    const bw = 0.2 + 0.6 * blending
    const wh = planSmoothstep(mc - bw / 2, mc + bw / 2, y)
    const ws = (1 - wh) * planSmoothstep(0, 0.06, y)
    const ds = planDelta(shadows.u, shadows.v)
    const dh = planDelta(highlights.u, highlights.v)
    return rgb.map((x, c) => x + 0.1 * (ws * ds[c] + wh * dh[c]))
  }
  const none = { u: 0, v: 0 }
  const blue = { u: 1, v: 0 }
  const red = { u: 0, v: 1 }
  const cases: Array<[number, number, Puck, Puck, number]> = [
    [1, 0, none, blue, 19 / 32], // balance +1: the hand-over at 0.75, so 0.59 is untouched
    [1, 0, none, blue, 24 / 32], // half way
    [1, 0, none, blue, 29 / 32], // all highlights
    [1, 0, red, none, 10 / 32], // all shadows
    [0, 0.5, red, blue, 19 / 32], // the defaults: a blend of both
    [-1, 1, red, blue, 8 / 32], // the widest, lowest hand-over
  ]
  for (const [balance, blending, shadows, highlights, x] of cases) {
    const state = grade({ tones: { shadows, highlights, balance, blending } })
    expectGrade(`Tones balance ${balance}, blending ${blending} at ${x}`, state, greyOf(x),
      toned(greyOf(x), balance, blending, shadows, highlights), 1e-6)
  }
})

test('Tones: true black stays black at any balance and blending; the film\'s lifted black is tinted', () => {
  // Plan 2c's own w_h has no black ramp: wherever balance and blending put the hand-over's lower
  // edge below 0 (balance −1 with blending over 0.5), black took up to 2.4 LSB of the highlights.
  const pucks = [{ u: 1, v: 0 }, { u: 0, v: 1 }, { u: -0.6, v: -0.8 }, { u: 0.6, v: -0.8 }]
  let tinted = 0
  for (const balance of [-1, -0.6, 0, 0.6, 1]) {
    for (const blending of [0, 0.5, 0.75, 1]) {
      for (let p = 0; p < pucks.length; p++) {
        const state = grade({ tones: { shadows: pucks[(p + 1) % 4], highlights: pucks[p], balance, blending } })
        if (evaluateGrade(state, null, [0, 0, 0], [0, 0, 0]).some((x) => x !== 0)) tinted++
      }
    }
  }
  assert.equal(tinted, 0, 'black tinted at some balance and blending')
  const widest = grade({ tones: { shadows: { u: 0, v: 1 }, highlights: { u: 1, v: 0 }, balance: -1, blending: 1 } })
  const lattice = bakeGradeFloat(widest, null, 33).lattice
  assert.ok([0, 1, 2].every((c) => lattice[c] === 0), `the bake's black node: ${[...lattice.subarray(0, 3)]}`)
  const lifted = evaluateGrade(widest, null, greyOf(0.1), [0, 0, 0])
  assert.ok(Math.max(...lifted.map((x) => Math.abs(x - 0.1))) * 255 > 3, `black lifted to 0.1: ${lifted}`)
})

test('a look: reproduced exactly, refined lattices equal its own trilinear, amount 0 is identity', (t) => {
  // A 33 cube on 33 at amount 1 with neutral controls comes back as it is.
  const cube33 = syntheticCube(33, 5)
  assert.deepEqual(bakeGradeFloat(NEUTRAL_GRADE, { cube: cube33, amount: 1 }, 33).lattice, cube33.data)

  const random = seeded(17)
  const points = Array.from({ length: 10_000 }, () => [random(), random(), random()])
  const warm = grade({ temperature: 10 })
  for (const [size, lattice] of [[17, 33], [21, 41]]) {
    assert.equal(latticeSizeFor(size, 33, 65).n, lattice)
    const cube = syntheticCube(size, size)
    const got = [0, 0, 0]
    const own = [0, 0, 0]
    for (const amount of [1, 0.5]) {
      const baked = bakeGradeFloat(NEUTRAL_GRADE, { cube, amount }, lattice).lattice
      let worst = 0
      for (const p of points) {
        sampleLattice(baked, lattice, p, got)
        sampleLattice(cube.data, size, p, own)
        for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(got[c] - (p[c] + amount * (own[c] - p[c]))))
      }
      assert.ok(worst <= 1e-6, `${size}³ on ${lattice}³ at ${amount}: ${worst}`)
    }
    // A control on top, checked against the per-pixel reference. At the nodes the only error is
    // stage 1's 4096-entry table, read linearly across the sRGB curves' small slope kinks
    // (h·Δslope/4, about 1.7e-6); between them the lattice's trilinear of a curved control,
    // which is all that moving a control on a loaded look costs.
    const look: GradeLook = { cube, amount: 0.5 }
    const { lattice: baked, peak } = bakeGradeFloat(warm, look, lattice)
    const evaluate = createGradeEvaluator(warm, look, { peak })
    const atNodes = worstAtNodes(baked, lattice, evaluate)
    assert.ok(atNodes <= 4e-6, `${size}³ + temperature at the nodes: ${atNodes}`)
    let between = 0
    const want = [0, 0, 0]
    for (const p of points) {
      sampleLattice(baked, lattice, p, got)
      evaluate(p, want)
      for (let c = 0; c < 3; c++) between = Math.max(between, Math.abs(got[c] - want[c]))
    }
    t.diagnostic(`${size}³ on ${lattice}³, amount 0.5, temperature +10: nodes ${atNodes.toExponential(2)}, `
      + `between them ${(between * 255).toFixed(3)} LSB max`)
    assert.ok(between * 255 <= 0.1, `between the nodes: ${(between * 255).toFixed(3)} LSB`)
  }

  // Amount 0 is the identity.
  const zero = bakeGradeTexels(NEUTRAL_GRADE, { cube: syntheticCube(17, 9), amount: 0 }, 33)
  assert.equal(differing(zero.texels, identityTexels(33)), 0)

  // A non-unit domain is mapped the same way by the bake and by evaluateGrade.
  const wide = syntheticCube(17, 21, [-0.1, -0.05, 0], [1.2, 1.1, 1.3])
  assert.equal(isUnitDomain(wide), false)
  assert.equal(isUnitDomain(cube33), true)
  const wideLook: GradeLook = { cube: wide, amount: 1 }
  const wideBake = bakeGradeFloat(BUSY, wideLook, 33)
  const wideWorst = worstAtNodes(wideBake.lattice, 33, createGradeEvaluator(BUSY, wideLook, { peak: wideBake.peak }))
  assert.ok(wideWorst * 255 < 0.01, `non-unit domain: ${wideWorst}`)
})

test('stage 0 reads a look with sampleLattice\'s own arithmetic, bit for bit, refined or not, any domain', () => {
  const u = [0, 0, 0]
  const sample = [0, 0, 0]
  const cases: Array<[CubeLattice, number]> = [
    [syntheticCube(17, 41), 33], [syntheticCube(21, 42), 41], [syntheticCube(9, 43), 33], [syntheticCube(13, 44), 37],
    [syntheticCube(33, 45), 33], [syntheticCube(17, 46, [-0.1, -0.05, 0], [1.2, 1.1, 1.3]), 33],
  ]
  for (const [cube, n] of cases) {
    const { lattice } = bakeGradeFloat(NEUTRAL_GRADE, { cube, amount: 1 }, n)
    // The same bake into doubles (bakeLattice only indexes its scratch), where a difference in the
    // snap onto the cube's nodes is not rounded away by the float32 store.
    const doubles = new Float64Array(3 * n ** 3)
    bakeLattice(compileGrade(NEUTRAL_GRADE, undefined, { cube, amount: 1 }), n, 1, doubles as unknown as Float32Array)
    let bad = 0
    let badDoubles = 0
    eachNode(n, (i, j, k, node) => {
      const x = [i / (n - 1), j / (n - 1), k / (n - 1)]
      for (let c = 0; c < 3; c++) u[c] = (x[c] - cube.domainMin[c]) / (cube.domainMax[c] - cube.domainMin[c])
      sampleLattice(cube.data, cube.size, u, sample)
      for (let c = 0; c < 3; c++) {
        if (lattice[3 * node + c] !== Math.fround(sample[c])) bad++
        if (doubles[3 * node + c] !== sample[c]) badDoubles++
      }
    })
    const label = `${cube.size}³ on ${n}³, domain ${cube.domainMin}..${cube.domainMax}`
    assert.equal(bad, 0, label)
    assert.equal(badDoubles, 0, `${label}, in doubles`)
  }
})

test('latticeSizeFor refines a look k(N−1)+1 ≥ 33 and warns when it cannot', () => {
  for (const [size, n, refinement] of [[33, 33, 1], [17, 33, 2], [9, 33, 4], [2, 33, 32], [21, 41, 2], [16, 46, 3],
    [32, 63, 2], [64, 64, 1], [65, 65, 1], [13, 37, 3], [4, 34, 11]]) {
    assert.deepEqual(latticeSizeFor(size, 33, 65), { n, exact: true, refinement }, `${size}`)
  }
  assert.deepEqual(latticeSizeFor(null, 33, 65), { n: 33, exact: true, refinement: 1 })
  const over = latticeSizeFor(129, 33, 65)
  assert.equal(over.n, 65)
  assert.equal(over.exact, false)
  assert.equal(over.refinement, 1)
  assert.match(over.warning!, /not 1:1/)
  const domain = latticeSizeFor(21, 33, 65, false)
  assert.equal(domain.n, 33)
  assert.equal(domain.exact, false)
  assert.equal(domain.refinement, 1)
  assert.match(domain.warning!, /domain/)
  const capped = latticeSizeFor(21, 33, 33)
  assert.equal(capped.n, 33)
  assert.equal(capped.exact, false)
  assert.equal(capped.refinement, 1)
  assert.match(capped.warning!, /not 1:1/)
  assert.deepEqual(latticeSizeFor(17, 33, 33), { n: 33, exact: true, refinement: 2 })
})

test('draftStride: 17³ nodes for 33, and only the look\'s own nodes on a refined lattice', () => {
  for (const [n, stride] of [[33, 2], [17, 2], [9, 1], [2, 1], [41, 2], [46, 3], [63, 2], [64, 3], [65, 2]]) {
    assert.equal(draftStride(n), stride, `${n}`)
  }
  // Every look size: on an exact refined lattice the draft's nodes include every node of the
  // look (the stride divides the refinement), or there is no draft.
  for (let size = 2; size <= 65; size++) {
    const { n, exact, refinement } = latticeSizeFor(size, 33, 65)
    const stride = draftStride(n, refinement)
    assert.ok(stride === 1 || ((n - 1) % stride === 0 && (n - 1) / stride + 1 >= 9), `${size}³ look on ${n}³: stride ${stride}`)
    if (exact && refinement > 1) assert.equal(refinement % stride, 0, `${size}³ look on ${n}³: stride ${stride}`)
  }
  for (const [size, side] of [[16, 16], [17, 17], [21, 21], [32, 32], [13, 13], [15, 15], [9, 17]]) {
    const { n, refinement } = latticeSizeFor(size, 33, 65)
    assert.equal((n - 1) / draftStride(n, refinement) + 1, side, `${size}³ look`)
  }
  assert.equal(draftStride(34, 11), 1, 'a 4³ look on 34³: no stride both fits and lands on its nodes')

  // So a draft of an exact look at amount 1 shows the look as the final bake does.
  for (const size of [13, 15, 17]) {
    const { n, refinement } = latticeSizeFor(size, 33, 65)
    const look: GradeLook = { cube: syntheticCube(size, 60 + size), amount: 1 }
    const final = bakeGradeFloat(NEUTRAL_GRADE, look, n).lattice
    const draft = bakeGradeFloat(NEUTRAL_GRADE, look, n, draftStride(n, refinement)).lattice
    let worst = 0
    for (let p = 0; p < final.length; p++) worst = Math.max(worst, Math.abs(draft[p] - final[p]))
    assert.ok(worst <= 1e-6, `${size}³ look on ${n}³, draft against final: ${(worst * 255).toFixed(3)} LSB`)
  }
})

test('the scheduler drafts a refined look on its own nodes, and not at all where it cannot', () => {
  const posted: BakeMessage[] = []
  const scheduler = createBakeScheduler({ post: (message) => { posted.push(message) }, draftThresholdMs: 8 })
  scheduler.setLastFinalMs(20)
  const job = (n: number, refinement?: number) => ({ state: grade({ saturation: 1.2 }), look: { key: 'k', amount: 1 }, n, refinement })
  assert.equal(scheduler.request(job(37, 3)), 'posted')
  assert.equal(posted[0].stride, 3, 'a 13³ look on 37³ drafts on its 13³ nodes')
  scheduler.reset()
  assert.equal(scheduler.request(job(37)), 'posted')
  assert.equal(posted[1].stride, 2, 'without a refinement the lattice alone decides')
  scheduler.reset()
  assert.equal(scheduler.request(job(34, 11)), 'posted')
  assert.equal(posted[2].stride, 1, 'a 4³ look on 34³ bakes finals only')
})

test('a draft (stride 2 and fill) is the trilinear of a real 17³ bake; roll-off comes before the fill', () => {
  const noRoll = { ...structuredClone(BUSY), rollOff: 0 }
  const draft = bakeGradeFloat(noRoll, null, 33, 2).lattice
  const real17 = bakeGradeFloat(noRoll, null, 17).lattice
  const full = bakeGradeFloat(noRoll, null, 33).lattice
  const want = [0, 0, 0]
  let worst = 0
  let evenBad = 0
  eachNode(33, (i, j, k, node) => {
    sampleLattice(real17, 17, [i / 32, j / 32, k / 32], want)
    for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(draft[3 * node + c] - want[c]))
    if (i % 2 === 0 && j % 2 === 0 && k % 2 === 0) {
      for (let c = 0; c < 3; c++) if (draft[3 * node + c] !== full[3 * node + c]) evenBad++
    }
  })
  assert.ok(worst <= 1e-6, `fill against the 17³ trilinear: ${worst}`)
  assert.equal(evenBad, 0, 'the baked nodes are the full bake\'s')

  // With gain 2 the roll-off has work to do. Filled after it, every node stays at or under 1.
  const bright = grade({ gain: { y: 2 }, rollOff: 1 })
  const rolled = bakeGradeFloat(bright, null, 33, 2)
  const rolled17 = bakeGradeFloat(bright, null, 17)
  assert.equal(rolled.peak, rolled17.peak, 'the draft sees the 17³ bake\'s nodes')
  let rolledWorst = 0
  let over = 0
  eachNode(33, (i, j, k, node) => {
    sampleLattice(rolled17.lattice, 17, [i / 32, j / 32, k / 32], want)
    for (let c = 0; c < 3; c++) {
      rolledWorst = Math.max(rolledWorst, Math.abs(rolled.lattice[3 * node + c] - want[c]))
      if (rolled.lattice[3 * node + c] > 1 + 1e-6) over++
    }
  })
  assert.ok(rolledWorst <= 1e-6, `rolled draft: ${rolledWorst}`)
  assert.equal(over, 0)
  // Rolling off after the fill gives another answer, so the order is what the test sees.
  const compiled = compileGrade(bright)
  const late = new Float32Array(3 * 33 ** 3)
  const peak = bakeLattice(compiled, 33, 2, late)
  fillLattice(late, 33, 2)
  applyRollOff(late, 33, 1, 1, peak)
  let apart = 0
  for (let i = 0; i < late.length; i++) apart = Math.max(apart, Math.abs(late[i] - rolled.lattice[i]))
  assert.ok(apart > 1e-4, `the other order differs by ${apart}`)
})

test('gamut compression: inactive without added chroma, never negative, lift ε moves (24, 51, 3) by ε', () => {
  // Lift 0.01 adds no chroma: every node is the plain per-channel lift, saturated ones too.
  const lifted = bakeGradeFloat(grade({ lift: { y: 0.01 } }), null, 17).lattice
  const liftOnly = (x: number) => x * (1 - 0.01) + 0.01
  let worst = 0
  eachNode(17, (i, j, k, node) => {
    const x = [i / 16, j / 16, k / 16]
    for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(lifted[3 * node + c] - liftOnly(x[c])))
  })
  assert.ok(worst <= 1e-7, `lift 0.01: ${worst}`)

  // Strictly inside the gamut, with stage 1 kept non-negative (no lift, offset or contrast < 1)
  // and stage 2 anywhere in its ranges, nothing comes out negative.
  const random = seeded(23)
  const r = (lo: number, hi: number) => lo + (hi - lo) * random()
  const puck = () => {
    const angle = r(0, 2 * Math.PI)
    const radius = Math.sqrt(random())
    return { u: radius * Math.cos(angle), v: radius * Math.sin(angle) }
  }
  const hueCurve = (lo: number, hi: number) => Array.from({ length: Math.floor(r(1, 6)) }, (_, i) => [i * 60 + r(0, 40), r(lo, hi)])
  let lowest = Infinity
  const out = [0, 0, 0]
  for (let s = 0; s < 60; s++) {
    const state = grade({
      temperature: r(-100, 100), tint: r(-100, 100), gamma: { y: r(-1, 1), ...puck() }, gain: { y: r(1, 2), ...puck() },
      contrast: r(1, 2), saturation: r(0, 2), vibrance: r(-1, 1), hueSat: hueCurve(0, 2), hueLuma: hueCurve(-1, 1),
      tones: { shadows: puck(), highlights: puck(), balance: r(-1, 1), blending: r(0, 1) },
    })
    const evaluate = createGradeEvaluator(state, null)
    for (let p = 0; p < 2000; p++) {
      evaluate([r(0.01, 1), r(0.01, 1), r(0.01, 1)], out)
      lowest = Math.min(lowest, out[0], out[1], out[2])
    }
  }
  assert.ok(lowest >= -1e-9, `lowest channel ${lowest}`)

  // Lift ε on a dark canopy green: no channel moves by more than ε·255·1.01 LSB.
  const canopy = [24 / 255, 51 / 255, 3 / 255]
  const base = evaluateGrade(NEUTRAL_GRADE, null, canopy, [0, 0, 0])
  for (const epsilon of [0.001, 0.005, 0.01, 0.02, 0.05, -0.005, -0.01]) {
    const moved = evaluateGrade(grade({ lift: { y: epsilon } }), null, canopy, [0, 0, 0])
    const lsb = Math.max(...moved.map((x, c) => Math.abs(x - base[c]))) * 255
    assert.ok(lsb <= Math.abs(epsilon) * 255 * 1.01, `lift ${epsilon}: ${lsb.toFixed(3)} LSB`)
    const lattice = bakeGradeFloat(grade({ lift: { y: epsilon } }), null, 33).lattice
    const sampled = sampleLattice(lattice, 33, canopy, [0, 0, 0])
    const bakedLsb = Math.max(...sampled.map((x, c) => Math.abs(x - canopy[c]))) * 255
    assert.ok(bakedLsb <= Math.abs(epsilon) * 255 * 1.01, `baked lift ${epsilon}: ${bakedLsb.toFixed(3)} LSB`)
  }
})

test('roll-off: identity at a peak ≤ 1, everything under 1 with gain 2, below the knee untouched', () => {
  // A grade that never passes 1: the roll-off does nothing, bit for bit.
  const dim = grade({ gain: { y: 0.9 }, contrast: 1.2, saturation: 0.9 })
  const dimRolled = { ...structuredClone(dim), rollOff: 1 }
  const plain = bakeGradeTexels(dim, null, 33)
  assert.ok(plain.peak <= 1, `peak ${plain.peak}`)
  assert.equal(differing(bakeGradeTexels(dimRolled, null, 33).texels, plain.texels), 0)

  for (const rollOff of [0.3, 1]) {
    const bright = grade({ gain: { y: 2 }, rollOff })
    const unrolled = bakeGradeFloat({ ...structuredClone(bright), rollOff: 0 }, null, 33)
    const rolled = bakeGradeFloat(bright, null, 33)
    assert.ok(unrolled.peak > 1.9)
    const knee = 1 - 0.3 * rollOff
    let over = 0
    let belowChanged = 0
    let hueBad = 0
    eachNode(33, (i, j, k, node) => {
      const a = [0, 1, 2].map((c) => unrolled.lattice[3 * node + c])
      const b = [0, 1, 2].map((c) => rolled.lattice[3 * node + c])
      const m = Math.max(...a)
      if (Math.max(...b) > 1 + 1e-6) over++
      if (m <= knee && b.some((x, c) => x !== a[c])) belowChanged++
      if (m > knee) {
        const scale = Math.max(...b) / m
        if (b.some((x, c) => Math.abs(x - a[c] * scale) > 1e-6)) hueBad++
      }
    })
    assert.equal(over, 0, `rollOff ${rollOff}: nodes over 1`)
    assert.equal(belowChanged, 0, `rollOff ${rollOff}: nodes below the knee changed`)
    assert.equal(hueBad, 0, `rollOff ${rollOff}: all three channels scale together`)
  }

  // The shoulder along a grey ramp: continuous and C1 at the knee, monotone, the peak onto 1.
  const n = 2
  const grey = (m: number) => {
    const scratch = new Float32Array(3 * n ** 3).fill(0)
    scratch[0] = scratch[1] = scratch[2] = m
    applyRollOff(scratch, n, 1, 1, 2)
    return scratch[0]
  }
  const knee = 0.7
  assert.equal(grey(knee), Math.fround(knee))
  assert.ok(Math.abs(grey(2) - 1) < 1e-6)
  const h = 1e-3
  const slopeBelow = (grey(knee) - grey(knee - h)) / h
  const slopeAbove = (grey(knee + h) - grey(knee)) / h
  assert.ok(Math.abs(slopeBelow - 1) < 1e-3 && Math.abs(slopeAbove - 1) < 2e-3, `slopes ${slopeBelow}, ${slopeAbove}`)
  let previous = -Infinity
  for (let m = 0.5; m <= 2; m += 0.01) {
    const y = grey(m)
    assert.ok(y >= previous, `monotone at ${m}`)
    previous = y
  }
})

/** A random state anywhere in GRADE_RANGES, with the extremes now and then. */
function randomState(random: () => number): GradeState {
  const pick = (range: { min: number; max: number }) => {
    const roll = random()
    if (roll < 0.08) return range.min
    if (roll < 0.16) return range.max
    return range.min + (range.max - range.min) * random()
  }
  const puck = () => {
    if (random() < 0.2) return { u: 0, v: 0 }
    const angle = random() * 2 * Math.PI
    const radius = random() < 0.15 ? 1 : 0.02 + 0.98 * Math.sqrt(random())
    return { u: radius * Math.cos(angle), v: radius * Math.sin(angle) }
  }
  const toneCurve = () => {
    if (random() < 0.4) return [[0, 0], [1, 1]]
    const interior = Math.floor(random() * 7)
    const xs = new Set<number>()
    while (xs.size < interior) xs.add(Math.round((0.02 + random() * 0.96) * 50) / 50)
    return [0, ...[...xs].sort((a, b) => a - b), 1].map((x) => [x, random()])
  }
  const hueCurve = (lo: number, hi: number) => {
    if (random() < 0.3) return []
    return Array.from({ length: 1 + Math.floor(random() * 6) }, (_, i) => [i * 55 + random() * 40, lo + (hi - lo) * random()])
  }
  const R = GRADE_RANGES
  return grade({
    temperature: pick(R.temperature), tint: pick(R.tint),
    lift: { y: pick(R.lift.y), ...puck() }, gamma: { y: pick(R.gamma.y), ...puck() },
    gain: { y: pick(R.gain.y), ...puck() }, offset: { y: pick(R.offset.y), ...puck() },
    contrast: pick(R.contrast), pivot: pick(R.pivot), saturation: pick(R.saturation), vibrance: pick(R.vibrance),
    curves: { master: toneCurve(), red: toneCurve(), green: toneCurve(), blue: toneCurve() },
    hueSat: hueCurve(0, 2), hueLuma: hueCurve(-1, 1),
    tones: { shadows: puck(), highlights: puck(), balance: pick(R.tones.balance), blending: pick(R.tones.blending) },
    rollOff: pick(R.rollOff),
  })
}

test('fuzz: 200 random states, with and without a look, bake only finite texels within ±16', (t) => {
  const random = seeded(31)
  let floatsBeyond16 = 0
  for (let s = 0; s < 200; s++) {
    const state = randomState(random)
    const cube = syntheticCube(9, 100 + s)
    for (let p = 0; p < cube.data.length; p++) cube.data[p] += (random() - 0.5) * 0.3
    const look: GradeLook = { cube, amount: random() < 0.2 ? 1 : random() }
    for (const withLook of [false, true]) {
      const stride = random() < 0.3 ? 2 : 1
      const { texels, lattice } = bakeGradeTexels(state, withLook ? look : null, 17, stride)
      for (let i = 0; i < lattice.length; i++) {
        if (!Number.isFinite(lattice[i])) assert.fail(`state ${s}${withLook ? ' with a look' : ''}: ${lattice[i]} at ${i}`)
        if (Math.abs(lattice[i]) > 16) floatsBeyond16++
      }
      for (let q = 0; q < texels.length; q++) {
        const x = halfBitsToFloat(texels[q])
        if (!(Math.abs(x) <= 16) || (q % 4 === 3 && texels[q] !== 0x3c00)) assert.fail(`state ${s}: texel ${q} = ${x}`)
      }
    }
  }
  t.diagnostic(`${floatsBeyond16} float values beyond ±16 (clamped in the texels, kept for export)`)
})

// The editor compiles the grade out when isGradeIdentity says so (plan 1.6); the bake skips by its
// own flags. The two must agree: an identity verdict on a grade that bakes something would drop
// it from the screen, the other way round would compile an identity LUT in.
test('isGradeIdentity agrees with compileGrade, and a GradeLook is read as it is', (t) => {
  type Range = { min: number; max: number; step: number; default: number }
  const rangeAt = (path: string) => path.split('.')
    .reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], GRADE_RANGES) as Range
  /** `{ a: { b: value } }` for the path 'a.b'. */
  const at = (path: string, value: unknown): unknown => path.split('.')
    .reduceRight<unknown>((inner, key) => ({ [key]: inner }), value)
  let identities = 0
  let checked = 0
  const agree = (state: GradeState, label: string) => {
    const verdict = isGradeIdentity(state, null)
    assert.equal(verdict, compileGrade(state).identity, label)
    if (verdict) identities++
    checked++
  }
  const scalars = ['temperature', 'tint', 'lift.y', 'gamma.y', 'gain.y', 'offset.y', 'contrast', 'pivot', 'saturation',
    'vibrance', 'tones.balance', 'tones.blending', 'rollOff']
  for (const path of scalars) {
    const range = rangeAt(path)
    for (const value of [range.default - range.step, range.default + range.step, range.min, range.max]) {
      if (value >= range.min && value <= range.max && value !== range.default) agree(grade(at(path, value)), `${path} = ${value}`)
    }
  }
  for (const path of ['lift', 'gamma', 'gain', 'offset', 'tones.shadows', 'tones.highlights']) {
    for (const puck of [{ u: 0.021, v: 0 }, { u: 0, v: -0.021 }, { u: 0.6, v: 0.8 }]) {
      agree(grade(at(path, puck)), `${path} ${JSON.stringify(puck)}`)
    }
  }
  for (const channel of ['master', 'red', 'green', 'blue']) {
    agree(grade({ curves: { [channel]: [[0, 0], [0.5, 0.52], [1, 1]] } }), `curves.${channel} point`)
    agree(grade({ curves: { [channel]: [[0, 0], [1, 0.99]] } }), `curves.${channel} end`)
  }
  agree(grade({ hueSat: [[100, 1.01]] }), 'hueSat off neutral')
  agree(grade({ hueLuma: [[100, -0.01]] }), 'hueLuma off neutral')
  agree(grade({ hueSat: [[0, 1], [120, 1]], hueLuma: [[60, 0]] }), 'hue curves at neutral')

  // Sparse random grades: a few fields moved, the inert ones (pivot, balance, blending, rollOff,
  // hue points at neutral) as often as the rest, so both verdicts come up.
  const random = seeded(77)
  const R = GRADE_RANGES
  const moves: Array<() => unknown> = [
    () => ({ pivot: R.pivot.min + random() * (R.pivot.max - R.pivot.min) }),
    () => ({ tones: { balance: random() * 2 - 1, blending: random() } }),
    () => ({ rollOff: random() }),
    () => ({ hueSat: [[random() * 360, 1]], hueLuma: [[random() * 360, 0]] }),
    () => ({ contrast: random() < 0.5 ? 1 : 0.5 + random() * 1.5 }),
    () => ({ saturation: random() < 0.5 ? 1 : random() * 2 }),
    () => ({ gain: { y: random() < 0.5 ? 1 : 0.5 + random() * 1.5, u: random() < 0.5 ? 0 : 0.3, v: 0 } }),
    () => ({ temperature: random() < 0.5 ? 0 : Math.round(random() * 200 - 100) }),
    () => ({ tones: { shadows: random() < 0.5 ? { u: 0, v: 0 } : { u: 0.1, v: 0.2 } } }),
    () => ({ curves: { blue: random() < 0.5 ? [[0, 0], [1, 1]] : [[0, 0], [0.5, random()], [1, 1]] } }),
  ]
  for (let trial = 0; trial < 300; trial++) {
    const partial: Record<string, unknown> = {}
    for (const move of moves) {
      if (random() < 0.25) {
        const part = move() as Record<string, unknown>
        for (const [key, value] of Object.entries(part)) {
          const prior = partial[key]
          partial[key] = prior && typeof prior === 'object' && !Array.isArray(prior) ? { ...prior, ...(value as object) } : value
        }
      }
    }
    agree(grade(partial), JSON.stringify(partial))
  }
  for (let s = 0; s < 50; s++) agree(randomState(random), `random state ${s}`)
  t.diagnostic(`${checked} grades checked, ${identities} of them identity`)
  assert.ok(identities > 30 && checked - identities > 30, 'both verdicts are exercised')

  // A GradeLook is a LookIdentity as it is: an identity cube counts as no look, and the bake of
  // it is the identity anyway, so compiling it out loses nothing; a real look counts as one.
  const identityCube: CubeLattice = { data: identityLattice(17), size: 17, domainMin: [0, 0, 0], domainMax: [1, 1, 1] }
  const plainLook: GradeLook = { cube: identityCube, amount: 1 }
  assert.equal(isGradeIdentity(NEUTRAL_GRADE, plainLook), true)
  assert.equal(compileGrade(NEUTRAL_GRADE, undefined, plainLook).identity, false, 'the bake still runs the look')
  assert.equal(differing(bakeGradeTexels(NEUTRAL_GRADE, plainLook, 33).texels, identityTexels(33)), 0)
  // The identity lattice of a narrower domain clamps: a look, and the bake says so too.
  const narrowCube: CubeLattice = {
    data: identityLattice(9).map((x) => 0.1 + 0.8 * x), size: 9, domainMin: [0.1, 0.1, 0.1], domainMax: [0.9, 0.9, 0.9],
  }
  assert.equal(isGradeIdentity(NEUTRAL_GRADE, { cube: narrowCube, amount: 1 }), false)
  const narrowBake = bakeGradeFloat(NEUTRAL_GRADE, { cube: narrowCube, amount: 1 }, 33).lattice
  assert.ok(Math.abs(narrowBake[0] - 0.1) < 1e-6 && Math.abs(narrowBake[narrowBake.length - 1] - 0.9) < 1e-6)
  const realLook: GradeLook = { cube: syntheticCube(17, 4), amount: 0.25 }
  assert.equal(isGradeIdentity(NEUTRAL_GRADE, realLook), false)
  assert.equal(isGradeIdentity(NEUTRAL_GRADE, { ...realLook, amount: 0 }), true)
  assert.equal(compileGrade(NEUTRAL_GRADE, undefined, { ...realLook, amount: 0 }).identity, true)
})

/** The GPU's tap: trilinear on the half texels with 8-bit fractional weights. */
function gpuSample(decoded: Float64Array, n: number, rgb: number[], out: number[]) {
  const s = n - 1
  const at = [0, 0, 0]
  const f = [0, 0, 0]
  for (let c = 0; c < 3; c++) {
    const x = Math.min(Math.max(rgb[c], 0), 1) * s
    at[c] = Math.min(Math.floor(x), s - 1)
    f[c] = Math.round((x - at[c]) * 256) / 256
  }
  for (let c = 0; c < 3; c++) {
    let sum = 0
    for (let corner = 0; corner < 8; corner++) {
      let weight = 1
      let node = 0
      for (let axis = 0; axis < 3; axis++) {
        const bit = (corner >> axis) & 1
        weight *= bit ? f[axis] : 1 - f[axis]
        node += (at[axis] + bit) * n ** axis
      }
      sum += weight * decoded[3 * node + c]
    }
    out[c] = sum
  }
  return out
}

// The budget (plan 6.3, tightened to what the bake gives): at most 2 LSB, and at most 8 % of the
// dark-green and sky ramps over 1 LSB. Measured: dark green 1.62 LSB with 7.8 % over 1 LSB, sky
// 1.47 LSB with 1.9 %. The deep-green ramp, saturated canopy, is held to the maximum only:
// strong hue curves (BUSY's ±0.2 stops and 1.25 on greens) swing faster across a 33³ cell there
// than trilinear follows, 19 % over 1 LSB; at 65³ its maximum is 0.6 LSB.
test('error budget: a busy grade at 33³ through an 8-bit-weight tap stays within 2 LSB', (t) => {
  const n = 33
  const { texels, peak } = bakeGradeTexels(BUSY, null, n)
  const decoded = new Float64Array(3 * n ** 3)
  for (let node = 0; node < n ** 3; node++) for (let c = 0; c < 3; c++) decoded[3 * node + c] = halfBitsToFloat(texels[4 * node + c])
  const evaluate = createGradeEvaluator(BUSY, null, { peak })
  const display = (x: number) => Math.min(Math.max(x, 0), 1) * 255
  const ramps: Array<[string, (t: number) => number[], number]> = [
    // Canopy greens from code 20 to 110 on G.
    ['dark green', (u) => { const g = (20 + 90 * u) / 255; return [0.55 * g, g, 0.35 * g] }, 0.08],
    // Horizon haze to zenith blue.
    ['sky', (u) => [(205 - 145 * u) / 255, (220 - 100 * u) / 255, (235 - 30 * u) / 255], 0.08],
    ['deep green', (u) => { const g = (20 + 90 * u) / 255; return [0.3 * g, g, 0.12 * g] }, 1],
  ]
  for (const [name, ramp, shareLimit] of ramps) {
    const steps = 4000
    let worst = 0
    let overOne = 0
    const got = [0, 0, 0]
    const want = [0, 0, 0]
    for (let s = 0; s <= steps; s++) {
      const rgb = ramp(s / steps)
      gpuSample(decoded, n, rgb, got)
      evaluate(rgb, want)
      const lsb = Math.max(...[0, 1, 2].map((c) => Math.abs(display(got[c]) - display(want[c]))))
      worst = Math.max(worst, lsb)
      if (lsb > 1) overOne++
    }
    const share = overOne / (steps + 1)
    t.diagnostic(`${name}: max ${worst.toFixed(3)} LSB, ${(100 * share).toFixed(2)} % over 1 LSB`)
    assert.ok(worst <= 2, `${name}: ${worst} LSB`)
    assert.ok(share <= shareLimit, `${name}: ${(100 * share).toFixed(2)} % over 1 LSB`)
  }
})

// 2d leaves a channel alone where the input's is at or below 0 (t = 1), so the nodes on a lattice
// face (i, j or k = 0) keep the negative a saturation boost gives them, though the compressed
// grade just inside the face is about 0. Trilinear from that negative to the node inside, clamped
// by the canvas, follows the grade's steep rise off 0; with the face nodes at 0 instead, these
// greens with almost no blue render up to 1.1 LSB off, 7 % of them over 1 LSB.
test('canopy greens next to the blue = 0 face, saturation 1.1, through the tap: within 0.5 LSB', (t) => {
  const n = 33
  const state = grade({ saturation: 1.1 })
  const { texels, lattice, peak } = bakeGradeTexels(state, null, n)
  const red = 3 * nodeOf(n, 32, 0, 0)
  assert.ok(lattice[red + 1] < 0 && lattice[red + 2] < 0, `the face keeps its negative: ${[...lattice.subarray(red, red + 3)]}`)
  const decoded = new Float64Array(3 * n ** 3)
  for (let node = 0; node < n ** 3; node++) for (let c = 0; c < 3; c++) decoded[3 * node + c] = halfBitsToFloat(texels[4 * node + c])
  const evaluate = createGradeEvaluator(state, null, { peak })
  const display = (x: number) => Math.min(Math.max(x, 0), 1) * 255
  let worst = 0
  const got = [0, 0, 0]
  const want = [0, 0, 0]
  for (let s = 0; s <= 4000; s++) {
    const g = (20 + 90 * s / 4000) / 255
    for (const rgb of [[0.55 * g, g, 0.35 * g], [0.3 * g, g, 0.12 * g], [0.3 * g, g, 0.02 * g]]) {
      gpuSample(decoded, n, rgb, got)
      evaluate(rgb, want)
      worst = Math.max(worst, ...[0, 1, 2].map((c) => Math.abs(display(got[c]) - display(want[c]))))
    }
  }
  t.diagnostic(`max ${worst.toFixed(3)} LSB`)
  assert.ok(worst <= 0.5, `${worst.toFixed(3)} LSB`)
})

test('bake times (logged; fails only above 50 ms at 33³)', (t) => {
  const time = (f: () => void, runs = 7) => {
    f()
    const ms: number[] = []
    for (let r = 0; r < runs; r++) {
      const start = performance.now()
      f()
      ms.push(performance.now() - start)
    }
    return median(ms)
  }
  const texels33 = new Uint16Array(4 * 33 ** 3)
  const texels41 = new Uint16Array(4 * 41 ** 3)
  const texels65 = new Uint16Array(4 * 65 ** 3)
  const scratch33 = new Float32Array(3 * 33 ** 3)
  const scratch41 = new Float32Array(3 * 41 ** 3)
  const scratch65 = new Float32Array(3 * 65 ** 3)
  const look17: GradeLook = { cube: syntheticCube(17, 1), amount: 1 }
  const look21: GradeLook = { cube: syntheticCube(21, 1), amount: 1 }
  const look33: GradeLook = { cube: syntheticCube(33, 1), amount: 1 }
  const final33 = time(() => bakeGradeTexels(BUSY, null, 33, 1, texels33, { scratch: scratch33 }))
  const draft = time(() => bakeGradeTexels(BUSY, null, 33, 2, texels33, { scratch: scratch33 }))
  // Stage 1's dense tables are kept while only stage 2 or the look amount moves; a stage-1 drag
  // rebuilds them every bake.
  const withLook17 = time(() => bakeGradeTexels(BUSY, look17, 33, 1, texels33, { scratch: scratch33 }))
  let temperature = BUSY.temperature
  const warmer = () => ({ ...BUSY, temperature: (temperature += 0.5) })
  const withLook17Rebuilt = time(() => bakeGradeTexels(warmer(), look17, 33, 1, texels33, { scratch: scratch33 }))
  const withLook21 = time(() => bakeGradeTexels(BUSY, look21, 41, 1, texels41, { scratch: scratch41 }))
  const withLook33 = time(() => bakeGradeTexels(BUSY, look33, 65, 1, texels65, { scratch: scratch65 }), 3)
  const plain65 = time(() => bakeGradeTexels(BUSY, null, 65, 1, texels65, { scratch: scratch65 }), 3)
  const neutral = time(() => bakeGradeTexels(NEUTRAL_GRADE, null, 33, 1, texels33, { scratch: scratch33 }))
  const lattice33 = bakeGradeFloat(BUSY, null, 33).lattice
  const lattice65 = bakeGradeFloat(BUSY, null, 65).lattice
  const packBits33 = time(() => packHalfBits(lattice33, texels33), 15)
  const packBits65 = time(() => packHalfBits(lattice65, texels65))
  t.diagnostic(`33³ final, every control on: ${final33.toFixed(2)} ms (plan: 5.0-7.5)`)
  t.diagnostic(`17³ draft on 33³ (stride 2 + fill): ${draft.toFixed(2)} ms (plan: 1.3-2.4)`)
  t.diagnostic(`33³ with a 17³ look: ${withLook17.toFixed(2)} ms; ${withLook17Rebuilt.toFixed(2)} ms with stage 1 moving`)
  t.diagnostic(`41³ with a 21³ look: ${withLook21.toFixed(2)} ms (plan: about 10)`)
  t.diagnostic(`65³ with a 33³ look: ${withLook33.toFixed(2)} ms; without a look ${plain65.toFixed(2)} ms (plan: 36-56)`)
  t.diagnostic(`neutral 33³ (identity copy): ${neutral.toFixed(3)} ms`)
  if (HAS_FLOAT16_ARRAY) {
    const packF16_33 = time(() => packHalfFloat16(lattice33, texels33), 15)
    const packF16_65 = time(() => packHalfFloat16(lattice65, texels65))
    t.diagnostic(`pack 33³: Float16Array ${packF16_33.toFixed(3)} ms, integer ${packBits33.toFixed(3)} ms (plan: 0.25 / 1.1)`)
    t.diagnostic(`pack 65³: Float16Array ${packF16_65.toFixed(3)} ms, integer ${packBits65.toFixed(3)} ms`)
  } else {
    t.diagnostic(`pack 33³: integer ${packBits33.toFixed(3)} ms; 65³ ${packBits65.toFixed(3)} ms (no Float16Array)`)
  }
  assert.ok(final33 <= 50, `33³ final took ${final33.toFixed(1)} ms`)
})

test('the scheduler: one bake in flight, newest wins, commit promotes, duplicates skipped, stale dropped', () => {
  const n = 33
  const bytes = 8 * n ** 3
  const pool = createBufferPool(n)
  let current: Uint16Array = identityTexels(n).slice() // what the texture holds
  const posted: BakeMessage[] = [] // the worker's side, after the transfer
  const scheduler = createBakeScheduler({
    post: (message) => {
      posted.push(structuredClone(message, { transfer: [message.out] }))
      assert.equal(message.out.byteLength, 0, 'the buffer left with the message')
    },
    draftThresholdMs: 8,
    take: () => pool.take(),
    give: (buffer) => { pool.give(buffer) },
  })
  /** The worker answers the job it holds and transfers the buffer back. */
  const answer = (ms: number): BakedMessage => {
    const job = posted.shift()!
    const { peak } = bakeGradeTexels(job.state, null, job.n, job.stride, new Uint16Array(job.out))
    const reply: BakedMessage = { kind: 'baked', seq: job.seq, n: job.n, stride: job.stride, ms, peak, out: job.out }
    return structuredClone(reply, { transfer: [reply.out] })
  }
  /** The editor's upload: the result goes in, the array it replaces goes to the pool. */
  const apply = (result: BakeResult | null) => {
    assert.ok(result)
    const previous = current
    current = result!.texels
    pool.give(previous.buffer)
  }
  const intact = () => {
    assert.equal(identityTexels(n).buffer.byteLength, bytes, 'the identity cache is never detached')
    assert.equal(current.buffer.byteLength, bytes, 'the texture\'s array is never detached')
  }
  const job = (saturation: number, look: BakeMessage['look'] = null) => ({ state: grade({ saturation }), look, n })

  // Nothing measured yet: a drag bakes finals.
  assert.equal(scheduler.request(job(1.1)), 'posted')
  assert.equal(posted[0].stride, 1)
  assert.equal(scheduler.busy, true)
  assert.equal(scheduler.request(job(1.2)), 'queued')
  assert.equal(scheduler.request(job(1.3)), 'queued')
  assert.equal(posted.length, 1, 'one bake in flight')
  intact()
  const first = scheduler.onResult(answer(20))
  assert.equal(first?.final, true)
  assert.deepEqual(new Uint16Array(first!.texels), bakeGradeTexels(job(1.1).state, null, n).texels)
  apply(first)
  intact()
  assert.equal(scheduler.lastFinalMs, 20)
  // The newest waiting request went out, as a draft now that a final took 20 ms; 1.2 never did.
  assert.equal(posted.length, 1)
  assert.equal(posted[0].state.saturation, 1.3)
  assert.equal(posted[0].stride, 2)
  apply(scheduler.onResult(answer(3)))
  assert.equal(scheduler.lastFinalMs, 20, 'a draft does not count')
  intact()

  // A commit promotes the waiting draft of the same state to a final.
  assert.equal(scheduler.request(job(1.4)), 'posted')
  assert.equal(posted[0].stride, 2)
  assert.equal(scheduler.request(job(1.5)), 'queued')
  assert.equal(scheduler.request(job(1.5), { commit: true }), 'queued')
  apply(scheduler.onResult(answer(3)))
  assert.equal(posted[0].state.saturation, 1.5)
  assert.equal(posted[0].stride, 1, 'promoted')

  // A duplicate final is skipped, in flight and once it is shown; so is a draft of it.
  assert.equal(scheduler.request(job(1.5), { commit: true }), 'skipped')
  assert.equal(scheduler.request(job(1.5)), 'skipped')
  apply(scheduler.onResult(answer(12)))
  assert.equal(scheduler.lastFinalMs, 12)
  assert.equal(scheduler.request(job(1.5), { commit: true }), 'skipped')
  assert.equal(posted.length, 0)
  // Another look, amount or size is not a duplicate.
  assert.equal(scheduler.request(job(1.5, { key: 'a', amount: 1 }), { commit: true }), 'posted')
  apply(scheduler.onResult(answer(12)))
  assert.equal(scheduler.request(job(1.5, { key: 'a', amount: 0.5 }), { commit: true }), 'posted')
  intact()

  // A result with a stale seq is dropped and its buffer recycled.
  const reply = answer(12)
  const held = pool.count
  assert.equal(scheduler.onResult({ ...reply, seq: reply.seq - 1 }), null)
  assert.equal(pool.count, held + 1, 'the stale buffer went back to the pool')
  assert.equal(scheduler.busy, true, 'still waiting for its own result')
  // After a reset (a worker error) the real one is stale as well.
  scheduler.reset()
  assert.equal(scheduler.busy, false)
  const late = structuredClone(reply)
  assert.equal(scheduler.onResult(late), null)
  intact()

  // Drafts only above the threshold.
  scheduler.setLastFinalMs(8)
  assert.equal(scheduler.request(job(1.6)), 'posted')
  assert.equal(posted[0].stride, 1, '8 ms is not over 8')
  apply(scheduler.onResult(answer(8)))
  scheduler.setLastFinalMs(8.5)
  assert.equal(scheduler.request(job(1.7)), 'posted')
  assert.equal(posted[0].stride, 2)
  apply(scheduler.onResult(answer(2)))
  intact()
  // Every buffer that came back is the right size; the pool never grew past its limit.
  assert.ok(pool.count <= 3)
})

test('the buffer pool keeps buffers of its own size only, never the identity cache', () => {
  const n = 17
  const bytes = 8 * n ** 3
  const pool = createBufferPool(n)
  const a = pool.take()
  assert.equal(a.byteLength, bytes)
  assert.equal(pool.give(a), true)
  assert.equal(pool.count, 1)
  assert.equal(pool.give(a), false, 'already held')
  assert.equal(pool.take(), a, 'handed out again')
  assert.equal(pool.count, 0)
  assert.equal(pool.give(new ArrayBuffer(8 * 33 ** 3)), false, 'another size')
  const detached = new ArrayBuffer(bytes)
  structuredClone(detached, { transfer: [detached] })
  assert.equal(pool.give(detached), false, 'a detached buffer')
  assert.equal(pool.give(identityTexels(n).buffer), false, 'the identity cache')
  assert.equal(pool.give(null), false)
  for (let i = 0; i < 5; i++) pool.give(new ArrayBuffer(bytes))
  assert.equal(pool.count, 3, 'at most the limit')
  pool.clear()
  assert.equal(pool.count, 0)
  assert.notEqual(pool.take(), a, 'a fresh buffer once empty')
})
