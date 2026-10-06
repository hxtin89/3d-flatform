import { test } from 'node:test'
import assert from 'node:assert/strict'

import { HUE_LUMA_CURVE, HUE_SAT_CURVE, insertPoint, movePoint, TONE_CURVE, type Pt } from './grade-curves.ts'
import { luma, snapPuck, wheelChannels, type Puck } from './grade-model.ts'
import {
  bufferSize, canvasToPuck, clampToDisc, continuePuck, createKeyIsolation, curveKeyAction, curvePlot, curveReadout,
  discColour, DOUBLE_TAP_MS, DOUBLE_TAP_PX, dragPuck, dragSlopPx, fromCanvas, HIT_RADIUS_MOUSE_PX, HIT_RADIUS_TOUCH_PX,
  hitPoint, hitRadii, hitRadiusPx, hueCurveAt, hueCurveSamples, hueDomain, huePlot, hueReadout, hueStrip, isDoubleTap,
  isModifierKey, isShortcut, localPoint, missIntent, nudgePuck, nudgeSteps, outsideBy, pointKey, PUCK_STEP,
  PUCK_STEP_SHIFT, puckAngle, puckReadout, puckToCanvas, REMOVE_OUTSIDE_PX, renderDisc, stepSelection, storedPuck,
  toCanvas, toneCurveAt, toneCurveSamples, wheelGeometry, wheelKey, wheelReadout, widgetIsolatesKey, wrappedXs,
  type PlotBox, type WidgetKeyEvent,
} from './grade-widget-logic.ts'

const close = (a: number, b: number, eps = 1e-12) => Math.abs(a - b) <= eps

// ---- wheels

test('wheel geometry: the disc centred, as large as fits less the pad; u right, v up', () => {
  const g = wheelGeometry(218, 218, 9)
  assert.deepEqual(g, { cx: 109, cy: 109, radius: 100 })
  assert.equal(wheelGeometry(131, 200, 9).radius, 131 / 2 - 9, 'the short side decides')
  assert.equal(wheelGeometry(4, 4, 9).radius, 1, 'never below 1 px')
  assert.deepEqual(puckToCanvas({ u: 0, v: 0 }, g), [109, 109])
  assert.deepEqual(puckToCanvas({ u: 1, v: 0 }, g), [209, 109], 'u = 1 on the right rim (towards blue)')
  assert.deepEqual(puckToCanvas({ u: 0, v: 1 }, g), [109, 9], 'v = 1 on the top rim (towards red)')
  for (const p of [{ u: 0.3, v: -0.45 }, { u: -0.99, v: 0.01 }, { u: 0, v: -1 }]) {
    const [x, y] = puckToCanvas(p, g)
    const back = canvasToPuck(x, y, g)
    assert.ok(close(back.u, p.u) && close(back.v, p.v), 'canvas ↔ puck round trip')
  }
})

test('a wheel drag moves the puck relative to where it was: drag / (2·radius), a quarter with Shift, inside the disc', () => {
  const radius = 100
  const right = dragPuck({ u: 0, v: 0 }, 200, 0, radius, false)
  assert.ok(close(right.u, 1) && right.v === 0, 'a drag of two radii moves the puck one radius')
  const up = dragPuck({ u: 0.1, v: 0 }, 0, -50, radius, false)
  assert.ok(close(up.u, 0.1) && close(up.v, 0.25), 'screen up is +v; the start is kept')
  const fine = dragPuck({ u: 0, v: 0 }, 40, 0, radius, true)
  assert.ok(close(fine.u, 0.05), 'Shift: a quarter (40 / 200 · 0.25)')
  const coarse = dragPuck({ u: 0, v: 0 }, 40, 0, radius, false)
  assert.ok(close(fine.u / coarse.u, 0.25))
  // Past the rim it stays on the rim, in the drag's direction, and comes back at once.
  const out = dragPuck({ u: 0.9, v: 0 }, 300, 300, radius, false)
  assert.ok(close(Math.hypot(out.u, out.v), 1), 'clamped onto the rim')
  assert.ok(out.u > 0 && out.v < 0)
  const back = dragPuck(out, -20, 0, radius, false)
  assert.ok(back.u < out.u, 'a drag back inwards answers without a dead zone')
  assert.deepEqual(clampToDisc(0.3, 0.4), { u: 0.3, v: 0.4 })
  const rim = clampToDisc(3, 4)
  assert.ok(close(rim.u, 0.6) && close(rim.v, 0.8))
})

test('the stored puck snaps under 0.02 and rounds; the unsnapped one carries a slow drag or single nudges past the snap', () => {
  assert.deepEqual(storedPuck({ u: 0.015, v: 0.01 }), { u: 0, v: 0 }, 'inside the snap radius: exactly neutral')
  assert.deepEqual(storedPuck({ u: 0.123456, v: -0.0000001 }), { u: 0.1235, v: 0 }, '4 decimals, no −0')
  assert.deepEqual(storedPuck({ u: 1, v: 1e-9 }), snapPuck(1, 0))
  // A slow drag from neutral: each step alone is under the snap, together they leave it.
  let raw: Puck = { u: 0, v: 0 }
  let stored: Puck = { u: 0, v: 0 }
  for (let i = 0; i < 6; i++) {
    raw = dragPuck(continuePuck(raw, stored), 1, 0, 100, false)
    stored = storedPuck(raw)
  }
  assert.ok(close(raw.u, 0.03))
  assert.deepEqual(stored, { u: 0.03, v: 0 }, 'six 1 px moves at radius 100 reach 0.03')
  // Single 0.01 nudges, each its own key press.
  raw = { u: 0, v: 0 }
  stored = { u: 0, v: 0 }
  raw = nudgePuck(continuePuck(raw, stored), PUCK_STEP, 0)
  stored = storedPuck(raw)
  assert.deepEqual(stored, { u: 0, v: 0 }, 'the first nudge stays inside the snap')
  raw = nudgePuck(continuePuck(raw, stored), PUCK_STEP, 0)
  stored = storedPuck(raw)
  assert.deepEqual(stored, { u: 0.02, v: 0 }, 'the second leaves it')
  // Once something else has changed the state, the stored puck is the start.
  assert.deepEqual(continuePuck({ u: 0.015, v: 0 }, { u: 0.4, v: 0.1 }), { u: 0.4, v: 0.1 })
  assert.deepEqual(continuePuck(null, { u: 0.2, v: 0 }), { u: 0.2, v: 0 })
})

test('wheel keys: arrows nudge 0.01 (Shift 0.1) right = +u, up = +v; 0 resets; ten nudges make 0.1 exactly', () => {
  assert.deepEqual(wheelKey('ArrowRight', false), { action: 'nudge', du: PUCK_STEP, dv: 0 })
  assert.deepEqual(wheelKey('ArrowLeft', false), { action: 'nudge', du: -PUCK_STEP, dv: 0 })
  assert.deepEqual(wheelKey('ArrowUp', true), { action: 'nudge', du: 0, dv: PUCK_STEP_SHIFT })
  assert.deepEqual(wheelKey('ArrowDown', true), { action: 'nudge', du: 0, dv: -PUCK_STEP_SHIFT })
  assert.equal(PUCK_STEP, 0.01)
  assert.equal(PUCK_STEP_SHIFT, 0.1)
  assert.deepEqual(wheelKey('0', false), { action: 'reset' })
  assert.deepEqual(wheelKey('Escape', false), { action: 'blur' })
  for (const key of ['w', 'a', ' ', 'Enter', 'Delete', '[']) assert.equal(wheelKey(key, false), null)
  let raw: Puck = { u: 0, v: 0 }
  for (let i = 0; i < 10; i++) raw = nudgePuck(raw, PUCK_STEP, 0)
  assert.equal(raw.u, 0.1)
  for (let i = 0; i < 20; i++) raw = nudgePuck(raw, PUCK_STEP_SHIFT, 0)
  assert.deepEqual(raw, { u: 1, v: 0 }, 'nudges stop at the rim')
})

test('the disc shows the tint each direction adds: grey at the centre, blue right, red up, transparent outside', () => {
  const centre = discColour(0, 0)
  assert.deepEqual(centre, [0.5, 0.5, 0.5])
  const right = discColour(1, 0)
  assert.ok(close(right[2], 0.85) && right[2] > right[0], 'u = 1 adds blue: 0.5 + 0.35')
  const top = discColour(0, 1)
  assert.ok(top[0] > top[2] && top[0] > top[1], 'v = 1 adds red')
  for (const [u, v] of [[0.3, 0.2], [-0.7, 0.1], [0, -1]]) {
    const c = discColour(u, v)
    assert.ok(close(luma(c[0], c[1], c[2]), 0.5, 1e-9) || c.some((x) => x === 0 || x === 1), 'zero luma unless clamped')
  }
  // Odd, so pixel 20's centre is the disc's.
  const size = 41
  const g = wheelGeometry(size, size, 4)
  const data = renderDisc(size, size, g)
  const at = (x: number, y: number) => [...data.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)]
  assert.deepEqual(at(20, 20).slice(0, 3), [128, 128, 128], 'the centre is mid grey')
  assert.equal(at(20, 20)[3], 255)
  assert.deepEqual(at(0, 0), [0, 0, 0, 0], 'outside the rim: transparent')
  const rightEdge = at(Math.floor(g.cx + g.radius - 2), 20)
  assert.ok(rightEdge[2] > rightEdge[0] + 50 && rightEdge[3] === 255, 'near the right rim: blue')
  const topEdge = at(20, Math.ceil(g.cy - g.radius + 2))
  assert.ok(topEdge[0] > topEdge[2] + 50, 'near the top rim: red')
  // The rim pixels are antialiased.
  const alphas = new Set<number>()
  for (let i = 3; i < data.length; i += 4) alphas.add(data[i])
  assert.ok([...alphas].some((a) => a > 0 && a < 255), 'a soft edge')
})

test('readouts: the selected wheel per channel beyond its master value; a tones puck as hue and radius', () => {
  assert.equal(wheelReadout('lift', { y: 0, u: 0, v: 0 }), 'R 0.000 G 0.000 B 0.000')
  assert.equal(wheelReadout('lift', { y: 0.05, u: 1, v: 0 }), 'R 0.000 G −0.010 B +0.100', 'kLift 0.1 · Δ̂(1, 0)')
  assert.equal(wheelReadout('gain', { y: 1, u: 1, v: 0 }), 'R 0.000 G −0.025 B +0.250', 'kGain 0.25')
  assert.equal(wheelReadout('gain', { y: 2, u: 1, v: 0 }), 'R 0.000 G −0.050 B +0.500', 'gain scales with y')
  const busy = { y: 0.9, u: -0.6, v: 0.6 }
  const c = wheelChannels('gamma', busy)
  assert.equal(wheelReadout('gamma', busy), `R +${(c[0] - 0.9).toFixed(3)} G ${(c[1] - 0.9) < 0 ? '−' : '+'}${Math.abs(c[1] - 0.9).toFixed(3)} B −${Math.abs(c[2] - 0.9).toFixed(3)}`,
    'gamma is clamped to ±1 like the bake')
  assert.equal(puckReadout({ u: 0, v: 0 }), 'Neutral')
  assert.equal(puckReadout({ u: 0, v: 0.18 }), 'Hue 90° · 0.18')
  assert.equal(puckReadout({ u: -0.1, v: -0.1 }), 'Hue 225° · 0.14')
  assert.equal(puckReadout({ u: 0.5, v: -0.0001 }), 'Hue 0° · 0.50', '359.99° reads 0°')
  assert.ok(close(puckAngle({ u: 1, v: 0 }), 0) && close(puckAngle({ u: 0, v: -1 }), 270))
})

// ---- pointers

test('double tap: a second press within 300 ms and 12 px', () => {
  const first = { time: 1000, x: 50, y: 50 }
  assert.equal(isDoubleTap(null, first), false)
  assert.equal(isDoubleTap(first, { time: 1000 + DOUBLE_TAP_MS, x: 50, y: 50 }), true)
  assert.equal(isDoubleTap(first, { time: 1001 + DOUBLE_TAP_MS, x: 50, y: 50 }), false, 'too slow')
  assert.equal(isDoubleTap(first, { time: 1100, x: 50 + DOUBLE_TAP_PX, y: 50 }), true)
  assert.equal(isDoubleTap(first, { time: 1100, x: 59, y: 59 }), false, '12.7 px away')
  assert.equal(isDoubleTap(first, { time: 900, x: 50, y: 50 }), false, 'never backwards in time')
})

test('hit radius and slop by pointer type: 22 px and 8 px for a finger, 10 px and 3 px otherwise', () => {
  assert.equal(hitRadiusPx('touch'), HIT_RADIUS_TOUCH_PX)
  assert.equal(HIT_RADIUS_TOUCH_PX, 22)
  for (const type of ['mouse', 'pen', '']) assert.equal(hitRadiusPx(type), HIT_RADIUS_MOUSE_PX)
  assert.equal(HIT_RADIUS_MOUSE_PX, 10)
  assert.equal(dragSlopPx('touch'), 8)
  assert.equal(dragSlopPx('mouse'), 3)
})

test('a press that misses: a tap until it moves past the slop, then a drag, or with a finger mostly vertical a scroll', () => {
  assert.equal(missIntent(3, 5, 'touch'), 'wait')
  assert.equal(missIntent(2, 9, 'touch'), 'scroll')
  assert.equal(missIntent(-3, -20, 'touch'), 'scroll', 'up as well as down')
  assert.equal(missIntent(9, 4, 'touch'), 'drag', 'mostly sideways: a new point follows the finger')
  assert.equal(missIntent(0, 2, 'mouse'), 'wait')
  assert.equal(missIntent(0, 20, 'mouse'), 'drag', 'a mouse never scrolls the panel by dragging')
  assert.equal(missIntent(0, 20, 'pen'), 'drag')
})

// ---- curve plots

test('canvas ↔ curve units: the tone plot is a centred square, the hue plot full width over its strip', () => {
  const plot = curvePlot(218, 218)
  assert.deepEqual(plot, { left: 8, top: 8, width: 202, height: 202 })
  assert.deepEqual(curvePlot(300, 200), { left: 58, top: 8, width: 184, height: 184 }, 'the short side decides, centred')
  assert.deepEqual(toCanvas(0, 0, plot, TONE_CURVE), [8, 210], '(0, 0) bottom left')
  assert.deepEqual(toCanvas(1, 1, plot, TONE_CURVE), [210, 8], '(1, 1) top right')
  const hue = huePlot(270, 138)
  assert.deepEqual(hue, { left: 0, top: 8, width: 270, height: 138 - 8 - 4 - 10 - 2 })
  assert.deepEqual(hueStrip(hue), { top: 8 + 114 + 4, height: 10 })
  assert.deepEqual(toCanvas(180, 1, hue, HUE_SAT_CURVE), [135, 8 + 57], 'sat: neutral 1 halfway up')
  assert.deepEqual(toCanvas(0, 0, hue, HUE_LUMA_CURVE), [0, 8 + 57], 'luma: neutral 0 halfway up')
  for (const [box, d] of [[plot, TONE_CURVE], [hue, HUE_SAT_CURVE], [hue, HUE_LUMA_CURVE]] as const) {
    for (const [x, y] of [[d.xMin, d.yMin], [d.xMax, d.yMax], [(d.xMin + d.xMax) * 0.3, d.yMin + (d.yMax - d.yMin) * 0.7]]) {
      const [px, py] = toCanvas(x, y, box, d)
      const [bx, by] = fromCanvas(px, py, box, d)
      assert.ok(close(bx, x, 1e-9) && close(by, y, 1e-9), 'round trip')
    }
  }
})

test('the device pixel ratio sizes the buffer only: positions and hit radii are CSS px on every screen', () => {
  for (const dpr of [1, 1.25, 1.5, 2, 2.625, 3]) {
    const buffer = bufferSize(218, 218, dpr)
    assert.deepEqual(buffer, { width: Math.round(218 * dpr), height: Math.round(218 * dpr) })
    // The widget draws in CSS px with the context scaled by buffer / CSS size: a point lands on
    // the device pixel its CSS position times that scale.
    const scale = buffer.width / 218
    const [px, py] = toCanvas(0.5, 0.25, curvePlot(218, 218), TONE_CURVE)
    assert.ok(close(px * scale, 109 * scale) && close(py * scale, (8 + 202 * 0.75) * scale))
    // A pointer arrives in CSS px, so the curve units under it do not depend on the ratio.
    const [x, y] = fromCanvas(px, py, curvePlot(218, 218), TONE_CURVE)
    assert.ok(close(x, 0.5, 1e-12) && close(y, 0.25, 1e-12))
  }
  assert.deepEqual(bufferSize(0, 0, 2), { width: 1, height: 1 }, 'never an empty buffer')
  assert.deepEqual(bufferSize(100, 50, Number.NaN), { width: 100, height: 50 }, 'a missing ratio counts as 1')
  // The pointer's position in the content box: client position less the box and the 1 px border.
  assert.deepEqual(localPoint(160, 340, { left: 50, top: 300 }, 1, 1), [109, 39])
})

test('hit testing: a finger reaches 22 px, a mouse 10 px; the nearest wins; a hue point across the seam', () => {
  const plot: PlotBox = { left: 0, top: 0, width: 200, height: 200 }
  const points: Pt[] = [[0, 0], [0.5, 0.5], [1, 1]]
  const [mx, my] = toCanvas(0.5, 0.5, plot, TONE_CURVE)
  assert.equal(hitPoint(points, mx + 15, my, 'touch', plot, TONE_CURVE), 1, '15 px: a finger takes it')
  assert.equal(hitPoint(points, mx + 15, my, 'mouse', plot, TONE_CURVE), -1, '15 px: a mouse misses')
  assert.equal(hitPoint(points, mx + 9, my - 2, 'mouse', plot, TONE_CURVE), 1)
  assert.equal(hitPoint(points, mx + 21, my, 'touch', plot, TONE_CURVE), 1)
  assert.equal(hitPoint(points, mx + 23, my, 'touch', plot, TONE_CURVE), -1)
  assert.equal(hitPoint(points, 3, 197, 'mouse', plot, TONE_CURVE), 0, 'the end point')
  const crowded: Pt[] = [[0, 0], [0.5, 0.5], [0.55, 0.5], [1, 1]]
  const [cx] = toCanvas(0.55, 0.5, plot, TONE_CURVE)
  assert.equal(hitPoint(crowded, cx - 2, my, 'touch', plot, TONE_CURVE), 2, 'the nearer of two in reach')
  // The radii in curve units follow the plot's size, per axis.
  const [rx, ry] = hitRadii('touch', { left: 0, top: 0, width: 360, height: 120 }, HUE_SAT_CURVE)
  assert.ok(close(rx, 22) && close(ry, 22 / 120 * 2))
  const hue = huePlot(360, 138)
  const seam: Pt[] = [[2, 1.5]]
  const [, sy] = toCanvas(2, 1.5, hue, HUE_SAT_CURVE)
  assert.equal(hitPoint(seam, 358, sy, 'mouse', hue, HUE_SAT_CURVE), 0, 'a press at 358° takes the point at 2°')
})

test('hue curves wrap: points near an edge are drawn at both, the line meets itself, a drag past an edge comes back at the other', () => {
  const box: PlotBox = { left: 0, top: 8, width: 360, height: 100 }
  assert.deepEqual(wrappedXs(180, box, 8), [180])
  assert.deepEqual(wrappedXs(3, box, 8), [3, 363], 'near the left edge: also past the right')
  assert.deepEqual(wrappedXs(355, box, 8), [355, -5], 'near the right edge: also before the left')
  const points: Pt[] = [[10, 1.4], [120, 0.8], [350, 1.2]]
  const ys = hueCurveSamples(points, HUE_SAT_CURVE, 361)
  assert.equal(ys[0], ys[360], '0° and 360° are one hue')
  assert.ok(close(ys[10], 1.4, 1e-12) && close(ys[120], 0.8, 1e-12), 'through the knots')
  // Continuous across the seam: the step there is no bigger than its neighbours'.
  assert.ok(Math.abs(ys[1] - ys[0]) < 0.05 && Math.abs(ys[360] - ys[359]) < 0.05)
  assert.ok(hueCurveSamples([], HUE_SAT_CURVE, 5).every((y) => y === 1), 'no points: flat at neutral')
  assert.ok(hueCurveSamples([], HUE_LUMA_CURVE, 5).every((y) => y === 0))
  // A point dragged to canvas x −20 (past the left edge) lands near 340°.
  const [x] = fromCanvas(-20, 50, box, HUE_SAT_CURVE)
  const moved = movePoint([[10, 1.2], [180, 1]], 0, x, 1.2, HUE_SAT_CURVE)!
  assert.deepEqual(moved.points, [[180, 1], [340, 1.2]])
  assert.equal(moved.index, 1)
  // Outside the plot only counts above and below on a hue curve, on every side on a tone curve.
  assert.equal(outsideBy(-50, 50, box, true), 0)
  assert.equal(outsideBy(-50, 50, box, false), 50)
  assert.equal(outsideBy(100, 8 + 100 + REMOVE_OUTSIDE_PX + 1, box, true), REMOVE_OUTSIDE_PX + 1)
  assert.equal(outsideBy(100, 50, box, false), 0)
  assert.ok(close(outsideBy(-3, 4, box, false), 5), 'past a corner: the distance to it')
})

test('a tap adds a point on the curve where it is: the diagonal, the spline, neutral on an empty hue curve', () => {
  assert.equal(toneCurveAt([[0, 0], [1, 1]], 0.3), 0.3)
  const lifted: Pt[] = [[0, 0.1], [1, 1]]
  assert.ok(close(toneCurveAt(lifted, 0.5), 0.55))
  const added = insertPoint(lifted, 0.5, toneCurveAt(lifted, 0.5))!
  const before = toneCurveSamples(lifted, 101)
  const after = toneCurveSamples(added.points, 101)
  assert.ok(before.every((y, i) => close(y, after[i], 1e-9)), 'a point added on a straight curve keeps it straight')
  assert.equal(toneCurveSamples([[0, 0], [1, 1]], 3)[1], 0.5)
  assert.equal(hueCurveAt([], 100, HUE_SAT_CURVE), 1)
  assert.equal(hueCurveAt([], 100, HUE_LUMA_CURVE), 0)
  assert.equal(hueCurveAt([[100, 1.5]], 250, HUE_SAT_CURVE), 1.5, 'one point is a constant')
  assert.equal(hueCurveAt([[100, 3]], 10, { ...HUE_SAT_CURVE }), 2, 'clamped to the domain')
})

// ---- keys

test('curve keys: one sRGB code a press (Shift ten); hue curves 1° and 0.01; [ ] select round the ends; Delete removes', () => {
  assert.deepEqual(nudgeSteps(TONE_CURVE, false), [1 / 255, 1 / 255])
  assert.deepEqual(nudgeSteps(TONE_CURVE, true), [10 / 255, 10 / 255])
  assert.deepEqual(nudgeSteps(HUE_SAT_CURVE, false), [1, 0.01])
  assert.deepEqual(nudgeSteps(HUE_LUMA_CURVE, true), [10, 0.1])
  assert.deepEqual(pointKey('ArrowUp', false, TONE_CURVE), { action: 'nudge', dx: 0, dy: 1 / 255 })
  assert.deepEqual(pointKey('ArrowLeft', true, TONE_CURVE), { action: 'nudge', dx: -10 / 255, dy: 0 })
  assert.deepEqual(pointKey('ArrowDown', false, HUE_SAT_CURVE), { action: 'nudge', dx: 0, dy: -0.01 })
  assert.deepEqual(pointKey('ArrowRight', false, HUE_SAT_CURVE), { action: 'nudge', dx: 1, dy: 0 })
  assert.deepEqual(pointKey('[', false, TONE_CURVE), { action: 'select', step: -1 })
  assert.deepEqual(pointKey(']', false, TONE_CURVE), { action: 'select', step: 1 })
  assert.deepEqual(pointKey('Delete', false, TONE_CURVE), { action: 'remove' })
  assert.deepEqual(pointKey('Backspace', false, TONE_CURVE), { action: 'remove' })
  assert.deepEqual(pointKey('Escape', false, TONE_CURVE), { action: 'blur' })
  for (const key of ['w', 's', ' ', 'c', 'Enter', '0']) assert.equal(pointKey(key, false, TONE_CURVE), null)
  assert.equal(stepSelection(-1, 4, 1), 0)
  assert.equal(stepSelection(-1, 4, -1), 3)
  assert.equal(stepSelection(3, 4, 1), 0, 'round the end')
  assert.equal(stepSelection(0, 4, -1), 3)
  assert.equal(stepSelection(1, 4, 1), 2)
  assert.equal(stepSelection(7, 4, 1), 0, 'a selection past the end starts over')
  assert.equal(stepSelection(0, 0, 1), -1)
  // 255 presses carry a mid point from 0 to the top of its room, one code each.
  let points: Pt[] = [[0, 0], [0.5, 0], [1, 1]]
  for (let i = 0; i < 255; i++) {
    const [x, y] = points[1]
    points = movePoint(points, 1, x, y + nudgeSteps(TONE_CURVE, false)[1], TONE_CURVE)!.points
  }
  assert.ok(close(points[1][1], 1, 1e-9))
})

test('a focused widget keeps every key from the app but Tab and Ctrl/Cmd shortcuts', () => {
  for (const key of ['w', 'a', 's', 'd', ' ', 'c', 'Enter', 'Escape', 'ArrowUp', '[', 'Delete', '0']) {
    assert.equal(widgetIsolatesKey(key, false), true, key)
  }
  assert.equal(widgetIsolatesKey('Tab', false), false)
  assert.equal(widgetIsolatesKey('z', true), false, 'Ctrl+Z goes on to the section, which undoes')
})

test('a keyup is kept from the app only when its keydown was, so a key pressed elsewhere is let go', () => {
  const keys = createKeyIsolation()
  const shift = { key: 'Shift', code: 'ShiftLeft' }
  // Shift went down over the map (keyboard navigation holds it) and comes up over a widget.
  assert.equal(keys.up(shift), false, 'its keyup reaches the window')
  assert.equal(keys.down(shift, true), true)
  assert.equal(keys.up(shift), true, 'pressed and let go here: kept')
  assert.equal(keys.up(shift), false, 'once')
  // Space activates a focused button on its keyup; keyboard navigation would cancel that.
  keys.down({ key: ' ', code: 'Space' }, true)
  assert.equal(keys.up({ key: ' ', code: 'Space' }), true)
  // A keydown let through (Tab, a shortcut) lets its keyup through too, even after an earlier one.
  keys.down({ key: 'z', code: 'KeyZ' }, true)
  assert.equal(keys.down({ key: 'z', code: 'KeyZ' }, false), false)
  assert.equal(keys.up({ key: 'z', code: 'KeyZ' }), false)
  // Keys go by code: the key's character can change between down and up (Shift let go first).
  keys.down({ key: '{', code: 'BracketLeft' }, true)
  assert.equal(keys.up({ key: '[', code: 'BracketLeft' }), true)
  // Without a code, by key.
  keys.down({ key: 'w' }, true)
  assert.equal(keys.up({ key: 'w', code: '' }), true)
  // The focus going elsewhere sends the keyups elsewhere.
  keys.down({ key: 'a', code: 'KeyA' }, true)
  keys.clear()
  assert.equal(keys.up({ key: 'a', code: 'KeyA' }), false)
})

test('[ and ] select on any layout: AltGr and Option are typing, Ctrl/Cmd shortcuts go on to the section', () => {
  const key = (k: string, mods: Partial<WidgetKeyEvent> = {}): WidgetKeyEvent =>
    ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods })
  const next = { action: 'select', step: 1 }
  // German Windows AltGr+9: ctrl and alt set, AltGraph where the browser reports it.
  assert.deepEqual(curveKeyAction(key(']', { ctrlKey: true, altKey: true }), true, TONE_CURVE), next)
  assert.deepEqual(curveKeyAction(key(']', { ctrlKey: true, altKey: true }), false, TONE_CURVE), next)
  assert.equal(isShortcut(key(']', { ctrlKey: true, altKey: true }), false), false, 'so the widget keeps it')
  // macOS Option+5.
  assert.deepEqual(curveKeyAction(key('[', { altKey: true }), false, TONE_CURVE), { action: 'select', step: -1 })
  // Ctrl/Cmd+Z is a shortcut: no action here, and it goes on to the section's undo.
  for (const mods of [{ ctrlKey: true }, { metaKey: true }]) {
    assert.equal(isShortcut(key('z', mods), false), true)
    assert.equal(curveKeyAction(key('z', mods), false, TONE_CURVE), null)
    assert.equal(widgetIsolatesKey('z', isShortcut(key('z', mods), false)), false)
  }
  assert.equal(isShortcut(key('z', { ctrlKey: true }), true), false, 'AltGr+Z types')
  // Alt with anything else does nothing (Alt+arrows are the browser's).
  assert.equal(curveKeyAction(key('ArrowLeft', { altKey: true }), false, TONE_CURVE), null)
  assert.equal(curveKeyAction(key('ArrowLeft', { ctrlKey: true, altKey: true }), false, TONE_CURVE), null)
  assert.equal(curveKeyAction(key('ArrowLeft'), true, TONE_CURVE), null, 'nor with AltGr')
  assert.deepEqual(curveKeyAction(key('Delete'), false, TONE_CURVE), { action: 'remove' })
})

test('a modifier alone is no key that ends an arrow-key run', () => {
  for (const key of ['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock']) assert.equal(isModifierKey(key), true, key)
  for (const key of ['ArrowUp', 'Escape', '0', 'z', ' ', 'Tab']) assert.equal(isModifierKey(key), false, key)
})

test('curve readouts: point number, in and out as sRGB codes; hue and its value; a hint without a selection', () => {
  const points: Pt[] = [[0, 0], [0.2, 0.15], [128 / 255, 141 / 255], [1, 1]]
  assert.equal(curveReadout(points, 2), 'Point 3 · in 128 → out 141')
  assert.equal(curveReadout(points, 0), 'Point 1 · in 0 → out 0')
  assert.match(curveReadout(points, -1), /^Tap the curve to add a point/)
  assert.match(curveReadout(points, 9), /^Tap/)
  const hue: Pt[] = [[40, 0.75], [104.4, 1.2]]
  assert.equal(hueReadout(hue, 1, 'sat'), 'Point 2 · hue 104° → 120%')
  assert.equal(hueReadout([[359.7, 0.3]], 0, 'luma'), 'Point 1 · hue 0° → +0.30 stops')
  assert.equal(hueReadout([[200, -0.004]], 0, 'luma'), 'Point 1 · hue 200° → 0.00 stops', 'no −0.00')
  assert.match(hueReadout(hue, -1, 'sat'), /^Tap to add a point/)
  assert.equal(hueDomain('sat'), HUE_SAT_CURVE)
  assert.equal(hueDomain('luma'), HUE_LUMA_CURVE)
})
