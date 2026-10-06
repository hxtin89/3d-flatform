import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
  CubeParseError, cubeImportRejection, GRADE_CUBE_COMMENTS, gradeCubeFileName, identityLattice, isIdentityLattice,
  parseCube, sampleLattice, serializeCube, type CubeFile,
} from './cube-format.ts'
import { identityTexels, packHalf } from './grade-bake.ts'

/** mulberry32: the same seeded numbers on every run. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** An n³ lattice of distinct values in [0, 1.5), red fastest: its rows at 6 decimals, and the
 *  floats a parser has to read back from them. */
function latticeRows(n: number) {
  const values: number[] = []
  const lines: string[] = []
  for (let k = 0; k < n; k++) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const node = [i, j, k].map((v, c) => (v + 0.37 * c + 0.11 * (i + j + k)) / n)
        const text = node.map((v) => v.toFixed(6))
        values.push(...text.map(Number))
        lines.push(text.join(' '))
      }
    }
  }
  return { values: Float32Array.from(values), lines }
}

const SMALL = latticeRows(2)

/** parseCube must throw a CubeParseError on `line` whose message matches `pattern`. */
function throwsAt(lines: string[], line: number, pattern: RegExp) {
  assert.throws(() => parseCube(lines.join('\n')), (error: unknown) => {
    assert.ok(error instanceof CubeParseError, `expected a CubeParseError, got ${error}`)
    assert.equal(error.line, line, error.message)
    assert.ok(error.message.startsWith(`line ${line}: `), error.message)
    assert.match(error.reason, pattern)
    return true
  })
}

test('a Photoshop CS6-style file: CRLF, comments between keywords, 6 decimals', () => {
  const text = [
    '#Created by: Adobe Photoshop CS6',
    '#Copyright: Copyright 2012 Adobe Systems Inc.',
    'TITLE "CandleLight from Tungsten"',
    '',
    '#LUT size',
    'LUT_3D_SIZE 2',
    '',
    '#data domain',
    'DOMAIN_MIN 0.0 0.0 0.0',
    'DOMAIN_MAX 1.0 1.0 1.0',
    '',
    '#LUT data points',
    ...SMALL.lines,
    '',
  ].join('\r\n')
  const cube = parseCube(text)
  assert.equal(cube.title, 'CandleLight from Tungsten')
  assert.equal(cube.kind, '3d')
  assert.equal(cube.size, 2)
  assert.deepEqual(cube.domainMin, [0, 0, 0])
  assert.deepEqual(cube.domainMax, [1, 1, 1])
  assert.deepEqual(cube.data, SMALL.values)
  assert.equal(cube.lut1d, null)
  assert.deepEqual(cube.warnings, [])
  assert.equal(cubeImportRejection(cube), null)
})

test('tabs, runs of spaces, trailing whitespace and blank lines anywhere', () => {
  const rows = SMALL.lines.map((line, i) => line.replace(/ /g, i % 2 ? '\t\t' : ' \t  ') + (i % 3 ? '  \t' : ''))
  const text = [
    '  # indented comment',
    'LUT_3D_SIZE\t \t2   ',
    '\t',
    ...rows.slice(0, 4),
    '',
    '   ',
    ...rows.slice(4),
    '',
    '\t',
    '# a comment after the data',
    '',
  ].join('\n')
  const cube = parseCube(text)
  assert.equal(cube.size, 2)
  assert.equal(cube.title, null)
  assert.deepEqual(cube.data, SMALL.values)
  assert.deepEqual(cube.warnings, [])
  // CR-only line ends too.
  assert.deepEqual(parseCube(['LUT_3D_SIZE 2', ...SMALL.lines].join('\r')).data, SMALL.values)
})

test('TITLE: quoted with a #, unquoted with spaces, unquoted with a comment', () => {
  const titled = (line: string) => parseCube([line, 'LUT_3D_SIZE 2', ...SMALL.lines].join('\n'))
  assert.equal(titled('TITLE "Look #2 # final" # the comment').title, 'Look #2 # final')
  assert.equal(titled('TITLE Full Range To SMPTE Range 10 bits Extended Domain').title,
    'Full Range To SMPTE Range 10 bits Extended Domain')
  assert.equal(titled('TITLE Unquoted # with a comment').title, 'Unquoted')
  assert.equal(titled('TITLE ""').title, '')
  const open = titled('TITLE "no closing quote')
  assert.equal(open.title, 'no closing quote')
  assert.equal(open.warnings.length, 1)
  assert.equal(parseCube(['LUT_3D_SIZE 2', ...SMALL.lines].join('\n')).title, null)
})

test('DOMAIN_MIN −0.07306 and 1e-1, LUT_3D_INPUT_RANGE, and DOMAIN winning over INPUT_RANGE', () => {
  const domain = parseCube([
    'LUT_3D_SIZE 2', 'DOMAIN_MIN -0.07306 -0.07306 1e-1', 'DOMAIN_MAX 1.09475 1.09475 1E+0', ...SMALL.lines,
  ].join('\n'))
  assert.deepEqual(domain.domainMin, [-0.07306, -0.07306, 0.1])
  assert.deepEqual(domain.domainMax, [1.09475, 1.09475, 1])
  assert.deepEqual(domain.warnings, [])

  const range = parseCube(['LUT_3D_SIZE 2', 'LUT_3D_INPUT_RANGE 0.0 1.5', ...SMALL.lines].join('\n'))
  assert.deepEqual(range.domainMin, [0, 0, 0])
  assert.deepEqual(range.domainMax, [1.5, 1.5, 1.5])
  assert.deepEqual(range.warnings, [])

  const both = parseCube(['LUT_3D_SIZE 2', 'LUT_3D_INPUT_RANGE -0.5 1.5', 'DOMAIN_MAX 2 2 2', ...SMALL.lines].join('\n'))
  assert.deepEqual(both.domainMin, [-0.5, -0.5, -0.5], 'the range fills the min DOMAIN does not give')
  assert.deepEqual(both.domainMax, [2, 2, 2])
  assert.equal(both.warnings.length, 1)
  assert.match(both.warnings[0], /override LUT_3D_INPUT_RANGE/)
})

test('lowercase keywords, an unknown keyword before the data, and a repeated keyword', () => {
  const lower = parseCube([
    'title "low"', 'lut_3d_size 2', 'domain_min 0 0 0', 'Domain_Max 1 1 1', ...SMALL.lines,
  ].join('\n'))
  assert.equal(lower.title, 'low')
  assert.equal(lower.size, 2)
  assert.deepEqual(lower.warnings, [])

  const unknown = parseCube(['LUT_3D_SIZE 2', 'GAMMA 2.2', ...SMALL.lines].join('\n'))
  assert.deepEqual(unknown.data, SMALL.values)
  assert.equal(unknown.warnings.length, 1)
  assert.match(unknown.warnings[0], /^line 2: unknown keyword GAMMA/)

  const twice = parseCube(['LUT_3D_SIZE 3', 'LUT_3D_SIZE 2', ...SMALL.lines].join('\n'))
  assert.equal(twice.size, 2)
  assert.match(twice.warnings[0], /^line 2: LUT_3D_SIZE given again/)
})

test('number forms: signs, exponents, a bare point; 1.127 and −0.01 are kept, nothing wraps', () => {
  const rows = ['1.127 -0.01 0.5', '+.5 5. 1E-1', '-0 2.5e+0 -1.25', ...SMALL.lines.slice(3)]
  const cube = parseCube(['LUT_3D_SIZE 2', ...rows].join('\n'))
  assert.deepEqual([...cube.data.subarray(0, 9)], [1.127, -0.01, 0.5, 0.5, 5, 0.1, -0, 2.5, -1.25].map(Math.fround))
})

/** Plan 3's number grammar as the plan writes it, the reference for parseCube's own. */
const PLAN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

test('numbers: the plan\'s grammar, every string of up to 5 characters from 0 9 . + - e x', () => {
  const alphabet = ['0', '9', '.', '+', '-', 'e', 'x']
  let strings = ['']
  let checked = 0
  let numbers = 0
  for (let length = 1; length <= 5; length++) {
    strings = strings.flatMap((s) => alphabet.map((c) => s + c))
    for (const token of strings) {
      let refused = false
      try {
        parseCube(['LUT_3D_SIZE 2', `0 ${token} 0`, ...SMALL.lines.slice(1)].join('\n'))
      } catch (error) {
        refused = error instanceof CubeParseError && /is not a number$/.test(error.reason)
      }
      assert.equal(!refused, PLAN_NUMBER.test(token), `'${token}'`)
      checked++
      if (!refused) numbers++
    }
  }
  assert.equal(checked, 19607)
  assert.ok(numbers > 500, `${numbers} of them are numbers`)
})

test('numbers: a long run of digits is read or refused at once, never backtracked through', () => {
  // The plan's own regex splits a run of n digits between \d+ and \d* in n ways and tries every
  // split before it refuses a bad last character: seconds for 20 000 digits.
  for (const [token, pattern] of [
    ['1'.repeat(20_000) + 'x', /is not a number$/],
    ['1.' + '1'.repeat(20_000) + 'x', /is not a number$/],
    ['-' + '9'.repeat(20_000) + 'e+5e', /is not a number$/],
  ] as const) {
    const start = performance.now()
    throwsAt(['LUT_3D_SIZE 2', `${token} 0 0`, ...SMALL.lines.slice(1)], 2, pattern)
    const ms = performance.now() - start
    assert.ok(ms < 200, `${token.length} characters took ${ms.toFixed(0)} ms`)
  }
  const long = parseCube(['LUT_3D_SIZE 2', `0.${'1'.repeat(20_000)} 0 0`, ...SMALL.lines.slice(1)].join('\n'))
  assert.equal(long.data[0], Math.fround(0.1111111111111111))
})

const PLAN_1D_MESSAGE = (n: number) => `This .cube has a 1D table (LUT_1D_SIZE ${n}). 1D and shaper LUTs are not supported `
  + 'yet; export a 3D LUT (for example 33 point) instead.'

test('1D only (Adobe FullToSMPTE-style): kind 1d, parsed, refused as a look', () => {
  const cube = parseCube([
    'TITLE Full Range To SMPTE Range 10 bits Extended Domain',
    '# Min = -64 / 876',
    '',
    'LUT_1D_SIZE 2',
    'DOMAIN_MIN -0.07306 -0.07306 -0.07306',
    'DOMAIN_MAX 1.09475 1.09475 1.09475',
    '',
    '0.0 0.0 0.0',
    '1.0 1.0 1.0',
  ].join('\n'))
  assert.equal(cube.kind, '1d')
  assert.equal(cube.size, 0)
  assert.equal(cube.data.length, 0)
  assert.deepEqual(cube.domainMin, [0, 0, 0], 'the top-level domain is the 3D table\'s')
  assert.ok(cube.lut1d)
  assert.equal(cube.lut1d.size, 2)
  assert.deepEqual(cube.lut1d.domainMin, [-0.07306, -0.07306, -0.07306])
  assert.deepEqual(cube.lut1d.domainMax, [1.09475, 1.09475, 1.09475])
  assert.deepEqual([...cube.lut1d.data], [0, 0, 0, 1, 1, 1])
  assert.equal(cubeImportRejection(cube), PLAN_1D_MESSAGE(2))
  assert.equal(isIdentityLattice(cube), false)
})

test('1D + 3D (Resolve shaper): the 1D rows come first, each table has its own range', () => {
  const shaper = ['0 0 0', '0.5 0.5 0.5', '0.75 0.75 0.75', '1 1 1']
  const cube = parseCube([
    'LUT_1D_SIZE 4', 'LUT_1D_INPUT_RANGE 0 2', 'LUT_3D_SIZE 2', 'LUT_3D_INPUT_RANGE 0.0 1.0', ...shaper, ...SMALL.lines,
  ].join('\n'))
  assert.equal(cube.kind, '1d+3d')
  assert.equal(cube.size, 2)
  assert.deepEqual(cube.data, SMALL.values)
  assert.ok(cube.lut1d)
  assert.equal(cube.lut1d.size, 4)
  assert.deepEqual([...cube.lut1d.data], [0, 0, 0, 0.5, 0.5, 0.5, 0.75, 0.75, 0.75, 1, 1, 1])
  assert.deepEqual(cube.lut1d.domainMax, [2, 2, 2])
  assert.deepEqual(cube.domainMax, [1, 1, 1])
  assert.equal(cubeImportRejection(cube), PLAN_1D_MESSAGE(4))
})

// Lines 1-3 are the header, the 8 data rows are lines 4-11.
const HEAD = ['# test', 'LUT_3D_SIZE 2', '']
const withRow = (index: number, row: string) => [...HEAD, ...SMALL.lines.slice(0, index), row, ...SMALL.lines.slice(index + 1)]

test('errors: a row count other than N³ (+N1), with expected and found counts', () => {
  throwsAt([...HEAD, ...SMALL.lines, '0 0 0'], 12, /^expected 2³ = 8 data rows, found 9$/)
  throwsAt([...HEAD, ...SMALL.lines.slice(0, 7)], 10, /^expected 2³ = 8 data rows, found 7$/)
  throwsAt([...HEAD, ...SMALL.lines, '0 0 0', '1 1 1', ''], 12, /found 10$/)
  throwsAt(['LUT_1D_SIZE 3', 'LUT_3D_SIZE 2', '0 0 0', '1 1 1', ...SMALL.lines], 12, /^expected 3 \+ 2³ = 11 data rows, found 10$/)
  throwsAt(['LUT_1D_SIZE 3', '0 0 0', '1 1 1'], 3, /^expected 3 data rows, found 2$/)
  throwsAt(['# nothing but a size', 'LUT_3D_SIZE 2', ''], 2, /found 0$/)
})

test('errors: a keyword after the data', () => {
  throwsAt([...HEAD, ...SMALL.lines, 'LUT_3D_SIZE 2'], 12, /^LUT_3D_SIZE after the data/)
  throwsAt([...HEAD, ...SMALL.lines.slice(0, 4), 'TITLE "late"', ...SMALL.lines.slice(4)], 8, /^TITLE after the data/)
  throwsAt([...HEAD, ...SMALL.lines.slice(0, 1), 'domain_max 1 1 1', ...SMALL.lines.slice(1)], 5, /^DOMAIN_MAX after the data/)
})

test('errors: rows of 2 or 4 values, non-numbers, NaN and Infinity', () => {
  throwsAt(withRow(2, '0.5 0.5'), 6, /exactly 3 numbers, found 2/)
  throwsAt(withRow(2, '0.5 0.5 0.5 0.5'), 6, /exactly 3 numbers, found 4/)
  throwsAt(withRow(1, 'abc 0 0'), 5, /^'abc' is not a number$/)
  throwsAt(withRow(1, '0 0.5x 0'), 5, /^'0.5x' is not a number$/)
  throwsAt(withRow(3, '0 NaN 0'), 7, /^'NaN' is not a number$/)
  throwsAt(withRow(3, '0 0 Infinity'), 7, /^'Infinity' is not a number$/)
  throwsAt(withRow(0, 'NaN 0 0'), 4, /^'NaN' is not a number$/)
  throwsAt(withRow(0, '-inf 0 0'), 4, /^'-inf' is not a number$/)
  throwsAt(withRow(7, '1e999 0 0'), 11, /^'1e999' is too large$/)
  throwsAt(withRow(7, 'END'), 11, /exactly 3 numbers, found 1/)
  // Finite as doubles, but not as the float32s the tables hold, where they would be ±Infinity.
  throwsAt(withRow(7, '3.5e38 0 0'), 11, /^'3\.5e38' is too large for a 32-bit float$/)
  throwsAt(withRow(2, '0 -1e39 0'), 6, /^'-1e39' is too large for a 32-bit float$/)
  throwsAt(withRow(5, '0 0 3.4028236e38'), 9, /^'3\.4028236e38' is too large for a 32-bit float$/)
  throwsAt(['LUT_1D_SIZE 2', '0 0 0', '1e39 1 1'], 3, /too large for a 32-bit float/)
  const largest = parseCube(withRow(7, '3.4028234e38 -3.4028234e38 0').join('\n'))
  assert.ok(largest.data.every(Number.isFinite), 'the largest float32 is kept')
  assert.equal(largest.data[21], Math.fround(3.4028234e38))
})

test('errors: sizes outside 2..256 (3D) and 2..65536 (1D), malformed keywords, no size keyword', () => {
  throwsAt(['# x', 'LUT_3D_SIZE 1', ...SMALL.lines], 2, /^LUT_3D_SIZE 1 is outside 2\.\.256$/)
  throwsAt(['# x', 'LUT_3D_SIZE 300', ...SMALL.lines], 2, /^LUT_3D_SIZE 300 is outside 2\.\.256$/)
  throwsAt(['LUT_1D_SIZE 1'], 1, /outside 2\.\.65536/)
  throwsAt(['LUT_1D_SIZE 65537'], 1, /outside 2\.\.65536/)
  throwsAt(['LUT_3D_SIZE 2.5'], 1, /not a whole number/)
  throwsAt(['LUT_3D_SIZE'], 1, /needs one number, found 0/)
  throwsAt(['LUT_3D_SIZE 2 2'], 1, /needs one number, found 2/)
  throwsAt(['LUT_3D_SIZE two'], 1, /'two' is not a number/)
  throwsAt(['LUT_3D_SIZE 2', 'DOMAIN_MIN 0 0', ...SMALL.lines], 2, /DOMAIN_MIN needs 3 numbers, found 2/)
  throwsAt(['LUT_3D_SIZE 2', 'LUT_3D_INPUT_RANGE 1', ...SMALL.lines], 2, /needs 2 numbers \(min max\), found 1/)
  throwsAt(['LUT_3D_SIZE 2', 'DOMAIN_MIN 0.5 0 0', 'DOMAIN_MAX 0.5 1 1', ...SMALL.lines], 3, /3D domain is empty on R/)
  // An empty domain is reported where its min and max were read, not at the last domain keyword.
  throwsAt(['LUT_1D_SIZE 2', 'LUT_1D_INPUT_RANGE 1 0', 'LUT_3D_SIZE 2', 'LUT_3D_INPUT_RANGE 0 1', '0 0 0', '1 1 1',
    ...SMALL.lines], 2, /^the 1D domain is empty on R: min 1, max 0$/)
  throwsAt(['LUT_3D_SIZE 2', 'DOMAIN_MIN 2 0 0', 'DOMAIN_MAX 1 1 1', 'LUT_3D_INPUT_RANGE 0 1', ...SMALL.lines], 3,
    /^the 3D domain is empty on R: min 2, max 1$/)
  throwsAt(['LUT_3D_SIZE 2', 'LUT_3D_INPUT_RANGE 1 0', 'LUT_1D_INPUT_RANGE 0 1', ...SMALL.lines], 2, /3D domain is empty on R/)
  throwsAt(['# only comments', 'TITLE "x"', ''], 2, /^no LUT_3D_SIZE or LUT_1D_SIZE/)
  throwsAt([''], 1, /^no LUT_3D_SIZE or LUT_1D_SIZE/)
  throwsAt(['TITLE "x"', '0 0 0'], 2, /^data before any LUT_3D_SIZE or LUT_1D_SIZE$/)
})

test('serializeCube: LF only, header comments, no DOMAIN, 6 decimals, red fastest, values unclamped', () => {
  const n = 33
  const lattice = identityLattice(n)
  lattice[3 * 5] = 1.25
  lattice[3 * 6 + 1] = -0.01
  const text = serializeCube(lattice, n, { title: 'Evening "warm" #2' })
  assert.ok(!text.includes('\r'), 'LF only')
  assert.ok(text.endsWith('\n'))
  const lines = text.split('\n')
  assert.deepEqual(lines.slice(0, 3), [
    '# SCHNELLE BUNTE BILDER · Canopy colour grade',
    '# Input: the displayed frame, sRGB-encoded, after the film look. Take the screenshot with the grade off.',
    '# Interpolation: trilinear',
  ])
  assert.deepEqual(lines.slice(0, 3), GRADE_CUBE_COMMENTS.map((comment) => `# ${comment}`))
  assert.equal(lines[3], `TITLE "Evening 'warm' 2"`)
  assert.equal(lines[4], 'LUT_3D_SIZE 33')
  assert.ok(!/DOMAIN/i.test(text), 'no DOMAIN lines')
  assert.ok(lines.slice(3).every((line) => !line.startsWith('#')), 'comments only at the top')
  const rows = lines.filter((line) => /^[-\d]/.test(line))
  assert.equal(rows.length, n ** 3)
  for (const row of rows) assert.match(row, /^-?\d+\.\d{6} -?\d+\.\d{6} -?\d+\.\d{6}$/)
  assert.equal(rows[0], '0.000000 0.000000 0.000000')
  assert.equal(rows[1], '0.031250 0.000000 0.000000', 'the second row is (1/(n−1), 0, 0)')
  assert.equal(rows[5], '1.250000 0.000000 0.000000')
  assert.equal(rows[6], '0.187500 -0.010000 0.000000')
  assert.equal(rows[n * n * n - 1], '1.000000 1.000000 1.000000')
  const parsed = parseCube(text)
  assert.equal(parsed.title, "Evening 'warm' 2")
  assert.equal(parsed.data[15], 1.25)
  assert.deepEqual(parsed.warnings, [])
})

test('serializeCube: RGBA input, own comments, -0, and refusing what it cannot write', () => {
  const rgb = identityLattice(3)
  const rgba = new Float32Array(4 * 27)
  for (let i = 0; i < 27; i++) rgba.set([rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2], 1], 4 * i)
  assert.equal(serializeCube(rgba, 3), serializeCube(rgb, 3), 'alpha is skipped')

  const own = serializeCube(rgb, 3, { title: 'x', comments: ['first', 'second\nthird', ''] })
  assert.deepEqual(own.split('\n').slice(0, 5), ['# first', '# second', '# third', '#', 'TITLE "x"'])

  const signed = Float32Array.from(rgb)
  signed[0] = -0
  signed[1] = -1e-9
  assert.equal(serializeCube(signed, 3).split('\n')[6], '0.000000 0.000000 0.000000')

  const bad = Float32Array.from(rgb)
  bad[10] = NaN
  assert.throws(() => serializeCube(bad, 3), RangeError)
  bad[10] = Infinity
  assert.throws(() => serializeCube(bad, 3), RangeError)
  assert.throws(() => serializeCube(rgb, 4), RangeError, 'wrong length')
  assert.throws(() => serializeCube(new Float32Array(3), 1), RangeError, 'size 1')
  assert.equal(gradeCubeFileName(33), 'canopy-grade-33.cube')
})

test('parse(serialize(x)) round trips within 5e-7 (plus the float32 store)', () => {
  const next = random(7)
  for (const n of [2, 9, 17]) {
    const lattice = new Float32Array(3 * n ** 3)
    for (let i = 0; i < lattice.length; i++) lattice[i] = next() * 2 - 0.5
    lattice[0] = 0
    lattice[1] = 1
    lattice[2] = -0.5
    const back = parseCube(serializeCube(lattice, n)).data
    assert.equal(back.length, lattice.length)
    let worst = 0
    for (let i = 0; i < lattice.length; i++) {
      const error = Math.abs(back[i] - lattice[i])
      // 6 decimals round by at most 5e-7; reading the decimal back into a float32 adds half an ulp.
      assert.ok(error <= 5e-7 + Math.abs(lattice[i]) * 2 ** -24, `n ${n} value ${i}: ${lattice[i]} → ${back[i]}`)
      worst = Math.max(worst, error)
    }
    assert.ok(worst > 0, 'the values did need rounding')
  }
  const identity = identityLattice(33)
  const back = parseCube(serializeCube(identity, 33))
  assert.deepEqual(back.data, identity, 'the 33 identity comes back bit for bit')
  assert.ok(isIdentityLattice(back.data, 33, 0))
})

test('a 33 identity → serialize → parse → pack gives identityTexels bitwise', () => {
  const parsed = parseCube(serializeCube(identityLattice(33), 33))
  const identity = identityTexels(33)
  const texels = new Uint16Array(identity.length)
  packHalf(parsed.data, texels)
  let differing = 0
  for (let i = 0; i < texels.length; i++) if (texels[i] !== identity[i]) differing++
  assert.equal(differing, 0)
})

/** Trilinear as an 8-corner weighted sum: a different formulation from sampleLattice's lerps. */
function referenceTrilinear(data: Float32Array, n: number, rgb: number[]): number[] {
  const p = rgb.map((v) => Math.min(Math.max(Number.isNaN(v) ? 0 : v, 0), 1) * (n - 1))
  const lo = p.map((v) => Math.min(Math.floor(v), n - 2))
  const out = [0, 0, 0]
  for (let corner = 0; corner < 8; corner++) {
    let weight = 1
    const at = [0, 0, 0]
    for (let axis = 0; axis < 3; axis++) {
      const bit = (corner >> axis) & 1
      const f = p[axis] - lo[axis]
      weight *= bit ? f : 1 - f
      at[axis] = lo[axis] + bit
    }
    const q = 3 * (at[0] + n * at[1] + n * n * at[2])
    for (let c = 0; c < 3; c++) out[c] += weight * data[q + c]
  }
  return out
}

test('sampleLattice equals an independent trilinear, clamps outside, and hits nodes exactly', () => {
  const next = random(11)
  for (const n of [2, 5, 7]) {
    const data = new Float32Array(3 * n ** 3)
    for (let i = 0; i < data.length; i++) data[i] = next() * 1.5 - 0.2
    const out = [0, 0, 0]
    for (let s = 0; s < 10_000; s++) {
      const rgb = [next() * 1.4 - 0.2, next() * 1.4 - 0.2, next() * 1.4 - 0.2]
      const want = referenceTrilinear(data, n, rgb)
      sampleLattice(data, n, rgb, out)
      for (let c = 0; c < 3; c++) assert.ok(Math.abs(out[c] - want[c]) < 1e-12, `n ${n} ${rgb} channel ${c}`)
    }
    for (let k = 0; k < n; k++) {
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const p = 3 * (i + n * j + n * n * k)
          assert.deepEqual(sampleLattice(data, n, [i / (n - 1), j / (n - 1), k / (n - 1)], [0, 0, 0]), [...data.subarray(p, p + 3)])
        }
      }
    }
    assert.deepEqual(sampleLattice(data, n, [NaN, -1, 2], new Float64Array(3)),
      Float64Array.from(referenceTrilinear(data, n, [0, 0, 1])), 'NaN and below 0 clamp to 0, above 1 to 1')
  }
  // Nodes come back exactly for doubles too, on the top face as well, where the last cell is read
  // at f = 1: a + 1·(b − a) is not always b (0.03 + (0.01 − 0.03) is 0.010000000000000002).
  for (const [a, b] of [[0.03, 0.01], [0.03, 0.29], [0.03, 0.3], [0.03, 0.31]]) {
    const values = new Array<number>(24).fill(0)
    values[0] = a
    values[3] = b
    for (const data of [values, Float64Array.from(values)]) {
      const kind = Array.isArray(data) ? 'number[]' : 'Float64Array'
      assert.equal(sampleLattice(data, 2, [1, 0, 0], [0, 0, 0])[0], b, `${a} → ${b} at the top node, ${kind}`)
      assert.equal(sampleLattice(data, 2, [0, 0, 0], [0, 0, 0])[0], a, `${kind} at node 0`)
    }
  }
  for (const n of [2, 3, 6]) {
    const data = Float64Array.from({ length: 3 * n ** 3 }, () => next() * 2 - 0.5)
    let off = 0
    for (let k = 0; k < n; k++) {
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const p = 3 * (i + n * j + n * n * k)
          const got = sampleLattice(data, n, [i / (n - 1), j / (n - 1), k / (n - 1)], [0, 0, 0])
          for (let c = 0; c < 3; c++) if (got[c] !== data[p + c]) off++
        }
      }
    }
    assert.equal(off, 0, `${n}³ doubles: every node exactly`)
  }
  // A 41 lattice over a 21 cube: every even node of the lattice is a cube node, exactly, even
  // where i/40·20 is not a whole number in floats.
  const cube21 = new Float32Array(3 * 21 ** 3)
  for (let i = 0; i < cube21.length; i++) cube21[i] = next()
  for (let i = 0; i <= 40; i += 2) {
    const u = i / 40
    const p = 3 * (i / 2 + 21 * (i / 2) + 441 * (20 - i / 2))
    assert.deepEqual(sampleLattice(cube21, 21, [u, u, 1 - u], [0, 0, 0]), [...cube21.subarray(p, p + 3)], `node ${i}`)
  }
  const identity = identityLattice(5)
  const out = new Float64Array(3)
  sampleLattice(identity, 5, [0.3, 0.71, 0.999], out)
  assert.ok(Math.abs(out[0] - 0.3) < 1e-15 && Math.abs(out[1] - 0.71) < 1e-15 && Math.abs(out[2] - 0.999) < 1e-15)
})

test('isIdentityLattice: true for the identity, false at a 1e-4 perturbation, domain-aware for cubes', () => {
  for (const n of [2, 17, 33]) assert.ok(isIdentityLattice(identityLattice(n), n, 0), `n ${n}`)
  const near = identityLattice(17)
  near[3 * 100 + 1] += 5e-6
  assert.ok(isIdentityLattice(near, 17), 'within the default 1e-5')
  near[3 * 100 + 1] += 1e-4
  assert.equal(isIdentityLattice(near, 17), false)
  const nan = identityLattice(9)
  nan[40] = NaN
  assert.equal(isIdentityLattice(nan, 9), false, 'NaN is never identity')
  assert.equal(isIdentityLattice(identityLattice(9), 8), false, 'length that does not fit n')
  assert.equal(isIdentityLattice(new Float32Array(3), 1), false)

  const cube = parseCube(serializeCube(identityLattice(17), 17))
  assert.ok(isIdentityLattice(cube))
  assert.ok(isIdentityLattice(cube, 0))

  // An identity over the domain [−0.5, 1.5]: its rows are the domain's own lattice points.
  const n = 5
  const rows: string[] = []
  for (let k = 0; k < n; k++) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) rows.push([i, j, k].map((v) => (-0.5 + 2 * v / (n - 1)).toFixed(6)).join(' '))
    }
  }
  const wide: CubeFile = parseCube(['LUT_3D_SIZE 5', 'DOMAIN_MIN -0.5 -0.5 -0.5', 'DOMAIN_MAX 1.5 1.5 1.5', ...rows].join('\n'))
  assert.ok(isIdentityLattice(wide), 'the cube form reads the domain')
  assert.equal(isIdentityLattice(wide.data, wide.size), false, 'plain data is checked against the unit domain')
  assert.ok(isIdentityLattice(wide.data, wide.size, 1e-5, wide.domainMin, wide.domainMax))

  // The identity lattice of a narrower domain is no identity: the look clamps what lies outside
  // it, so black comes out at the domain's min and white at its max.
  const narrowRows = [0, 1, 2, 3, 4, 5, 6, 7]
    .map((p) => [p & 1, (p >> 1) & 1, (p >> 2) & 1].map((v) => (0.1 + 0.8 * v).toFixed(6)).join(' '))
  const narrow = parseCube(['LUT_3D_SIZE 2', 'DOMAIN_MIN 0.1 0.1 0.1', 'DOMAIN_MAX 0.9 0.9 0.9', ...narrowRows].join('\n'))
  assert.deepEqual(narrow.warnings, [])
  assert.equal(isIdentityLattice(narrow), false, 'a domain inside [0, 1]')
  assert.equal(isIdentityLattice(narrow.data, 2, 1e-5, narrow.domainMin, narrow.domainMax), false)
  // Short of 1 on one channel is enough.
  const short = Float32Array.from(identityLattice(5), (v, p) => (p % 3 === 2 ? 0.9 * v : v))
  assert.equal(isIdentityLattice(short, 5, 1e-5, [0, 0, 0], [1, 1, 0.9]), false, 'blue up to 0.9 only')
})

const ADOBE = 'C:/Program Files/Adobe'

/** Every *.cube under `root`, without following links; folders that cannot be read are counted.
 *  The folders are read in parallel: Adobe's tree has some 14 000 of them, and one at a time
 *  takes twice as long. */
async function findCubes(root: string) {
  const files: string[] = []
  let unreadable = 0
  const visit = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      unreadable++
      return
    }
    const folders: Promise<void>[] = []
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) folders.push(visit(path))
      else if (entry.isFile() && /\.cube$/i.test(entry.name)) files.push(path)
    }
    await Promise.all(folders)
  }
  await visit(root)
  return { files: files.sort(), unreadable }
}

test('every .cube Adobe ships parses', { skip: existsSync(ADOBE) ? false : `no ${ADOBE} on this machine` }, async (t) => {
  const { files, unreadable } = await findCubes(ADOBE)
  const counts = new Map<string, number>()
  const failures: string[] = []
  let warned = 0
  let nonUnit = 0
  for (const file of files) {
    let cube: CubeFile
    try {
      cube = parseCube(readFileSync(file, 'utf8'))
    } catch (error) {
      failures.push(`${file}: ${(error as Error).message}`)
      continue
    }
    const key = cube.kind === '3d' ? `3D ${cube.size}` : cube.kind === '1d' ? `1D ${cube.lut1d!.size}`
      : `1D ${cube.lut1d!.size} + 3D ${cube.size}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
    if (cube.warnings.length) warned++
    if (cube.size) {
      assert.ok(cube.size >= 2 && cube.size <= 256, `${file}: size ${cube.size}`)
      assert.equal(cube.data.length, 3 * cube.size ** 3, file)
      assert.ok(cube.data.every(Number.isFinite), `${file}: finite`)
      if (cube.domainMin.some((v) => v !== 0) || cube.domainMax.some((v) => v !== 1)) nonUnit++
    }
    assert.equal(cubeImportRejection(cube) === null, cube.kind === '3d', file)
  }
  t.diagnostic(`${files.length} .cube files under ${ADOBE} (${unreadable} folders unreadable)`)
  for (const [key, count] of [...counts].sort((a, b) => b[1] - a[1])) t.diagnostic(`${count} × ${key}`)
  t.diagnostic(`${warned} with warnings, ${nonUnit} 3D with a non-unit domain`)
  assert.deepEqual(failures, [])
  assert.ok(files.length > 0, 'the scan found no .cube at all')
})
