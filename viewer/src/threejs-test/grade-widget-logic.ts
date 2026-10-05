// The Colour grade widgets' geometry, gestures and keys (plan 5.3–5.5, 5.8), apart from the
// canvases grade-widgets.ts draws them on: where a puck or a curve point sits on a canvas and back,
// how a drag or an arrow key moves a puck, what counts as a double tap, how far a pointer reaches,
// when a press that misses every point becomes a drag or a scroll, where a hue point near the seam
// is drawn twice, what each key does and how the readouts read. Pure, no three, no DOM, so it runs
// under `node --test` (grade-widget-logic.test.ts).
//
// Positions on a canvas are CSS pixels in its content box (inside the 1 px border). The widgets
// draw in the same units with the canvas scaled by the device pixel ratio, so hit radii, slops
// and the wheel's drag speed are the same on every screen.
import {
  HUE_LUMA_CURVE, HUE_SAT_CURVE, monotoneCurve, nearestPoint, periodicCurveFn, type CurveDomain, type Pt,
} from './grade-curves.ts'
import { signed } from './grade-editor-logic.ts'
import {
  DEFAULT_GRADE_TUNING, GRADE_RANGES, snapPuck, wheelChannels, wheelDelta,
  type GradeTuning, type Puck, type Wheel, type WheelName,
} from './grade-model.ts'

// ---- pointers -------------------------------------------------------------------------------

/** A second press within this long … */
export const DOUBLE_TAP_MS = 300
/** … and this close to the first is a double tap (a reset on a wheel, a removal on a point). */
export const DOUBLE_TAP_PX = 12
/** How far from a curve point a press still takes it: a finger, and a mouse or a pen. */
export const HIT_RADIUS_TOUCH_PX = 22
export const HIT_RADIUS_MOUSE_PX = 10
/** A point dragged this far outside the plot is removed (an end point never is). */
export const REMOVE_OUTSIDE_PX = 24
/** A finger moves this far before a press is a drag (of a point, or of a new one) or a scroll … */
export const TOUCH_SLOP_PX = 8
/** … and a mouse or a pen this far, so a click never nudges a point. */
export const MOUSE_SLOP_PX = 3
/** Shift slows a wheel drag to a quarter. */
export const WHEEL_FINE = 0.25
/** Arrow-key nudges are one undo step once the keys rest this long. */
export const NUDGE_COMMIT_MS = 400

/** A finger: the big hit radius and slop, and a vertical swipe that misses every point scrolls
 *  the panel. A mouse and a pen are precise, and an unknown pointer type (a synthetic event)
 *  counts as precise too. */
export const isTouch = (pointerType: string) => pointerType === 'touch'
export const hitRadiusPx = (pointerType: string) => (isTouch(pointerType) ? HIT_RADIUS_TOUCH_PX : HIT_RADIUS_MOUSE_PX)
export const dragSlopPx = (pointerType: string) => (isTouch(pointerType) ? TOUCH_SLOP_PX : MOUSE_SLOP_PX)

/** A press: when (the event's timeStamp, ms) and where (client px). */
export interface Tap {
  time: number
  x: number
  y: number
}

/** True when `next` follows `previous` within DOUBLE_TAP_MS and DOUBLE_TAP_PX. */
export function isDoubleTap(previous: Tap | null, next: Tap): boolean {
  if (!previous) return false
  const dt = next.time - previous.time
  return dt >= 0 && dt <= DOUBLE_TAP_MS && Math.hypot(next.x - previous.x, next.y - previous.y) <= DOUBLE_TAP_PX
}

/** A pointer's position in a canvas's content box, in CSS px: its client position less the box's
 *  client rect and the border (clientLeft, clientTop). */
export function localPoint(clientX: number, clientY: number, rect: { left: number; top: number },
  borderLeft: number, borderTop: number): [number, number] {
  return [clientX - rect.left - borderLeft, clientY - rect.top - borderTop]
}

/** The drawing buffer of a canvas laid out at cssWidth × cssHeight at this device pixel ratio:
 *  whole device pixels, at least 1 × 1. The widgets then draw in CSS px with the context scaled by
 *  buffer / CSS size. */
export function bufferSize(cssWidth: number, cssHeight: number, dpr: number): { width: number; height: number } {
  const ratio = dpr > 0 && Number.isFinite(dpr) ? dpr : 1
  return { width: Math.max(1, Math.round(cssWidth * ratio)), height: Math.max(1, Math.round(cssHeight * ratio)) }
}

// ---- colour wheels (plan 5.3) ---------------------------------------------------------------

/** Margin between the disc and the canvas edge, CSS px: room for the puck on the rim. */
export const WHEEL_PAD_PX = 9
export const MINI_WHEEL_PAD_PX = 3
/** Arrow keys move a puck this far (Shift: ten times), in puck units. */
export const PUCK_STEP = GRADE_RANGES.puck.step
export const PUCK_STEP_SHIFT = 10 * GRADE_RANGES.puck.step

export interface WheelGeometry {
  /** The disc's centre and radius; the rim is |puck| = 1. */
  cx: number
  cy: number
  radius: number
}

/** The disc in a width × height box: centred, as large as fits less `pad`. */
export function wheelGeometry(width: number, height: number, pad: number): WheelGeometry {
  return { cx: width / 2, cy: height / 2, radius: Math.max(Math.min(width, height) / 2 - pad, 1) }
}

/** Where a puck sits: u to the right, v up (plan 2.1: v = −puck y on screen). */
export function puckToCanvas(puck: Readonly<Puck>, g: WheelGeometry): [number, number] {
  return [g.cx + puck.u * g.radius, g.cy - puck.v * g.radius]
}

/** The puck under a canvas position, not clamped. */
export function canvasToPuck(x: number, y: number, g: WheelGeometry): Puck {
  return { u: (x - g.cx) / g.radius, v: (g.cy - y) / g.radius }
}

/** Pulled onto the rim when outside the unit disc. */
export function clampToDisc(u: number, v: number): Puck {
  const r = Math.hypot(u, v)
  return r > 1 ? { u: u / r, v: v / r } : { u, v }
}

/**
 * A relative drag, as Resolve's wheels move: the puck travels drag / (2 · radius), a quarter of
 * that with Shift, whatever the pointer's start; screen down is −v. Kept inside the unit disc, so
 * a drag back inwards answers at once. `raw` is the unsnapped puck the drag carries along.
 */
export function dragPuck(raw: Readonly<Puck>, dx: number, dy: number, radius: number, fine: boolean): Puck {
  const k = (fine ? WHEEL_FINE : 1) / (2 * Math.max(radius, 1))
  return clampToDisc(raw.u + dx * k, raw.v - dy * k)
}

const round = (x: number, digits: number) => {
  const f = 10 ** digits
  return Math.round(x * f) / f + 0
}

/** An arrow-key nudge of the unsnapped puck, rounded so ten 0.01 steps make 0.1. */
export function nudgePuck(raw: Readonly<Puck>, du: number, dv: number): Puck {
  return clampToDisc(round(raw.u + du, 6), round(raw.v + dv, 6))
}

/** The puck the state stores for an unsnapped one: 4 decimals (a wheel pixel is about 0.005),
 *  then snapPuck — exactly 0 under 0.02, never outside the disc. */
export function storedPuck(raw: Readonly<Puck>): Puck {
  return snapPuck(round(raw.u, 4), round(raw.v, 4))
}

export const samePuck = (a: Readonly<Puck>, b: Readonly<Puck>) => a.u === b.u && a.v === b.v

/**
 * Where the next drag or nudge starts from: the unsnapped puck the last one left, while the state
 * still holds what it stored; otherwise (an undo, a paste, the other wheel) the stored puck. So
 * slow drags and single 0.01 nudges leave the 0.02 snap around neutral instead of snapping back to
 * 0 on every step.
 */
export function continuePuck(raw: Readonly<Puck> | null, stored: Readonly<Puck>): Puck {
  if (raw && samePuck(storedPuck(raw), stored)) return { u: raw.u, v: raw.v }
  return { u: stored.u, v: stored.v }
}

/** The disc's colour at a puck position: clamp(0.5 + 0.35 · Δ̂(u, v)), the tint that direction
 *  adds over mid grey, as display values in [0, 1]. */
export const DISC_GREY = 0.5
export const DISC_TINT = 0.35
export function discColour<T extends number[] | Float64Array>(u: number, v: number, out: T = [0, 0, 0] as unknown as T): T {
  wheelDelta(u, v, out)
  for (let c = 0; c < 3; c++) out[c] = Math.min(Math.max(DISC_GREY + DISC_TINT * out[c], 0), 1)
  return out
}

/**
 * The disc as RGBA bytes for a width × height buffer, `g` in buffer pixels: each pixel centre's
 * discColour, opaque inside the rim, a one-pixel antialiased edge, transparent outside. The wheel
 * renders it once per canvas size.
 */
export function renderDisc(width: number, height: number, g: WheelGeometry, out?: Uint8ClampedArray): Uint8ClampedArray {
  const data = out && out.length === width * height * 4 ? out : new Uint8ClampedArray(width * height * 4)
  const rgb = new Float64Array(3)
  for (let y = 0; y < height; y++) {
    const dy = y + 0.5 - g.cy
    for (let x = 0; x < width; x++) {
      const dx = x + 0.5 - g.cx
      const i = (y * width + x) * 4
      const alpha = Math.min(Math.max(g.radius + 0.5 - Math.hypot(dx, dy), 0), 1)
      if (alpha <= 0) {
        data[i] = data[i + 1] = data[i + 2] = data[i + 3] = 0
        continue
      }
      const p = clampToDisc(dx / g.radius, -dy / g.radius)
      discColour(p.u, p.v, rgb)
      data[i] = rgb[0] * 255
      data[i + 1] = rgb[1] * 255
      data[i + 2] = rgb[2] * 255
      data[i + 3] = alpha * 255
    }
  }
  return data
}

export type WheelKey = { action: 'nudge'; du: number; dv: number } | { action: 'reset' } | { action: 'blur' } | null

/** A key on a focused wheel: arrows nudge the puck by 0.01 (Shift 0.1), right towards blue and
 *  up towards red as on screen; 0 resets it; Escape lets go of the focus. */
export function wheelKey(key: string, shift: boolean): WheelKey {
  const step = shift ? PUCK_STEP_SHIFT : PUCK_STEP
  switch (key) {
    case 'ArrowRight': return { action: 'nudge', du: step, dv: 0 }
    case 'ArrowLeft': return { action: 'nudge', du: -step, dv: 0 }
    case 'ArrowUp': return { action: 'nudge', du: 0, dv: step }
    case 'ArrowDown': return { action: 'nudge', du: 0, dv: -step }
    case '0': return { action: 'reset' }
    case 'Escape': return { action: 'blur' }
    default: return null
  }
}

/** The Primary readout: what the selected wheel does per channel beyond its master value, from
 *  the bake's own wheelChannels — "R +0.012 G −0.004 B −0.019". */
export function wheelReadout(name: WheelName, wheel: Readonly<Wheel>, tuning: Readonly<GradeTuning> = DEFAULT_GRADE_TUNING): string {
  const c = wheelChannels(name, wheel, tuning)
  return `R ${signed(c[0] - wheel.y, 3)} G ${signed(c[1] - wheel.y, 3)} B ${signed(c[2] - wheel.y, 3)}`
}

/** A puck's direction as a vectorscope reads it, degrees from +u towards +v in [0, 360). */
export function puckAngle(puck: Readonly<Puck>): number {
  const degrees = Math.atan2(puck.v, puck.u) * 180 / Math.PI
  return degrees < 0 ? degrees + 360 : degrees
}

/** The Tones readout: "Hue 212° · 0.18", or "Neutral" at the centre. */
export function puckReadout(puck: Readonly<Puck>): string {
  const r = Math.hypot(puck.u, puck.v)
  if (r === 0) return 'Neutral'
  return `Hue ${Math.round(puckAngle(puck)) % 360}° · ${r.toFixed(2)}`
}

// ---- curve plots (plan 5.4, 5.5) ------------------------------------------------------------

/** The area of a canvas a curve's domain maps onto, CSS px. */
export interface PlotBox {
  left: number
  top: number
  width: number
  height: number
}

/** Margin around the tone curve's square: the end points and their hit areas stay on the canvas. */
export const CURVE_PAD_PX = 8
/** The hue curve: a margin above, then the plot, a gap, the hue strip and a margin below. */
export const HUE_PAD_TOP_PX = 8
export const HUE_STRIP_GAP_PX = 4
export const HUE_STRIP_PX = 10
export const HUE_PAD_BOTTOM_PX = 2

/** The tone curve's plot: the largest square that fits, inset by `pad`, centred. */
export function curvePlot(width: number, height: number, pad = CURVE_PAD_PX): PlotBox {
  const size = Math.max(Math.min(width, height) - 2 * pad, 1)
  return { left: (width - size) / 2, top: (height - size) / 2, width: size, height: size }
}

/** The hue curve's plot: the full width (0° and 360° are the two edges, the same hue), above the
 *  strip. */
export function huePlot(width: number, height: number): PlotBox {
  const plotHeight = height - HUE_PAD_TOP_PX - HUE_STRIP_GAP_PX - HUE_STRIP_PX - HUE_PAD_BOTTOM_PX
  return { left: 0, top: HUE_PAD_TOP_PX, width: Math.max(width, 1), height: Math.max(plotHeight, 1) }
}

/** The hue strip under the hue plot: its top and height. */
export function hueStrip(box: PlotBox): { top: number; height: number } {
  return { top: box.top + box.height + HUE_STRIP_GAP_PX, height: HUE_STRIP_PX }
}

/** Curve units → canvas px: x along the plot from xMin, y up from yMin. */
export function toCanvas(x: number, y: number, box: PlotBox, d: CurveDomain): [number, number] {
  return [
    box.left + (x - d.xMin) / (d.xMax - d.xMin) * box.width,
    box.top + (d.yMax - y) / (d.yMax - d.yMin) * box.height,
  ]
}

/** Canvas px → curve units, not clamped (movePoint and insertPoint clamp). */
export function fromCanvas(px: number, py: number, box: PlotBox, d: CurveDomain): [number, number] {
  return [
    d.xMin + (px - box.left) / box.width * (d.xMax - d.xMin),
    d.yMax - (py - box.top) / box.height * (d.yMax - d.yMin),
  ]
}

/** The pointer's hit radius in curve units, per axis: the same reach in px on every axis. */
export function hitRadii(pointerType: string, box: PlotBox, d: CurveDomain): [number, number] {
  const px = hitRadiusPx(pointerType)
  return [px / box.width * (d.xMax - d.xMin), px / box.height * (d.yMax - d.yMin)]
}

/** The point a press at canvas (px, py) takes, or −1: the nearest within the hit radius, across
 *  the seam on a hue curve. */
export function hitPoint(points: readonly Pt[], px: number, py: number, pointerType: string, box: PlotBox, d: CurveDomain): number {
  const [x, y] = fromCanvas(px, py, box, d)
  const [rx, ry] = hitRadii(pointerType, box, d)
  return nearestPoint(points, x, y, rx, ry, d)
}

/** How far a canvas position lies outside the plot, px; 0 inside. A periodic curve has no left or
 *  right outside (dragging past an edge carries the point over the seam), only above and below. */
export function outsideBy(px: number, py: number, box: PlotBox, periodic: boolean): number {
  const dy = Math.max(box.top - py, py - (box.top + box.height), 0)
  const dx = periodic ? 0 : Math.max(box.left - px, px - (box.left + box.width), 0)
  return Math.hypot(dx, dy)
}

export type MissIntent = 'wait' | 'drag' | 'scroll'

/**
 * A press that missed every point, once it has moved (dx, dy) px: still a tap ('wait', a tap adds
 * a point where it lifts), a drag (a point is added at the press and follows the pointer), or —
 * a finger moving mostly vertically — a scroll of the panel.
 */
export function missIntent(dx: number, dy: number, pointerType: string): MissIntent {
  if (Math.hypot(dx, dy) <= dragSlopPx(pointerType)) return 'wait'
  return isTouch(pointerType) && Math.abs(dy) > Math.abs(dx) ? 'scroll' : 'drag'
}

/** Where a hue point at canvas x is drawn: there, and once more a plot width over while it lies
 *  within `reach` px of an edge, so a point at 359° shows at both edges. */
export function wrappedXs(px: number, box: PlotBox, reach: number): number[] {
  const xs = [px]
  if (px - box.left < reach) xs.push(px + box.width)
  if (box.left + box.width - px < reach) xs.push(px - box.width)
  return xs
}

/** A tone curve at `count` evenly spaced x from 0 to 1, for drawing: the diagonal for the
 *  default curve. */
export function toneCurveSamples(points: readonly Pt[], count: number): Float64Array {
  const ys = new Float64Array(count)
  const f = monotoneCurve(points)
  for (let i = 0; i < count; i++) {
    const x = count > 1 ? i / (count - 1) : 0
    ys[i] = f ? f(x) : x
  }
  return ys
}

/** A hue curve at `count` evenly spaced hues from xMin to xMax, for drawing: flat at neutral
 *  without points. The first and last sample are the same hue, so the line meets itself at the
 *  seam. */
export function hueCurveSamples(points: readonly Pt[], d: CurveDomain, count: number): Float64Array {
  const ys = new Float64Array(count)
  const f = periodicCurveFn(points, d.xMax - d.xMin)
  const neutral = d.neutral ?? 0
  for (let i = 0; i < count; i++) {
    const x = d.xMin + (count > 1 ? i / (count - 1) : 0) * (d.xMax - d.xMin)
    ys[i] = f ? f(x) : neutral
  }
  return ys
}

/** The y a tap at x adds a point at on a tone curve: the curve's own (the diagonal by default),
 *  so adding a point leaves the curve where it was. */
export function toneCurveAt(points: readonly Pt[], x: number): number {
  const f = monotoneCurve(points)
  return Math.min(Math.max(f ? f(x) : x, 0), 1)
}

/** The same for a hue curve: the curve's own, neutral without points. */
export function hueCurveAt(points: readonly Pt[], hue: number, d: CurveDomain): number {
  const f = periodicCurveFn(points, d.xMax - d.xMin)
  return Math.min(Math.max(f ? f(hue) : d.neutral ?? 0, d.yMin), d.yMax)
}

/** The canopy's measured hexcone hues, marked on the hue curves. */
export const CANOPY_HUES: readonly [number, number] = Object.freeze([90, 108] as const)

// ---- keys on a curve ------------------------------------------------------------------------

export type PointKey =
  | { action: 'nudge'; dx: number; dy: number }
  | { action: 'select'; step: 1 | -1 }
  | { action: 'remove' }
  | { action: 'blur' }
  | null

/**
 * One arrow-key step of a curve point, per axis. A tone curve moves by one sRGB code, 1/255 (Shift
 * 10/255), as its readout counts. A hue curve moves 1° along the hue and 0.01 in y — 1 % of
 * saturation, or 0.01 stop (Shift ten times both), which its readout shows as whole steps.
 */
export function nudgeSteps(d: CurveDomain, shift: boolean): [number, number] {
  const k = shift ? 10 : 1
  if (d.periodic) return [k, k * 0.01]
  return [k * (d.xMax - d.xMin) / 255, k * (d.yMax - d.yMin) / 255]
}

/** A key on a focused curve: arrows nudge the selected point, [ and ] select the previous and next
 *  point, Delete and Backspace remove it, Escape lets go of the focus. */
export function pointKey(key: string, shift: boolean, d: CurveDomain): PointKey {
  const [sx, sy] = nudgeSteps(d, shift)
  switch (key) {
    case 'ArrowLeft': return { action: 'nudge', dx: -sx, dy: 0 }
    case 'ArrowRight': return { action: 'nudge', dx: sx, dy: 0 }
    case 'ArrowUp': return { action: 'nudge', dx: 0, dy: sy }
    case 'ArrowDown': return { action: 'nudge', dx: 0, dy: -sy }
    case '[': return { action: 'select', step: -1 }
    case ']': return { action: 'select', step: 1 }
    case 'Delete':
    case 'Backspace': return { action: 'remove' }
    case 'Escape': return { action: 'blur' }
    default: return null
  }
}

/** [ and ]: the previous or next point, round the ends; from no selection, the first or last. */
export function stepSelection(index: number, count: number, step: 1 | -1): number {
  if (count <= 0) return -1
  if (index < 0 || index >= count) return step > 0 ? 0 : count - 1
  return (index + step + count) % count
}

/**
 * Keys a focused widget keeps from the app (keyboard navigation on window, main.ts on document:
 * W A S D, Space, C, Enter move the camera): every key but Tab, and but Ctrl/Cmd shortcuts, which
 * go on to the Colour grade section — it undoes on Ctrl+Z and keeps them from the app itself.
 */
export const widgetIsolatesKey = (key: string, ctrlOrMeta: boolean) => key !== 'Tab' && !ctrlOrMeta

// ---- readouts -------------------------------------------------------------------------------

const code = (value: number) => Math.round(value * 255)

/** The tone curve's readout: "Point 3 · in 128 → out 141", in sRGB codes; a hint without a
 *  selected point. */
export function curveReadout(points: readonly Pt[], index: number): string {
  if (index < 0 || index >= points.length) return 'Tap the curve to add a point, drag one to move it'
  const [x, y] = points[index]
  return `Point ${index + 1} · in ${code(x)} → out ${code(y)}`
}

export type HueMode = 'sat' | 'luma'
export const HUE_MODES: readonly HueMode[] = Object.freeze(['sat', 'luma'] as const)
export const hueDomain = (mode: HueMode): CurveDomain => (mode === 'sat' ? HUE_SAT_CURVE : HUE_LUMA_CURVE)

/** The hue curve's readout: "Point 2 · hue 104° → 120%" (saturation) or "→ +0.30 stops" (luma). */
export function hueReadout(points: readonly Pt[], index: number, mode: HueMode): string {
  if (index < 0 || index >= points.length) return 'Tap to add a point, drag one to move it'
  const [hue, y] = points[index]
  const value = mode === 'sat' ? `${Math.round(y * 100)}%` : `${signed(y, 2)} stops`
  return `Point ${index + 1} · hue ${Math.round(hue) % 360}° → ${value}`
}
