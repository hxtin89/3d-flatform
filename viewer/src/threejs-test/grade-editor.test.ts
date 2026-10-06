import { test } from 'node:test'
import assert from 'node:assert/strict'

import { serializeCube } from './cube-format.ts'
import { GRADE_SLIDERS, LOOK_AMOUNT_SLIDER, splitValueText } from './grade-editor-logic.ts'
import { DEFAULT_GRADE_TUNING, NEUTRAL_GRADE, type GradeState } from './grade-model.ts'
import { gradeSnippet, parseGradePaste } from './grade-state.ts'

// grade-editor.ts under node: a fake DOM just big enough for it and the widgets it makes, the real
// grade-output.ts, a fake module Worker that runs the real grade-bake-host.ts a task later, and a
// fetch that answers when told. Handlers run in order on the element dispatched to (no tree); an
// event is a plain object that records stopPropagation.
const g = globalThis as any
const mutationObservers: any[] = []
class FakeClassList {
  names = new Set<string>()
  owner: unknown
  constructor(owner: unknown) { this.owner = owner }
  changed() {
    for (const observer of mutationObservers) {
      if (observer.target === this.owner) queueMicrotask(() => observer.target && observer.callback([]))
    }
  }
  add(...names: string[]) {
    const size = this.names.size
    for (const name of names) this.names.add(name)
    if (this.names.size !== size) this.changed()
  }
  remove(...names: string[]) {
    let changed = false
    for (const name of names) changed = this.names.delete(name) || changed
    if (changed) this.changed()
  }
  toggle(name: string, force?: boolean) {
    const on = force ?? !this.names.has(name)
    if (on) this.add(name)
    else this.remove(name)
    return on
  }
  contains(name: string) { return this.names.has(name) }
}
let doc: any
let designPanel: FakeElement | null = null
class FakeElement {
  tagName: string
  id: string
  dataset: Record<string, string> = {}
  classList = new FakeClassList(this)
  style = { setProperty() {} }
  attributes = new Map<string, string>()
  handlers = new Map<string, ((event: any) => void)[]>()
  kids: FakeElement[] = []
  hidden = false
  disabled = false
  open = false
  textContent = ''
  value = ''
  type = ''
  files: unknown = null
  width = 0
  height = 0
  clientWidth = 0
  clientHeight = 0
  clientLeft = 0
  clientTop = 0
  tabIndex = -1
  rect = { left: 0, top: 0, right: 0, bottom: 0 }
  captured = new Set<number>()
  row?: FakeElement
  canvas?: FakeElement
  constructor(tag = 'div', id = '') {
    this.tagName = tag.toUpperCase()
    this.id = id
  }
  get ownerDocument() { return doc }
  setAttribute(name: string, value: unknown) { this.attributes.set(name, String(value)) }
  getAttribute(name: string) { return this.attributes.get(name) ?? null }
  addEventListener(type: string, fn: (event: any) => void) { this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]) }
  removeEventListener(type: string, fn: (event: any) => void) { this.handlers.set(type, (this.handlers.get(type) ?? []).filter((f) => f !== fn)) }
  dispatch(type: string, init: Record<string, unknown> = {}) {
    const event = {
      type, target: this, stopped: false, pointerId: 1, key: '', code: '', ctrlKey: false, metaKey: false, shiftKey: false,
      altKey: false, stopPropagation() { this.stopped = true }, preventDefault() {}, ...init,
    }
    for (const fn of [...(this.handlers.get(type) ?? [])]) fn(event)
    return event
  }
  closest(selector: string) {
    if (selector === '.row') return (this.row ??= new FakeElement())
    return selector === '#designPanel' ? designPanel : null
  }
  querySelectorAll() { return this.kids }
  querySelector() { return (this.canvas ??= new FakeElement('canvas')) }
  appendChild() {}
  remove() {}
  click() { this.dispatch('click') }
  focus() {}
  blur() { this.dispatch('blur') }
  getContext() { return null }
  getBoundingClientRect() { return this.rect }
  setPointerCapture(id: number) { this.captured.add(id) }
  hasPointerCapture(id: number) { return this.captured.has(id) }
  releasePointerCapture(id: number) { this.captured.delete(id) }
}
class FakeInput extends FakeElement {}
const RANGES = new Set([...GRADE_SLIDERS.map((spec) => spec.id), LOOK_AMOUNT_SLIDER.id])
g.HTMLElement = FakeElement
g.HTMLInputElement = FakeInput
g.HTMLTextAreaElement = class extends FakeElement {}
g.window = Object.assign(new FakeElement('window'), { innerWidth: 1000, devicePixelRatio: 1, setTimeout, clearTimeout })
g.requestAnimationFrame = () => 1
g.cancelAnimationFrame = () => {}
g.ResizeObserver = class { observe() {} disconnect() {} }
g.MutationObserver = class {
  target: unknown = null
  callback: (records: unknown[]) => void
  constructor(callback: (records: unknown[]) => void) { this.callback = callback }
  observe(target: unknown) {
    this.target = target
    mutationObservers.push(this)
  }
  disconnect() { this.target = null }
}

const { createGradeBakeHost } = await import('./grade-bake-host.ts')
const workers = { created: 0, messages: [] as string[], silent: false }
g.Worker = class {
  host = createGradeBakeHost()
  dead = false
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror = null
  onmessageerror = null
  constructor() { workers.created++ }
  postMessage(message: any, options?: { transfer?: ArrayBuffer[] }) {
    // A real worker's copy: the transferred buffers detach here.
    const copy = structuredClone(message, { transfer: options?.transfer ?? [] })
    workers.messages.push(copy.kind)
    if (workers.silent) return
    setTimeout(() => {
      const result = this.dead ? null : this.host.handle(copy)
      if (result && !this.dead) this.onmessage?.({ data: structuredClone(result.reply, { transfer: result.transfer }) })
    }, 1)
  }
  terminate() { this.dead = true }
}

/** Looks under grades/, each answered when released. */
function serve(files: Record<string, string>) {
  const waiting = new Map<string, () => void>()
  const asked: string[] = []
  g.fetch = (url: string) => new Promise((resolve) => {
    const file = decodeURIComponent(String(url).split('grades/')[1])
    asked.push(file)
    waiting.set(file, () => resolve(file in files
      ? { ok: true, status: 200, statusText: 'OK', text: async () => files[file] }
      : { ok: false, status: 404, statusText: 'Not Found', text: async () => '' }))
  })
  return { asked, release(file: string) { waiting.get(file)?.(); waiting.delete(file) } }
}

const { createGradeEditor } = await import('./grade-editor.ts')
const { createGradeOutput } = await import('./grade-output.ts')
const settle = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

async function boot({ enabled = true, open = true, state = {} as Partial<GradeState>, look = null as { file: string; amount: number } | null } = {}) {
  const ids = new Map<string, FakeElement>()
  const body = new FakeElement('body')
  body.classList.add('design-open')
  doc = {
    body,
    createElement: (tag: string) => new FakeElement(tag),
    getElementById(id: string) {
      if (!ids.has(id)) ids.set(id, RANGES.has(id) ? Object.assign(new FakeInput('input', id), { type: 'range' }) : new FakeElement('div', id))
      return ids.get(id)
    },
  }
  g.document = doc
  const buttons = (data: string, values: string[]) => values.map((value) => Object.assign(new FakeElement('button'), { dataset: { [data]: value } }))
  doc.getElementById('gradeWheelMinis').kids = buttons('wheel', ['lift', 'gamma', 'gain', 'offset'])
  doc.getElementById('gradeCurveChannel').kids = buttons('channel', ['master', 'red', 'green', 'blue'])
  doc.getElementById('gradeHueMode').kids = buttons('mode', ['sat', 'luma'])
  doc.getElementById('gradeTabs').kids = buttons('tab', ['primary', 'curves', 'hue', 'tones', 'look'])
  const root = doc.getElementById('gradeSection')
  root.open = open
  const stages: boolean[] = []
  workers.created = 0
  workers.messages.length = 0
  const editor = createGradeEditor({
    root, output: createGradeOutput(33), setStage: (on) => { stages.push(on) }, captureCanvas: () => new FakeElement('canvas') as any,
    initial: {
      enabled: true, lutSize: 33, maxLattice: 65, draftWhenFinalOverMs: 8, worker: true, look, compareSplit: 0.5,
      state: { ...structuredClone(NEUTRAL_GRADE), ...state }, tuning: DEFAULT_GRADE_TUNING,
    },
    enabled, baseUrl: '/',
  })
  const el = (id: string): FakeElement => doc.getElementById(id)
  const frames = async (n = 3) => {
    for (let i = 0; i < n; i++) {
      editor.update()
      await settle(2)
    }
  }
  const undoSteps = () => {
    let steps = 0
    while (editor.stats().canUndo) {
      el('gradeUndo').click()
      steps++
    }
    return steps
  }
  return { editor, el, root, body, stages, frames, undoSteps }
}

/** A 9³ look that changes something. */
function cube(): string {
  const data = new Float32Array(3 * 9 ** 3)
  for (let k = 0, p = 0; k < 9; k++) for (let j = 0; j < 9; j++) for (let i = 0; i < 9; i++) {
    data[p++] = (i / 8) * 0.9
    data[p++] = j / 8
    data[p++] = k / 8
  }
  return serializeCube(data, 9, { title: 'test' })
}
const paste = (patch: Partial<GradeState>, look: string | null, enabled = true, lutSize = 33) =>
  parseGradePaste(`grade: ${gradeSnippet(enabled, lutSize, look ? { name: look, file: look, amount: 1 } : null,
    { ...structuredClone(NEUTRAL_GRADE), ...patch })}`)

test('a paste whose look is fetched is one undo step with it, and changes no stage while it loads', async () => {
  const net = serve({ 'film.cube': cube() })
  // Section closed, panel open: compiled in for the saturation alone.
  const h = await boot({ open: false, state: { saturation: 1.3 } })
  await h.frames()
  assert.deepEqual(h.stages, [true])
  const reports: string[][] = []
  const notes = h.editor.applyPaste(paste({}, 'film.cube'), (n) => reports.push(n))
  assert.deepEqual(notes, ['Loading the look grades/film.cube.'])
  await h.frames()
  // The neutral paste alone would compile out (and back in once the look lands).
  assert.deepEqual(h.stages, [true], 'no stage change while the look loads')
  assert.equal(h.editor.stats().canUndo, false, 'nothing recorded yet')
  net.release('film.cube')
  await settle(20)
  await h.frames()
  assert.equal(h.editor.look()?.file, 'film.cube')
  assert.deepEqual(h.stages, [true])
  assert.deepEqual(reports, [['Loaded the look grades/film.cube.']])
  assert.equal(h.undoSteps(), 1)
  assert.equal(h.editor.state().saturation, 1.3)
  assert.equal(h.editor.look(), null)
  h.editor.dispose()
})

test('a look that lands after a newer look change is only held; a paste\'s failed fetch is reported', async () => {
  const warnings: unknown[][] = []
  const warn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args) }
  try {
    // The boot look is slow; an import comes first.
    const text = cube()
    let net = serve({ 'evergreen.cube': text })
    let h = await boot({ look: { file: 'evergreen.cube', amount: 1 } })
    h.el('gradeFile').files = [{ name: 'mine.cube', size: text.length, lastModified: 1, text: async () => text }]
    h.el('gradeFile').dispatch('change')
    await settle(20)
    assert.equal(h.editor.look()?.name, 'mine.cube')
    net.release('evergreen.cube')
    await settle(20)
    await h.frames()
    assert.equal(h.editor.look()?.name, 'mine.cube', 'the boot look does not override the import')
    assert.ok(h.editor.stats().looksHeld.includes('grades/evergreen.cube'), 'but it is held')
    h.editor.dispose()

    // A pasted look still loading when the paste is undone.
    net = serve({ 'x.cube': text })
    h = await boot()
    const reports: string[][] = []
    h.editor.applyPaste(paste({ saturation: 0.6 }, 'x.cube'), (n) => reports.push(n))
    h.el('gradeUndo').click()
    assert.equal(h.editor.state().saturation, 1)
    net.release('x.cube')
    await settle(20)
    await h.frames()
    assert.equal(h.editor.look(), null)
    assert.equal(h.editor.stats().canRedo, true, 'the redo of the paste is still there')
    assert.match(reports.at(-1)!.join(), /grades\/x\.cube was not applied/)
    h.el('gradeRedo').click()
    assert.equal(h.editor.state().saturation, 0.6, 'redone without its look')
    assert.equal(h.editor.look(), null)
    h.editor.dispose()

    // A pasted look that is not there.
    net = serve({})
    h = await boot()
    reports.length = 0
    h.editor.applyPaste(paste({ saturation: 0.6 }, 'gone.cube'), (n) => reports.push(n))
    net.release('gone.cube')
    await settle(20)
    assert.match(reports.at(-1)!.join(), /^The look grades\/gone\.cube was not loaded \(404 Not Found\)/)
    assert.equal(h.editor.state().saturation, 0.6)
    assert.equal(h.undoSteps(), 1)
    assert.ok(warnings.some((args) => /paste look grades\/gone\.cube/.test(String(args[0]))))
    h.editor.dispose()
  } finally {
    console.warn = warn
  }
})

test('one undo of a paste puts the switch and the lattice size back; the Grade button is no undo step', async () => {
  const h = await boot()
  const lattice = () => Number(/"lutSize": (\d+)/.exec(h.editor.snippet())![1])
  h.editor.applyPaste(paste({ saturation: 1.4 }, null, false, 41))
  assert.equal(h.editor.isEnabled(), false)
  assert.equal(lattice(), 41)
  assert.equal(h.editor.stats().target, 41)
  h.el('gradeUndo').click()
  assert.equal(h.editor.isEnabled(), true)
  assert.equal(lattice(), 33)
  assert.equal(h.editor.stats().target, 33)
  h.el('gradeRedo').click()
  assert.equal(h.editor.isEnabled(), false)
  assert.equal(lattice(), 41)
  // Grade on by hand, then an edit and its undo: the switch stays as the button left it.
  h.el('gradeToggle').click()
  const contrast = h.el('gradeContrast')
  contrast.value = '1.2'
  contrast.dispatch('input')
  contrast.dispatch('change')
  h.el('gradeUndo').click()
  assert.equal(h.editor.isEnabled(), true)
  // A commit that changes nothing is no step: one more undo takes the paste back.
  contrast.dispatch('change')
  h.el('gradeUndo').click()
  assert.equal(h.editor.state().saturation, 1)
  assert.equal(h.editor.isEnabled(), true)
  assert.equal(h.editor.stats().canUndo, false)
  h.editor.dispose()
})

test('a worker that leaves a parse unanswered for 6 s is given up on', async () => {
  const realNow = performance.now.bind(performance)
  let offset = 0
  Object.defineProperty(performance, 'now', { value: () => realNow() + offset, configurable: true })
  workers.silent = true
  const warn = console.warn
  console.warn = () => {}
  try {
    const h = await boot()
    const text = cube()
    h.el('gradeFile').files = [{ name: 'nine.cube', size: text.length, lastModified: 2, text: async () => text }]
    h.el('gradeFile').dispatch('change')
    await settle(5)
    await h.frames(2)
    assert.equal(h.editor.stats().mode, 'worker')
    offset += 7000
    await h.frames(2)
    await settle(5)
    assert.equal(h.editor.stats().mode, 'main thread')
    assert.equal(h.editor.look()?.name, 'nine.cube', 'the import went on on the main thread')
    h.editor.dispose()
  } finally {
    workers.silent = false
    console.warn = warn
    Object.defineProperty(performance, 'now', { value: realNow, configurable: true })
  }
})

test('with the grade off at boot a configured look waits for the Grade button: no fetch, worker or bake', async () => {
  const net = serve({ 'evergreen.cube': cube() })
  const h = await boot({ enabled: false, look: { file: 'evergreen.cube', amount: 1 } })
  await settle(20)
  await h.frames()
  assert.deepEqual(net.asked, [])
  assert.equal(workers.created, 0)
  h.el('gradeToggle').click()
  net.release('evergreen.cube')
  await settle(20)
  await h.frames()
  assert.deepEqual(net.asked, ['evergreen.cube'])
  assert.equal(h.editor.look()?.file, 'evergreen.cube')
  assert.equal(h.editor.stats().canUndo, false, 'the boot look is the starting point')
  h.editor.dispose()
})

test('Compare starts at config compareSplit, and the handle stays left of the open Design panel', async () => {
  // 1000 px wide: the panel at right 260 px, 320 px wide (x 420..740); the handle at 30vh.
  designPanel = new FakeElement('div', 'designPanel')
  designPanel.rect = { left: 420, right: 740, top: 52, bottom: 780 }
  try {
    const h = await boot()
    const handle = h.el('gradeSplitHandle')
    handle.rect = { left: 0, right: 44, top: 218, bottom: 262 }
    const limit = (420 - 30) / 1000
    h.el('gradeCompare').click()
    assert.equal(h.editor.stats().split, limit, 'config 0.5 would put the handle under the panel')
    assert.equal(handle.getAttribute('aria-valuetext'), splitValueText(limit))
    handle.dispatch('pointerdown', { pointerId: 4, clientX: 400 })
    handle.dispatch('pointermove', { pointerId: 4, clientX: 900 })
    assert.equal(h.editor.stats().split, limit, 'a drag stops short of it')
    handle.dispatch('pointermove', { pointerId: 4, clientX: 200 })
    assert.equal(h.editor.stats().split, 0.2)
    assert.equal(handle.getAttribute('aria-valuetext'), '20% without the grade, on the left')
    handle.dispatch('pointerup', { pointerId: 4, clientX: 200 })
    // A narrower window moves the panel over it.
    designPanel.rect = { left: 120, right: 440, top: 52, bottom: 780 }
    g.window.innerWidth = 700
    g.window.dispatch('resize')
    assert.equal(h.editor.stats().split, (120 - 30) / 700)
    // The phone sheet lies below the handle: Compare starts at 0.5 again.
    g.window.innerWidth = 390
    designPanel.rect = { left: 0, right: 390, top: 288, bottom: 800 }
    h.el('gradeCompare').click()
    h.el('gradeCompare').click()
    assert.equal(h.editor.stats().split, 0.5)
    h.editor.dispose()
  } finally {
    designPanel = null
    g.window.innerWidth = 1000
  }
})

test('the peek ends when the pointer that holds the control lifts, not another', async () => {
  const h = await boot()
  const saturation = h.el('gradeSaturation')
  h.root.dispatch('pointerdown', { target: saturation, pointerId: 5 })
  assert.equal(h.body.classList.contains('grade-dragging'), true)
  g.window.dispatch('pointerup', { pointerId: 6 })
  assert.equal(h.body.classList.contains('grade-dragging'), true, 'a second finger lifting')
  g.window.dispatch('pointercancel', { pointerId: 5 })
  assert.equal(h.body.classList.contains('grade-dragging'), false)
  h.editor.dispose()
})

test('a keyup leaves the section unless the section kept its keydown', async () => {
  const h = await boot()
  const up = (init: Record<string, unknown>) => h.root.dispatch('keyup', init).stopped
  assert.equal(up({ key: 'Shift', code: 'ShiftLeft' }), false, 'Shift went down over the map: keyboard navigation lets go')
  assert.equal(h.root.dispatch('keydown', { key: ' ', code: 'Space' }).stopped, true)
  assert.equal(up({ key: ' ', code: 'Space' }), true, 'Space pressed on a section button: its keyup stays (it clicks)')
  h.root.dispatch('keydown', { key: 'w', code: 'KeyW' })
  h.root.dispatch('focusout')
  assert.equal(up({ key: 'w', code: 'KeyW' }), false, 'after the focus left, the keyup is the app\'s')
  const handle = h.el('gradeSplitHandle')
  assert.equal(handle.dispatch('keyup', { key: 'd', code: 'KeyD' }).stopped, false)
  assert.equal(handle.dispatch('keydown', { key: 'd', code: 'KeyD' }).stopped, true)
  assert.equal(handle.dispatch('keyup', { key: 'd', code: 'KeyD' }).stopped, true)
  h.editor.dispose()
})
