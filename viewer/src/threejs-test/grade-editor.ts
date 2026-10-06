// The Design panel's Colour grade section (goal 4, plan 4.9): owns the grade the LUT tap in the
// final quad shows (grade-output.ts) — the state and the look, the undo history and the A/B
// snapshots, the bake (a module worker, grade-bake.worker.ts, or the same code on the main
// thread when no worker comes up), the texel buffers, when the tap is compiled in, .cube import
// and export, Frame for grading, the before/after split, the section's sliders and its wheels and
// curve editors (grade-widgets.ts).
//
// The decisions live in grade-editor-logic.ts, where node tests reach them; this file wires them
// to the DOM. The panel's own binders (bindDesignSlider, bindSeg, bindEffectToggle in main.ts)
// are not used: the UI renders from the state here, because undo, snapshots and pastes change
// many controls at once.
//
// Per frame, update() (main.ts, right before depthOfField.render()) disposes replaced textures,
// runs at most one main-thread bake, and uploads the newest bake result — at most one upload a
// frame. A slider's 'input', a widget's drag or arrow key patches the state and asks for a bake
// (a draft while finals are slow); a slider's 'change', a widget's pointerup or the pause after
// its arrow keys is a commit: an undo step, a final bake, and the compile-in decision.
import { GRADE_CUBE_TITLE, gradeCubeFileName } from './cube-format.ts'
import {
  createGradeBakeHost, type CubeMessage, type GradeBakeHost, type HostReply, type HostRequest, type LookMeta,
  type ParseErrorMessage, type ParsedMessage,
} from './grade-bake-host.ts'
import {
  bakeGradeTexels, createBakeScheduler, createBufferPool, latticeSizeFor,
  type BakeJob, type BakeMessage, type BakeResult, type BufferPool, type LatticeSize,
} from './grade-bake.ts'
import {
  createCompilePolicy, createLookStore, curveLabel, fileLookKey, GRADE_ELEMENT_IDS, GRADE_SLIDERS, GRADE_TAB_GROUPS,
  GRADE_TABS, gradeBoot, gradeStatusText, hueCurveLabel, importLookKey, isEditing, isolatesKey, LOOK_AMOUNT_SLIDER,
  lookStatusText, lookUrl, nudgeSplit, pasteLoadingNote, pasteLookNote, planPaste, pushSample, readPath, sliderRange,
  splitFromPointer, splitLimit, splitValueText, summarize, toggleText, toneWheelLabel, undoKeyAction,
  WHEEL_MASTER_SLIDERS, wheelLabel, writePath, type GradeConfig, type GradeTab, type PasteLookOutcome,
} from './grade-editor-logic.ts'
import {
  CURVE_CHANNELS, GRADE_RANGES, isGradeIdentity, parseGradeState, WHEEL_NAMES,
  type CurveChannel, type GradeState, type LookRef, type WheelName,
} from './grade-model.ts'
import type { GradeOutput } from './grade-output.ts'
import {
  createHistory, createSnapshots, gradeSnippet, sameData, type GradePaste, type GradeSnapshot, type SnapshotSlot,
} from './grade-state.ts'
import { createKeyIsolation, HUE_MODES, puckReadout, wheelReadout, type HueMode } from './grade-widget-logic.ts'
import { createColourWheel, createCurveEditor, createHueCurveEditor, type GradeWidget } from './grade-widgets.ts'

export interface GradeEditorOptions {
  /** #gradeSection, the section's <details>. */
  root: HTMLDetailsElement
  output: GradeOutput
  /** Puts the tap into the final quad (true) or takes it out (false); each change rebuilds the
   *  post materials, so the editor calls it only when its compile-in decision changes. */
  setStage(on: boolean): void
  /** Renders the frame again and returns the canvas, for Frame for grading. Outside the loop
   *  only the final quad re-runs (nodeFrame does not advance), so it is the last frame. */
  captureCanvas(): HTMLCanvasElement
  /** config grade. */
  initial: GradeConfig
  /** The Grade switch at boot: `?grade=0|1` over config grade.enabled. */
  enabled: boolean
  /** Vite's BASE_URL; looks under public/grades/ are fetched from there. */
  baseUrl: string
}

export interface GradeEditorStats {
  enabled: boolean
  compiled: boolean
  /** Stage changes (compile in or out) since boot. */
  stageChanges: number
  identity: boolean
  /** The lattice the tap reads, and the one the current grade bakes on. */
  n: number
  target: number
  exact: boolean
  mode: 'worker' | 'main thread'
  busy: boolean
  /** Bake times (ms, the worker's own clock or the main thread's), the upload's main-thread
   *  part, and the time from an edit to the frame that shows it. Median and p95 of the last 200. */
  bakeFinalMs: ReturnType<typeof summarize>
  bakeDraftMs: ReturnType<typeof summarize>
  uploadMs: ReturnType<typeof summarize>
  editToFrameMs: ReturnType<typeof summarize>
  pooledBuffers: number
  looksHeld: string[]
  canUndo: boolean
  canRedo: boolean
  compare: boolean
  split: number
}

export interface GradeEditor {
  /** Once per frame, right before the render. */
  update(): void
  /** Copies. */
  state(): GradeState
  look(): LookRef | null
  isEnabled(): boolean
  isCompiled(): boolean
  /** The `grade:` block for Copy values (grade-state.ts gradeSnippet). */
  snippet(): string
  /** Applies a parsed Paste values text as one undo step — the state, the switch, the lattice
   *  size and the look. Returns notes for the status line beside pasteSummary's (a capped lattice
   *  size, a look being fetched). A paste whose look has to be fetched is recorded when the fetch
   *  ends; `onLook` then gets the notes again, the fetch's outcome in place of its loading note. */
  applyPaste(paste: GradePaste, onLook?: (notes: string[]) => void): string[]
  stats(): GradeEditorStats
  dispose(): void
}

/** A look the editor holds: its text (to parse again if the worker goes), what the parse said,
 *  and the name and file it came from. */
interface HeldLook {
  text: string
  meta: LookMeta
  name: string
  file: string | null
}

/** A grade's switch before and after a paste that changed it. */
interface Switch {
  from: boolean
  to: boolean
}

/** An undo step or a snapshot: the state and the look, and the lattice size (only a paste
 *  changes it). The undo step of a paste that switched the grade on or off holds the switch too:
 *  the Grade button is no undo step, so only the undo and redo of such a paste set it. */
interface GradeEntry extends GradeSnapshot {
  lutSize: number
  enabled?: Switch
}

const FLASH_MS = 1600
const NOTE_MS = 8000
/** A 65³ bake with a look takes 36–56 ms on a desktop, so a phone's stays far below this; a
 *  large .cube parsed ahead of it in the worker's queue too. */
const WORKER_SILENCE_MS = 6000

const lookLoadingNote = (file: string) => `Loading grades/${file} …`

export function createGradeEditor(options: GradeEditorOptions): GradeEditor {
  const { root, output, initial } = options
  const doc = root.ownerDocument
  const body = doc.body
  const byId = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const element = doc.getElementById(id)
    if (!element) throw new Error(`grade editor: #${id} is missing from the markup`)
    return element as T
  }
  const ids = GRADE_ELEMENT_IDS
  const el = {
    toggle: byId<HTMLButtonElement>(ids.toggle),
    compare: byId<HTMLButtonElement>(ids.compare),
    snapA: byId<HTMLButtonElement>(ids.snapA),
    snapB: byId<HTMLButtonElement>(ids.snapB),
    store: byId<HTMLButtonElement>(ids.store),
    undo: byId<HTMLButtonElement>(ids.undo),
    redo: byId<HTMLButtonElement>(ids.redo),
    reset: byId<HTMLButtonElement>(ids.reset),
    tabs: byId(ids.tabs),
    wheelMinis: byId(ids.wheelMinis),
    wheel: byId<HTMLCanvasElement>(ids.wheel),
    wheelReadout: byId(ids.wheelReadout),
    curveChannel: byId(ids.curveChannel),
    curve: byId<HTMLCanvasElement>(ids.curve),
    curveReadout: byId(ids.curveReadout),
    curvePointRemove: byId<HTMLButtonElement>(ids.curvePointRemove),
    curveReset: byId<HTMLButtonElement>(ids.curveReset),
    hueMode: byId(ids.hueMode),
    hueCurve: byId<HTMLCanvasElement>(ids.hueCurve),
    hueReadout: byId(ids.hueReadout),
    huePointRemove: byId<HTMLButtonElement>(ids.huePointRemove),
    hueReset: byId<HTMLButtonElement>(ids.hueReset),
    shadowWheel: byId<HTMLCanvasElement>(ids.shadowWheel),
    shadowReadout: byId(ids.shadowReadout),
    highlightWheel: byId<HTMLCanvasElement>(ids.highlightWheel),
    highlightReadout: byId(ids.highlightReadout),
    pivotTrack: byId(ids.pivotTrack),
    importButton: byId<HTMLButtonElement>(ids.importButton),
    file: byId<HTMLInputElement>(ids.file),
    lookStatus: byId(ids.lookStatus),
    lookRemove: byId<HTMLButtonElement>(ids.lookRemove),
    exportButton: byId<HTMLButtonElement>(ids.exportButton),
    frame: byId<HTMLButtonElement>(ids.frame),
    status: byId(ids.status),
    split: byId(ids.split),
    splitHandle: byId<HTMLButtonElement>(ids.splitHandle),
  }
  const groups = Object.fromEntries(GRADE_TABS.map((tab) => [tab, byId(GRADE_TAB_GROUPS[tab])])) as Record<GradeTab, HTMLElement>

  const cleanups: (() => void)[] = []
  const listen = (target: EventTarget, type: string, handler: (event: any) => void, opts?: AddEventListenerOptions | boolean) => {
    target.addEventListener(type, handler, opts)
    cleanups.push(() => target.removeEventListener(type, handler, opts))
  }

  // ---- state
  const boot = gradeBoot(initial, options.enabled)
  if (boot.warnings.length > 0) console.warn('[grade] config grade:', boot.warnings.join('; '))
  const tuning = { ...initial.tuning }
  const maxLattice = boot.maxLattice
  let lutSize = boot.lutSize
  let state: GradeState = boot.state
  let look: LookRef | null = null
  let enabled = options.enabled
  let compareOn = false
  /** Where Compare starts (plan 5.2: config compareSplit). */
  const compareStart = Math.min(Math.max(Number.isFinite(initial.compareSplit) ? initial.compareSplit : 0.5, 0), 1)
  let compareAt = compareStart
  /** A loading or error line for the Look tab, over the look's own status. */
  let lookNote: string | undefined
  let bakeError: string | null = null
  let disposed = false

  const looks = createLookStore<HeldLook>()
  let history = createHistory<GradeEntry>(100)
  const snapshots = createSnapshots<GradeEntry>()
  const current = (): GradeEntry => ({ state, look, lutSize })
  /** Every action that sets the look — a paste, an import, Remove, undo, redo, a snapshot recall,
   *  the boot look — takes the next number. A look file that lands after a newer one was taken
   *  is only held (an undo or redo may name it later); it is neither made current nor recorded. */
  let lookTicket = 0
  /** A paste's switch of the grade, for the undo step that records the paste. */
  let switched: Switch | null = null

  const metaOf = (ref: LookRef | null): LookMeta | null => (ref ? looks.peek(ref.key)?.meta ?? null : null)
  const latticeOf = (ref: LookRef | null): LatticeSize => {
    const meta = metaOf(ref)
    return meta ? latticeSizeFor(meta.size, lutSize, maxLattice, meta.unitDomain) : latticeSizeFor(null, lutSize, maxLattice)
  }
  /** A look counts once it is held: until then (loading, or dropped) the grade bakes without it. */
  const identity = () => {
    const meta = metaOf(look)
    return isGradeIdentity(state, look && meta ? { amount: look.amount, isIdentity: meta.isIdentity } : null)
  }
  const pinnedKeys = () => {
    const keys: string[] = []
    if (look) keys.push(look.key)
    for (const slot of ['A', 'B'] as const) {
      const held = snapshots.recall(slot)
      if (held?.look) keys.push(held.look.key)
    }
    return keys
  }

  // ---- the bake: a worker, or the same host on the main thread
  let worker: Worker | null = null
  let host: GradeBakeHost | null = null
  /** Main-thread mode: the bake job waiting for update(). */
  let syncJob: BakeMessage | null = null
  /** Parses and exports waiting for their reply, with when they were sent (the watchdog in
   *  update()). */
  const parsing = new Map<string, { text: string; sentAt: number; settle: ((reply: ParsedMessage | ParseErrorMessage) => void)[] }>()
  const exporting = new Map<number, { sentAt: number; resolve: (reply: CubeMessage) => void; reject: (error: Error) => void }>()
  let exportId = 0

  const useHost = () => {
    host = createGradeBakeHost({ tuning })
  }
  const wantsWorker = initial.worker && typeof Worker !== 'undefined'
  /** The baker starts with the first bake or parse, so a viewer who never grades loads no
   *  worker at all. */
  let bakerStarted = false
  const bakeMode = (): 'worker' | 'main thread' => (worker || (!bakerStarted && wantsWorker) ? 'worker' : 'main thread')

  function send(message: HostRequest, transfer: ArrayBuffer[] = []): void {
    if (!bakerStarted) {
      bakerStarted = true
      if (!startWorker()) useHost()
    }
    if (worker) {
      worker.postMessage(message, { transfer })
      return
    }
    if (!host) useHost()
    if (message.kind === 'bake') {
      // At most one main-thread bake a frame, in update(), before the render.
      syncJob = message
      return
    }
    const result = host!.handle(message)
    if (result) queueMicrotask(() => receive(result.reply))
  }

  function startWorker(): boolean {
    if (!wantsWorker) return false
    try {
      worker = new Worker(new URL('./grade-bake.worker.ts', import.meta.url), { type: 'module' })
    } catch (error) {
      console.warn('[grade] the bake worker did not start; baking on the main thread.', error)
      worker = null
      return false
    }
    worker.onmessage = (event: MessageEvent<HostReply>) => receive(event.data)
    worker.onerror = (event) => {
      event.preventDefault()
      fallBack(`bake worker error${event.message ? `: ${event.message}` : ''}`)
    }
    worker.onmessageerror = () => fallBack('a bake worker message could not be read')
    worker.postMessage({ kind: 'init', tuning } satisfies HostRequest)
    return true
  }

  /** The worker failed: bake here from now on. The looks it held go with it, so they are parsed
   *  again from the texts the store keeps; the bake in flight is lost and asked for again. */
  function fallBack(reason: string): void {
    if (!worker) return
    console.warn(`[grade] ${reason}; baking on the main thread from now on.`)
    worker.onmessage = null
    worker.onerror = null
    worker.terminate()
    worker = null
    useHost()
    for (const key of looks.keys()) host!.handle({ kind: 'parse', key, text: looks.peek(key)!.text })
    for (const [key, entry] of parsing) {
      const result = host!.handle({ kind: 'parse', key, text: entry.text })
      if (result) queueMicrotask(() => receive(result.reply))
    }
    for (const [id, pending] of exporting) {
      exporting.delete(id)
      pending.reject(new Error('the bake worker stopped; export again'))
    }
    scheduler.reset()
    requestBake(true)
    renderStatus()
  }

  // ---- texel buffers and the scheduler
  let pool: BufferPool = createBufferPool(output.size)
  const poolFor = (n: number) => {
    if (pool.n !== n) {
      pool.clear()
      pool = createBufferPool(n)
    }
    return pool
  }
  const give = (buffer: ArrayBufferLike) => { pool.give(buffer) }

  /** When the edit behind the next posted bake happened, for edit-to-frame latency. */
  let editAt: number | null = null
  const editAtBySeq = new Map<number, number>()
  /** When the bake in flight was posted (the watchdog in update()). */
  let postedAt = 0

  /** When the oldest request still waiting for the worker's answer was sent — a bake, a parse or
   *  an export — or null. A worker that leaves one unanswered for WORKER_SILENCE_MS (a module it
   *  could not load, a browser that never runs it) is given up on. */
  function oldestRequest(): number | null {
    let oldest = scheduler.busy ? postedAt : Infinity
    for (const entry of parsing.values()) oldest = Math.min(oldest, entry.sentAt)
    for (const entry of exporting.values()) oldest = Math.min(oldest, entry.sentAt)
    return Number.isFinite(oldest) ? oldest : null
  }
  const scheduler = createBakeScheduler({
    post(message) {
      postedAt = performance.now()
      editAtBySeq.set(message.seq, editAt ?? postedAt)
      editAt = null
      send(message, [message.out])
    },
    draftThresholdMs: initial.draftWhenFinalOverMs,
    take: (n) => poolFor(n).take(),
    give,
  })

  /** The newest result, uploaded by the next update(). */
  let pending: BakeResult | null = null
  const finalMs: number[] = []
  const draftMs: number[] = []
  const uploadMs: number[] = []
  const latencyMs: number[] = []
  let lastFinalMs: number | null = null
  let lastDraftMs: number | null = null

  function job(): BakeJob {
    const lattice = latticeOf(look)
    const held = look !== null && looks.has(look.key)
    return {
      // A copy: main-thread jobs wait for update(), and the state keeps changing meanwhile.
      state: structuredClone(state),
      look: held ? { key: look!.key, amount: look!.amount } : null,
      n: lattice.n,
      // Only an exact look has nodes a draft must land on (1: its own lattice, no draft);
      // without one the lattice alone decides (draftStride).
      refinement: held && lattice.exact ? lattice.refinement : undefined,
    }
  }

  function requestBake(commit: boolean): void {
    if (disposed) return
    if (scheduler.request(job(), { commit }) === 'skipped') editAt = null
  }

  function receive(reply: HostReply): void {
    if (disposed) return
    switch (reply.kind) {
      case 'baked': {
        const result = scheduler.onResult(reply)
        if (!result) return
        // A result superseded before it reached the texture goes back to the pool.
        if (pending) give(pending.texels.buffer)
        pending = result
        bakeError = null
        if (result.final) {
          pushSample(finalMs, result.ms)
          lastFinalMs = result.ms
        } else {
          pushSample(draftMs, result.ms)
          lastDraftMs = result.ms
        }
        break
      }
      case 'bake-failed': {
        scheduler.reset()
        give(reply.out)
        const held = reply.missingLook ? looks.peek(reply.missingLook) : undefined
        if (held && reply.missingLook) {
          // The baker lost the look (a restart): hand it the text again, then bake.
          parseText(reply.missingLook, held.text).then(() => requestBake(true), (error) => {
            bakeError = String(error?.message ?? error)
            renderStatus()
          })
          return
        }
        bakeError = reply.message
        console.warn('[grade] bake failed:', reply.message)
        break
      }
      case 'parsed':
      case 'error': {
        const entry = parsing.get(reply.key)
        parsing.delete(reply.key)
        for (const settle of entry?.settle ?? []) settle(reply)
        return
      }
      case 'cube':
      case 'export-error': {
        const waiter = exporting.get(reply.id)
        exporting.delete(reply.id)
        if (!waiter) return
        if (reply.kind === 'cube') waiter.resolve(reply)
        else waiter.reject(new Error(reply.message))
        return
      }
    }
    renderStatus()
  }

  // ---- looks
  function parseText(key: string, text: string): Promise<LookMeta> {
    return new Promise((resolve, reject) => {
      let entry = parsing.get(key)
      const first = !entry
      if (!entry) {
        entry = { text, sentAt: performance.now(), settle: [] }
        parsing.set(key, entry)
      }
      entry.settle.push((reply) => {
        if (reply.kind === 'parsed') resolve(reply.meta)
        else reject(new Error(reply.message))
      })
      if (first) send({ kind: 'parse', key, text })
    })
  }

  /** Parses a look (once per key) and holds it; looks the store lets go are dropped from the
   *  baker too. */
  async function holdLook(key: string, text: string, name: string, file: string | null): Promise<LookMeta> {
    const held = looks.get(key)
    if (held) return held.meta
    const meta = await parseText(key, text)
    for (const dropped of looks.add(key, { text, meta, name, file }, pinnedKeys())) send({ kind: 'drop', key: dropped })
    return meta
  }

  async function importFile(file: File): Promise<void> {
    flushWidgets()
    settlePaste()
    const ticket = ++lookTicket
    const key = importLookKey(file.name, file.size, file.lastModified)
    const reading = `Reading ${file.name} …`
    lookNote = reading
    renderLook()
    try {
      const meta = looks.has(key) ? looks.get(key)!.meta : await holdLook(key, await file.text(), file.name, null)
      if (disposed) return
      if (lookNote === reading) lookNote = undefined
      if (ticket !== lookTicket) {
        renderLook()
        return
      }
      flushWidgets()
      look = { key, name: file.name, file: null, size: meta.size, amount: GRADE_RANGES.look.amount.default }
      commit()
      syncControls()
    } catch (error) {
      if (disposed) return
      if (ticket === lookTicket) lookNote = `${file.name} was not loaded: ${String((error as Error)?.message ?? error)}`
      else if (lookNote === reading) lookNote = undefined
      renderLook()
    }
  }

  /**
   * A look under public/grades/: at boot (config grade.look), from a paste, or again after the
   * store let it go. Fetching it again gives the same key, so a history entry that names it finds
   * it. 'reload' bakes and changes nothing else; 'boot' becomes the history's starting point
   * while nothing has been edited yet; 'paste' records the paste waiting for it (pendingPaste).
   * `ticket` is the lookTicket of the action that asked: when a newer one was taken before the
   * file lands, the look is only held.
   */
  async function loadLookFile(file: string, amount: number, mode: 'boot' | 'paste' | 'reload', ticket: number): Promise<void> {
    const key = fileLookKey(file)
    const name = file.split('/').pop() || file
    const loading = lookLoadingNote(file)
    lookNote = loading
    renderLook()
    try {
      let meta = looks.peek(key)?.meta
      if (!meta) {
        const response = await fetch(lookUrl(options.baseUrl, file))
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim())
        meta = await holdLook(key, await response.text(), name, file)
      }
      if (disposed) return
      if (lookNote === loading) lookNote = undefined
      if (mode === 'reload') {
        requestBake(true)
        evaluate()
        renderAll()
        return
      }
      if (ticket !== lookTicket) {
        renderLook()
        return
      }
      look = { key, name, file, size: meta.size, amount }
      if (mode === 'boot' && !history.canUndo() && !history.canRedo()) {
        history = createHistory<GradeEntry>(100)
        history.push(current())
        requestBake(true)
        evaluate()
      } else {
        // A paste waiting for this look is recorded now, as one undo step with it.
        if (mode === 'paste') endPaste(ticket, 'loaded')
        commit()
      }
      syncControls()
    } catch (error) {
      if (disposed) return
      const message = String((error as Error)?.message ?? error)
      if (mode !== 'reload') console.warn(`[grade] the ${mode} look grades/${file} was not loaded:`, message)
      if (mode === 'reload' || ticket === lookTicket) lookNote = `grades/${file} was not loaded: ${message}`
      else if (lookNote === loading) lookNote = undefined
      if (mode === 'paste' && ticket === lookTicket && endPaste(ticket, 'failed', message)) {
        // The paste without its look.
        commit()
        syncControls()
      } else renderLook()
    }
  }

  /**
   * A paste whose look is being fetched (plan 4.11): its state, switch and lattice size are set
   * and shown, while the frame keeps the grade before it; it is recorded once the fetch ends, as
   * one undo step with its look — or without it when the fetch fails, or when an undo, a redo, a
   * recall, an import, a removal or another paste comes first (settlePaste). An edit meanwhile is
   * recorded with the look there was, and the pasted look still lands after it.
   */
  let pendingPaste: { ticket: number; file: string; report: (outcome: PasteLookOutcome, message?: string) => void } | null = null

  /** Ends the pending paste of `ticket`, reporting how its fetch ended; false when there is none
   *  (it was settled already). The caller records it. */
  function endPaste(ticket: number, outcome: PasteLookOutcome, message?: string): boolean {
    const paste = pendingPaste
    if (!paste || paste.ticket !== ticket) return false
    pendingPaste = null
    paste.report(outcome, message)
    return true
  }

  /** A look-setting action comes before the pending paste's look has landed: the paste is
   *  recorded now, without it, and the look is only held when it lands. */
  function settlePaste(): void {
    const paste = pendingPaste
    if (!paste) return
    lookTicket++
    if (lookNote === lookLoadingNote(paste.file)) lookNote = undefined
    endPaste(paste.ticket, 'superseded')
    commit()
  }

  // ---- compile in or out (plan 1.6)
  const policy = createCompilePolicy((on) => options.setStage(on))
  const panelOpen = () => body.classList.contains('design-open')
  function evaluate(): void {
    if (disposed) return
    const changed = policy.evaluate({ enabled, sectionOpen: root.open, panelOpen: panelOpen(), identity: identity() })
    // The split only means something while the section is in view and the grade is on.
    if (compareOn && !(enabled && isEditing(root.open, panelOpen()))) setCompare(false)
    if (changed) renderStatus()
  }

  // ---- commits, undo, snapshots
  /** Records the present as an undo step, with a paste's switch of the grade when one waits. One
   *  that equals the step before, that step's switch aside, is not recorded. */
  function record(): void {
    const entry = current()
    if (switched) {
      entry.enabled = switched
      switched = null
      history.push(entry)
      return
    }
    const present = history.current()
    if (present?.enabled) {
      delete present.enabled
      if (sameData(present, entry)) return
    }
    history.push(entry)
  }

  function commit(): void {
    record()
    requestBake(true)
    evaluate()
    renderAll()
  }

  /** The Grade switch, from a paste or its undo or redo. */
  function setEnabled(on: boolean): void {
    if (on === enabled) return
    enabled = on
    if (!enabled) setCompare(false)
  }

  /** The wheels and curve editors (made with the controls below). */
  const widgets: GradeWidget[] = []
  /** An arrow-key nudge still waiting for its pause becomes its own undo step before anything
   *  else changes the state (an undo, a reset, a recall, a paste). */
  const flushWidgets = () => {
    for (const widget of widgets) widget.flush()
  }

  /** Makes a history entry or a snapshot the present, with the switch `on` when given (the undo
   *  or redo of a paste that switched the grade); the caller records it (or not). A look-setting
   *  action: it takes a lookTicket. */
  function restore(entry: GradeEntry, on?: boolean): void {
    const ticket = ++lookTicket
    state = entry.state
    look = entry.look
    lutSize = entry.lutSize
    if (on !== undefined) setEnabled(on)
    if (look && !looks.has(look.key) && look.file) void loadLookFile(look.file, look.amount, 'reload', ticket)
    requestBake(true)
    evaluate()
    syncControls()
  }

  const undo = () => {
    flushWidgets()
    settlePaste()
    const leaving = history.current()
    const entry = history.undo()
    if (entry) restore(entry, leaving?.enabled?.from)
  }
  const redo = () => {
    flushWidgets()
    settlePaste()
    const entry = history.redo()
    if (entry) restore(entry, entry.enabled?.to)
  }

  function tapSnapshot(slot: SnapshotSlot): void {
    flushWidgets()
    if (snapshots.has(slot)) settlePaste()
    const held = snapshots.tap(slot, current())
    if (held) {
      restore(held)
      record()
    }
    renderAll()
  }

  // ---- the before/after split (plan 5.6)
  function placeSplit(): void {
    el.split.style.setProperty('--split', `${(compareAt * 100).toFixed(3)}%`)
    el.splitHandle.setAttribute('aria-valuenow', String(Math.round(compareAt * 100)))
    el.splitHandle.setAttribute('aria-valuetext', splitValueText(compareAt))
  }

  /** #gradeSplit sits under the panels, so the handle stays left of the open Design panel where
   *  the panel reaches into its row (the desktop layout; the phone sheet is below the handle). */
  const designPanel = root.closest<HTMLElement>('#designPanel')
  function splitMax(): number {
    if (!designPanel || el.split.hidden || !panelOpen()) return 1
    return splitLimit(designPanel.getBoundingClientRect(), el.splitHandle.getBoundingClientRect(), window.innerWidth)
  }

  function setCompare(on: boolean): void {
    compareOn = on && enabled
    el.split.hidden = !compareOn
    // Compare starts from config compareSplit (plan 5.2), clear of the panel.
    if (compareOn) compareAt = Math.min(compareStart, splitMax())
    // A uniform: no recompile either way.
    output.setSplit(compareOn ? compareAt : 0)
    placeSplit()
    renderHeader()
  }

  function moveSplit(x: number): void {
    compareAt = Math.min(Math.max(x, 0), splitMax())
    if (compareOn) output.setSplit(compareAt)
    placeSplit()
  }

  // A narrower window or a wider panel moves the panel over the handle.
  const keepSplitClear = () => {
    if (compareOn) moveSplit(compareAt)
  }
  listen(window, 'resize', keepSplitClear)
  if (designPanel && typeof ResizeObserver !== 'undefined') {
    const panelSize = new ResizeObserver(keepSplitClear)
    panelSize.observe(designPanel)
    cleanups.push(() => panelSize.disconnect())
  }

  listen(el.splitHandle, 'pointerdown', (event: PointerEvent) => {
    event.stopPropagation()
    event.preventDefault()
    el.splitHandle.setPointerCapture(event.pointerId)
    el.splitHandle.focus({ preventScroll: true })
  })
  listen(el.splitHandle, 'pointermove', (event: PointerEvent) => {
    if (!el.splitHandle.hasPointerCapture(event.pointerId)) return
    event.stopPropagation()
    moveSplit(splitFromPointer(event.clientX, window.innerWidth))
  })
  const releaseHandle = (event: PointerEvent) => {
    if (el.splitHandle.hasPointerCapture(event.pointerId)) el.splitHandle.releasePointerCapture(event.pointerId)
  }
  listen(el.splitHandle, 'pointerup', releaseHandle)
  listen(el.splitHandle, 'pointercancel', releaseHandle)
  const handleKeys = createKeyIsolation()
  const onHandleKey = (event: KeyboardEvent) => {
    if (event.type !== 'keydown') {
      if (handleKeys.up(event)) event.stopPropagation()
      return
    }
    if (handleKeys.down(event, isolatesKey(event.key))) event.stopPropagation()
    const next = nudgeSplit(compareAt, event.key, event.shiftKey)
    if (next !== null) {
      event.preventDefault()
      moveSplit(next)
    } else if (event.key === 'Escape') el.splitHandle.blur()
  }
  listen(el.splitHandle, 'keydown', onHandleKey)
  listen(el.splitHandle, 'keyup', onHandleKey)
  listen(el.splitHandle, 'blur', () => handleKeys.clear())

  // ---- Frame for grading (plan 5.7) and Export .cube
  function download(blob: Blob, name: string): void {
    const url = URL.createObjectURL(blob)
    const link = doc.createElement('a')
    link.href = url
    link.download = name
    link.style.display = 'none'
    body.appendChild(link)
    link.click()
    link.remove()
    // Revoked a moment later: some browsers cancel a download whose URL goes at once.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const flashTimers = new Map<HTMLButtonElement, number>()
  function flash(button: HTMLButtonElement, text: string, rest: string): void {
    button.textContent = text
    clearTimeout(flashTimers.get(button))
    flashTimers.set(button, window.setTimeout(() => { button.textContent = rest }, FLASH_MS))
  }

  /**
   * The frame as on screen without the grade, as a PNG to grade elsewhere: the split set to show
   * "before" everywhere, the frame re-composited (only the final quad re-runs, so it is the same
   * frame), copied in the same task — on WebGPU the canvas texture is only readable until the task
   * ends — and the split put back before the next loop frame.
   */
  async function frameForGrading(): Promise<void> {
    const before = output.split()
    output.setSplit(2)
    let width = 0
    let height = 0
    let encoded: Promise<Blob | null>
    try {
      const source = options.captureCanvas()
      width = source.width
      height = source.height
      if (typeof OffscreenCanvas !== 'undefined') {
        const copy = new OffscreenCanvas(width, height)
        const context = copy.getContext('2d')
        if (!context) throw new Error('no 2D canvas')
        context.drawImage(source, 0, 0)
        encoded = copy.convertToBlob({ type: 'image/png' })
      } else {
        const copy = doc.createElement('canvas')
        copy.width = width
        copy.height = height
        const context = copy.getContext('2d')
        if (!context) throw new Error('no 2D canvas')
        context.drawImage(source, 0, 0)
        encoded = new Promise((resolve) => copy.toBlob(resolve, 'image/png'))
      }
    } finally {
      output.setSplit(before)
    }
    const blob = await encoded
    if (!blob) throw new Error('the PNG could not be encoded')
    download(blob, `canopy-frame-${width}x${height}.png`)
  }

  async function exportCube(): Promise<void> {
    const { state: jobState, look: jobLook, n } = job()
    const id = ++exportId
    const reply = await new Promise<CubeMessage>((resolve, reject) => {
      exporting.set(id, { sentAt: performance.now(), resolve, reject })
      send({ kind: 'export', id, title: GRADE_CUBE_TITLE, job: { state: jobState, look: jobLook, n } })
    })
    download(new Blob([reply.text], { type: 'text/plain' }), gradeCubeFileName(reply.n))
  }

  // ---- controls
  interface BoundSlider { sync(): void }

  /** A range bound to the state: its limits from GRADE_RANGES, its readout from `format`; 'input'
   *  edits (a bake, no undo step, then `after`), 'change' commits. */
  function bindGradeSlider(id: string, range: { min: number; max: number; step: number }, format: (v: number) => string,
    get: () => number, set: (v: number) => void, after?: () => void): BoundSlider {
    const input = byId<HTMLInputElement>(id)
    const readout = byId(`${id}Val`)
    input.min = String(range.min)
    input.max = String(range.max)
    input.step = String(range.step)
    const show = () => { readout.textContent = format(get()) }
    listen(input, 'input', () => {
      set(Number(input.value))
      show()
      editAt ??= performance.now()
      requestBake(false)
      after?.()
    })
    listen(input, 'change', () => commit())
    return {
      sync() {
        input.value = String(get())
        show()
      },
    }
  }

  // ---- peek (plan 4.12, 5.8): on a phone the sheet clears while a grade control is held — a
  // range, or a widget once its drag starts (a swipe that scrolls never) — leaving its row, until
  // the pointer that holds it lifts; the CSS only acts under 700 px.
  let endPeek: (() => void) | null = null
  function startPeek(row: Element | null, pointerId: number): void {
    endPeek?.()
    row?.classList.add('grade-active')
    body.classList.add('grade-dragging')
    const end = () => {
      row?.classList.remove('grade-active')
      body.classList.remove('grade-dragging')
      window.removeEventListener('pointerup', lift, true)
      window.removeEventListener('pointercancel', lift, true)
      if (endPeek === end) endPeek = null
    }
    // Another finger lifting is no end.
    const lift = (event: PointerEvent) => {
      if (event.pointerId === pointerId) end()
    }
    window.addEventListener('pointerup', lift, true)
    window.addEventListener('pointercancel', lift, true)
    endPeek = end
  }
  listen(root, 'pointerdown', (event: PointerEvent) => {
    // Widgets stop their pointerdown and call startPeek themselves (grabbing below).
    const target = event.target
    if (target instanceof HTMLInputElement && target.type === 'range') startPeek(target.closest('.row'), event.pointerId)
  })

  // ---- the wheels and curve editors (plan 5.3–5.5). They read and write the state through
  // closures, so a restore only redraws them; their input bakes like a slider's 'input', their
  // commit is a slider's 'change'. None of them ever changes the stage.
  const widgetInput = () => {
    editAt ??= performance.now()
    requestBake(false)
  }
  const grabbing = (canvas: HTMLElement) => (pointerId: number) => startPeek(canvas.closest('.row'), pointerId)

  // Primary: four minis pick the wheel the large one edits; that wheel's master range shows under it.
  let wheelName: WheelName = 'lift'
  const miniButtons = [...el.wheelMinis.querySelectorAll<HTMLButtonElement>('button[data-wheel]')]
  const minis = new Map<WheelName, GradeWidget>()
  for (const button of miniButtons) {
    const name = button.dataset.wheel as WheelName
    const canvas = button.querySelector('canvas')
    if (!WHEEL_NAMES.includes(name) || !canvas) throw new Error('grade editor: each wheel button needs a data-wheel and a canvas')
    minis.set(name, createColourWheel(canvas, { mini: true, get: () => state[name] }))
  }
  const masterRows = WHEEL_NAMES.map((name) => [name, byId(WHEEL_MASTER_SLIDERS[name]).closest<HTMLElement>('.row')] as const)
  const primaryWheel = createColourWheel(el.wheel, {
    get: () => state[wheelName],
    set: (puck) => {
      state[wheelName].u = puck.u
      state[wheelName].v = puck.v
    },
    label: wheelLabel(wheelName),
    readout: { element: el.wheelReadout, text: () => wheelReadout(wheelName, state[wheelName], tuning) },
    onInput: () => {
      minis.get(wheelName)?.redraw()
      widgetInput()
    },
    onCommit: commit,
    onGrab: grabbing(el.wheel),
  })
  function showWheel(): void {
    for (const button of miniButtons) {
      const on = button.dataset.wheel === wheelName
      button.classList.toggle('on', on)
      button.setAttribute('aria-pressed', String(on))
    }
    for (const [name, row] of masterRows) if (row) row.hidden = name !== wheelName
    primaryWheel.setLabel(wheelLabel(wheelName))
    primaryWheel.redraw()
  }
  for (const button of miniButtons) {
    listen(button, 'click', () => {
      flushWidgets()
      wheelName = button.dataset.wheel as WheelName
      showWheel()
    })
  }

  // Tones: the shadow and highlight tints.
  const toneWheel = (which: 'shadows' | 'highlights', canvas: HTMLCanvasElement, readout: HTMLElement) => createColourWheel(canvas, {
    get: () => state.tones[which],
    set: (puck) => { state.tones[which] = puck },
    label: toneWheelLabel(which),
    readout: { element: readout, text: () => puckReadout(state.tones[which]) },
    onInput: widgetInput,
    onCommit: commit,
    onGrab: grabbing(canvas),
  })

  // Curves: one editor, the channel picked above it.
  let curveChannel: CurveChannel = 'master'
  const channelButtons = [...el.curveChannel.querySelectorAll<HTMLButtonElement>('button[data-channel]')]
  const curveEditor = createCurveEditor(el.curve, {
    curves: () => state.curves,
    channel: () => curveChannel,
    setPoints: (points) => { state.curves[curveChannel] = points },
    label: curveLabel(curveChannel),
    readout: el.curveReadout,
    removeButton: el.curvePointRemove,
    onInput: widgetInput,
    onCommit: commit,
    onGrab: grabbing(el.curve),
  })
  function showChannel(): void {
    for (const button of channelButtons) {
      const on = button.dataset.channel === curveChannel
      button.classList.toggle('on', on)
      button.setAttribute('aria-pressed', String(on))
    }
    curveEditor.setLabel(curveLabel(curveChannel))
    curveEditor.deselect()
  }
  for (const button of channelButtons) {
    const channel = button.dataset.channel as CurveChannel
    if (!CURVE_CHANNELS.includes(channel)) throw new Error(`grade editor: unknown curve channel ${channel}`)
    listen(button, 'click', () => {
      curveChannel = channel
      showChannel()
    })
  }

  // Hue: one editor, hue vs saturation or hue vs luma.
  let hueMode: HueMode = 'sat'
  const hueButtons = [...el.hueMode.querySelectorAll<HTMLButtonElement>('button[data-mode]')]
  const hueEditor = createHueCurveEditor(el.hueCurve, {
    mode: () => hueMode,
    points: () => (hueMode === 'sat' ? state.hueSat : state.hueLuma),
    setPoints: (points) => {
      if (hueMode === 'sat') state.hueSat = points
      else state.hueLuma = points
    },
    label: hueCurveLabel(hueMode),
    readout: el.hueReadout,
    removeButton: el.huePointRemove,
    onInput: widgetInput,
    onCommit: commit,
    onGrab: grabbing(el.hueCurve),
  })
  function showHueMode(): void {
    for (const button of hueButtons) {
      const on = button.dataset.mode === hueMode
      button.classList.toggle('on', on)
      button.setAttribute('aria-pressed', String(on))
    }
    hueEditor.setLabel(hueCurveLabel(hueMode))
    hueEditor.deselect()
  }
  for (const button of hueButtons) {
    const mode = button.dataset.mode as HueMode
    if (!HUE_MODES.includes(mode)) throw new Error(`grade editor: unknown hue curve mode ${mode}`)
    listen(button, 'click', () => {
      hueMode = mode
      showHueMode()
    })
  }

  widgets.push(...minis.values(), primaryWheel,
    toneWheel('shadows', el.shadowWheel, el.shadowReadout), toneWheel('highlights', el.highlightWheel, el.highlightReadout),
    curveEditor, hueEditor)
  showWheel()
  showChannel()
  showHueMode()

  /** A wheel's master range changes its readout too. */
  const wheelMasterIds = new Set<string>(Object.values(WHEEL_MASTER_SLIDERS))
  const sliders: BoundSlider[] = GRADE_SLIDERS.map((spec) => bindGradeSlider(spec.id, sliderRange(spec), spec.format,
    () => readPath(state, spec.path), (v) => writePath(state, spec.path, v),
    wheelMasterIds.has(spec.id) ? primaryWheel.redraw : undefined))
  const lookAmountInput = byId<HTMLInputElement>(LOOK_AMOUNT_SLIDER.id)
  const lookAmount = bindGradeSlider(LOOK_AMOUNT_SLIDER.id, LOOK_AMOUNT_SLIDER.range, LOOK_AMOUNT_SLIDER.format,
    () => look?.amount ?? LOOK_AMOUNT_SLIDER.range.default,
    (v) => { if (look) look.amount = Math.min(Math.max(v, 0), 1) + 0 })

  // The pivot's 18 % grey mark, from the same table the slider reads.
  {
    const { min, max, default: grey } = GRADE_RANGES.pivot
    el.pivotTrack.style.setProperty('--ref', `${((grey - min) / (max - min)) * 100}%`)
  }

  const tabButtons = [...el.tabs.querySelectorAll<HTMLButtonElement>('button[data-tab]')]
  function showTab(tab: GradeTab): void {
    for (const button of tabButtons) {
      const on = button.dataset.tab === tab
      button.classList.toggle('on', on)
      button.setAttribute('aria-selected', String(on))
    }
    for (const name of GRADE_TABS) groups[name].hidden = name !== tab
  }
  for (const button of tabButtons) {
    listen(button, 'click', () => showTab(button.dataset.tab as GradeTab))
  }

  function renderHeader(): void {
    el.toggle.classList.toggle('on', enabled)
    el.toggle.setAttribute('aria-pressed', String(enabled))
    el.toggle.textContent = toggleText('◐ Grade', enabled)
    el.compare.classList.toggle('on', compareOn)
    el.compare.setAttribute('aria-pressed', String(compareOn))
    el.compare.textContent = toggleText('◧ Compare', compareOn)
    el.compare.disabled = !enabled
    const selected = snapshots.selected()
    for (const [slot, button] of [['A', el.snapA], ['B', el.snapB]] as const) {
      const stored = snapshots.has(slot)
      button.classList.toggle('stored', stored)
      button.classList.toggle('selected', selected === slot)
      button.setAttribute('aria-label', `Snapshot ${slot}: ${stored ? 'stored, tap to recall' : 'empty, tap to store'}`)
    }
    el.undo.disabled = !history.canUndo()
    el.redo.disabled = !history.canRedo()
  }

  function renderLook(): void {
    const meta = metaOf(look)
    el.lookStatus.textContent = lookStatusText(look, meta, meta ? latticeOf(look) : null, lookNote)
    lookAmountInput.disabled = look === null
    el.lookRemove.disabled = look === null
  }

  function renderStatus(): void {
    const text = gradeStatusText({
      enabled,
      compiled: policy.compiled,
      editing: isEditing(root.open, panelOpen()),
      identity: identity(),
      n: output.size,
      target: latticeOf(look).n,
      lastFinalMs,
      lastDraftMs,
      mode: bakeMode(),
      busy: scheduler.busy,
    })
    el.status.textContent = bakeError ? `${text} · bake failed: ${bakeError}` : text
  }

  function renderAll(): void {
    renderHeader()
    renderLook()
    renderStatus()
  }

  /** Every control from the state, after anything that replaced it. */
  function syncControls(): void {
    for (const slider of sliders) slider.sync()
    lookAmount.sync()
    for (const widget of widgets) widget.redraw()
    renderAll()
  }

  // ---- header and tab buttons
  listen(el.toggle, 'click', () => {
    enabled = !enabled
    if (!enabled) setCompare(false)
    // While off nothing was baked for the tap to show, maybe; covered requests are skipped.
    requestBake(true)
    evaluate()
    renderAll()
    if (enabled) loadBootLook()
  })
  listen(el.compare, 'click', () => setCompare(!compareOn))
  listen(el.snapA, 'click', () => tapSnapshot('A'))
  listen(el.snapB, 'click', () => tapSnapshot('B'))
  listen(el.store, 'click', () => {
    snapshots.store(current())
    renderHeader()
  })
  listen(el.undo, 'click', undo)
  listen(el.redo, 'click', redo)
  listen(el.reset, 'click', () => {
    flushWidgets()
    // The controls to neutral; the look stays (✕ Remove takes it off).
    state = parseGradeState({}).state
    commit()
    syncControls()
  })
  listen(el.curveReset, 'click', () => {
    flushWidgets()
    state.curves = parseGradeState({}).state.curves
    commit()
    syncControls()
  })
  listen(el.hueReset, 'click', () => {
    flushWidgets()
    state.hueSat = []
    state.hueLuma = []
    commit()
    syncControls()
  })
  listen(el.importButton, 'click', () => el.file.click())
  listen(el.file, 'change', () => {
    const file = el.file.files?.[0]
    // Cleared, so choosing the same file again fires 'change' again.
    el.file.value = ''
    if (file) void importFile(file)
  })
  listen(el.lookRemove, 'click', () => {
    flushWidgets()
    settlePaste()
    lookTicket++
    look = null
    lookNote = undefined
    commit()
    syncControls()
  })
  /** An export or frame failure shows in the Look status for a while, then the look's own
   *  status comes back. */
  let noteTimer = 0
  const noteBriefly = (text: string) => {
    lookNote = text
    renderLook()
    clearTimeout(noteTimer)
    noteTimer = window.setTimeout(() => {
      if (lookNote !== text) return
      lookNote = undefined
      renderLook()
    }, NOTE_MS)
  }
  listen(el.exportButton, 'click', () => {
    el.exportButton.disabled = true
    exportCube().then(
      () => flash(el.exportButton, '✓ Exported', '⤓ Export .cube'),
      (error) => noteBriefly(`Export failed: ${String(error?.message ?? error)}`),
    ).finally(() => { el.exportButton.disabled = false })
  })
  listen(el.frame, 'click', () => {
    frameForGrading().then(
      () => flash(el.frame, '✓ Saved', '⤓ Frame for grading'),
      (error) => noteBriefly(`Frame for grading failed: ${String(error?.message ?? error)}`),
    )
  })

  // ---- keys (plan 5.2, 5.8): undo and redo inside the section; no key but Tab leaves it, so the
  // camera's keys stay with the camera only while no grade control has focus. A keyup leaves it
  // unless its keydown did not: keyboard navigation lets go of a key on its keyup, wherever it
  // was pressed. Escape lets go of the focus.
  const sectionKeys = createKeyIsolation()
  const onSectionKey = (event: KeyboardEvent) => {
    if (event.type !== 'keydown') {
      if (sectionKeys.up(event)) event.stopPropagation()
      return
    }
    if (sectionKeys.down(event, isolatesKey(event.key))) event.stopPropagation()
    const target = event.target as HTMLElement | null
    const action = undoKeyAction(event, target instanceof HTMLTextAreaElement)
    if (action) {
      event.preventDefault()
      if (action === 'undo') undo()
      else redo()
    } else if (event.key === 'Escape' && target && target !== body) target.blur()
  }
  listen(root, 'keydown', onSectionKey)
  listen(root, 'keyup', onSectionKey)
  // The keys held as the focus moves have their keyups elsewhere.
  listen(root, 'focusout', () => sectionKeys.clear())

  // ---- the section and the panel
  listen(root, 'toggle', () => {
    body.classList.toggle('grade-open', root.open)
    evaluate()
    renderStatus()
  })
  // The Design chip and the panel's close button toggle body.design-open in main.ts; watching the
  // class covers both without touching them.
  const observer = new MutationObserver(() => evaluate())
  observer.observe(body, { attributes: true, attributeFilter: ['class'] })

  // ---- boot
  history.push(current())
  body.classList.toggle('grade-open', root.open)
  showTab('primary')
  placeSplit()
  el.split.hidden = true
  if (boot.bakeNow) {
    // One main-thread bake before the first frame, so a configured grade is on screen from the
    // start; the stage is set by evaluate() below.
    const { n } = latticeOf(null)
    const { texels, ms } = bakeGradeTexels(state, null, n, 1, undefined, { tuning })
    const replaced = output.upload(texels, n)
    if (replaced) poolFor(n).give(replaced.buffer)
    pushSample(finalMs, ms)
    lastFinalMs = ms
    scheduler.setLastFinalMs(ms)
  }
  evaluate()
  syncControls()
  // The configured look, fetched once the grade is on: with `?grade=0` nothing loads, no worker
  // starts and nothing bakes until the Grade button. A look set before then wins over it.
  let bootLook = boot.look
  const bootTicket = bootLook ? ++lookTicket : 0
  function loadBootLook(): void {
    if (!bootLook) return
    const { file, amount } = bootLook
    bootLook = null
    if (bootTicket === lookTicket) void loadLookFile(file, amount, 'boot', bootTicket)
  }
  if (enabled) loadBootLook()

  return {
    update() {
      output.update()
      const oldest = worker ? oldestRequest() : null
      if (oldest !== null && performance.now() - oldest > WORKER_SILENCE_MS) {
        fallBack(`the bake worker did not answer in ${WORKER_SILENCE_MS / 1000} s`)
      }
      if (syncJob && host) {
        const message = syncJob
        syncJob = null
        const result = host.handle(message)
        if (result) receive(result.reply)
      }
      if (!pending) return
      const result = pending
      pending = null
      const start = performance.now()
      const replaced = output.upload(result.texels, result.n)
      const now = performance.now()
      pushSample(uploadMs, now - start)
      if (replaced) poolFor(result.n).give(replaced.buffer)
      const editedAt = editAtBySeq.get(result.seq)
      if (editedAt !== undefined) pushSample(latencyMs, now - editedAt)
      for (const seq of editAtBySeq.keys()) if (seq <= result.seq) editAtBySeq.delete(seq)
      renderStatus()
    },
    state: () => structuredClone(state),
    look: () => (look ? { ...look } : null),
    isEnabled: () => enabled,
    isCompiled: () => policy.compiled,
    snippet: () => gradeSnippet(enabled, lutSize, look ? { name: look.name, file: look.file, amount: look.amount } : null, state),
    applyPaste(paste, onLook) {
      if (!paste.grade) return []
      flushWidgets()
      settlePaste()
      const ticket = ++lookTicket
      const held = looks.keys().map((key) => {
        const entry = looks.peek(key)!
        return { key, name: entry.name, file: entry.file }
      })
      const plan = planPaste(paste.grade, held, maxLattice)
      const was = enabled
      state = plan.state
      if (plan.enabled !== undefined) setEnabled(plan.enabled)
      // The undo step of the paste switches the grade back (record()).
      switched = enabled !== was ? { from: was, to: enabled } : null
      if (plan.lutSize !== undefined) lutSize = plan.lutSize
      if (plan.look.action === 'clear') look = null
      else if (plan.look.action === 'use') {
        const entry = looks.peek(plan.look.key)!
        look = { key: plan.look.key, name: entry.name, file: entry.file, size: entry.meta.size, amount: plan.look.amount }
      }
      if (plan.look.action !== 'fetch') {
        commit()
        syncControls()
        return plan.notes
      }
      // The look comes first: no commit, bake or stage change until it has landed (pendingPaste).
      const { file, amount } = plan.look
      const notes = plan.notes.filter((note) => note !== pasteLoadingNote(file))
      pendingPaste = {
        ticket,
        file,
        report: (outcome, message) => onLook?.([...notes, pasteLookNote(file, outcome, message)]),
      }
      syncControls()
      void loadLookFile(file, amount, 'paste', ticket)
      return plan.notes
    },
    stats() {
      const lattice = latticeOf(look)
      return {
        enabled,
        compiled: policy.compiled,
        stageChanges: policy.changes,
        identity: identity(),
        n: output.size,
        target: lattice.n,
        exact: lattice.exact,
        mode: bakeMode(),
        busy: scheduler.busy,
        bakeFinalMs: summarize(finalMs),
        bakeDraftMs: summarize(draftMs),
        uploadMs: summarize(uploadMs),
        editToFrameMs: summarize(latencyMs),
        pooledBuffers: pool.count,
        looksHeld: looks.keys(),
        canUndo: history.canUndo(),
        canRedo: history.canRedo(),
        compare: compareOn,
        split: output.split(),
      }
    },
    dispose() {
      disposed = true
      observer.disconnect()
      for (const cleanup of cleanups) cleanup()
      cleanups.length = 0
      endPeek?.()
      for (const widget of widgets) widget.dispose()
      widgets.length = 0
      for (const timer of flashTimers.values()) clearTimeout(timer)
      clearTimeout(noteTimer)
      if (worker) {
        worker.onmessage = null
        worker.onerror = null
        worker.terminate()
        worker = null
      }
      for (const pendingExport of exporting.values()) pendingExport.reject(new Error('the grade editor was disposed'))
      exporting.clear()
      parsing.clear()
      pool.clear()
      pending = null
      syncJob = null
      body.classList.remove('grade-open', 'grade-dragging')
    },
  }
}
