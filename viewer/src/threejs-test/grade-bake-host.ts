// The colour grade's bake service (goal 4, plan 4.7): what grade-bake.worker.ts runs, and what
// grade-editor.ts runs on the main thread where no worker comes up. One message in, at most one
// reply out, so both paths share every line of it — pure, no three, no DOM, so it runs under
// `node --test` (grade-bake-host.test.ts).
//
// It holds:
// - the parsed looks, by the key the editor gave them (grade-editor-logic.ts lookKey). The editor
//   decides which looks stay (its look store, up to 4) and sends 'drop' for the rest; the host's
//   own limit is only a backstop;
// - the float lattice of the last final bake, for Export .cube, so an export of what is on screen
//   costs no second bake.
// A bake writes into the buffer the message brought (transferred) and sends it back the same way.
import {
  cubeImportRejection, CubeParseError, GRADE_CUBE_TITLE, isIdentityLattice, parseCube, serializeCube,
  type CubeFile, type CubeKind, type CubeRgb,
} from './cube-format.ts'
import { bakeGradeFloat, bakeGradeTexels, isUnitDomain, type BakedMessage, type BakeJob, type BakeMessage, type GradeLook } from './grade-bake.ts'
import { DEFAULT_GRADE_TUNING, type GradeTuning } from './grade-model.ts'

/** How far a look's nodes may sit from their inputs and still count as no look (plan 2.5). */
const LOOK_IDENTITY_EPS = 1e-5

/** What the editor needs to know about a parsed look, for the Look status line, the lattice
 *  size (latticeSizeFor) and the identity test (isGradeIdentity's LookIdentity.isIdentity). */
export interface LookMeta {
  title: string | null
  kind: CubeKind
  /** N of the 3D table. */
  size: number
  domainMin: CubeRgb
  domainMax: CubeRgb
  /** The default 0..1 domain on every channel; anything else is resampled, not 1:1. */
  unitDomain: boolean
  /** Every node within 1e-5 of its input over a domain covering 0..1: the look changes nothing. */
  isIdentity: boolean
  /** What the parser tolerated (unknown keywords and the like). */
  warnings: string[]
}

/** Sets the tuning every later bake uses (config grade.tuning). */
export interface InitMessage { kind: 'init'; tuning: GradeTuning }
/** Parses a .cube's text and holds it under `key`. */
export interface ParseMessage { kind: 'parse'; key: string; text: string }
/** Forgets the look under `key`. No reply. */
export interface DropMessage { kind: 'drop'; key: string }
/** The .cube text of `job` as a final bake: the kept lattice when it was baked for the same job,
 *  else a fresh bake. `id` comes back with the reply. */
export interface ExportMessage { kind: 'export'; id: number; title?: string; job: BakeJob }

export interface ParsedMessage { kind: 'parsed'; key: string; meta: LookMeta }
/** A parse that failed: `line` is the file's 1-based line, 0 when the file as a whole is refused
 *  (a 1D or shaper LUT, `rejected`). */
export interface ParseErrorMessage { kind: 'error'; key: string; message: string; line: number; rejected?: boolean }
/** A bake that could not run (its look is not held, a size out of range). The buffer comes back. */
export interface BakeFailedMessage { kind: 'bake-failed'; seq: number; message: string; out: ArrayBuffer; missingLook?: string }
export interface CubeMessage { kind: 'cube'; id: number; n: number; text: string }
export interface ExportErrorMessage { kind: 'export-error'; id: number; message: string }

export type HostRequest = InitMessage | ParseMessage | DropMessage | BakeMessage | ExportMessage
export type HostReply = ParsedMessage | ParseErrorMessage | BakedMessage | BakeFailedMessage | CubeMessage | ExportErrorMessage

export interface HostResult {
  reply: HostReply
  /** What to transfer with the reply: a bake's buffer. */
  transfer: ArrayBuffer[]
}

export interface GradeBakeHost {
  /** One message in; the reply to send back, or null for one that has none (init, drop). Never
   *  throws: every failure is a reply. */
  handle(message: HostRequest): HostResult | null
  /** The keys of the looks held, oldest use first. */
  looks(): string[]
  /** The size of the kept final lattice, 0 before the first final bake. */
  readonly keptSize: number
}

export interface GradeBakeHostOptions {
  tuning?: Readonly<GradeTuning>
  /** Looks held at most; the oldest use goes first. A backstop: the editor drops what it no
   *  longer holds itself, and holds 4. */
  maxLooks?: number
}

/** The same key the bake scheduler compares jobs by (grade-bake.ts jobHash). */
function jobKey(job: Pick<BakeJob, 'state' | 'look' | 'n'>): string {
  return `${JSON.stringify(job.state)}|${job.look ? JSON.stringify([job.look.key, job.look.amount]) : '-'}|${job.n}`
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function createGradeBakeHost(options: GradeBakeHostOptions = {}): GradeBakeHost {
  let tuning: Readonly<GradeTuning> = options.tuning ?? DEFAULT_GRADE_TUNING
  const maxLooks = Math.max(1, Math.floor(options.maxLooks ?? 8))
  /** Map order is use order: a use deletes and re-inserts. */
  const looks = new Map<string, CubeFile>()
  /** One float lattice per role and size: finals into `finals` (kept for export), drafts into
   *  `drafts`, so a drag's drafts never overwrite what an export reads. */
  const finals = new Map<number, Float32Array>()
  const drafts = new Map<number, Float32Array>()
  let kept: { key: string; n: number; lattice: Float32Array } | null = null

  const scratch = (pool: Map<number, Float32Array>, n: number) => {
    let lattice = pool.get(n)
    if (!lattice) {
      // One size at a time: a size change (a look on or off) drops the old one.
      pool.clear()
      lattice = new Float32Array(3 * n ** 3)
      pool.set(n, lattice)
    }
    return lattice
  }

  const useLook = (key: string): CubeFile | null => {
    const cube = looks.get(key)
    if (!cube) return null
    looks.delete(key)
    looks.set(key, cube)
    return cube
  }

  const lookFor = (job: Pick<BakeJob, 'look'>): GradeLook | null | string => {
    if (!job.look) return null
    const cube = useLook(job.look.key)
    return cube ? { cube, amount: job.look.amount } : job.look.key
  }

  function parse(message: ParseMessage): HostResult {
    let cube: CubeFile
    try {
      cube = parseCube(message.text)
    } catch (error) {
      const line = error instanceof CubeParseError ? error.line : 0
      return { reply: { kind: 'error', key: message.key, message: errorText(error), line }, transfer: [] }
    }
    const rejection = cubeImportRejection(cube)
    if (rejection) return { reply: { kind: 'error', key: message.key, message: rejection, line: 0, rejected: true }, transfer: [] }
    looks.delete(message.key)
    looks.set(message.key, cube)
    while (looks.size > maxLooks) looks.delete(looks.keys().next().value!)
    const meta: LookMeta = {
      title: cube.title,
      kind: cube.kind,
      size: cube.size,
      domainMin: [...cube.domainMin],
      domainMax: [...cube.domainMax],
      unitDomain: isUnitDomain(cube),
      isIdentity: isIdentityLattice(cube, LOOK_IDENTITY_EPS),
      warnings: [...cube.warnings],
    }
    return { reply: { kind: 'parsed', key: message.key, meta }, transfer: [] }
  }

  function bake(message: BakeMessage): HostResult {
    const fail = (text: string, missingLook?: string): HostResult => ({
      reply: { kind: 'bake-failed', seq: message.seq, message: text, out: message.out, ...(missingLook ? { missingLook } : {}) },
      transfer: message.out.byteLength > 0 ? [message.out] : [],
    })
    const look = lookFor(message)
    if (typeof look === 'string') return fail(`the look ${look} is not loaded`, look)
    const final = message.stride === 1
    try {
      const lattice = scratch(final ? finals : drafts, message.n)
      const { peak, ms } = bakeGradeTexels(message.state, look, message.n, message.stride, new Uint16Array(message.out),
        { tuning, scratch: lattice })
      if (final) kept = { key: jobKey(message), n: message.n, lattice }
      return {
        reply: { kind: 'baked', seq: message.seq, n: message.n, stride: message.stride, ms, peak, out: message.out },
        transfer: [message.out],
      }
    } catch (error) {
      if (final) kept = null
      return fail(errorText(error))
    }
  }

  function exportCube(message: ExportMessage): HostResult {
    const failure = (text: string): HostResult => ({ reply: { kind: 'export-error', id: message.id, message: text }, transfer: [] })
    const { job } = message
    try {
      let lattice: Float32Array
      if (kept && kept.key === jobKey(job) && kept.n === job.n) lattice = kept.lattice
      else {
        const look = lookFor(job)
        if (typeof look === 'string') return failure(`the look ${look} is not loaded`)
        lattice = bakeGradeFloat(job.state, look, job.n, 1, new Float32Array(3 * job.n ** 3), { tuning }).lattice
      }
      const text = serializeCube(lattice, job.n, { title: message.title ?? GRADE_CUBE_TITLE })
      return { reply: { kind: 'cube', id: message.id, n: job.n, text }, transfer: [] }
    } catch (error) {
      return failure(errorText(error))
    }
  }

  return {
    handle(message) {
      switch (message?.kind) {
        case 'init':
          tuning = { ...DEFAULT_GRADE_TUNING, ...message.tuning }
          kept = null
          return null
        case 'parse': return parse(message)
        case 'drop':
          looks.delete(message.key)
          return null
        case 'bake': return bake(message)
        case 'export': return exportCube(message)
        default: return null
      }
    },
    looks: () => [...looks.keys()],
    get keptSize() { return kept ? kept.n : 0 },
  }
}
