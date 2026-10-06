import { test } from 'node:test'
import assert from 'node:assert/strict'

import { HUE_SAT_CURVE } from './grade-curves.ts'
import { huePlot, toCanvas } from './grade-widget-logic.ts'

// The widgets on canvases from a fake DOM, just enough for grade-widgets.ts: EventTarget canvases
// laid out at a fixed size, no 2D context (nothing is drawn), pointer capture, no animation
// frames. Node's EventTarget has no tree, so a stopped event shows as cancelBubble.
class FakeCanvas extends EventTarget {
  width = 300
  height = 150
  clientLeft = 1
  clientTop = 1
  tabIndex = -1
  focused = false
  clientWidth: number
  clientHeight: number
  constructor(width = 0, height = 0) {
    super()
    this.clientWidth = width
    this.clientHeight = height
  }
  getContext() { return null }
  getBoundingClientRect() { return { left: 0, top: 0 } }
  setAttribute() {}
  closest() { return null }
  focus() { this.focused = true }
  blur() {
    if (!this.focused) return
    this.focused = false
    this.dispatchEvent(new Event('blur'))
  }
  setPointerCapture() {}
  hasPointerCapture() { return false }
  releasePointerCapture() {}
}
const g = globalThis as any
g.window = Object.assign(new EventTarget(), { devicePixelRatio: 1, setTimeout })
g.document = { createElement: () => new FakeCanvas() }
g.ResizeObserver = class { observe() {} disconnect() {} }
g.requestAnimationFrame = () => 1
g.cancelAnimationFrame = () => {}
const { createColourWheel, createCurveEditor, createHueCurveEditor } = await import('./grade-widgets.ts')

function event(type: string, init: Record<string, unknown>): Event {
  const e = new Event(type, { bubbles: true, cancelable: true })
  for (const [k, v] of Object.entries(init)) Object.defineProperty(e, k, { value: v })
  return e
}
const pointer = (type: string, init: Record<string, unknown>) =>
  event(type, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 0, clientY: 0, shiftKey: false, timeStamp: 0, ...init })
const key = (type: string, init: Record<string, unknown>) =>
  event(type, { key: '', code: '', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...init })
/** Dispatches and tells whether the event got past the widget. */
const reaches = (canvas: FakeCanvas, e: Event) => {
  canvas.dispatchEvent(e)
  return !e.cancelBubble
}

function wheel(puck = { u: 0.3, v: 0.2 }) {
  const canvas = new FakeCanvas(218, 218)
  const log: string[] = []
  const state = { puck }
  const widget = createColourWheel(canvas as any, {
    get: () => state.puck,
    set: (p) => { state.puck = p },
    onInput: () => log.push('input'),
    onCommit: () => log.push('commit'),
    onGrab: (id) => log.push(`grab ${id}`),
  })
  return { canvas, log, state, widget }
}

function curve(points: number[][] = [[0, 0], [0.25, 0.3], [0.5, 0.55], [1, 1]]) {
  const canvas = new FakeCanvas(268, 268)
  const curves: any = { master: points, red: [[0, 0], [1, 1]], green: [[0, 0], [1, 1]], blue: [[0, 0], [1, 1]] }
  let commits = 0
  const editor = createCurveEditor(canvas as any, {
    curves: () => curves, channel: () => 'master', setPoints: (p) => { curves.master = p },
    label: 'RGB curve', onInput() {}, onCommit: () => { commits++ },
  })
  return { canvas, curves, editor, commits: () => commits }
}

test('a keyup reaches the window unless the widget kept its keydown', () => {
  const { canvas } = wheel()
  // Shift went down over the map, where keyboard navigation took it; it comes up over the wheel.
  assert.equal(reaches(canvas, key('keyup', { key: 'Shift', code: 'ShiftLeft' })), true)
  assert.equal(reaches(canvas, key('keydown', { key: 'Shift', code: 'ShiftLeft', shiftKey: true })), false)
  assert.equal(reaches(canvas, key('keyup', { key: 'Shift', code: 'ShiftLeft' })), false, 'down and up here: kept')
  assert.equal(reaches(canvas, key('keydown', { key: 'w', code: 'KeyW' })), false)
  canvas.focus()
  canvas.blur()
  assert.equal(reaches(canvas, key('keyup', { key: 'w', code: 'KeyW' })), true, 'after a blur its keyup belongs elsewhere')
  assert.equal(reaches(canvas, key('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true })), true, 'Ctrl+Z goes on to the section')
  assert.equal(reaches(canvas, key('keyup', { key: 'z', code: 'KeyZ' })), true)
  const { canvas: curveCanvas } = curve()
  assert.equal(reaches(curveCanvas, key('keyup', { key: ' ', code: 'Space' })), true)
  assert.equal(reaches(curveCanvas, key('keydown', { key: ' ', code: 'Space' })), false)
  assert.equal(reaches(curveCanvas, key('keyup', { key: ' ', code: 'Space' })), false)
})

test('[ and ] pick points when typed with AltGr (Ctrl+Alt) or Option, and stay with the curve', () => {
  const { canvas, editor } = curve()
  assert.equal(reaches(canvas, key('keydown', { key: ']', code: 'Digit9', ctrlKey: true, altKey: true })), false)
  assert.equal(editor.selected(), 0)
  canvas.dispatchEvent(key('keydown', { key: ']', code: 'Digit9', ctrlKey: true, altKey: true, getModifierState: (m: string) => m === 'AltGraph' }))
  assert.equal(editor.selected(), 1)
  canvas.dispatchEvent(key('keydown', { key: '[', code: 'Digit5', altKey: true }))
  assert.equal(editor.selected(), 0)
})

test('a modifier pressed in an arrow-key run does not end it: one undo step', () => {
  const w = wheel({ u: 0.3, v: 0 })
  for (const init of [{ key: 'ArrowRight' }, { key: 'ArrowRight' }, { key: 'Shift', shiftKey: true }, { key: 'ArrowRight', shiftKey: true }]) {
    w.canvas.dispatchEvent(key('keydown', init))
  }
  w.widget.flush()
  assert.deepEqual(w.log.filter((x) => x === 'commit'), ['commit'])
  assert.equal(w.state.puck.u, 0.42)
  const c = curve([[0, 0], [0.5, 0.5], [1, 1]])
  for (const init of [{ key: ']' }, { key: ']' }, { key: 'ArrowUp' }, { key: 'Shift', shiftKey: true }, { key: 'ArrowUp', shiftKey: true }]) {
    c.canvas.dispatchEvent(key('keydown', init))
  }
  c.editor.flush()
  assert.equal(c.commits(), 1)
})

test('a wheel moves nothing until the pointer is past the slop, so a jittery double tap still resets', () => {
  for (const [pointerType, jitter] of [['touch', 6], ['mouse', 2]] as const) {
    const { canvas, state, log } = wheel()
    canvas.dispatchEvent(pointer('pointerdown', { pointerType, clientX: 100, clientY: 100, timeStamp: 1000 }))
    canvas.dispatchEvent(pointer('pointermove', { pointerType, clientX: 100 + jitter, clientY: 100, timeStamp: 1030 }))
    canvas.dispatchEvent(pointer('pointerup', { pointerType, clientX: 100 + jitter, clientY: 100, timeStamp: 1060 }))
    assert.deepEqual(state.puck, { u: 0.3, v: 0.2 }, `${pointerType}: the jitter moved nothing`)
    canvas.dispatchEvent(pointer('pointerdown', { pointerType, clientX: 101, clientY: 100, timeStamp: 1150 }))
    canvas.dispatchEvent(pointer('pointerup', { pointerType, clientX: 101, clientY: 100, timeStamp: 1200 }))
    assert.deepEqual(state.puck, { u: 0, v: 0 }, `${pointerType}: the double tap reset it`)
    assert.deepEqual(log, ['input', 'commit'], `${pointerType}: no peek for taps`)
  }
  // Past the slop the drag counts from the press: 20 px on a 100 px radius is 0.1.
  const { canvas, state, log } = wheel({ u: 0, v: 0 })
  canvas.dispatchEvent(pointer('pointerdown', { pointerId: 7, clientX: 100, clientY: 100 }))
  canvas.dispatchEvent(pointer('pointermove', { pointerId: 7, clientX: 102, clientY: 100 }))
  assert.deepEqual(state.puck, { u: 0, v: 0 })
  canvas.dispatchEvent(pointer('pointermove', { pointerId: 7, clientX: 120, clientY: 100 }))
  assert.deepEqual(state.puck, { u: 0.1, v: 0 })
  assert.equal(log[0], 'grab 7', 'the peek starts with the drag, for the pointer that holds it')
})

test('a redraw forgets the unsnapped puck (another wheel picked), but not during a drag', () => {
  const { canvas, state, widget } = wheel({ u: 0, v: 0 })
  // 0.01 is inside the 0.02 snap: the state stays at 0, the wheel carries 0.01 along.
  canvas.dispatchEvent(key('keydown', { key: 'ArrowRight' }))
  assert.deepEqual(state.puck, { u: 0, v: 0 })
  widget.redraw()
  canvas.dispatchEvent(key('keydown', { key: 'ArrowRight' }))
  assert.equal(state.puck.u, 0, 'starts over from the stored puck')
  canvas.dispatchEvent(key('keydown', { key: 'ArrowRight' }))
  assert.equal(state.puck.u, 0.02, 'and carries it again')
  // A drag carries its own: 0.005 a pixel on a 100 px radius, back under the snap and out again
  // with a redraw (a sync of the controls) between.
  state.puck = { u: 0, v: 0 }
  widget.redraw()
  canvas.dispatchEvent(pointer('pointerdown', { clientX: 100, clientY: 100 }))
  canvas.dispatchEvent(pointer('pointermove', { clientX: 104, clientY: 100 }))
  assert.equal(state.puck.u, 0.02)
  canvas.dispatchEvent(pointer('pointermove', { clientX: 101, clientY: 100 }))
  assert.equal(state.puck.u, 0, 'under the snap')
  widget.redraw()
  for (const x of [102, 103, 104]) canvas.dispatchEvent(pointer('pointermove', { clientX: x, clientY: 100 }))
  assert.equal(state.puck.u, 0.02, 'back where the pointer is: the redraw left the drag its puck')
})

test('a point is dragged off when the point, not the finger, leaves the plot', () => {
  const W = 270
  const H = 138
  const run = (grabOffsetY: number, pastBottomPx: number) => {
    const canvas = new FakeCanvas(W, H)
    let points: number[][] = [[100, 0.6], [220, 1.4]]
    createHueCurveEditor(canvas as any, {
      mode: () => 'sat', points: () => points as any, setPoints: (p) => { points = p }, label: 'hue', onInput() {}, onCommit() {},
    })
    const box = huePlot(W, H)
    const [px, py] = toCanvas(100, 0.6, box, HUE_SAT_CURVE)
    const T = { pointerType: 'touch', pointerId: 3 }
    // Client = local + the 1 px border.
    canvas.dispatchEvent(pointer('pointerdown', { ...T, clientX: px + 1, clientY: py + grabOffsetY + 1 }))
    const finger = box.top + box.height + pastBottomPx + grabOffsetY
    for (let y = py + grabOffsetY; y <= finger; y += 2) canvas.dispatchEvent(pointer('pointermove', { ...T, clientX: px + 1, clientY: y + 1 }))
    canvas.dispatchEvent(pointer('pointermove', { ...T, clientX: px + 1, clientY: finger + 1 }))
    canvas.dispatchEvent(pointer('pointerup', { ...T, clientX: px + 1, clientY: finger + 1 }))
    return points.some((p) => p[0] === 100)
  }
  assert.equal(run(20, 5), true, 'taken 20 px below: the point 5 px past stays (the finger is 25 px past)')
  assert.equal(run(-20, 40), false, 'taken 20 px above: the point 40 px past goes (the finger is 20 px past)')
  assert.equal(run(0, 25), false)
})
