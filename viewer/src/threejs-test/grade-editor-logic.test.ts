import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { EXPERIENCE_CONFIG } from './config.ts'
import type { LookMeta } from './grade-bake-host.ts'
import { latticeSizeFor } from './grade-bake.ts'
import {
  createCompilePolicy, createLookStore, fileLookKey, GRADE_ELEMENT_IDS, GRADE_SLIDERS, GRADE_TAB_GROUPS, GRADE_TABS,
  gradeBoot, gradeStatusText, heldEditsNote, importLookKey, isEditing, isolatesKey, LOOK_AMOUNT_SLIDER,
  lookStatusText, lookUrl, nudgeSplit, planPaste, pushSample, readPath, shouldCompileIn, signed, sliderRange,
  splitFromPointer, summarize, toggleText, undoKeyAction, writePath, type CompileInputs, type GradeConfig,
  type GradeStatus,
} from './grade-editor-logic.ts'
import { DEFAULT_GRADE_TUNING, GRADE_RANGES, isGradeIdentity, NEUTRAL_GRADE, parseGradeState, type GradeState, type LookRef } from './grade-model.ts'
import { gradeSnippet, parseGradePaste } from './grade-state.ts'

const neutral = (): GradeState => parseGradeState({}).state
const CONFIG = EXPERIENCE_CONFIG.grade as GradeConfig
const HTML = readFileSync(new URL('../../threejs-test.html', import.meta.url), 'utf8')

const config = (patch: Partial<GradeConfig>): GradeConfig => ({ ...CONFIG, ...patch })

// ---- config and boot

test('config grade: on, neutral, no look — compiled out at boot for every viewer', () => {
  assert.equal(CONFIG.enabled, true)
  assert.equal(CONFIG.lutSize, 33)
  assert.equal(CONFIG.maxLattice, 65)
  assert.equal(CONFIG.worker, true)
  assert.equal(CONFIG.look, null)
  assert.equal(CONFIG.compareSplit, 0.5)
  assert.deepEqual({ ...CONFIG.tuning }, { ...DEFAULT_GRADE_TUNING })
  const boot = gradeBoot(CONFIG, true)
  assert.deepEqual(boot.warnings, [])
  assert.deepEqual(boot.state, NEUTRAL_GRADE)
  assert.equal(boot.bakeNow, false, 'nothing is baked before the first frame')
  assert.equal(boot.look, null)
  // The section is closed in the markup, so with the panel open or not nothing compiles in.
  for (const panelOpen of [false, true]) {
    assert.equal(shouldCompileIn({ enabled: true, sectionOpen: false, panelOpen, identity: true }), false)
  }
  assert.doesNotMatch(sectionTag(), /\sopen[\s>=]/, '#gradeSection is closed by default')
})

test('gradeBoot: a configured grade bakes before the first frame unless it is off; sizes and amounts clamp', () => {
  const warm = config({ state: { temperature: 20 } })
  assert.equal(gradeBoot(warm, true).bakeNow, true)
  assert.equal(gradeBoot(warm, false).bakeNow, false, '?grade=0 bakes nothing')
  assert.equal(gradeBoot(config({ state: { pivot: 0.5 } }), true).bakeNow, false, 'pivot alone changes nothing')
  const odd = gradeBoot(config({ lutSize: 80, maxLattice: 300, look: { file: 'a.cube', amount: 3 } }), true)
  assert.equal(odd.maxLattice, 256)
  assert.equal(odd.lutSize, 80)
  assert.deepEqual(odd.look, { file: 'a.cube', amount: 1 })
  assert.equal(odd.warnings.length, 1)
  const small = gradeBoot(config({ lutSize: 80 }), true)
  assert.equal(small.lutSize, 65, 'lutSize never exceeds maxLattice')
  assert.match(small.warnings.join(), /grade\.lutSize: 80 read as 65/)
  assert.ok(gradeBoot(config({ state: { contrast: 'x' } }), true).warnings.some((w) => w.startsWith('contrast')))
})

// ---- compile-in policy

test('shouldCompileIn: enabled and (editing or not identity)', () => {
  for (const enabled of [false, true]) {
    for (const sectionOpen of [false, true]) {
      for (const panelOpen of [false, true]) {
        for (const identity of [false, true]) {
          const expected = enabled && ((sectionOpen && panelOpen) || !identity)
          assert.equal(shouldCompileIn({ enabled, sectionOpen, panelOpen, identity }), expected)
        }
      }
    }
  }
  assert.equal(isEditing(true, false), false, 'an open section in a closed panel is not editing')
})

test('the compile policy changes the stage only when its decision changes: one per open, close and toggle, none in a drag', () => {
  const calls: boolean[] = []
  const policy = createCompilePolicy((on) => calls.push(on))
  const inputs: CompileInputs = { enabled: true, sectionOpen: false, panelOpen: true, identity: true }
  const step = (patch: Partial<CompileInputs>) => policy.evaluate(Object.assign(inputs, patch))

  assert.equal(step({}), false, 'boot: neutral, section closed, nothing to do')
  assert.equal(step({ sectionOpen: true }), true, 'opening the section compiles in')
  // A drag never evaluates; its commit does, and changes nothing while editing.
  assert.equal(step({ identity: false }), false)
  assert.equal(step({ identity: true }), false)
  assert.equal(step({ sectionOpen: false }), true, 'closing at identity compiles out')
  assert.equal(step({ identity: false }), true, 'a paste that changes something compiles in')
  assert.equal(step({ sectionOpen: true }), false)
  assert.equal(step({ sectionOpen: false }), false, 'closing with a grade keeps it')
  assert.equal(step({ enabled: false }), true, 'the toggle compiles out')
  assert.equal(step({ enabled: true }), true, 'and in again')
  assert.equal(step({ panelOpen: false }), false, 'the panel closing with a grade keeps it')
  assert.deepEqual(calls, [true, false, true, false, true])
  assert.equal(policy.changes, 5)
  assert.equal(policy.compiled, true)
  assert.equal(createCompilePolicy(() => assert.fail('no call'), true).evaluate({ ...inputs, identity: false }), false,
    'starting compiled in, the same decision calls nothing')
})

// ---- looks

test('look keys: an imported file by name, size and date; a saved one by its path', () => {
  assert.equal(importLookKey('Kodak 2393.cube', 1234, 99), 'import:Kodak 2393.cube:1234:99')
  assert.notEqual(importLookKey('a.cube', 10, 1), importLookKey('a.cube', 10, 2), 'an edited file is a new look')
  assert.equal(fileLookKey('evergreen.cube'), 'grades/evergreen.cube')
  assert.equal(lookUrl('/livingdashboard/', 'film looks/F125 #2.cube'), '/livingdashboard/grades/film%20looks/F125%20%232.cube')
  assert.equal(lookUrl('/', 'a.cube'), '/grades/a.cube')
  assert.equal(lookUrl('/base', 'a.cube'), '/base/grades/a.cube')
})

test('the look store: newest uses kept up to the limit, pinned looks never dropped', () => {
  const store = createLookStore<number>(2)
  assert.deepEqual(store.add('a', 1), [])
  assert.deepEqual(store.add('b', 2), [])
  assert.equal(store.get('a'), 1, 'a use')
  assert.deepEqual(store.add('c', 3), ['b'], 'b was used longest ago')
  assert.deepEqual(store.keys(), ['a', 'c'])
  assert.equal(store.peek('a'), 1)
  assert.deepEqual(store.add('d', 4, ['a']), ['c'], 'a is pinned (the current look), c goes')
  assert.deepEqual(store.add('e', 5, ['a', 'd']), [], 'with everything pinned the store holds more for a while')
  assert.equal(store.size, 3)
  assert.deepEqual(store.add('f', 6), ['a', 'd'], 'unpinned again, the oldest go until it fits')
  assert.deepEqual(store.keys(), ['e', 'f'])
  assert.deepEqual(store.add('e', 50), [], 'adding a held key replaces it')
  assert.deepEqual(store.keys(), ['f', 'e'])
  assert.equal(store.delete('f'), true)
  assert.equal(store.has('f'), false)
})

// ---- paste

const HELD = [
  { key: 'grades/evergreen.cube', name: 'evergreen.cube', file: 'evergreen.cube' },
  { key: 'import:F125 Kodak 2393.cube:1:2', name: 'F125 Kodak 2393.cube', file: null },
]

test('planPaste: state, enabled, lutSize capped, and the look kept, cleared, matched or fetched', () => {
  const warm = parseGradeState({ temperature: 30 }).state
  const keep = planPaste({ state: warm }, HELD, 65)
  assert.deepEqual(keep, { state: warm, look: { action: 'keep' }, notes: [] })
  assert.notEqual(keep.state, warm, 'the state is a copy')

  const full = planPaste({ enabled: false, lutSize: 129, look: null, state: warm }, HELD, 65)
  assert.equal(full.enabled, false)
  assert.equal(full.lutSize, 65)
  assert.deepEqual(full.look, { action: 'clear' })
  assert.match(full.notes.join(), /lutSize 129 is above maxLattice, 65 used/)

  assert.deepEqual(planPaste({ look: { file: 'evergreen.cube', amount: 0.4 }, state: warm }, HELD, 65).look,
    { action: 'use', key: 'grades/evergreen.cube', amount: 0.4 })
  // Copy values names a session import by lookFileName(name); the paste finds it under that name.
  assert.deepEqual(planPaste({ look: { file: 'F125 Kodak 2393.cube', amount: 0.65 }, state: warm }, HELD, 65).look,
    { action: 'use', key: 'import:F125 Kodak 2393.cube:1:2', amount: 0.65 })
  const fetch = planPaste({ look: { file: 'other/new.cube', amount: 1 }, state: warm }, HELD, 65)
  assert.deepEqual(fetch.look, { action: 'fetch', file: 'other/new.cube', amount: 1 })
  assert.match(fetch.notes.join(), /grades\/other\/new\.cube/)
})

test('Copy values → Paste values: the editor\'s snippet comes back as the same grade and look', () => {
  const state = parseGradeState({ temperature: 12, lift: { y: 0.01, u: 0.3, v: -0.2 }, curves: { red: [[0, 0], [0.5, 0.55], [1, 1]] } }).state
  const look: LookRef = { key: HELD[1].key, name: HELD[1].name, file: null, size: 21, amount: 0.65 }
  const paste = parseGradePaste(`toneMapping: {}\ngrade: ${gradeSnippet(true, 33, look, state)}\neyeDomeLighting: {}`)
  assert.ok(paste.grade)
  const plan = planPaste(paste.grade!, HELD, 65)
  assert.deepEqual(plan.state, state)
  assert.equal(plan.enabled, true)
  assert.equal(plan.lutSize, 33)
  assert.deepEqual(plan.look, { action: 'use', key: look.key, amount: 0.65 })
  assert.deepEqual(paste.ignored, ['toneMapping', 'eyeDomeLighting'])
})

// ---- status lines

const status = (patch: Partial<GradeStatus>): string => gradeStatusText({
  enabled: true, compiled: false, editing: false, identity: true, n: 33, target: 33,
  lastFinalMs: null, lastDraftMs: null, mode: 'worker', busy: false, ...patch,
})

test('gradeStatusText says whether the tap is in, why not, the lattice and the last bake', () => {
  assert.equal(status({}), 'Neutral · compiled out · 33³ lattice · bakes on the worker')
  assert.equal(status({ enabled: false }), 'Off · compiled out · 33³ lattice · bakes on the worker')
  assert.equal(status({ compiled: true, editing: true }), 'Compiled in (neutral while editing) · 33³ lattice · bakes on the worker')
  assert.equal(status({ compiled: true, identity: false, lastFinalMs: 6.24, mode: 'main thread' }),
    'Compiled in · 33³ lattice · bake 6.2 ms (main thread)')
  assert.equal(status({ compiled: true, identity: false, target: 41, lastFinalMs: 12.6, lastDraftMs: 2.04, busy: true }),
    'Compiled in · 33³ → 41³ lattice · bake 13 ms (worker) · drafts 2.0 ms · baking…')
})

const META: LookMeta = {
  title: 'Kodak 2393', kind: '3d', size: 21, domainMin: [0, 0, 0], domainMax: [1, 1, 1], unitDomain: true, isIdentity: false, warnings: [],
}

test('lookStatusText: no look, a look 1:1 or resampled, an identity cube, a look not held, a note', () => {
  assert.match(lookStatusText(null, null, null), /^No look\./)
  const session: LookRef = { key: 'k', name: 'F125 Kodak 2393.cube', file: null, size: 21, amount: 1 }
  assert.equal(lookStatusText(session, META, latticeSizeFor(21, 33, 65)),
    'Kodak 2393 · 21³ · baked on 41³, 1:1 · this session only: save it as public/grades/F125 Kodak 2393.cube to keep it')
  const saved: LookRef = { ...session, name: 'big.cube', file: 'big.cube' }
  const resampled = lookStatusText(saved, { ...META, title: null, size: 129, warnings: ['TITLE repeated'] }, latticeSizeFor(129, 33, 65))
  assert.match(resampled, /^big\.cube · 129³ · .*not 1:1/)
  assert.match(resampled, /1 parser note: TITLE repeated/)
  assert.doesNotMatch(resampled, /this session only/)
  assert.match(lookStatusText(saved, { ...META, isIdentity: true }, latticeSizeFor(21, 33, 65)), /identity cube, changes nothing/)
  assert.match(lookStatusText(saved, null, null), /not held any more/)
  assert.equal(lookStatusText(saved, META, latticeSizeFor(21, 33, 65), 'Loading …'), 'Loading …')
})

// ---- measurements

test('summarize and pushSample: median, p95, a bounded window', () => {
  assert.deepEqual(summarize([]), { count: 0, median: null, p95: null })
  assert.deepEqual(summarize([3, 1, 2]), { count: 3, median: 2, p95: 3 })
  assert.deepEqual(summarize([4, 1, 3, 2]), { count: 4, median: 2.5, p95: 4 })
  const samples: number[] = []
  for (let i = 1; i <= 100; i++) pushSample(samples, i, 50)
  pushSample(samples, Number.NaN, 50)
  assert.equal(samples.length, 50)
  assert.equal(samples[0], 51)
  assert.deepEqual(summarize(samples), { count: 50, median: 75.5, p95: 98 })
})

// ---- split and keys

test('the split: pointer to a share of the width; arrows 2 %, Shift 10 %, clamped', () => {
  assert.equal(splitFromPointer(640, 1280), 0.5)
  assert.equal(splitFromPointer(-20, 1280), 0)
  assert.equal(splitFromPointer(1400, 1280), 1)
  assert.equal(splitFromPointer(10, 0), 0.5)
  assert.equal(nudgeSplit(0.5, 'ArrowLeft', false), 0.48)
  assert.equal(nudgeSplit(0.5, 'ArrowRight', true), 0.6)
  assert.equal(nudgeSplit(0.99, 'ArrowRight', false), 1)
  assert.equal(nudgeSplit(0.05, 'ArrowLeft', true), 0)
  assert.equal(nudgeSplit(0.5, 'ArrowUp', false), null)
  let x = 0.5
  for (let i = 0; i < 5; i++) x = nudgeSplit(x, 'ArrowRight', false)!
  assert.equal(x, 0.6, 'repeated nudges do not drift')
})

test('undo keys: Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y, not in a textarea; every key but Tab stays in the section', () => {
  const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) =>
    ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods })
  assert.equal(undoKeyAction(key('z', { ctrlKey: true }), false), 'undo')
  assert.equal(undoKeyAction(key('z', { metaKey: true }), false), 'undo')
  assert.equal(undoKeyAction(key('Z', { ctrlKey: true, shiftKey: true }), false), 'redo')
  assert.equal(undoKeyAction(key('y', { ctrlKey: true }), false), 'redo')
  assert.equal(undoKeyAction(key('z'), false), null, 'plain Z is the app\'s')
  assert.equal(undoKeyAction(key('z', { ctrlKey: true }), true), null, 'a textarea keeps its own undo')
  assert.equal(undoKeyAction(key('z', { ctrlKey: true, altKey: true }), false), null)
  for (const k of ['w', 'a', 's', 'd', ' ', 'c', 'Enter', 'Escape', 'ArrowLeft']) assert.equal(isolatesKey(k), true)
  assert.equal(isolatesKey('Tab'), false)
})

// ---- controls

test('GRADE_SLIDERS: unique ids, each edits a real field within its GRADE_RANGES entry, neutral at default', () => {
  const ids = GRADE_SLIDERS.map((spec) => spec.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.deepEqual(ids, ['gradeLiftY', 'gradeGammaY', 'gradeGainY', 'gradeOffsetY', 'gradeTemperature', 'gradeTint',
    'gradeContrast', 'gradePivot', 'gradeSaturation', 'gradeVibrance', 'gradeBalance', 'gradeBlending', 'gradeRollOff'])
  for (const spec of GRADE_SLIDERS) {
    const range = sliderRange(spec)
    assert.equal(readPath(NEUTRAL_GRADE as GradeState, spec.path), range.default, `${spec.id} starts at its default`)
    const state = neutral()
    writePath(state, spec.path, range.max + 1)
    assert.equal(readPath(state, spec.path), range.max, `${spec.id} clamps to its max`)
    writePath(state, spec.path, Number.NaN)
    assert.equal(readPath(state, spec.path), range.min)
    writePath(state, spec.path, range.default)
    assert.deepEqual(state, NEUTRAL_GRADE, `${spec.id} back at its default is neutral again`)
    for (const v of [range.min, range.default, range.max]) {
      const text = spec.format(v)
      assert.equal(typeof text, 'string')
      assert.doesNotMatch(text, /NaN|undefined|-0\b/)
    }
  }
  // Moving any of them off its default changes the grade, except the four plan 2.5 ignores.
  const ignored = ['gradePivot', 'gradeBalance', 'gradeBlending', 'gradeRollOff']
  for (const spec of GRADE_SLIDERS) {
    const state = neutral()
    const range = sliderRange(spec)
    writePath(state, spec.path, range.default + range.step * (range.default < range.max ? 1 : -1))
    assert.equal(isGradeIdentity(state, null), ignored.includes(spec.id), spec.id)
  }
  assert.throws(() => sliderRange({ path: ['curves'] }), RangeError)
})

test('readouts: signed values with a real minus and no −0, the pivot as an sRGB code, gamma as γ', () => {
  assert.equal(signed(0.0123, 3), '+0.012')
  assert.equal(signed(-0.004, 3), '−0.004')
  assert.equal(signed(-0.0001, 3), '0.000')
  assert.equal(signed(0, 0), '0')
  const format = (id: string, v: number) => GRADE_SLIDERS.find((spec) => spec.id === id)!.format(v)
  assert.equal(format('gradePivot', GRADE_RANGES.pivot.default), 'sRGB 118')
  assert.equal(format('gradeGammaY', 1), '+1.00 · γ 2.00')
  assert.equal(format('gradeGainY', 1), '1.00×')
  assert.equal(format('gradeSaturation', 1.15), '115%')
  assert.equal(LOOK_AMOUNT_SLIDER.format(0.65), '65%')
  assert.equal(toggleText('◐ Grade', true), '◐ Grade · On')
  assert.equal(toggleText('◧ Compare', false), '◧ Compare · Off')
})

test('heldEditsNote names what a tab cannot edit yet but the grade holds', () => {
  const state = neutral()
  for (const tab of ['primary', 'curves', 'hue', 'tones'] as const) assert.equal(heldEditsNote(state, tab), '')
  state.lift.u = 0.2
  state.gain.v = -0.1
  state.curves.master = [[0, 0.02], [1, 1]]
  state.curves.blue = [[0, 0], [0.5, 0.45], [1, 1]]
  state.hueSat = [[100, 1.2]]
  state.hueLuma = [[40, 0]]
  state.tones.highlights = { u: 0.1, v: 0 }
  assert.match(heldEditsNote(state, 'primary'), /lift and gain wheels/)
  assert.match(heldEditsNote(state, 'curves'), /the master and blue curves/)
  assert.match(heldEditsNote(state, 'hue'), /^Held: hue vs sat \(1 point\), graded/)
  assert.doesNotMatch(heldEditsNote(state, 'hue'), /luma/, 'a hue curve at neutral is not held')
  assert.match(heldEditsNote(state, 'tones'), /^Held highlight tint/)
})

// ---- the markup (threejs-test.html) against these tables

/** The opening tag of the element with this id, or null. */
function tagOf(id: string): string | null {
  const matches = [...HTML.matchAll(new RegExp(`<[a-z]+\\b[^>]*\\bid="${id}"[^>]*>`, 'g'))]
  assert.ok(matches.length <= 1, `#${id} is unique`)
  return matches[0]?.[0] ?? null
}
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]
function sectionTag(): string {
  const tag = tagOf(GRADE_ELEMENT_IDS.section)
  assert.ok(tag)
  return tag!
}

test('the markup has every element the editor and the footer look up', () => {
  const footer = ['designCopy', 'designPaste', 'designPasteBox', 'designPasteText', 'designPasteApply', 'designPasteCancel',
    'designPasteStatus', 'designCopyBox', 'designCopyText', 'designCopyClose']
  const sliderIds = [...GRADE_SLIDERS.map((spec) => spec.id), LOOK_AMOUNT_SLIDER.id]
  for (const id of [...Object.values(GRADE_ELEMENT_IDS), ...footer, ...sliderIds, ...sliderIds.map((id) => `${id}Val`)]) {
    assert.ok(tagOf(id), `#${id} is in threejs-test.html`)
  }
  for (const tab of GRADE_TABS) {
    const group = tagOf(GRADE_TAB_GROUPS[tab])!
    assert.equal(/\shidden[\s>]/.test(group), tab !== 'primary', `only Primary shows at first (${tab})`)
    assert.match(HTML, new RegExp(`data-tab="${tab}"[^>]*aria-controls="${GRADE_TAB_GROUPS[tab]}"`))
  }
  assert.match(tagOf('gradeSplit')!, /\shidden>/, 'the split overlay starts hidden')
  assert.match(tagOf('gradeFile')!, /type="file"/)
  assert.match(tagOf('gradeFile')!, /accept="\.cube,\.CUBE"/)
})

test('the markup\'s ranges match GRADE_RANGES, and the section sits after Tone & colour', () => {
  for (const spec of [...GRADE_SLIDERS, { id: LOOK_AMOUNT_SLIDER.id, range: LOOK_AMOUNT_SLIDER.range }]) {
    const tag = tagOf(spec.id)!
    const range = 'range' in spec ? spec.range : sliderRange(spec)
    assert.equal(attr(tag, 'type'), 'range')
    assert.equal(Number(attr(tag, 'min')), range.min, `${spec.id} min`)
    assert.equal(Number(attr(tag, 'max')), range.max, `${spec.id} max`)
    assert.equal(Number(attr(tag, 'step')), range.step, `${spec.id} step`)
  }
  const tone = HTML.indexOf('<summary>Tone &amp; colour</summary>')
  const grade = HTML.indexOf(sectionTag())
  const fog = HTML.indexOf('<summary>Ground fog</summary>')
  assert.ok(tone > 0 && tone < grade && grade < fog, 'Tone & colour, then Colour grade, then Ground fog')
  assert.match(sectionTag(), /class="design-section"/)
  // The 320 px rule has to sit inside min-width, or it beats the phone sheet's width: 100%.
  assert.match(HTML, /@media \(min-width: 701px\) \{ body\.grade-open #designPanel \{ width: 320px; \} \}/)
})
