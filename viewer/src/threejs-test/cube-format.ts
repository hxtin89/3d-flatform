// Reading and writing .cube LUT files, the format Resolve, Photoshop and Premiere exchange looks
// in — pure, no DOM and no three, so it runs under `node --test` (cube-format.test.ts) and in
// grade-bake.worker.ts. The grade editor imports a 3D cube as a look, which grade-bake.ts bakes
// into its own lattice, and exports its baked lattice as one.
//
// The parser reads Adobe's Cube LUT Specification 1.0 (TITLE, LUT_1D_SIZE, LUT_3D_SIZE,
// DOMAIN_MIN, DOMAIN_MAX) and Resolve's additions (LUT_1D_INPUT_RANGE, LUT_3D_INPUT_RANGE and a
// 1D shaper table ahead of the 3D one). It is lenient about layout — CRLF, tabs, comments between
// keywords, blank lines anywhere, lowercase keywords, unknown keywords before the data — and
// strict about the data: every row is exactly three numbers, finite as float32, and there are
// exactly as many rows as the sizes say, so a file is either read as its author meant or refused
// with a line number, never misread.

export type CubeRgb = [number, number, number]

/** Which tables a file holds. Only '3d' is accepted as a look in v1 (cubeImportRejection). */
export type CubeKind = '3d' | '1d' | '1d+3d'

export interface CubeTable1D {
  size: number
  domainMin: CubeRgb
  domainMax: CubeRgb
  /** `size` rows of RGB: row i is the output for the input domainMin + i/(size−1)·(domainMax − domainMin). */
  data: Float32Array
}

export interface CubeFile {
  title: string | null
  kind: CubeKind
  /** N of the 3D table, 0 without one. */
  size: number
  /** The 3D table's input domain, [0,0,0]..[1,1,1] unless the file says otherwise. */
  domainMin: CubeRgb
  domainMax: CubeRgb
  /** N³ rows of RGB, red fastest: row i + N·j + N²·k is the output for the lattice point
   *  (i, j, k)/(N−1) of the domain. Values outside [0,1] are kept as written. Empty without a
   *  3D table. */
  data: Float32Array
  lut1d: CubeTable1D | null
  /** Things the parser tolerated: unknown keywords, repeated keywords, DOMAIN over INPUT_RANGE. */
  warnings: string[]
}

/** A file the parser refuses. `line` is 1-based; `message` starts with it, `reason` is without. */
export class CubeParseError extends Error {
  line: number
  reason: string
  constructor(reason: string, line: number) {
    super(`line ${line}: ${reason}`)
    this.name = 'CubeParseError'
    this.line = line
    this.reason = reason
  }
}

export const CUBE_3D_SIZE_MAX = 256
export const CUBE_1D_SIZE_MAX = 65536

/** The plan's number grammar, /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/, written so a run of
 *  digits can be matched one way only: the plan's form splits n digits between \d+ and \d* in n
 *  ways and tries all of them before refusing a long run that ends in a bad character, which
 *  took 6 s for a 40 000-digit token. Both accept the same strings. */
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/
const WORD = /^[A-Za-z_][A-Za-z0-9_]*$/
/** Words that are meant as numbers: they start a data row and are refused there. */
const NON_FINITE = /^[+-]?(nan|inf|infinity)$/i
/** TITLE is matched before comments are cut, so a quoted title may hold '#'. */
const TITLE_LINE = /^TITLE(?![A-Za-z0-9_])[ \t]*(.*)$/i
const KEYWORDS = new Set([
  'TITLE', 'LUT_1D_SIZE', 'LUT_3D_SIZE', 'DOMAIN_MIN', 'DOMAIN_MAX', 'LUT_1D_INPUT_RANGE', 'LUT_3D_INPUT_RANGE',
])

/**
 * The tokens of a trimmed line up to a comment, split on runs of spaces and tabs, into `tokens`;
 * returns how many. A hand loop rather than split(/[ \t]+/), which cost half the parse of a 65³
 * cube.
 */
function tokenize(content: string, tokens: string[]): number {
  let count = 0
  let i = 0
  const end = content.length
  while (i < end) {
    let c = content.charCodeAt(i)
    if (c === 32 || c === 9) {
      i++
      continue
    }
    if (c === 35) break
    const start = i
    while (i < end && (c = content.charCodeAt(i)) !== 32 && c !== 9 && c !== 35) i++
    tokens[count++] = content.slice(start, i)
  }
  return count
}

/** A letter or '_': the line may hold a keyword. */
const startsWord = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95

function parseNumber(token: string, line: number): number {
  if (!NUMBER.test(token)) throw new CubeParseError(`'${token}' is not a number`, line)
  const value = Number(token)
  if (!Number.isFinite(value)) throw new CubeParseError(`'${token}' is too large`, line)
  return value
}

/** A table value: the tables are Float32Arrays, so a number beyond the float32 range (about
 *  3.4e38), finite as a double, is refused rather than stored as ±Infinity. */
function parseValue(token: string, line: number): number {
  const value = parseNumber(token, line)
  if (!Number.isFinite(Math.fround(value))) throw new CubeParseError(`'${token}' is too large for a 32-bit float`, line)
  return value
}

function parseSize(tokens: string[], keyword: string, max: number, line: number): number {
  if (tokens.length !== 2) throw new CubeParseError(`${keyword} needs one number, found ${tokens.length - 1}`, line)
  const size = parseNumber(tokens[1], line)
  if (!Number.isInteger(size)) throw new CubeParseError(`${keyword} ${tokens[1]} is not a whole number`, line)
  if (size < 2 || size > max) throw new CubeParseError(`${keyword} ${tokens[1]} is outside 2..${max}`, line)
  return size
}

/** DOMAIN_MIN / DOMAIN_MAX: three numbers, or one for all channels. */
function parseTriple(tokens: string[], keyword: string, line: number): CubeRgb {
  const values = tokens.slice(1).map((token) => parseNumber(token, line))
  if (values.length === 3) return [values[0], values[1], values[2]]
  if (values.length === 1) return [values[0], values[0], values[0]]
  throw new CubeParseError(`${keyword} needs 3 numbers, found ${values.length}`, line)
}

/** LUT_xD_INPUT_RANGE min max, the same on every channel. */
function parseRange(tokens: string[], keyword: string, line: number): [CubeRgb, CubeRgb] {
  if (tokens.length !== 3) throw new CubeParseError(`${keyword} needs 2 numbers (min max), found ${tokens.length - 1}`, line)
  const min = parseNumber(tokens[1], line)
  const max = parseNumber(tokens[2], line)
  return [[min, min, min], [max, max, max]]
}

/** The title after TITLE: up to the closing quote when quoted, else up to a comment. */
function parseTitle(rest: string, line: number, warnings: string[]): string {
  if (!rest.startsWith('"')) {
    const hash = rest.indexOf('#')
    return (hash >= 0 ? rest.slice(0, hash) : rest).trim()
  }
  const close = rest.indexOf('"', 1)
  if (close < 0) {
    warnings.push(`line ${line}: the TITLE has no closing quote; the rest of the line is used`)
    return rest.slice(1).trim()
  }
  const after = rest.slice(close + 1).trim()
  if (after !== '' && !after.startsWith('#')) warnings.push(`line ${line}: text after the TITLE's closing quote ignored`)
  return rest.slice(1, close)
}

/**
 * Parse a .cube file. Throws CubeParseError on a keyword after the data, a row that is not
 * exactly 3 numbers, a token that is not a finite number (in a table row: not finite as a
 * float32), a row count other than N³ (+ the 1D size), a size outside 2..256 (3D) or 2..65536
 * (1D), a missing size keyword or an empty domain, which is reported at the later of the lines
 * its min and max came from.
 * A file with both tables holds the 1D rows first. DOMAIN_MIN/MAX win over an INPUT_RANGE, with a
 * warning, and in a file with both tables they apply to both.
 */
export function parseCube(text: string): CubeFile {
  const lines = text.split(/\r\n|\r|\n/)
  const warnings: string[] = []
  const seen = new Set<string>()
  let title: string | null = null
  let size1 = 0
  let size3 = 0
  let domainMin: CubeRgb | null = null
  let domainMax: CubeRgb | null = null
  let range1: [CubeRgb, CubeRgb] | null = null
  let range3: [CubeRgb, CubeRgb] | null = null
  // The line each domain source was read on, for an empty-domain error.
  let domainMinLine = 0
  let domainMaxLine = 0
  let range1Line = 0
  let range3Line = 0
  let lastLine = 0
  // Filled once the first data row arrives, when both sizes are final.
  let lut1: Float32Array | null = null
  let lut3: Float32Array | null = null
  let expected = 0
  let rows = 0
  let firstDataLine = 0
  let lastDataLine = 0
  let firstExtraLine = 0

  const keywordSeen = (keyword: string, line: number) => {
    if (firstDataLine) {
      throw new CubeParseError(`${keyword} after the data: every keyword has to come before the first data row`, line)
    }
    if (seen.has(keyword)) warnings.push(`line ${line}: ${keyword} given again; this one is used`)
    seen.add(keyword)
  }

  const tokens: string[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = index + 1
    const content = lines[index].trim()
    if (content === '') continue
    lastLine = line
    const first = content.charCodeAt(0)
    if (first === 35) continue
    if (first === 84 || first === 116) {
      const titleMatch = TITLE_LINE.exec(content)
      if (titleMatch) {
        keywordSeen('TITLE', line)
        title = parseTitle(titleMatch[1], line, warnings)
        continue
      }
    }
    const count = tokenize(content, tokens)
    const head = tokens[0]
    if (startsWord(first)) {
      const keyword = head.toUpperCase()
      if (KEYWORDS.has(keyword)) {
        keywordSeen(keyword, line)
        const words = tokens.slice(0, count)
        switch (keyword) {
          case 'LUT_1D_SIZE': size1 = parseSize(words, keyword, CUBE_1D_SIZE_MAX, line); break
          case 'LUT_3D_SIZE': size3 = parseSize(words, keyword, CUBE_3D_SIZE_MAX, line); break
          case 'DOMAIN_MIN': domainMin = parseTriple(words, keyword, line); domainMinLine = line; break
          case 'DOMAIN_MAX': domainMax = parseTriple(words, keyword, line); domainMaxLine = line; break
          case 'LUT_1D_INPUT_RANGE': range1 = parseRange(words, keyword, line); range1Line = line; break
          case 'LUT_3D_INPUT_RANGE': range3 = parseRange(words, keyword, line); range3Line = line; break
        }
        continue
      }
      if (!firstDataLine && WORD.test(head) && !NON_FINITE.test(head)) {
        warnings.push(`line ${line}: unknown keyword ${head} ignored`)
        continue
      }
    }

    // A data row.
    if (!firstDataLine) {
      if (!size1 && !size3) throw new CubeParseError('data before any LUT_3D_SIZE or LUT_1D_SIZE', line)
      firstDataLine = line
      expected = size1 + size3 ** 3
      lut1 = new Float32Array(3 * size1)
      lut3 = new Float32Array(3 * size3 ** 3)
    }
    if (count !== 3) {
      const row = tokens.slice(0, count).join(' ')
      throw new CubeParseError(`a data row needs exactly 3 numbers, found ${count}: '${row}'`, line)
    }
    const r = parseValue(tokens[0], line)
    const g = parseValue(tokens[1], line)
    const b = parseValue(tokens[2], line)
    if (rows < expected) {
      const target = rows < size1 ? lut1! : lut3!
      const p = 3 * (rows < size1 ? rows : rows - size1)
      target[p] = r
      target[p + 1] = g
      target[p + 2] = b
    } else if (!firstExtraLine) {
      firstExtraLine = line
    }
    rows++
    lastDataLine = line
  }

  if (!size1 && !size3) throw new CubeParseError('no LUT_3D_SIZE or LUT_1D_SIZE: not a .cube LUT', Math.max(lastLine, 1))
  expected = size1 + size3 ** 3
  if (rows !== expected) {
    const want = size1 && size3 ? `${size1} + ${size3}³ = ${expected}` : size3 ? `${size3}³ = ${expected}` : `${size1}`
    const at = rows > expected ? firstExtraLine : lastDataLine || Math.max(lastLine, 1)
    throw new CubeParseError(`expected ${want} data rows, found ${rows}`, at)
  }

  const resolveDomain = (table: '1D' | '3D', range: [CubeRgb, CubeRgb] | null, rangeLine: number): [CubeRgb, CubeRgb] => {
    if (range && (domainMin || domainMax)) warnings.push(`DOMAIN_MIN/DOMAIN_MAX override LUT_${table}_INPUT_RANGE`)
    const min = domainMin ?? range?.[0] ?? [0, 0, 0]
    const max = domainMax ?? range?.[1] ?? [1, 1, 1]
    // The lines the min and max came from (0 for the default, which is never the empty side).
    const minLine = domainMin ? domainMinLine : range ? rangeLine : 0
    const maxLine = domainMax ? domainMaxLine : range ? rangeLine : 0
    for (let c = 0; c < 3; c++) {
      if (!(max[c] > min[c])) {
        const at = Math.max(minLine, maxLine) || 1
        throw new CubeParseError(`the ${table} domain is empty on ${'RGB'[c]}: min ${min[c]}, max ${max[c]}`, at)
      }
    }
    return [[min[0], min[1], min[2]], [max[0], max[1], max[2]]]
  }
  if (size1 && size3 && (domainMin || domainMax)) warnings.push('DOMAIN_MIN/DOMAIN_MAX apply to both the 1D and the 3D table')
  if (range1 && !size1) warnings.push('LUT_1D_INPUT_RANGE without a 1D table ignored')
  if (range3 && !size3) warnings.push('LUT_3D_INPUT_RANGE without a 3D table ignored')

  let lut1d: CubeTable1D | null = null
  if (size1) {
    const [min, max] = resolveDomain('1D', range1, range1Line)
    lut1d = { size: size1, domainMin: min, domainMax: max, data: lut1! }
  }
  const [min3, max3]: [CubeRgb, CubeRgb] = size3 ? resolveDomain('3D', range3, range3Line) : [[0, 0, 0], [1, 1, 1]]
  return {
    title,
    kind: size1 && size3 ? '1d+3d' : size3 ? '3d' : '1d',
    size: size3,
    domainMin: min3,
    domainMax: max3,
    data: lut3!,
    lut1d,
    warnings,
  }
}

/** Why a parsed cube cannot be a look in v1, for the Look status line, or null when it can. */
export function cubeImportRejection(cube: CubeFile): string | null {
  if (!cube.lut1d) return null
  return `This .cube has a 1D table (LUT_1D_SIZE ${cube.lut1d.size}). 1D and shaper LUTs are not supported yet; `
    + 'export a 3D LUT (for example 33 point) instead.'
}

/** A [0,1] coordinate (clamped, NaN to 0) in node units of a lattice with s = n − 1 cells a side.
 *  Within 1e-9 of a node it is the node: i/(L−1)·(N−1) is not always a whole number in floats
 *  (2/6·6 is not 2), and a refined lattice should land on the cube's own nodes exactly.
 *  sampleLattice reads with it, and grade-bake.ts's per-axis look tables too, so both agree bit
 *  for bit. */
export function nodeCoordinate(v: number, s: number): number {
  const x = (v > 0 ? (v < 1 ? v : 1) : 0) * s
  const node = Math.round(x)
  return Math.abs(x - node) < 1e-9 ? node : x
}

/**
 * Trilinear sample of an RGB lattice of n³ nodes (n ≥ 2, red fastest) at `rgb` in lattice
 * coordinates, [0,1] on each axis; outside that (and NaN) is clamped to the lattice. Mapping an
 * input onto a cube's domain is the caller's. Writes R, G, B into `out` and returns it. At a node
 * the node's value comes back exactly, for finite data of any array type: every lerp is
 * (1 − f)·a + f·b, exact at f = 0 and at f = 1 (a node on the top face is read from the cell
 * below it, at f = 1). grade-bake.ts's stage 0 does the same arithmetic.
 */
export function sampleLattice<T extends { [index: number]: number }>(
  data: ArrayLike<number>, n: number, rgb: ArrayLike<number>, out: T,
): T {
  const s = n - 1
  const x = nodeCoordinate(rgb[0], s)
  const y = nodeCoordinate(rgb[1], s)
  const z = nodeCoordinate(rgb[2], s)
  const i = Math.min(Math.floor(x), s - 1)
  const j = Math.min(Math.floor(y), s - 1)
  const k = Math.min(Math.floor(z), s - 1)
  const fx = x - i
  const fy = y - j
  const fz = z - k
  const gx = 1 - fx
  const gy = 1 - fy
  const gz = 1 - fz
  const dy = 3 * n
  const dz = 3 * n * n
  const base = 3 * i + dy * j + dz * k
  for (let c = 0; c < 3; c++) {
    const p = base + c
    const c00 = gx * data[p] + fx * data[p + 3]
    const c10 = gx * data[p + dy] + fx * data[p + dy + 3]
    const c01 = gx * data[p + dz] + fx * data[p + dz + 3]
    const c11 = gx * data[p + dz + dy] + fx * data[p + dz + dy + 3]
    const c0 = gy * c00 + fy * c10
    const c1 = gy * c01 + fy * c11
    out[c] = gz * c0 + fz * c1
  }
  return out
}

/** The RGB identity lattice, node (i, j, k) = (i, j, k)/(n−1), red fastest. Exact for every n. */
export function identityLattice(n: number): Float32Array {
  const data = new Float32Array(3 * n ** 3)
  const s = n - 1
  let p = 0
  for (let k = 0; k < n; k++) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        data[p++] = i / s
        data[p++] = j / s
        data[p++] = k / s
      }
    }
  }
  return data
}

/** The part of a CubeFile a lattice check needs. */
export type CubeLattice = Pick<CubeFile, 'data' | 'size' | 'domainMin' | 'domainMax'>

/**
 * True when the lattice, read over its domain, gives every input in [0,1]³ back: every node of
 * the RGB n³ lattice within `eps` of its own input, and a domain that covers [0,1] on every
 * channel — a narrower one clamps the inputs outside it (plan 2.4 stage 0), so it is never the
 * identity. Plain data is checked against (i, j, k)/(n−1), the unit domain; give the domain, or
 * pass a parsed cube (`isIdentityLattice(cube, eps)`), for a cube whose domain is not [0,1] —
 * there the identity is domainMin + (i, j, k)/(n−1)·(domainMax − domainMin). NaN is never
 * identity.
 */
export function isIdentityLattice(cube: CubeLattice, eps?: number): boolean
export function isIdentityLattice(
  data: ArrayLike<number>, n: number, eps?: number, domainMin?: Readonly<CubeRgb>, domainMax?: Readonly<CubeRgb>,
): boolean
export function isIdentityLattice(
  first: ArrayLike<number> | CubeLattice, second?: number, third?: number,
  fourth?: Readonly<CubeRgb>, fifth?: Readonly<CubeRgb>,
): boolean {
  const plain = typeof (first as ArrayLike<number>).length === 'number'
  const data = plain ? first as ArrayLike<number> : (first as CubeLattice).data
  const n = plain ? second ?? 0 : (first as CubeLattice).size
  const eps = (plain ? third : second) ?? 1e-5
  const min = plain ? fourth ?? [0, 0, 0] : (first as CubeLattice).domainMin
  const max = plain ? fifth ?? [1, 1, 1] : (first as CubeLattice).domainMax
  if (!Number.isInteger(n) || n < 2 || data.length !== 3 * n ** 3) return false
  for (let c = 0; c < 3; c++) if (!(min[c] <= 0 && max[c] >= 1)) return false
  const s = n - 1
  const axes = [0, 1, 2].map((c) => Array.from({ length: n }, (_, i) => min[c] + (i / s) * (max[c] - min[c])))
  const [ax, ay, az] = axes
  let p = 0
  for (let k = 0; k < n; k++) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        if (!(Math.abs(data[p] - ax[i]) <= eps && Math.abs(data[p + 1] - ay[j]) <= eps && Math.abs(data[p + 2] - az[k]) <= eps)) {
          return false
        }
        p += 3
      }
    }
  }
  return true
}

/** The comment lines an exported grade starts with: what it expects as input, and how to apply it. */
export const GRADE_CUBE_COMMENTS: readonly string[] = Object.freeze([
  'SCHNELLE BUNTE BILDER · Canopy colour grade',
  'Input: the displayed frame, sRGB-encoded, after the film look. Take the screenshot with the grade off.',
  'Interpolation: trilinear',
])

export const GRADE_CUBE_TITLE = 'Canopy colour grade'

export interface SerializeCubeOptions {
  /** Written as TITLE "…"; double quotes, '#' and line breaks are replaced, since not every
   *  reader handles them inside a title. Default GRADE_CUBE_TITLE. */
  title?: string
  /** Comment lines for the top of the file, without the '#'. Default GRADE_CUBE_COMMENTS. */
  comments?: readonly string[]
}

function formatValue(v: number, node: number): string {
  if (!Number.isFinite(v)) throw new RangeError(`serializeCube: node ${node} holds ${v}`)
  const text = v.toFixed(6)
  return text === '-0.000000' ? '0.000000' : text
}

/**
 * A 3D .cube of an n³ lattice, red fastest, from RGB (3 values per node) or RGBA (4, the alpha
 * is skipped) floats: LF only, comments only at the top, TITLE and LUT_3D_SIZE, no DOMAIN lines
 * (the default [0,1]), 6 decimals, values as they are — outside [0,1] too, since the canvas
 * clamps after interpolation. Throws a RangeError on a non-finite value or a length that fits
 * neither layout, so it never writes a file parseCube would refuse.
 */
export function serializeCube(lattice: ArrayLike<number>, n: number, options: SerializeCubeOptions = {}): string {
  if (!Number.isInteger(n) || n < 2 || n > CUBE_3D_SIZE_MAX) throw new RangeError(`serializeCube: size ${n} is outside 2..${CUBE_3D_SIZE_MAX}`)
  const nodes = n ** 3
  const stride = lattice.length === 3 * nodes ? 3 : lattice.length === 4 * nodes ? 4 : 0
  if (!stride) throw new RangeError(`serializeCube: ${lattice.length} values fit neither 3·${n}³ nor 4·${n}³`)
  const out: string[] = []
  for (const comment of options.comments ?? GRADE_CUBE_COMMENTS) {
    for (const line of comment.split(/\r\n|\r|\n/)) out.push(line.trim() ? `# ${line.trim()}` : '#')
  }
  const title = (options.title ?? GRADE_CUBE_TITLE).replace(/"/g, "'").replace(/[#\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim()
  out.push(`TITLE "${title}"`, `LUT_3D_SIZE ${n}`, '')
  for (let node = 0, p = 0; node < nodes; node++, p += stride) {
    out.push(`${formatValue(lattice[p], node)} ${formatValue(lattice[p + 1], node)} ${formatValue(lattice[p + 2], node)}`)
  }
  return out.join('\n') + '\n'
}

/** The download name of an exported grade. */
export const gradeCubeFileName = (n: number) => `canopy-grade-${n}.cube`
