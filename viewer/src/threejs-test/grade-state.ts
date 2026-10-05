// The colour grade editor's bookkeeping (goal 4): the undo history, the A/B snapshots, the
// `grade:` block that Copy values writes, and the reader behind Paste values — pure, no three,
// no DOM, so it runs under `node --test` (grade-state.test.ts). grade-editor.ts owns the
// instances; main.ts puts the snippet into the Copy values text and hands a paste to the editor.
//
// The history and the snapshots hold `{ state, look }` pairs (plan 2.3: the look sits beside the
// state, and undo stores the two together). Everything going in or coming out is a structured
// clone, so the editor can keep editing its own objects without reaching into a stored entry.
import { CUBE_3D_SIZE_MAX } from './cube-format.ts'
import { GRADE_RANGES, NEUTRAL_GRADE, parseGradeState, type GradeState, type LookRef } from './grade-model.ts'

/** What one undo step, one snapshot slot and one paste carry. */
export interface GradeSnapshot {
  state: GradeState
  look: LookRef | null
}

// ---- equality -------------------------------------------------------------------------------

/** Deep equality for structured-clone data: same prototype, same own keys, equal leaves (0 and
 *  −0 equal, NaN equal to NaN). Enough to tell whether a commit changed anything. */
function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b)
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false
  const keysA = Object.keys(a)
  if (keysA.length !== Object.keys(b).length) return false
  for (const key of keysA) {
    if (!Object.hasOwn(b, key)) return false
    if (!sameData((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false
  }
  return true
}

// ---- history --------------------------------------------------------------------------------

export interface History<T> {
  /** Records `entry` as the new present and cuts the redo branch. An entry equal to the present
   *  is not recorded (false), so a commit that changed nothing costs no undo step and keeps the
   *  redo branch. */
  push(entry: T): boolean
  /** One step back: a copy of the entry before the present, or null at the oldest. */
  undo(): T | null
  /** One step forward again: a copy of the entry after the present, or null at the newest. */
  redo(): T | null
  canUndo(): boolean
  canRedo(): boolean
  /** A copy of the present entry, or null before the first push. */
  current(): T | null
}

/**
 * An undo history of `{ state, look }` (or any structured-clone data): the present entry plus up
 * to `limit` steps back; the oldest falls off. A push after an undo cuts the redo branch. Push the
 * starting point once (the boot state), then once per commit (plan 5.9: 'change', pointerup, the
 * end of a keyboard nudge, every discrete click); recalls, Reset and paste are commits too.
 */
export function createHistory<T = GradeSnapshot>(limit = 100): History<T> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`history limit ${limit}: expected an integer of 1 or more`)
  const entries: T[] = []
  let at = -1
  return {
    push(entry) {
      if (at >= 0 && sameData(entries[at], entry)) return false
      entries.length = at + 1
      entries.push(structuredClone(entry))
      if (entries.length > limit + 1) entries.splice(0, entries.length - limit - 1)
      at = entries.length - 1
      return true
    },
    undo() {
      if (at <= 0) return null
      at--
      return structuredClone(entries[at])
    },
    redo() {
      if (at >= entries.length - 1) return null
      at++
      return structuredClone(entries[at])
    },
    canUndo: () => at > 0,
    canRedo: () => at < entries.length - 1,
    current: () => (at >= 0 ? structuredClone(entries[at]) : null),
  }
}

// ---- A/B snapshots --------------------------------------------------------------------------

export type SnapshotSlot = 'A' | 'B'

export interface Snapshots<T> {
  /** The A or B button (plan 5.2): an empty slot stores `current` and gives null; a stored slot
   *  gives a copy of what it holds, for the editor to recall as one undo step. Either way the
   *  slot becomes the selected one. */
  tap(slot: SnapshotSlot, current: T): T | null
  /** The Store button: overwrites the selected slot (A while none is selected) with `current`,
   *  or `slot` when given, and selects it. Returns the slot written. */
  store(current: T, slot?: SnapshotSlot): SnapshotSlot
  /** A copy of what `slot` holds, or null when it is empty; selects nothing. */
  recall(slot: SnapshotSlot): T | null
  /** Whether `slot` holds something: the dot on its button. */
  has(slot: SnapshotSlot): boolean
  /** The slot the last tap or store went to, which Store overwrites; null at first. */
  selected(): SnapshotSlot | null
  /** Empties `slot`, or both (and the selection) without one. */
  clear(slot?: SnapshotSlot): void
}

function checkSlot(slot: SnapshotSlot) {
  if (slot !== 'A' && slot !== 'B') throw new RangeError(`snapshot slot ${String(slot)}: expected 'A' or 'B'`)
}

/** The two compare slots, each holding a copy of one `{ state, look }`. */
export function createSnapshots<T = GradeSnapshot>(): Snapshots<T> {
  const slots: Record<SnapshotSlot, T | null> = { A: null, B: null }
  let selected: SnapshotSlot | null = null
  const write = (slot: SnapshotSlot, current: T) => {
    slots[slot] = structuredClone(current)
    selected = slot
    return slot
  }
  return {
    tap(slot, current) {
      checkSlot(slot)
      const held = slots[slot]
      if (held === null) {
        write(slot, current)
        return null
      }
      selected = slot
      return structuredClone(held)
    },
    store(current, slot) {
      const target = slot ?? selected ?? 'A'
      checkSlot(target)
      return write(target, current)
    },
    recall(slot) {
      checkSlot(slot)
      const held = slots[slot]
      return held === null ? null : structuredClone(held)
    },
    has(slot) {
      checkSlot(slot)
      return slots[slot] !== null
    },
    selected: () => selected,
    clear(slot) {
      if (slot === undefined) {
        slots.A = null
        slots.B = null
        selected = null
        return
      }
      checkSlot(slot)
      slots[slot] = null
    },
  }
}

// ---- Copy values: the grade: block ----------------------------------------------------------

/** What the snippet needs of a look: its name (for one imported this session only), its file
 *  under public/grades/ (null when it has none yet) and its amount. A LookRef fits as is. */
export type SnippetLook = Pick<LookRef, 'name' | 'file' | 'amount'>

/** Characters a file name or a URL path segment cannot carry as they are. */
const UNSAFE_IN_FILE_NAME = /[\u0000-\u001f\u007f:*?"<>|#%]+/g

/**
 * The file name a look imported this session should be saved under, public/grades/<this>: the
 * name's last path part, characters a file name or URL cannot carry turned into '-', no leading
 * dot, and the .cube extension (kept in its own case, added when missing). The snippet writes it
 * as the look's file, so pasting the snippet into config.ts works once the file is saved there;
 * the editor can match a pasted file against lookFileName(look.name) to keep a look it holds.
 */
export function lookFileName(name: string): string {
  const base = String(name).split(/[\\/]/).pop() ?? ''
  const extension = /\.cube$/i.exec(base)?.[0] ?? '.cube'
  const stem = base.slice(0, base.length - (/\.cube$/i.test(base) ? extension.length : 0))
    .replace(UNSAFE_IN_FILE_NAME, '-').trim().replace(/^[.\s-]+/, '')
  return (stem || 'look') + extension
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** Lines stay inline up to this width, as config.ts's own one-line wheels and points do. */
const SNIPPET_WIDTH = 100

function inlineJson(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(inlineJson).join(', ')}]`
  const entries = Object.entries(value)
  return entries.length === 0 ? '{}' : `{ ${entries.map(([key, v]) => `${JSON.stringify(key)}: ${inlineJson(v)}`).join(', ')} }`
}

/** JSON that keeps a value on one line while it fits (a wheel, a puck, a short curve) and breaks
 *  it one entry per line, indented by two, when it does not. `lead` is what already stands on the
 *  line before the value (the indent and the key). */
function formatJson(value: Json, indent: string, lead: number): string {
  const flat = inlineJson(value)
  if (value === null || typeof value !== 'object' || lead + flat.length + 1 <= SNIPPET_WIDTH) return flat
  const inner = `${indent}  `
  if (Array.isArray(value)) {
    return `[\n${value.map((v) => inner + formatJson(v, inner, inner.length)).join(',\n')}\n${indent}]`
  }
  const lines = Object.entries(value).map(([key, v]) => {
    const head = `${inner}${JSON.stringify(key)}: `
    return head + formatJson(v, inner, head.length)
  })
  return `{\n${lines.join(',\n')}\n${indent}}`
}

/**
 * The value of Copy values' `grade:` block (main.ts appends `\ngrade: ${snippet}` after the
 * toneMapping block): `{ enabled, lutSize, look: { file, amount } | null, state }`, shaped like
 * config grade, so it can be pasted into config.ts or back into Paste values. Numbers only — a
 * look travels as its file, never as a lattice. It is JSON with one exception: a look imported
 * this session (file null) is written under lookFileName(name) with a trailing
 * `// save it as public/grades/<file> to keep it`; parseGradePaste reads the comment away.
 * Numbers are written exactly (JSON's shortest round-trip form), so a paste gives back the same
 * state bit for bit.
 */
export function gradeSnippet(enabled: boolean, lutSize: number, look: SnippetLook | null, state: GradeState): string {
  const file = look === null ? null : look.file || lookFileName(look.name)
  const note = look !== null && !look.file ? ` // save it as public/grades/${file} to keep it` : ''
  // Through JSON first, so the formatter only meets plain JSON values (and writes what JSON would).
  const plainJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as Json
  const entries: Array<[string, Json, string]> = [
    ['enabled', plainJson(enabled), ''],
    ['lutSize', plainJson(lutSize), ''],
    ['look', look === null ? null : plainJson({ file, amount: look.amount }), note],
    ['state', plainJson(state), ''],
  ]
  const lines = entries.map(([key, value, comment], i) => {
    const head = `  ${JSON.stringify(key)}: `
    return `${head}${formatJson(value, '  ', head.length)}${i < entries.length - 1 ? ',' : ''}${comment}`
  })
  return `{\n${lines.join('\n')}\n}`
}

// ---- Paste values ---------------------------------------------------------------------------

/** A grade read from a paste. A key is present only when the paste had it: no `look` means
 *  "keep the current look", `look: null` means "no look". `state` is always a full, sanitised
 *  GradeState (parseGradeState). */
export interface PastedGrade {
  enabled?: boolean
  lutSize?: number
  look?: { file: string; amount: number } | null
  state: GradeState
}

export interface GradePaste {
  /** Absent when nothing usable was found; `warnings` then says why. */
  grade?: PastedGrade
  /** The other Copy values blocks the paste held (design, pointLighting, ...), in order. */
  ignored: string[]
  warnings: string[]
}

/** How the status line describes `ignored` (plan 4.5). */
export const PASTE_IGNORED_NOTE = 'not applied: only grade is pasted in this version'

/** The sizes a lattice can have (a .cube's 3D limit, cube-format.ts). The editor still caps a
 *  pasted lutSize at config grade.maxLattice, which this module does not read. */
export const LUT_SIZE_LIMITS = Object.freeze({ min: 2, max: CUBE_3D_SIZE_MAX })

/** A block header in a Copy values dump: a name at the start of a line, a colon, then a space,
 *  a brace or the end of the line (so a console prefix like `VM12:1` is not one). */
const BLOCK_HEADER = /^(\w+):(?=[ \t]|\{|\[|$)/gm
/** What the console fallback of Copy values puts in front of the dump, with or without the
 *  source location a copied console line starts with. */
const CONSOLE_TAG = /^\s*(?:\S+\s+)?\[design\]\s*$/
/** A .cube file pasted by mistake: its size keyword. */
const CUBE_TEXT = /^\s*LUT_(?:1D|3D)_SIZE\b/im

/** The keys of the config-shaped wrapper, and those of config grade that a paste does not set. */
const WRAPPER_KEYS = ['enabled', 'lutSize', 'look', 'state']
const CONFIG_ONLY_KEYS = ['maxLattice', 'draftWhenFinalOverMs', 'worker', 'compareSplit', 'tuning']
const STATE_KEYS = Object.keys(NEUTRAL_GRADE)
const LOOK_KEYS = ['file', 'amount']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const describe = (value: unknown): string => typeof value === 'string' ? `"${value.slice(0, 40)}"`
  : value === null ? 'null' : typeof value === 'object' ? (Array.isArray(value) ? 'a list' : 'an object') : String(value)

/**
 * JSON plus what a hand-edited or config.ts-pasted block brings along: // and /* *\/ comments
 * (the snippet's own "save it as" note among them) and trailing commas, including one after the
 * block itself. Strings are copied as they are, so a "//" or "/*" inside one stays.
 */
function relaxedJson(text: string): string {
  let out = ''
  /** Where in `out` a comma stands that no value has followed yet. */
  let comma = -1
  for (let i = 0; i < text.length;) {
    const ch = text[i]
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 2
      out += ' '
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      out += ch
      i++
      continue
    }
    if ((ch === '}' || ch === ']') && comma >= 0) out = out.slice(0, comma) + out.slice(comma + 1)
    comma = -1
    if (ch === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (ch === ',') comma = out.length
    out += ch
    i++
  }
  return comma >= 0 ? out.slice(0, comma) + out.slice(comma + 1) : out
}

function parseJson(text: string, label: string, warnings: string[]): { value: unknown } | null {
  const source = relaxedJson(text).trim()
  if (source === '') {
    warnings.push(`${label}: empty, nothing applied`)
    return null
  }
  try {
    return { value: JSON.parse(source) }
  } catch (error) {
    warnings.push(`${label}: not valid JSON (${(error as Error)?.message ?? String(error)}), nothing applied`)
    return null
  }
}

function readLookFile(value: unknown, warnings: string[]): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    warnings.push(`grade.look.file: ${value === undefined ? 'missing' : describe(value)}, look not applied`)
    return null
  }
  const file = value.trim()
  // A path under public/grades/: relative, no backslash or control character, no empty, '.' or
  // '..' segment, and a .cube at the end, since that is all the worker reads.
  const segments = file.split('/')
  const plainPath = !/[\u0000-\u001f\u007f\\]/.test(file) && segments.every((s) => s !== '' && s !== '.' && s !== '..')
  if (!plainPath || !/\.cube$/i.test(file)) {
    warnings.push(`grade.look.file: ${describe(file)} is not a .cube file under public/grades/, look not applied`)
    return null
  }
  return file
}

function readLook(value: unknown, warnings: string[]): { file: string; amount: number } | null | undefined {
  if (value === null) return null
  if (!isRecord(value)) {
    warnings.push(`grade.look: ${describe(value)} is not a { file, amount } look, not applied`)
    return undefined
  }
  for (const key of Object.keys(value)) if (!LOOK_KEYS.includes(key)) warnings.push(`grade.look.${key}: unknown, ignored`)
  const file = readLookFile(value.file, warnings)
  if (file === null) return undefined
  const limits = GRADE_RANGES.look.amount
  let amount = limits.default
  if (value.amount !== undefined) {
    if (typeof value.amount !== 'number' || !Number.isFinite(value.amount)) {
      warnings.push(`grade.look.amount: ${describe(value.amount)} is not a number, ${limits.default} used`)
    } else if (value.amount < limits.min || value.amount > limits.max) {
      amount = Math.min(Math.max(value.amount, limits.min), limits.max)
      warnings.push(`grade.look.amount: ${value.amount} clamped to ${amount}`)
    } else amount = value.amount + 0
  }
  return { file, amount }
}

/**
 * A grade from a parsed value: the config-shaped wrapper `{ enabled, lutSize, look, state }`
 * when it has a `state`, or wrapper keys and no state key; otherwise a bare GradeState.
 */
function readGrade(value: unknown, warnings: string[]): PastedGrade | undefined {
  if (!isRecord(value)) {
    warnings.push(`grade: ${describe(value)} is not a grade, expected an object; nothing applied`)
    return undefined
  }
  const keys = Object.keys(value)
  const isWrapper = Object.hasOwn(value, 'state') || (
    keys.some((key) => WRAPPER_KEYS.includes(key) || CONFIG_ONLY_KEYS.includes(key))
    && !keys.some((key) => STATE_KEYS.includes(key)))
  if (!isWrapper) {
    const { state, warnings: stateWarnings } = parseGradeState(value)
    warnings.push(...stateWarnings)
    return { state }
  }
  for (const key of keys) {
    if (CONFIG_ONLY_KEYS.includes(key)) warnings.push(`grade.${key}: config only, not applied`)
    else if (!WRAPPER_KEYS.includes(key)) warnings.push(`grade.${key}: unknown, ignored`)
  }
  const grade: Partial<PastedGrade> = {}
  if (value.enabled !== undefined) {
    if (typeof value.enabled === 'boolean') grade.enabled = value.enabled
    else warnings.push(`grade.enabled: ${describe(value.enabled)} is not true or false, not applied`)
  }
  if (value.lutSize !== undefined) {
    const n = value.lutSize
    if (typeof n === 'number' && Number.isInteger(n) && n >= LUT_SIZE_LIMITS.min && n <= LUT_SIZE_LIMITS.max) grade.lutSize = n
    else warnings.push(`grade.lutSize: ${describe(n)} is not a lattice size ${LUT_SIZE_LIMITS.min}..${LUT_SIZE_LIMITS.max}, not applied`)
  }
  if (value.look !== undefined) {
    const look = readLook(value.look, warnings)
    if (look !== undefined) grade.look = look
  }
  if (value.state === undefined) warnings.push('grade.state: missing, neutral state used')
  const { state, warnings: stateWarnings } = parseGradeState(value.state)
  warnings.push(...stateWarnings)
  grade.state = state
  return grade as PastedGrade
}

function readPaste(text: string, ignored: string[], warnings: string[]): GradePaste {
  if (typeof text !== 'string') {
    warnings.push('paste: not text, nothing applied')
    return { ignored, warnings }
  }
  // A byte-order mark (U+FEFF) that a copy from some editors puts in front.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  if (body.trim() === '') {
    warnings.push('paste: empty, nothing applied')
    return { ignored, warnings }
  }
  const headers = [...body.matchAll(BLOCK_HEADER)]
  if (headers.length === 0) {
    if (CUBE_TEXT.test(body)) {
      warnings.push('paste: this is a .cube file; load it with Import .cube in the Look tab')
      return { ignored, warnings }
    }
    const parsed = parseJson(body, 'paste', warnings)
    const grade = parsed === null ? undefined : readGrade(parsed.value, warnings)
    return grade === undefined ? { ignored, warnings } : { grade, ignored, warnings }
  }
  const preamble = body.slice(0, headers[0].index)
  if (preamble.trim() !== '' && !CONSOLE_TAG.test(preamble)) warnings.push('paste: text before the first block ignored')
  let grade: PastedGrade | undefined
  let gradeBlocks = 0
  headers.forEach((header, i) => {
    const name = header[1]
    if (name !== 'grade') {
      if (!ignored.includes(name)) ignored.push(name)
      return
    }
    gradeBlocks++
    const start = header.index! + header[0].length
    const end = i + 1 < headers.length ? headers[i + 1].index! : body.length
    const parsed = parseJson(body.slice(start, end), 'grade', warnings)
    grade = parsed === null ? undefined : readGrade(parsed.value, warnings)
  })
  if (gradeBlocks === 0) warnings.push('paste: no grade block, nothing applied')
  if (gradeBlocks > 1) warnings.push(`paste: ${gradeBlocks} grade blocks, the last one read`)
  return grade === undefined ? { ignored, warnings } : { grade, ignored, warnings }
}

/**
 * Reads what Paste values was given (plan 4.5), and never throws:
 * - a whole Copy values dump: split into blocks on `name:` at the start of a line; the grade
 *   block is read, the others (design, pointLighting, atmosphere, toneMapping, eyeDomeLighting,
 *   depthOfField) are listed in `ignored`; the console fallback's `[design]` line in front is
 *   skipped;
 * - a bare `grade: {…}` block;
 * - bare JSON: the config-shaped `{ enabled, lutSize, look, state }` (gradeSnippet's text) or a
 *   GradeState alone.
 * Block values are JSON with comments and trailing commas allowed. The state goes through
 * parseGradeState (defaults, clamps, sanitised curves), whose warnings are passed on; enabled,
 * lutSize and look are set only when present and valid, each problem a warning. A dump with
 * several grade blocks gives the last one.
 */
export function parseGradePaste(text: string): GradePaste {
  const ignored: string[] = []
  const warnings: string[] = []
  try {
    return readPaste(text, ignored, warnings)
  } catch (error) {
    // Nothing above throws on any text; this is only the promise kept.
    warnings.push(`paste: unreadable (${String(error)}), nothing applied`)
    return { ignored, warnings }
  }
}

/** The status line after a paste: what was applied, the blocks left out, and the warnings. */
export function pasteSummary(paste: GradePaste): string {
  const parts = [paste.grade ? 'Grade pasted.' : 'No grade pasted.']
  if (paste.ignored.length > 0) parts.push(`${paste.ignored.join(', ')} ${PASTE_IGNORED_NOTE}.`)
  const n = paste.warnings.length
  if (n > 0) parts.push(`${n === 1 ? '1 warning' : `${n} warnings`}: ${paste.warnings.join('; ')}.`)
  return parts.join(' ')
}
