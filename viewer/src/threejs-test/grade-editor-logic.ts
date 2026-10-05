// The Colour grade section's decisions (goal 4, plan 1.6 and section 5), apart from the DOM that
// grade-editor.ts wires them to: when the grade is compiled in, which looks stay held, what a
// paste does, what the status lines say, what the sliders edit and how they read, the split's
// keys and the undo keys. Pure, no three, no DOM, so it runs under `node --test`
// (grade-editor-logic.test.ts, which also checks the markup against these tables).
import { CUBE_3D_SIZE_MAX } from './cube-format.ts'
import type { LookMeta } from './grade-bake-host.ts'
import type { LatticeSize } from './grade-bake.ts'
import {
  GRADE_RANGES, isGradeIdentity, parseGradeState,
  type GradeRange, type GradeState, type GradeTuning, type LookRef, type WheelName,
} from './grade-model.ts'
import { lookFileName, type PastedGrade } from './grade-state.ts'

// ---- config ---------------------------------------------------------------------------------

/** config grade (config.ts), as the editor reads it. */
export interface GradeConfig {
  readonly enabled: boolean
  readonly lutSize: number
  readonly maxLattice: number
  readonly draftWhenFinalOverMs: number
  readonly worker: boolean
  readonly look: { readonly file: string; readonly amount: number } | null
  readonly compareSplit: number
  readonly state: unknown
  readonly tuning: Readonly<GradeTuning>
}

/** What the editor starts from. */
export interface GradeBoot {
  state: GradeState
  /** What parseGradeState changed, and sizes pulled into range. */
  warnings: string[]
  lutSize: number
  maxLattice: number
  /** Bake on the main thread before the first frame: the grade is on and the state changes
   *  something. A configured look is fetched and baked afterwards, off the first frame. */
  bakeNow: boolean
  look: { file: string; amount: number } | null
}

const clampInt = (x: number, lo: number, hi: number) => Math.min(Math.max(Math.round(Number.isFinite(x) ? x : lo), lo), hi)

/** The editor's starting point from config grade and the boot switch (`?grade=` over enabled). */
export function gradeBoot(config: GradeConfig, enabled: boolean): GradeBoot {
  const { state, warnings } = parseGradeState(config.state)
  const maxLattice = clampInt(config.maxLattice, 2, CUBE_3D_SIZE_MAX)
  const lutSize = clampInt(config.lutSize, 2, maxLattice)
  if (maxLattice !== config.maxLattice) warnings.push(`grade.maxLattice: ${config.maxLattice} read as ${maxLattice}`)
  if (lutSize !== config.lutSize) warnings.push(`grade.lutSize: ${config.lutSize} read as ${lutSize} (2..maxLattice)`)
  let look: GradeBoot['look'] = null
  if (config.look) {
    const amount = Number.isFinite(config.look.amount) ? Math.min(Math.max(config.look.amount, 0), 1) : 1
    look = { file: config.look.file, amount }
  }
  return { state, warnings, lutSize, maxLattice, bakeNow: enabled && !isGradeIdentity(state, null), look }
}

// ---- compile-in policy (plan 1.6) -------------------------------------------------------------

export interface CompileInputs {
  /** The Grade button (and `?grade=`). */
  enabled: boolean
  /** The Colour grade section is open … */
  sectionOpen: boolean
  /** … in an open Design panel (body.design-open). */
  panelOpen: boolean
  /** isGradeIdentity(state, look): the grade changes nothing. */
  identity: boolean
}

/** Editing: the section can be seen. While editing, the tap stays compiled in even at neutral,
 *  so the first slider move recompiles nothing. */
export const isEditing = (sectionOpen: boolean, panelOpen: boolean) => sectionOpen && panelOpen

/** compiledIn = enabled && (editing || !identity). */
export function shouldCompileIn(inputs: CompileInputs): boolean {
  return inputs.enabled && (isEditing(inputs.sectionOpen, inputs.panelOpen) || !inputs.identity)
}

export interface CompilePolicy {
  /** Decides and, only when the decision changes, calls setStage: a stage change rebuilds the
   *  post materials (9 node builds with DoF and EDL on, a 12–16 ms frame), so this runs on the
   *  events plan 1.6 lists — the Grade button, the section's toggle, a body class change, a commit
   *  — never on 'input' or pointermove. True when the stage changed. */
  evaluate(inputs: CompileInputs): boolean
  readonly compiled: boolean
  /** Stage changes so far. */
  readonly changes: number
}

export function createCompilePolicy(setStage: (on: boolean) => void, compiled = false): CompilePolicy {
  let on = compiled
  let changes = 0
  return {
    evaluate(inputs) {
      const next = shouldCompileIn(inputs)
      if (next === on) return false
      on = next
      changes++
      setStage(on)
      return true
    },
    get compiled() { return on },
    get changes() { return changes },
  }
}

// ---- looks ----------------------------------------------------------------------------------

/** How many parsed looks the editor (and so the worker) holds: a 65³ cube is 3 MB of floats. */
export const LOOKS_HELD = 4

/** The key of a look imported from a file this session: name, size and date, so importing the
 *  same file again finds it held, and an edited file is a new look. */
export const importLookKey = (name: string, bytes: number, lastModified: number) => `import:${name}:${bytes}:${lastModified}`

/** The key of a look under public/grades/: its path, so fetching it again gives the same key. */
export const fileLookKey = (file: string) => `grades/${file}`

/** The URL of a look under public/grades/, each path segment encoded. `base` is Vite's BASE_URL. */
export function lookUrl(base: string, file: string): string {
  return `${base.endsWith('/') ? base : `${base}/`}grades/${file.split('/').map(encodeURIComponent).join('/')}`
}

export interface LookStore<T> {
  /** Holds `value` under `key` as the newest use; then, while more than the limit are held, drops
   *  the oldest use that is neither `key` nor pinned. Returns the keys dropped. */
  add(key: string, value: T, pinned?: Iterable<string>): string[]
  /** The value, counted as a use. */
  get(key: string): T | undefined
  /** The value, not counted as a use. */
  peek(key: string): T | undefined
  has(key: string): boolean
  delete(key: string): boolean
  /** Oldest use first. */
  keys(): string[]
  readonly size: number
}

/** The looks the editor holds (with their text, for a re-parse after a worker failure): the most
 *  recently used `limit`, the current look and the snapshots' never dropped. */
export function createLookStore<T>(limit = LOOKS_HELD): LookStore<T> {
  const entries = new Map<string, T>()
  const touch = (key: string) => {
    const value = entries.get(key)
    if (value === undefined) return undefined
    entries.delete(key)
    entries.set(key, value)
    return value
  }
  return {
    add(key, value, pinned = []) {
      entries.delete(key)
      entries.set(key, value)
      const keep = new Set(pinned)
      keep.add(key)
      const dropped: string[] = []
      for (const candidate of [...entries.keys()]) {
        if (entries.size <= limit) break
        if (keep.has(candidate)) continue
        entries.delete(candidate)
        dropped.push(candidate)
      }
      return dropped
    },
    get: touch,
    peek: (key) => entries.get(key),
    has: (key) => entries.has(key),
    delete: (key) => entries.delete(key),
    keys: () => [...entries.keys()],
    get size() { return entries.size },
  }
}

// ---- paste ----------------------------------------------------------------------------------

/** A look the editor holds, as a paste can name it. */
export interface HeldLook {
  key: string
  name: string
  /** Its file under public/grades/, or null for one imported this session. */
  file: string | null
}

export type LookPlan =
  | { action: 'keep' }
  | { action: 'clear' }
  | { action: 'use'; key: string; amount: number }
  | { action: 'fetch'; file: string; amount: number }

export interface PastePlan {
  state: GradeState
  enabled?: boolean
  lutSize?: number
  look: LookPlan
  /** What the status line adds to pasteSummary's text. */
  notes: string[]
}

/**
 * What applying a pasted grade does (plan 4.11 Paste values): the state as read; enabled and
 * lutSize when the paste had them (lutSize capped at maxLattice); and the look — kept when the
 * paste has no look key, cleared for `look: null`, the held look whose file it names (a look
 * imported this session counts under the name Copy values gave it, lookFileName), or else
 * fetched from public/grades/.
 */
export function planPaste(grade: PastedGrade, held: readonly HeldLook[], maxLattice: number): PastePlan {
  const notes: string[] = []
  const plan: PastePlan = { state: structuredClone(grade.state), look: { action: 'keep' }, notes }
  if (grade.enabled !== undefined) plan.enabled = grade.enabled
  if (grade.lutSize !== undefined) {
    plan.lutSize = Math.min(grade.lutSize, maxLattice)
    if (plan.lutSize !== grade.lutSize) notes.push(`lutSize ${grade.lutSize} is above maxLattice, ${maxLattice} used.`)
  }
  if (grade.look === null) plan.look = { action: 'clear' }
  else if (grade.look !== undefined) {
    const { file, amount } = grade.look
    const match = held.find((look) => look.file === file) ?? held.find((look) => look.file === null && lookFileName(look.name) === file)
    if (match) plan.look = { action: 'use', key: match.key, amount }
    else {
      plan.look = { action: 'fetch', file, amount }
      notes.push(`Loading the look grades/${file}.`)
    }
  }
  return plan
}

// ---- status lines ---------------------------------------------------------------------------

export interface GradeStatus {
  enabled: boolean
  compiled: boolean
  editing: boolean
  identity: boolean
  /** The lattice the tap reads now, and the one being baked for. */
  n: number
  target: number
  lastFinalMs: number | null
  lastDraftMs: number | null
  mode: 'worker' | 'main thread'
  busy: boolean
}

const ms = (value: number) => `${value < 10 ? value.toFixed(1) : Math.round(value)} ms`

/** #gradeStatus: whether the tap is compiled in and why not, the lattice, the last bake. */
export function gradeStatusText(status: GradeStatus): string {
  const parts: string[] = []
  if (!status.enabled) parts.push('Off · compiled out')
  else if (status.compiled) parts.push(status.identity ? 'Compiled in (neutral while editing)' : 'Compiled in')
  else parts.push('Neutral · compiled out')
  parts.push(status.target === status.n ? `${status.n}³ lattice` : `${status.n}³ → ${status.target}³ lattice`)
  if (status.lastFinalMs !== null) parts.push(`bake ${ms(status.lastFinalMs)} (${status.mode})`)
  else parts.push(`bakes on the ${status.mode}`)
  if (status.lastDraftMs !== null) parts.push(`drafts ${ms(status.lastDraftMs)}`)
  if (status.busy) parts.push('baking…')
  return parts.join(' · ')
}

/**
 * #gradeLookStatus. `note` (loading, an error) wins. Otherwise the look's name and size, the
 * lattice it is baked on and whether that is 1:1, an identity cube, parser notes, and where to
 * save a look imported this session.
 */
export function lookStatusText(look: LookRef | null, meta: LookMeta | null, lattice: LatticeSize | null, note?: string): string {
  if (note) return note
  if (!look) return 'No look. Import a 3D .cube to grade through it; the other tabs act on top of it.'
  const name = meta?.title || look.name
  if (!meta || !lattice) {
    return `${name}: not held any more (only the last ${LOOKS_HELD} looks are). Import it again, or ✕ Remove.`
  }
  const parts = [`${name} · ${meta.size}³`]
  parts.push(lattice.exact ? `baked on ${lattice.n}³, 1:1` : lattice.warning ?? `resampled onto ${lattice.n}³, not 1:1`)
  if (meta.isIdentity) parts.push('an identity cube, changes nothing')
  if (meta.warnings.length > 0) parts.push(`${meta.warnings.length === 1 ? '1 parser note' : `${meta.warnings.length} parser notes`}: ${meta.warnings.join('; ')}`)
  if (!look.file) parts.push(`this session only: save it as public/grades/${lookFileName(look.name)} to keep it`)
  return parts.join(' · ')
}

// ---- measurements ---------------------------------------------------------------------------

/** Samples kept per measurement for stats(). */
export const STATS_SAMPLES = 200

export function pushSample(samples: number[], value: number, limit = STATS_SAMPLES): void {
  if (!Number.isFinite(value)) return
  samples.push(value)
  if (samples.length > limit) samples.splice(0, samples.length - limit)
}

/** Median and 95th percentile (nearest rank) of the samples, null without any. */
export function summarize(samples: readonly number[]): { count: number; median: number | null; p95: number | null } {
  if (samples.length === 0) return { count: 0, median: null, p95: null }
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]
  const mid = sorted.length >> 1
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  return { count: sorted.length, median, p95: rank(0.95) }
}

// ---- the before/after split (plan 5.6) ------------------------------------------------------

export const SPLIT_STEP = 0.02
export const SPLIT_STEP_SHIFT = 0.1

/** The split from a pointer: #view covers the window, so clientX / innerWidth, clamped. */
export function splitFromPointer(clientX: number, width: number): number {
  if (!(width > 0) || !Number.isFinite(clientX)) return 0.5
  return Math.min(Math.max(clientX / width, 0), 1)
}

/** ArrowLeft / ArrowRight on the handle: 2 % a press, 10 % with Shift; null for other keys. */
export function nudgeSplit(x: number, key: string, shift: boolean): number | null {
  const step = shift ? SPLIT_STEP_SHIFT : SPLIT_STEP
  const next = key === 'ArrowLeft' ? x - step : key === 'ArrowRight' ? x + step : null
  return next === null ? null : Math.min(Math.max(Math.round(next * 1e6) / 1e6, 0), 1)
}

// ---- keys (plan 5.2, 5.8) -------------------------------------------------------------------

export interface KeyLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/** Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y redo — inside the section and not in a
 *  textarea, which keeps its own text undo. Nothing else in the app binds Z. */
export function undoKeyAction(event: KeyLike, inTextArea: boolean): 'undo' | 'redo' | null {
  if (inTextArea || event.altKey || !(event.ctrlKey || event.metaKey)) return null
  const key = event.key.toLowerCase()
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo'
  if (key === 'y' && !event.shiftKey) return 'redo'
  return null
}

/** Keys the section keeps from the app's own handlers (keyboard navigation on window, main.ts on
 *  document, both bubbling): all but Tab, so W, A, S, D, Space, C and Enter never move the camera
 *  while a grade control has focus. */
export const isolatesKey = (key: string) => key !== 'Tab'

// ---- controls -------------------------------------------------------------------------------

export type GradeTab = 'primary' | 'curves' | 'hue' | 'tones' | 'look'
export const GRADE_TABS: readonly GradeTab[] = Object.freeze(['primary', 'curves', 'hue', 'tones', 'look'] as const)

/** Every element grade-editor.ts looks up, by role. The test checks threejs-test.html has them. */
export const GRADE_ELEMENT_IDS = Object.freeze({
  section: 'gradeSection',
  toggle: 'gradeToggle',
  compare: 'gradeCompare',
  snapA: 'gradeSnapA',
  snapB: 'gradeSnapB',
  store: 'gradeStore',
  undo: 'gradeUndo',
  redo: 'gradeRedo',
  reset: 'gradeReset',
  tabs: 'gradeTabs',
  primary: 'gradePrimary',
  curves: 'gradeCurves',
  hue: 'gradeHue',
  tones: 'gradeTones',
  look: 'gradeLook',
  wheelMinis: 'gradeWheelMinis',
  wheel: 'gradeWheel',
  wheelReadout: 'gradeWheelReadout',
  curveChannel: 'gradeCurveChannel',
  curve: 'gradeCurve',
  curveReadout: 'gradeCurveReadout',
  curvePointRemove: 'gradeCurvePointRemove',
  curveReset: 'gradeCurveReset',
  hueMode: 'gradeHueMode',
  hueCurve: 'gradeHueCurve',
  hueReadout: 'gradeHueReadout',
  huePointRemove: 'gradeHuePointRemove',
  hueReset: 'gradeHueReset',
  shadowWheel: 'gradeShadowWheel',
  shadowReadout: 'gradeShadowReadout',
  highlightWheel: 'gradeHighlightWheel',
  highlightReadout: 'gradeHighlightReadout',
  pivotTrack: 'gradePivotTrack',
  importButton: 'gradeImport',
  file: 'gradeFile',
  lookStatus: 'gradeLookStatus',
  lookRemove: 'gradeLookRemove',
  exportButton: 'gradeExport',
  frame: 'gradeFrame',
  status: 'gradeStatus',
  split: 'gradeSplit',
  splitHandle: 'gradeSplitHandle',
} as const)

/** Which group each tab shows. */
export const GRADE_TAB_GROUPS: Readonly<Record<GradeTab, string>> = Object.freeze({
  primary: GRADE_ELEMENT_IDS.primary,
  curves: GRADE_ELEMENT_IDS.curves,
  hue: GRADE_ELEMENT_IDS.hue,
  tones: GRADE_ELEMENT_IDS.tones,
  look: GRADE_ELEMENT_IDS.look,
})

const MINUS = '−'

/** A signed readout: +0.012, −0.004, and 0.000 for zero (never −0). */
export function signed(value: number, digits: number): string {
  const text = Math.abs(value).toFixed(digits)
  if (Number(text) === 0) return text
  return `${value < 0 ? MINUS : '+'}${text}`
}
const percent = (value: number) => `${Math.round(value * 100)}%`
const factor = (value: number) => `${value.toFixed(2)}×`

/** A range in the section: its input id (the readout is `${id}Val`), the state field it edits
 *  (a path into GradeState, also into GRADE_RANGES) and how its value reads. */
export interface GradeSliderSpec {
  readonly id: string
  readonly path: readonly [string] | readonly [string, string]
  readonly tab: 'primary' | 'tones'
  readonly format: (value: number) => string
}

/**
 * The section's ranges, in panel order. In Primary: the four wheels' master values (one shows,
 * under the large wheel, for the wheel picked: WHEEL_MASTER_SLIDERS; the pucks are moved by the
 * wheels, grade-widgets.ts), white balance, contrast and its pivot, saturation and vibrance. In
 * Tones: the split toning's balance and blending, and the roll-off.
 */
export const GRADE_SLIDERS: readonly GradeSliderSpec[] = Object.freeze([
  { id: 'gradeLiftY', path: ['lift', 'y'], tab: 'primary', format: (v) => signed(v, 3) },
  { id: 'gradeGammaY', path: ['gamma', 'y'], tab: 'primary', format: (v) => `${signed(v, 2)} · γ ${(2 ** v).toFixed(2)}` },
  { id: 'gradeGainY', path: ['gain', 'y'], tab: 'primary', format: factor },
  { id: 'gradeOffsetY', path: ['offset', 'y'], tab: 'primary', format: (v) => signed(v, 3) },
  { id: 'gradeTemperature', path: ['temperature'], tab: 'primary', format: (v) => signed(v, 0) },
  { id: 'gradeTint', path: ['tint'], tab: 'primary', format: (v) => signed(v, 0) },
  { id: 'gradeContrast', path: ['contrast'], tab: 'primary', format: factor },
  { id: 'gradePivot', path: ['pivot'], tab: 'primary', format: (v) => `sRGB ${Math.round(v * 255)}` },
  { id: 'gradeSaturation', path: ['saturation'], tab: 'primary', format: percent },
  { id: 'gradeVibrance', path: ['vibrance'], tab: 'primary', format: (v) => signed(v, 2) },
  { id: 'gradeBalance', path: ['tones', 'balance'], tab: 'tones', format: (v) => signed(v, 2) },
  { id: 'gradeBlending', path: ['tones', 'blending'], tab: 'tones', format: percent },
  { id: 'gradeRollOff', path: ['rollOff'], tab: 'tones', format: percent },
] as GradeSliderSpec[])

/** The look's amount, beside the state rather than in it. */
export const LOOK_AMOUNT_SLIDER = Object.freeze({ id: 'gradeLookAmount', range: GRADE_RANGES.look.amount, format: percent })

/** A slider's limits and default from GRADE_RANGES. */
export function sliderRange(spec: Pick<GradeSliderSpec, 'path'>): GradeRange {
  let node: any = GRADE_RANGES
  for (const key of spec.path) node = node?.[key]
  if (!node || typeof node.min !== 'number') throw new RangeError(`no grade range at ${spec.path.join('.')}`)
  return node as GradeRange
}

export function readPath(state: GradeState, path: GradeSliderSpec['path']): number {
  const record = state as unknown as Record<string, any>
  return path.length === 1 ? record[path[0]] : record[path[0]][path[1]]
}

/** Writes a slider's value into the state, clamped to its range (a range input already is). */
export function writePath(state: GradeState, path: GradeSliderSpec['path'], value: number): void {
  const { min, max } = sliderRange({ path })
  const v = Math.min(Math.max(Number.isFinite(value) ? value : min, min), max) + 0
  const record = state as unknown as Record<string, any>
  if (path.length === 1) record[path[0]] = v
  else record[path[0]][path[1]] = v
}

/** Each primary wheel's master range: the one under the large wheel while that wheel is picked. */
export const WHEEL_MASTER_SLIDERS: Readonly<Record<WheelName, string>> = Object.freeze({
  lift: 'gradeLiftY',
  gamma: 'gradeGammaY',
  gain: 'gradeGainY',
  offset: 'gradeOffsetY',
})

const WHEEL_TITLES: Readonly<Record<WheelName, string>> = Object.freeze({ lift: 'Lift', gamma: 'Gamma', gain: 'Gain', offset: 'Offset' })
const CHANNEL_TITLES = Object.freeze({ master: 'RGB', red: 'red', green: 'green', blue: 'blue' })

/** ARIA labels of the widget canvases: what they edit and how, for a screen reader. */
export const wheelLabel = (name: WheelName) =>
  `${WHEEL_TITLES[name]} colour wheel: drag to tint, Shift for fine moves; arrows nudge, 0 or a double tap resets`
export const toneWheelLabel = (which: 'shadows' | 'highlights') =>
  `${which === 'shadows' ? 'Shadow' : 'Highlight'} tint wheel: drag to tint, Shift for fine moves; arrows nudge, 0 or a double tap resets`
export const curveLabel = (channel: keyof typeof CHANNEL_TITLES) =>
  `${CHANNEL_TITLES[channel]} curve: tap to add a point, drag to move it, double tap or drag it off to remove; arrows nudge the selected point, [ and ] pick another, Delete removes it`
export const hueCurveLabel = (mode: 'sat' | 'luma') =>
  `Hue vs ${mode === 'sat' ? 'saturation' : 'luma'} curve: tap to add a point, drag to move it, double tap or drag it off to remove; arrows nudge the selected point, [ and ] pick another, Delete removes it`

/** A switch's text in the panel's own pattern: "◐ Grade · On". */
export const toggleText = (label: string, on: boolean) => `${label} · ${on ? 'On' : 'Off'}`
