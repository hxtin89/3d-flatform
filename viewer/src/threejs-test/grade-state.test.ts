import { test } from 'node:test'
import assert from 'node:assert/strict'

import { GRADE_RANGES, NEUTRAL_GRADE, parseGradeState, type GradeState, type LookRef } from './grade-model.ts'
import {
  createHistory, createSnapshots, gradeSnippet, lookFileName, parseGradePaste, pasteSummary, PASTE_IGNORED_NOTE,
  type GradeSnapshot,
} from './grade-state.ts'

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

const neutral = (): GradeState => structuredClone(NEUTRAL_GRADE) as GradeState

/** Every control off neutral, with the awkward numbers: 0.1 + 0.2, a puck on the rim, −0. */
const BUSY_INPUT = {
  version: 1,
  temperature: 12,
  tint: -7,
  lift: { y: -0.012, u: 0.3, v: -0.2 },
  gamma: { y: 0.15, u: -0, v: 0.4 },
  gain: { y: 1.08, u: -0.1, v: 0.05 },
  offset: { y: 0.004, u: 0.6, v: 0.8 },
  contrast: 1.2,
  pivot: 0.45,
  saturation: 0.1 + 0.2,
  vibrance: -0.35,
  curves: {
    master: [[0, 0.02], [0.25, 0.22], [0.75, 0.8], [1, 0.97]],
    red: [[0, 0], [0.5, 0.53], [1, 1]],
    green: [[0, 0], [1, 1]],
    blue: [[0, 0.01], [0.3, 0.28], [0.6, 0.61], [0.9, 0.88], [1, 0.99]],
  },
  hueSat: [[95, 1.2], [210, 0.8], [350, 1.05]],
  hueLuma: [[100, -0.2]],
  tones: { shadows: { u: 0.2, v: -0.1 }, highlights: { u: -0.3, v: 0.25 }, balance: 0.2, blending: 0.7 },
  rollOff: 0.4,
}
const busyRead = parseGradeState(BUSY_INPUT)
const BUSY = busyRead.state

const SAVED_LOOK: LookRef = { key: 'grades/evergreen.cube', name: 'Evergreen', file: 'evergreen.cube', size: 33, amount: 0.8 }
const SESSION_LOOK: LookRef = { key: 'import-1', name: 'F125 Kodak 2393.cube', file: null, size: 21, amount: 0.65 }

/**
 * A Copy values text in the layout of main.ts's (its #designCopy handler): the same blocks in
 * the same order, the same keys and JSON.stringify(…, null, 2), one block per line start, with
 * the grade block where plan 4.11 appends it (`\ngrade: ${snippet}` after toneMapping) or at the
 * very end. The values are plausible ones, not the config's; the strings, nested objects, arrays
 * and nulls are where they are in the real dump.
 */
function copyValuesDump(gradeBody: string | null, gradeAt: 'afterToneMapping' | 'end' = 'afterToneMapping') {
  const blocks = [
    `design: ${JSON.stringify({
      maskMode: 2,
      mapSaturation: 0.85,
      mapBrightness: 1.4,
      pointContrast: 1.05,
      pointSaturation: 1.1,
      pointGradeEnabled: true,
      colourMatch: { enabled: true, strength: 1, referenceBrightness: 1.4, fieldDir: 'colour-field/' },
      droneOrtho: {
        enabled: true, minZoom: 15, presets: { strong: 'full', medium: 'half', constrained: 'off' }, force: null,
        fullMinDownlinkMbps: 10, fetchTimeoutMs: 20000, composeTimeoutMs: 5000, maxConcurrentComposes: 2,
        maxOrthoRequests: 2, settleMs: 1000, forbiddenLimit: 3,
      },
      basemapErrorTarget: 2,
      groundPatch: { enabled: true, color: '0x3b4a2a', amount: 0.6, colorMix: 0.5, brightness: 0.9, blurM: 12, threshold: 0.2 },
      maskFringe: 0.3,
      maskFringeCurve: 1.5,
      surroundColor: '0x0d1117',
      surroundOpacity: 0.8,
      surroundTint: 0.25,
      vignettePosition: { sideAngleDeg: 30, topAngleDeg: 20, sideForwardOffsetM: 40, sideMinRadiusM: 80, sideMaxVignetteStrength: 0.6 },
      groundFog: {
        enabled: true, strength: 0.5, baseOffsetM: 2, heightM: 30, fadeBelowM: 5, efoldDistanceM: 400, curve: 1.2,
        color: '0xdfe6ea', tint: 0.3,
      },
    }, null, 2)}`,
    `pointLighting: ${JSON.stringify({
      cloudShadowsEnabled: true, cloudShadowStrength: 0.45, cloudShadowScaleM: 900, cloudShadowContrast: 1.3,
    }, null, 2)}`,
    `atmosphere: ${JSON.stringify({
      distanceFogEnabled: false,
      fogNearFactor: 1.5,
      fogFarFactor: 6,
      haze: { enabled: true, skyGradient: true, startM: 300, distanceM: 4000, strength: 0.6, horizonBlend: 0.4, zenithElevation: 0.6 },
    }, null, 2)}`,
    `toneMapping: ${JSON.stringify({
      enabled: true,
      mode: 'film',
      exposure: 1.1,
      whitePoint: 1.6,
      film: {
        toneEnabled: true, contrast: 1.12, saturation: 0.95, split: 0.4, splitEnabled: true,
        shadowTint: [0.02, 0.05, 0.04], highlightTint: [0.06, 0.03, -0.01],
        liftEnabled: true, lift: 0.1, vignette: 0.3, vignetteEnabled: true, whitePoint: 1.6,
      },
    }, null, 2)}`,
    `eyeDomeLighting: ${JSON.stringify({ enabled: true, strength: 0.8, radiusPx: 1.5, floor: 0.2 }, null, 2)}`,
    `depthOfField: ${JSON.stringify({
      enabled: true, autoFocus: true, focusDistanceM: 120, focalLengthM: 0.05, bokehScale: 2, focusSmoothing: 0.1,
    }, null, 2)}`,
  ]
  if (gradeBody !== null) blocks.splice(gradeAt === 'end' ? blocks.length : 4, 0, `grade: ${gradeBody}`)
  return blocks.join('\n')
}

const OTHER_BLOCKS = ['design', 'pointLighting', 'atmosphere', 'toneMapping', 'eyeDomeLighting', 'depthOfField']

// ---- history --------------------------------------------------------------------------------

test('history: push, undo and redo walk the entries; canUndo and canRedo follow', () => {
  const h = createHistory<number>()
  assert.equal(h.canUndo(), false)
  assert.equal(h.canRedo(), false)
  assert.equal(h.undo(), null)
  assert.equal(h.redo(), null)
  assert.equal(h.current(), null)
  assert.equal(h.push(1), true)
  assert.equal(h.canUndo(), false, 'the starting point alone has nothing to go back to')
  h.push(2)
  h.push(3)
  assert.equal(h.current(), 3)
  assert.equal(h.canUndo(), true)
  assert.equal(h.undo(), 2)
  assert.equal(h.canRedo(), true)
  assert.equal(h.undo(), 1)
  assert.equal(h.canUndo(), false)
  assert.equal(h.undo(), null, 'nothing before the oldest')
  assert.equal(h.current(), 1)
  assert.equal(h.redo(), 2)
  assert.equal(h.redo(), 3)
  assert.equal(h.canRedo(), false)
  assert.equal(h.redo(), null, 'nothing after the newest')
  assert.equal(h.current(), 3)
})

test('history: a push after an undo cuts the redo branch', () => {
  const h = createHistory<string>()
  for (const s of ['a', 'b', 'c', 'd']) h.push(s)
  assert.equal(h.undo(), 'c')
  assert.equal(h.undo(), 'b')
  h.push('x')
  assert.equal(h.canRedo(), false, 'c and d are gone')
  assert.equal(h.redo(), null)
  assert.equal(h.undo(), 'b')
  assert.equal(h.undo(), 'a')
  assert.equal(h.redo(), 'b')
  assert.equal(h.redo(), 'x')
  assert.equal(h.redo(), null)
})

test('history: an entry equal to the present is not recorded and keeps the redo branch', () => {
  const h = createHistory<GradeSnapshot>()
  h.push({ state: neutral(), look: null })
  h.push({ state: BUSY, look: SAVED_LOOK })
  assert.equal(h.push({ state: structuredClone(BUSY), look: { ...SAVED_LOOK } }), false, 'equal by value')
  assert.equal(h.undo()?.look, null)
  assert.equal(h.canUndo(), false, 'the duplicate added no step')
  assert.equal(h.push({ state: neutral(), look: null }), false, 'a commit that changed nothing after an undo')
  assert.equal(h.canRedo(), true, 'so the redo branch is kept')
  assert.deepEqual(h.redo(), { state: BUSY, look: SAVED_LOOK })
  const state = structuredClone(BUSY)
  state.gamma.u = 0.4
  assert.equal(h.push({ state, look: SAVED_LOOK }), true, 'one puck moved is a change')
  // 0 and −0 are one value: JSON, the bake and isGradeIdentity cannot tell them apart.
  const zero = structuredClone(state)
  zero.lift.y = -0
  const negative = createHistory<GradeState>()
  negative.push({ ...zero, lift: { ...zero.lift, y: 0 } })
  assert.equal(negative.push(zero), false)
})

test('history: keeps the present and `limit` steps back, the oldest falls off', () => {
  const h = createHistory<number>(3)
  for (let i = 0; i < 10; i++) h.push(i)
  const back: number[] = []
  for (let v = h.undo(); v !== null; v = h.undo()) back.push(v)
  assert.deepEqual(back, [8, 7, 6])
  const forward: number[] = []
  for (let v = h.redo(); v !== null; v = h.redo()) forward.push(v)
  assert.deepEqual(forward, [7, 8, 9])

  const standard = createHistory<number>()
  for (let i = 0; i < 150; i++) standard.push(i)
  let steps = 0
  while (standard.undo() !== null) steps++
  assert.equal(steps, 100, 'the default limit is 100 undo steps')
  assert.equal(standard.current(), 49)

  assert.throws(() => createHistory(0), RangeError)
  assert.throws(() => createHistory(2.5), RangeError)
  assert.throws(() => createHistory(Number.NaN), RangeError)
})

test('history: stores copies and hands out copies, of the state and the look together', () => {
  const h = createHistory<GradeSnapshot>()
  const state = neutral()
  const look = { ...SESSION_LOOK }
  h.push({ state, look })
  state.temperature = 40
  look.amount = 0.1
  assert.deepEqual(h.current(), { state: neutral(), look: SESSION_LOOK }, 'editing after the push does not reach the entry')
  h.push({ state: BUSY, look: null })
  const back = h.undo()!
  assert.deepEqual(back, { state: neutral(), look: SESSION_LOOK }, 'undo restores the look with the state')
  back.state.curves.master.push([0.5, 0.9])
  back.look!.name = 'changed'
  assert.deepEqual(h.current(), { state: neutral(), look: SESSION_LOOK }, 'editing what undo returned does not either')
  assert.deepEqual(h.redo(), { state: BUSY, look: null })
  // NEUTRAL_GRADE is frozen; what comes back is not, so the editor can patch it in place.
  h.push({ state: NEUTRAL_GRADE as GradeState, look: null })
  const fresh = h.current()!
  assert.equal(Object.isFrozen(fresh.state), false)
  fresh.state.tint = 3
})

// ---- snapshots ------------------------------------------------------------------------------

test('snapshots: tapping an empty slot stores, tapping a stored one recalls; Store overwrites the selected slot', () => {
  const s = createSnapshots()
  assert.equal(s.selected(), null)
  assert.equal(s.has('A'), false)
  assert.equal(s.has('B'), false)
  assert.equal(s.recall('A'), null)

  const first: GradeSnapshot = { state: BUSY, look: SAVED_LOOK }
  assert.equal(s.tap('A', first), null, 'an empty slot stores and has nothing to recall')
  assert.equal(s.has('A'), true)
  assert.equal(s.selected(), 'A')

  const second: GradeSnapshot = { state: neutral(), look: null }
  assert.equal(s.tap('B', second), null)
  assert.equal(s.selected(), 'B')

  const recalled = s.tap('A', second)
  assert.deepEqual(recalled, first, 'a stored slot gives what it holds, not the current grade')
  assert.equal(s.selected(), 'A', 'and becomes the selected slot')
  recalled!.state.temperature = -50
  assert.deepEqual(s.recall('A'), first, 'the recall is a copy')

  const third: GradeSnapshot = { state: { ...neutral(), saturation: 1.4 }, look: { ...SESSION_LOOK } }
  assert.equal(s.store(third), 'A', 'Store goes to the selected slot')
  assert.deepEqual(s.recall('A'), third)
  assert.deepEqual(s.recall('B'), second, 'the other slot is untouched')
  third.look!.amount = 0
  assert.equal(s.recall('A')!.look!.amount, SESSION_LOOK.amount, 'store keeps a copy')

  assert.equal(s.store(first, 'B'), 'B', 'an explicit slot wins')
  assert.equal(s.selected(), 'B')
  assert.deepEqual(s.tap('B', second), first)
  assert.equal(s.store(third), 'B', 'Store follows the selection to B')
  assert.deepEqual(s.recall('B'), third)
  assert.deepEqual(s.recall('A'), { state: { ...neutral(), saturation: 1.4 }, look: SESSION_LOOK })

  s.clear('A')
  assert.equal(s.has('A'), false)
  assert.equal(s.has('B'), true)
  s.clear()
  assert.equal(s.has('B'), false)
  assert.equal(s.selected(), null)
  assert.equal(s.store(second), 'A', 'Store with nothing selected goes to A')

  assert.throws(() => s.tap('C' as 'A', second), RangeError)
  assert.throws(() => s.store(second, 'a' as 'A'), RangeError)
})

// ---- the grade: snippet ---------------------------------------------------------------------

/** Every leaf of a parsed JSON value, with its path. */
function leaves(value: unknown, path = ''): Array<[string, unknown]> {
  if (value === null || typeof value !== 'object') return [[path, value]]
  return Object.entries(value).flatMap(([key, v]) => leaves(v, path ? `${path}.${key}` : key))
}

test('gradeSnippet: config-shaped JSON, numbers only, keys in config order, short values on one line', () => {
  assert.deepEqual(busyRead.warnings, [], 'the busy fixture is a clean state')
  const text = gradeSnippet(true, 33, null, BUSY)
  const value = JSON.parse(text)
  assert.deepEqual(value, { enabled: true, lutSize: 33, look: null, state: BUSY })
  assert.deepEqual(Object.keys(value), ['enabled', 'lutSize', 'look', 'state'])
  assert.deepEqual(Object.keys(value.state), Object.keys(NEUTRAL_GRADE), 'the state in config 4.13 order')
  for (const [path, leaf] of leaves(value)) {
    assert.ok(typeof leaf === 'number' || typeof leaf === 'boolean' || leaf === null, `${path} is ${typeof leaf}`)
  }
  const lines = text.split('\n')
  assert.equal(lines[0], '{')
  assert.equal(lines.at(-1), '}')
  assert.ok(!text.includes('\r'), 'LF only')
  assert.ok(lines.every((line) => line.length <= 100), 'no line over 100 columns')
  assert.ok(lines.includes('    "lift": { "y": -0.012, "u": 0.3, "v": -0.2 },'), 'a wheel is one line')
  assert.ok(lines.includes('      "red": [[0, 0], [0.5, 0.53], [1, 1]],'), 'a short curve is one line')
  assert.ok(lines.includes('    "saturation": 0.30000000000000004,'), 'numbers are written exactly')
  assert.ok(lines.includes('    "gamma": { "y": 0.15, "u": 0, "v": 0.4 },'), '−0 is written as 0')

  const neutralText = gradeSnippet(false, 33, null, neutral())
  assert.deepEqual(JSON.parse(neutralText), { enabled: false, lutSize: 33, look: null, state: NEUTRAL_GRADE })
  assert.ok(neutralText.includes('\n    "hueSat": [],\n'))

  // A curve too long for one line breaks one point per line.
  const long = structuredClone(BUSY)
  long.curves.master = Array.from({ length: 12 }, (_, i) => [i / 11, (i / 11) ** 1.3] as [number, number])
  const longText = gradeSnippet(true, 33, null, long)
  assert.ok(longText.split('\n').every((line) => line.length <= 100))
  assert.deepEqual(JSON.parse(longText).state.curves.master, long.curves.master)
  assert.ok(longText.includes('      "master": [\n        [0, 0],\n'))
})

test('gradeSnippet: a saved look is its file; a look imported this session is named, with the note to save it', () => {
  const saved = gradeSnippet(true, 33, SAVED_LOOK, BUSY)
  assert.deepEqual(JSON.parse(saved).look, { file: 'evergreen.cube', amount: 0.8 }, 'file and amount only, no key, name or size')
  assert.ok(!saved.includes('//'))

  const session = gradeSnippet(true, 33, SESSION_LOOK, BUSY)
  const lookLine = session.split('\n').find((line) => line.includes('"look"'))
  assert.equal(lookLine,
    '  "look": { "file": "F125 Kodak 2393.cube", "amount": 0.65 }, // save it as public/grades/F125 Kodak 2393.cube to keep it')
  assert.throws(() => JSON.parse(session), 'the note makes it config.ts text, not strict JSON')
  const pasted = parseGradePaste(`grade: ${session}`)
  assert.deepEqual(pasted.warnings, [])
  assert.deepEqual(pasted.grade?.look, { file: 'F125 Kodak 2393.cube', amount: 0.65 })

  const unnamed = gradeSnippet(true, 33, { name: 'Lumetri: Fuji "Eterna"', file: null, amount: 1 }, BUSY)
  assert.ok(unnamed.includes('"file": "Lumetri- Fuji -Eterna-.cube"'))
})

test('lookFileName: a plain file name under public/grades/ that a paste accepts back', () => {
  const cases: Array<[string, string]> = [
    ['F125 Kodak 2393', 'F125 Kodak 2393.cube'],
    ['Evergreen.CUBE', 'Evergreen.CUBE'],
    ['C:\\fakepath\\look:v2?.cube', 'look-v2-.cube'],
    ['../../etc/passwd', 'passwd.cube'],
    ['.hidden.cube', 'hidden.cube'],
    ['a\tb\nc', 'a-b-c.cube'],
    ['50% #2', '50- -2.cube'],
    ['', 'look.cube'],
    ['   ', 'look.cube'],
    ['#%', 'look.cube'],
    ['.cube', 'look.cube'],
  ]
  for (const [name, file] of cases) {
    assert.equal(lookFileName(name), file, JSON.stringify(name))
    const pasted = parseGradePaste(JSON.stringify({ look: { file, amount: 1 }, state: {} }))
    assert.deepEqual(pasted.grade?.look, { file, amount: 1 }, `${file} is accepted back`)
  }
})

// ---- Paste values ---------------------------------------------------------------------------

test('parseGradePaste: a whole Copy values dump gives the grade and lists the other blocks as ignored', () => {
  for (const gradeAt of ['afterToneMapping', 'end'] as const) {
    for (const look of [null, SAVED_LOOK, SESSION_LOOK]) {
      const dump = copyValuesDump(gradeSnippet(true, 33, look, BUSY), gradeAt)
      const expected = { enabled: true, lutSize: 33, look: look && { file: look.file ?? lookFileName(look.name), amount: look.amount }, state: BUSY }
      const paste = parseGradePaste(dump)
      assert.deepEqual(paste.warnings, [], `${gradeAt}, look ${look?.name}`)
      assert.deepEqual(paste.ignored, OTHER_BLOCKS)
      assert.deepEqual(paste.grade, expected)
      // The same through the console fallback (main.ts logs `[design]\n${snippet}`), copied with
      // or without the console's source location, and with Windows line ends.
      for (const variant of [`[design]\n${dump}`, `main.ts:4088 [design]\n${dump}`, dump.replace(/\n/g, '\r\n'), `\uFEFF${dump}\n\n`]) {
        const again = parseGradePaste(variant)
        assert.deepEqual(again.warnings, [])
        assert.deepEqual(again.ignored, OTHER_BLOCKS)
        assert.deepEqual(again.grade, expected)
      }
    }
  }
  assert.equal(pasteSummary(parseGradePaste(copyValuesDump(gradeSnippet(true, 33, null, BUSY)))),
    `Grade pasted. ${OTHER_BLOCKS.join(', ')} ${PASTE_IGNORED_NOTE}.`)
})

test('parseGradePaste: a dump from before the grade existed has nothing to apply', () => {
  const paste = parseGradePaste(copyValuesDump(null))
  assert.equal(paste.grade, undefined)
  assert.deepEqual(paste.ignored, OTHER_BLOCKS)
  assert.deepEqual(paste.warnings, ['paste: no grade block, nothing applied'])
  assert.match(pasteSummary(paste), /^No grade pasted\. design, .* not applied: only grade is pasted in this version\. 1 warning: paste: no grade block/)
})

test('parseGradePaste: a bare grade: block, the bare snippet, the wrapper as JSON and a state alone', () => {
  const snippet = gradeSnippet(false, 17, SAVED_LOOK, BUSY)
  const wrapper = { enabled: false, lutSize: 17, look: { file: 'evergreen.cube', amount: 0.8 }, state: BUSY }
  for (const text of [`grade: ${snippet}`, snippet, `grade:\n${snippet}`, `grade:${snippet}`, JSON.stringify(wrapper), JSON.stringify(wrapper, null, 2)]) {
    const paste = parseGradePaste(text)
    assert.deepEqual(paste.warnings, [], text.slice(0, 30))
    assert.deepEqual(paste.ignored, [])
    assert.deepEqual(paste.grade, wrapper)
  }
  // A state alone sets the state only: no enabled, lutSize or look key, so the editor keeps those.
  for (const text of [JSON.stringify(BUSY), JSON.stringify(BUSY, null, 2), `grade: ${JSON.stringify(BUSY)}`]) {
    const paste = parseGradePaste(text)
    assert.deepEqual(paste.warnings, [])
    assert.deepEqual(paste.grade, { state: BUSY })
    assert.equal(Object.hasOwn(paste.grade!, 'look'), false)
  }
  // A partial state is filled with defaults; an empty object is the neutral grade.
  assert.deepEqual(parseGradePaste('{"temperature": 20}').grade, { state: { ...neutral(), temperature: 20 } })
  assert.deepEqual(parseGradePaste('{}').grade, { state: neutral() })
  // look: null is kept apart from no look: null removes the look.
  assert.deepEqual(parseGradePaste('{"look": null, "state": {}}').grade, { look: null, state: neutral() })
})

test('gradeSnippet → parseGradePaste gives the same grade back, for neutral, busy and 200 random states', () => {
  const random = seeded(4)
  const pick = (r: { min: number; max: number }) => r.min + random() * (r.max - r.min)
  const puck = () => {
    const a = random() * Math.PI * 2
    const m = random() < 0.2 ? 0 : random() < 0.2 ? 1 : random()
    return { u: Math.cos(a) * m, v: Math.sin(a) * m }
  }
  const tone = () => {
    const points: number[][] = [[0, random() * 0.2]]
    for (let i = 0; i < Math.floor(random() * 6); i++) points.push([0.05 + random() * 0.9, random()])
    points.push([1, 0.8 + random() * 0.2])
    return points
  }
  const hue = (yMin: number, yMax: number) => Array.from({ length: Math.floor(random() * 8) }, () => [random() * 360, yMin + random() * (yMax - yMin)])
  const states: GradeState[] = [neutral(), BUSY]
  for (let i = 0; i < 200; i++) {
    const R = GRADE_RANGES
    states.push(parseGradeState({
      temperature: pick(R.temperature), tint: pick(R.tint),
      lift: { y: pick(R.lift.y), ...puck() }, gamma: { y: pick(R.gamma.y), ...puck() },
      gain: { y: pick(R.gain.y), ...puck() }, offset: { y: pick(R.offset.y), ...puck() },
      contrast: pick(R.contrast), pivot: pick(R.pivot), saturation: pick(R.saturation), vibrance: pick(R.vibrance),
      curves: { master: tone(), red: tone(), green: tone(), blue: tone() },
      hueSat: hue(0, 2), hueLuma: hue(-1, 1),
      tones: { shadows: puck(), highlights: puck(), balance: pick(R.tones.balance), blending: pick(R.tones.blending) },
      rollOff: pick(R.rollOff),
    }).state)
  }
  const looks = [null, SAVED_LOOK, SESSION_LOOK, { ...SAVED_LOOK, amount: 0 }, { ...SAVED_LOOK, file: 'wi/evergreen v2.cube', amount: 1 / 3 }]
  states.forEach((state, i) => {
    const look = looks[i % looks.length]
    const enabled = i % 3 !== 0
    const lutSize = [33, 17, 65][i % 3]
    const paste = parseGradePaste(copyValuesDump(gradeSnippet(enabled, lutSize, look, state)))
    assert.deepEqual(paste.warnings, [], `state ${i}`)
    assert.deepEqual(paste.grade, {
      enabled, lutSize, look: look && { file: look.file ?? lookFileName(look.name), amount: look.amount }, state,
    }, `state ${i}`)
  })
})

test('parseGradePaste: comments, trailing commas and escapes are read; strings keep their slashes', () => {
  const text = [
    '// pasted from a note',
    '{',
    '  "enabled": true, /* on */',
    '  "look": { "file": "say \\"hi\\" /*x*/.cube", "amount": 0.5, }, // a trailing comma inside',
    '  "state": { "temperature": 3, "curves": { "master": [[0, 0], [0.5, 0.6], [1, 1],], }, },',
    '},',
  ].join('\r\n')
  const paste = parseGradePaste(`\uFEFF${text}`)
  assert.deepEqual(paste.warnings, [])
  assert.equal(paste.grade?.enabled, true)
  assert.deepEqual(paste.grade?.look, { file: 'say "hi" /*x*/.cube', amount: 0.5 })
  assert.equal(paste.grade?.state.temperature, 3)
  assert.deepEqual(paste.grade?.state.curves.master, [[0, 0], [0.5, 0.6], [1, 1]])
})

test('parseGradePaste: tolerant per field, every problem a warning', () => {
  const paste = parseGradePaste(JSON.stringify({
    enabled: 'yes',
    lutSize: 33.5,
    look: { file: '../secret.cube', amount: 0.5 },
    maxLattice: 33,
    tuning: {},
    colour: 1,
    state: { temperature: 500, saturation: 'lots', curves: { master: [[0, 0], [0.5, 0.6], [0.505, 0.61], [1, 1]] } },
  }))
  const grade = paste.grade!
  assert.ok(grade)
  assert.deepEqual(Object.keys(grade).sort(), ['state'], 'enabled, lutSize and look were not valid')
  assert.equal(grade.state.temperature, 100)
  assert.equal(grade.state.saturation, 1)
  assert.equal(grade.state.curves.master.length, 3, 'the point too close to its neighbour is dropped')
  for (const pattern of [/^grade\.enabled: "yes"/, /^grade\.lutSize: 33\.5/, /^grade\.look\.file: "\.\.\/secret\.cube"/,
    /^grade\.maxLattice: config only/, /^grade\.tuning: config only/, /^grade\.colour: unknown/,
    /^temperature: 500 clamped to 100$/, /^saturation: "lots" is not a number/, /^curves\.master/]) {
    assert.ok(paste.warnings.some((w) => pattern.test(w)), `${pattern} in ${JSON.stringify(paste.warnings)}`)
  }

  for (const lutSize of [1, 257, -33, '33', null]) {
    const p = parseGradePaste(JSON.stringify({ lutSize, state: {} }))
    assert.equal(Object.hasOwn(p.grade!, 'lutSize'), false, String(lutSize))
    assert.equal(p.warnings.length, 1)
  }
  assert.equal(parseGradePaste('{"lutSize": 2, "state": {}}').grade?.lutSize, 2)
  assert.equal(parseGradePaste('{"lutSize": 256, "state": {}}').grade?.lutSize, 256)

  const amount = parseGradePaste('{"look": {"file": "evergreen.cube", "amount": 2}, "state": {}}')
  assert.deepEqual(amount.grade?.look, { file: 'evergreen.cube', amount: 1 })
  assert.deepEqual(amount.warnings, ['grade.look.amount: 2 clamped to 1'])
  assert.deepEqual(parseGradePaste('{"look": {"file": "wi/evergreen.CUBE"}, "state": {}}').grade?.look,
    { file: 'wi/evergreen.CUBE', amount: 1 }, 'a missing amount is 1, a subfolder is fine')
  const extra = parseGradePaste('{"look": {"file": "evergreen.cube", "amount": 0.4, "key": "k", "size": 33}, "state": {}}')
  assert.deepEqual(extra.grade?.look, { file: 'evergreen.cube', amount: 0.4 })
  assert.deepEqual(extra.warnings, ['grade.look.key: unknown, ignored', 'grade.look.size: unknown, ignored'])

  for (const file of ['evergreen.png', '/abs.cube', 'a\\b.cube', 'a//b.cube', './a.cube', 'a/../b.cube', 'x/.', '', '  ', 42, null, 'a\u0000.cube']) {
    const p = parseGradePaste(JSON.stringify({ look: { file, amount: 1 }, state: {} }))
    assert.equal(Object.hasOwn(p.grade!, 'look'), false, `file ${JSON.stringify(file)}: the look is left as it is`)
    assert.equal(p.warnings.length, 1, JSON.stringify(file))
    assert.match(p.warnings[0], /^grade\.look\.file: .*look not applied$/)
  }
  for (const look of ['evergreen.cube', 3, [1]]) {
    const p = parseGradePaste(JSON.stringify({ look, state: {} }))
    assert.equal(Object.hasOwn(p.grade!, 'look'), false)
    assert.match(p.warnings[0], /^grade\.look: .* is not a \{ file, amount \} look/)
  }

  const noState = parseGradePaste('{"enabled": true, "lutSize": 33}')
  assert.deepEqual(noState.grade, { enabled: true, lutSize: 33, state: neutral() })
  assert.deepEqual(noState.warnings, ['grade.state: missing, neutral state used'])

  // State keys beside wrapper keys and no `state`: read as a state, the wrapper key reported.
  const mixed = parseGradePaste('{"temperature": 5, "enabled": true}')
  assert.deepEqual(mixed.grade, { state: { ...neutral(), temperature: 5 } })
  assert.deepEqual(mixed.warnings, ['enabled: unknown, ignored'])
})

test('parseGradePaste: several grade blocks give the last; text in front of the first block is reported', () => {
  const two = parseGradePaste('grade: {"state": {"temperature": 1}}\ngrade: {"state": {"temperature": 2}}')
  assert.equal(two.grade?.state.temperature, 2)
  assert.deepEqual(two.warnings, ['paste: 2 grade blocks, the last one read'])

  const front = parseGradePaste(`my notes\n${copyValuesDump(gradeSnippet(true, 33, null, BUSY))}`)
  assert.deepEqual(front.grade?.state, BUSY)
  assert.deepEqual(front.warnings, ['paste: text before the first block ignored'])

  // A broken grade block fails alone; the blocks around it are still listed.
  const broken = parseGradePaste(copyValuesDump('{ "state": { "temperature": 1 '))
  assert.equal(broken.grade, undefined)
  assert.deepEqual(broken.ignored, OTHER_BLOCKS)
  assert.equal(broken.warnings.length, 1)
  assert.match(broken.warnings[0], /^grade: not valid JSON \(.+\), nothing applied$/)
})

test('parseGradePaste: garbage gives warnings and no grade, and never throws', () => {
  const garbage: unknown[] = [
    '', '   \n\t ', 'hello world', '{', '}', '[1, 2]', '42', 'null', 'true', '"grade"', 'grade: {', 'grade: nonsense',
    'grade:', 'grade: []', 'grade: null', 'grade: 7', '\u0000\u0001', '{"a": 1', '/* only a comment */', '// x',
    `TITLE "x"\nLUT_3D_SIZE 2\n${'0 0 0\n'.repeat(8)}`,
    '['.repeat(100_000) + ']'.repeat(100_000),
    `{"state": ${'{"a": '.repeat(5000)}1${'}'.repeat(5000)}}`.slice(0, -1),
    undefined, null, 12, {}, ['grade: {}'],
  ]
  for (const text of garbage) {
    let paste: ReturnType<typeof parseGradePaste> | undefined
    assert.doesNotThrow(() => { paste = parseGradePaste(text as string) }, String(text).slice(0, 30))
    assert.equal(paste!.grade, undefined, String(text).slice(0, 30))
    assert.ok(paste!.warnings.length > 0, String(text).slice(0, 30))
    assert.ok(paste!.warnings.every((w) => typeof w === 'string' && w.length > 0))
    assert.match(pasteSummary(paste!), /^No grade pasted\./)
  }
  assert.deepEqual(parseGradePaste('LUT_3D_SIZE 33\n0 0 0').warnings,
    ['paste: this is a .cube file; load it with Import .cube in the Look tab'])
  assert.deepEqual(parseGradePaste('design: {}\npointLighting: {}').ignored, ['design', 'pointLighting'])

  // Junk values inside a readable block still give a grade: parseGradeState's own warnings.
  const junk = parseGradePaste('grade: {"state": {"temperature": "hot", "lift": 3, "hueSat": "lots"}}')
  assert.deepEqual(junk.grade, { state: neutral() })
  assert.equal(junk.warnings.length, 3)
})
