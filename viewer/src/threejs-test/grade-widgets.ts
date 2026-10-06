// The Colour grade section's canvases (goal 4, plan 5.3–5.5, 5.8, 5.9): the colour wheels, the
// tone curve editor and the hue curve editor. Each reads and writes the editor's state through
// closures, never a copy, so undo, snapshots and pastes need only redraw(); and each reports an
// edit twice: onInput while it happens (the editor asks for a bake, no undo step) and onCommit
// when it ends — pointerup, NUDGE_COMMIT_MS after the last arrow-key nudge, or a discrete action
// (a tap that adds a point, a double tap, Remove point, 0) — where the editor records an undo
// step, bakes the final lattice and decides compile-in. No widget changes the shader.
//
// Canvas 2D at the device pixel ratio: one ResizeObserver per canvas (the device-pixel box where
// the browser reports it), drawn at most once per animation frame and not at all while hidden.
// Pointers: touch-action none, pointer capture and stopPropagation on pointerdown, so neither the
// panel nor the camera sees a widget drag. A press changes nothing until the pointer has moved
// past the slop. On the curves a finger that misses every point and swipes mostly vertically lets
// go and scrolls the panel by hand; wheels always hold on. A focused widget keeps every key from
// the app but Tab and Ctrl/Cmd shortcuts (the section undoes on Ctrl+Z), and a keyup only when it
// kept the keydown. The geometry, gestures and keys are pure, in grade-widget-logic.ts.
import {
  insertPoint, isDefaultToneCurve, movePoint, removePoint, snapNeutral, TONE_CURVE, type CurveDomain, type Pt,
} from './grade-curves.ts'
import { CURVE_CHANNELS, type CurveChannel, type GradeCurves, type Puck } from './grade-model.ts'
import {
  bufferSize, CANOPY_HUES, continuePuck, createKeyIsolation, curveKeyAction, curvePlot, curveReadout, discColour,
  dragPuck, dragSlopPx, fromCanvas, hitPoint, hueCurveAt, hueCurveSamples, hueDomain, huePlot, hueReadout, hueStrip,
  isDoubleTap, isModifierKey, isShortcut, localPoint, MINI_WHEEL_PAD_PX, missIntent, NUDGE_COMMIT_MS, nudgePuck,
  outsideBy, puckToCanvas, REMOVE_OUTSIDE_PX, renderDisc, samePuck, stepSelection, storedPuck, toCanvas, toneCurveAt,
  toneCurveSamples, WHEEL_PAD_PX, wheelGeometry, wheelKey, widgetIsolatesKey, wrappedXs, type HueMode, type PlotBox,
  type Tap,
} from './grade-widget-logic.ts'

/** How a widget tells the editor about an edit. */
export interface WidgetHooks {
  /** The widget has just written the state: bake, no undo step. */
  onInput(): void
  /** An edit has ended: an undo step, the final bake, compile-in. */
  onCommit(): void
  /** A pointer has taken hold to edit (not to scroll): the editor's peek, until that pointer
   *  lifts. */
  onGrab?(pointerId: number): void
}

/** What every widget offers the editor. */
export interface GradeWidget {
  /** Draw again from the state (after undo, a snapshot, a paste, a switch of what it edits). */
  redraw(): void
  /** Commit an arrow-key nudge still waiting for its pause, now. */
  flush(): void
  setLabel(label: string): void
  dispose(): void
}

const TAU = Math.PI * 2
/** The panel's own colours (threejs-test.html): text, faint text, background, accent. */
const INK = '#e8eaed'
const INK_FAINT = 'rgba(232,234,237,.4)'
const PANEL_BG = '#0d1117'
const ACCENT_LIGHT = '#79b8ff'
const FONT = '600 8px ui-monospace, SFMono-Regular, monospace'
/** The four tone curves: master in the panel's ink, the channels in its red, green and blue. */
const CHANNEL_COLOURS: Readonly<Record<CurveChannel, string>> = Object.freeze({
  master: INK, red: '#f85149', green: '#3fb950', blue: '#58a6ff',
})

// ---- the canvas -----------------------------------------------------------------------------

interface Surface {
  readonly ctx: CanvasRenderingContext2D | null
  /** The content box, CSS px; 0 while the canvas is not laid out (a hidden tab, a closed section
   *  or panel). */
  readonly width: number
  readonly height: number
  /** Device px per CSS px, per axis. */
  readonly scaleX: number
  readonly scaleY: number
  /** Draw on the next animation frame (once, however often asked). */
  schedule(): void
  dispose(): void
}

/** A canvas kept at its laid-out size times the device pixel ratio and drawn by `draw`: once a
 *  frame for any number of schedule() calls, and at once when its size changes or it is shown. */
function createSurface(canvas: HTMLCanvasElement, draw: () => void): Surface {
  const ctx = canvas.getContext('2d')
  let width = 0
  let height = 0
  let scaleX = 1
  let scaleY = 1
  let frame = 0
  const run = () => {
    frame = 0
    if (ctx && width > 0 && height > 0) draw()
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(run)
  }
  const resize = (w: number, h: number, device?: { width: number; height: number }) => {
    width = w
    height = h
    if (!(width > 0 && height > 0)) return false
    const size = device ?? bufferSize(width, height, window.devicePixelRatio)
    scaleX = size.width / width
    scaleY = size.height / height
    if (canvas.width !== size.width || canvas.height !== size.height) {
      canvas.width = size.width
      canvas.height = size.height
    }
    return true
  }
  const observer = new ResizeObserver((entries) => {
    const entry = entries[entries.length - 1]
    const box = entry.contentBoxSize?.[0]
    const device = entry.devicePixelContentBoxSize?.[0]
    if (!resize(box ? box.inlineSize : entry.contentRect.width, box ? box.blockSize : entry.contentRect.height,
      device ? { width: device.inlineSize, height: device.blockSize } : undefined)) return
    // Now, not on the next frame: observers run after layout and before paint, so a canvas that
    // was just resized (cleared) or shown (stale while hidden) is never painted as it was.
    if (frame) cancelAnimationFrame(frame)
    run()
  })
  // Observers only run in a rendering step, which a hidden tab never takes; an input that arrives
  // before the first one (a pointer right after the section opens, a test) measures the laid-out
  // box itself, so the widget maths never works on a 0 px canvas.
  const measured = () => {
    if (width > 0 && height > 0) return
    if (resize(canvas.clientWidth, canvas.clientHeight)) schedule()
  }
  try {
    // Exact device pixels, and a callback when only the pixel ratio changes (Chromium, Firefox).
    observer.observe(canvas, { box: 'device-pixel-content-box' })
  } catch {
    observer.observe(canvas)
  }
  return {
    ctx,
    get width() { measured(); return width },
    get height() { measured(); return height },
    get scaleX() { measured(); return scaleX },
    get scaleY() { measured(); return scaleY },
    schedule,
    dispose() {
      observer.disconnect()
      if (frame) cancelAnimationFrame(frame)
      frame = 0
    },
  }
}

type Listener = [EventTarget, string, (event: any) => void, (AddEventListenerOptions | boolean)?]

function listenAll(listeners: Listener[]): () => void {
  for (const [target, type, handler, options] of listeners) target.addEventListener(type, handler, options)
  return () => {
    for (const [target, type, handler, options] of listeners) target.removeEventListener(type, handler, options)
  }
}

/** The common setup of an editing canvas: focusable, an application for screen readers, labelled. */
function makeInteractive(canvas: HTMLCanvasElement, label: string): void {
  canvas.tabIndex = 0
  canvas.setAttribute('role', 'application')
  canvas.setAttribute('aria-label', label)
}

/** Takes the pointer, so the drag goes on outside the canvas. A pointer the browser does not
 *  know as active (a synthetic event's) throws; the widget then works on the events it is sent. */
function capture(canvas: HTMLCanvasElement, pointerId: number): void {
  try {
    canvas.setPointerCapture(pointerId)
  } catch {
    // Not an active pointer.
  }
}

function release(canvas: HTMLCanvasElement, pointerId: number): void {
  if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId)
}

/** AltGr held, where the browser reports it (getModifierState is absent on a synthetic event). */
const altGraphOf = (event: KeyboardEvent) => event.getModifierState?.('AltGraph') === true

/** An arrow-key burst's commit, NUDGE_COMMIT_MS after the last key; flush() commits it now. */
function createNudgeCommit(commit: () => void) {
  let timer = 0
  const flush = () => {
    if (!timer) return
    clearTimeout(timer)
    timer = 0
    commit()
  }
  return {
    schedule() {
      clearTimeout(timer)
      timer = window.setTimeout(flush, NUDGE_COMMIT_MS)
    },
    flush,
    cancel() {
      clearTimeout(timer)
      timer = 0
    },
  }
}

const setText = (element: HTMLElement | undefined, text: string) => {
  if (element && element.textContent !== text) element.textContent = text
}

const rgbCss = (rgb: ArrayLike<number>) => `rgb(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)})`

// ---- colour wheels (plan 5.3) ---------------------------------------------------------------

export interface ColourWheelOptions extends Partial<WidgetHooks> {
  /** The puck shown (and edited). */
  get(): Readonly<Puck>
  /** Writes a puck into the state; already snapped (snapPuck). Absent for a mini. */
  set?(puck: Puck): void
  /** aria-label of an editing wheel. */
  label?: string
  /** A line under the wheel the widget keeps up to date as it draws. */
  readout?: { element: HTMLElement; text(): string }
  /** A 44 px display-only wheel (the Primary selectors): no pointer or keys of its own. */
  mini?: boolean
}

export type ColourWheel = GradeWidget

/**
 * A colour wheel: the disc coloured with the tint each direction adds (rendered once per size), a
 * crosshair at neutral, the rim at |puck| = 1, and the puck. Dragging moves the puck relative to
 * where it was, like Resolve: drag / (2 · radius), a quarter with Shift, kept in the disc and
 * snapped (snapPuck) — once the pointer has moved past the slop (dragSlopPx), then the whole way
 * from the press, so a tap that jitters moves nothing. A double click or double tap (300 ms,
 * 12 px) resets it; so does 0. Arrows nudge it by 0.01 (Shift 0.1).
 */
export function createColourWheel(canvas: HTMLCanvasElement, options: ColourWheelOptions): ColourWheel {
  const mini = options.mini === true || !options.set
  const pad = options.mini ? MINI_WHEEL_PAD_PX : WHEEL_PAD_PX
  const disc = document.createElement('canvas')
  let discKey = ''
  const rgb = new Float64Array(3)

  const surface = createSurface(canvas, draw)
  const geometry = () => wheelGeometry(surface.width, surface.height, pad)

  function draw(): void {
    const ctx = surface.ctx!
    const g = geometry()
    const { scaleX, scaleY } = surface
    // The disc in device pixels, once per size.
    const key = `${canvas.width}x${canvas.height}@${scaleX.toFixed(4)}`
    if (key !== discKey) {
      discKey = key
      disc.width = canvas.width
      disc.height = canvas.height
      const discCtx = disc.getContext('2d')
      if (discCtx) {
        const image = discCtx.createImageData(disc.width, disc.height)
        renderDisc(disc.width, disc.height, { cx: g.cx * scaleX, cy: g.cy * scaleY, radius: g.radius * Math.min(scaleX, scaleY) }, image.data)
        discCtx.putImageData(image, 0, 0)
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(disc, 0, 0)
    ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0)

    // The rim, |puck| = 1.
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(232,234,237,.38)'
    ctx.beginPath()
    ctx.arc(g.cx, g.cy, g.radius, 0, TAU)
    ctx.stroke()
    // Neutral.
    const arm = mini ? 3 : 7
    ctx.strokeStyle = 'rgba(13,17,23,.55)'
    ctx.beginPath()
    ctx.moveTo(g.cx - arm, g.cy)
    ctx.lineTo(g.cx + arm, g.cy)
    ctx.moveTo(g.cx, g.cy - arm)
    ctx.lineTo(g.cx, g.cy + arm)
    ctx.stroke()

    const puck = options.get()
    const [px, py] = puckToCanvas(puck, g)
    if (!mini && (puck.u !== 0 || puck.v !== 0)) {
      ctx.strokeStyle = 'rgba(255,255,255,.45)'
      ctx.beginPath()
      ctx.moveTo(g.cx, g.cy)
      ctx.lineTo(px, py)
      ctx.stroke()
    }
    // The puck, filled with the tint it adds.
    const radius = mini ? 3 : 6
    discColour(puck.u, puck.v, rgb)
    ctx.fillStyle = rgbCss(rgb)
    ctx.beginPath()
    ctx.arc(px, py, radius, 0, TAU)
    ctx.fill()
    ctx.lineWidth = mini ? 1.25 : 2
    ctx.strokeStyle = '#fff'
    ctx.stroke()
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(13,17,23,.8)'
    ctx.beginPath()
    ctx.arc(px, py, radius + (mini ? 1.1 : 1.5), 0, TAU)
    ctx.stroke()

    if (options.readout) setText(options.readout.element, options.readout.text())
  }

  if (mini) {
    return {
      redraw: surface.schedule,
      flush() {},
      setLabel() {},
      dispose: surface.dispose,
    }
  }

  const hooks = options as Required<Pick<ColourWheelOptions, 'set'>> & ColourWheelOptions
  const onInput = () => hooks.onInput?.()
  const onCommit = () => hooks.onCommit?.()
  makeInteractive(canvas, options.label ?? 'Colour wheel')

  /** The unsnapped puck drags and nudges carry along (continuePuck). */
  let raw: Puck | null = null
  let lastDown: Tap | null = null
  /** A press: where it went down (x0, y0) and where the pointer was last (x, y); `armed` once it
   *  has moved past the slop; `inert` for the second press of a double tap, which only waits to
   *  lift. */
  let gesture: {
    id: number; pointerType: string; x0: number; y0: number; x: number; y: number
    armed: boolean; changed: boolean; inert: boolean
  } | null = null
  const nudge = createNudgeCommit(onCommit)
  const keys = createKeyIsolation()

  /** Writes the puck when it differs; true when it did. */
  const write = (puck: Puck) => {
    if (samePuck(puck, options.get())) return false
    hooks.set(puck)
    surface.schedule()
    return true
  }

  const onPointerDown = (event: PointerEvent) => {
    if (event.button > 0) return
    event.stopPropagation()
    if (gesture) return
    nudge.flush()
    capture(canvas, event.pointerId)
    canvas.focus({ preventScroll: true })
    const tap: Tap = { time: event.timeStamp, x: event.clientX, y: event.clientY }
    const press = {
      id: event.pointerId, pointerType: event.pointerType, x0: event.clientX, y0: event.clientY,
      x: event.clientX, y: event.clientY, armed: false, changed: false,
    }
    if (isDoubleTap(lastDown, tap)) {
      lastDown = null
      raw = null
      gesture = { ...press, inert: true }
      if (write({ u: 0, v: 0 })) {
        onInput()
        onCommit()
      }
      return
    }
    lastDown = tap
    raw = continuePuck(raw, options.get())
    gesture = { ...press, inert: false }
  }

  const onPointerMove = (event: PointerEvent) => {
    if (!gesture || event.pointerId !== gesture.id || gesture.inert) return
    if (!gesture.armed) {
      // Nothing moves until the pointer is past the slop, as on the curves; then the drag counts
      // from the press, since gesture.x and y are still there.
      if (Math.hypot(event.clientX - gesture.x0, event.clientY - gesture.y0) <= dragSlopPx(gesture.pointerType)) return
      gesture.armed = true
      // A press that drags is no first tap of a double tap.
      lastDown = null
      hooks.onGrab?.(gesture.id)
    }
    const dx = event.clientX - gesture.x
    const dy = event.clientY - gesture.y
    gesture.x = event.clientX
    gesture.y = event.clientY
    if (dx === 0 && dy === 0) return
    raw = dragPuck(raw ?? options.get(), dx, dy, geometry().radius, event.shiftKey)
    if (write(storedPuck(raw))) {
      gesture.changed = true
      onInput()
    }
  }

  const onPointerEnd = (event: PointerEvent) => {
    if (!gesture || event.pointerId !== gesture.id) return
    const ended = gesture
    gesture = null
    release(canvas, event.pointerId)
    if (ended.changed) onCommit()
  }

  const onKey = (event: KeyboardEvent) => {
    if (event.type !== 'keydown') {
      if (keys.up(event)) event.stopPropagation()
      return
    }
    const shortcut = isShortcut(event, altGraphOf(event))
    if (keys.down(event, widgetIsolatesKey(event.key, shortcut))) event.stopPropagation()
    const action = shortcut || event.altKey ? null : wheelKey(event.key, event.shiftKey)
    if (action?.action === 'nudge') {
      event.preventDefault()
      raw = nudgePuck(continuePuck(raw, options.get()), action.du, action.dv)
      if (write(storedPuck(raw))) {
        onInput()
        nudge.schedule()
      }
      return
    }
    // Any other key ends an arrow-key run as its own undo step; a modifier alone does not.
    if (!isModifierKey(event.key)) nudge.flush()
    if (action?.action === 'reset') {
      event.preventDefault()
      raw = null
      if (write({ u: 0, v: 0 })) {
        onInput()
        onCommit()
      }
    } else if (action?.action === 'blur') canvas.blur()
  }

  const unlisten = listenAll([
    [canvas, 'pointerdown', onPointerDown],
    [canvas, 'pointermove', onPointerMove],
    [canvas, 'pointerup', onPointerEnd],
    [canvas, 'pointercancel', onPointerEnd],
    [canvas, 'lostpointercapture', onPointerEnd],
    [canvas, 'keydown', onKey],
    [canvas, 'keyup', onKey],
    [canvas, 'blur', () => {
      nudge.flush()
      keys.clear()
    }],
    [canvas, 'contextmenu', (event: Event) => event.preventDefault()],
  ])

  return {
    redraw() {
      // The state may have been replaced, or the wheel now edits another puck (the Primary
      // minis): an unsnapped puck left from before would carry over. A drag keeps its own.
      if (!gesture) raw = null
      surface.schedule()
    },
    flush: nudge.flush,
    setLabel(label) { canvas.setAttribute('aria-label', label) },
    dispose() {
      nudge.cancel()
      unlisten()
      surface.dispose()
    },
  }
}

// ---- point editors: the tone curve and the hue curves (plan 5.4, 5.5) ----------------------

export interface PointEditor extends GradeWidget {
  /** The selected point's index, or −1. */
  selected(): number
  /** Drops the selection (a switch of channel or mode). */
  deselect(): void
  /** Removes the selected point as one undo step; false when there is none or it is an end. */
  removeSelected(): boolean
}

interface PointEditorSpec {
  domain(): CurveDomain
  points(): readonly Pt[]
  setPoints(points: Pt[]): void
  /** The plot inside a width × height canvas, CSS px. */
  plot(width: number, height: number): PlotBox
  /** The y a tap at x adds a point at: the curve's own. */
  curveAt(points: readonly Pt[], x: number, d: CurveDomain): number
  /** A dragged y as stored: snapNeutral on the hue curves. */
  dragY(y: number, d: CurveDomain): number
  /** Everything under the points. */
  paintBack(ctx: CanvasRenderingContext2D, box: PlotBox, width: number, height: number): void
  /** The colour of the edited curve and its points. */
  colour(): string
  /** Where a point at canvas x is drawn (twice near a hue curve's seam). */
  pointXs(px: number, box: PlotBox): number[]
  readout(points: readonly Pt[], index: number): string
  label: string
  readoutElement?: HTMLElement
  removeButton?: HTMLButtonElement
  hooks: WidgetHooks
}

type PointGesture =
  /** On a point: it follows the pointer once the pointer has moved past the slop. */
  | { kind: 'point'; id: number; pointerType: string; x0: number; y0: number; tap: Tap; index: number; offsetX: number; offsetY: number; armed: boolean; changed: boolean }
  /** On empty space, undecided: a tap adds a point, a drag adds one and moves it, a finger's
   *  vertical swipe scrolls. */
  | { kind: 'miss'; id: number; pointerType: string; x0: number; y0: number; clientY0: number }
  /** Scrolling the panel by hand, capture released. */
  | { kind: 'scroll'; id: number; lastY: number; scroller: HTMLElement | null }
  /** Done (a removal, a point that could not be added): waits for the pointer to lift. */
  | { kind: 'spent'; id: number; changed: boolean }

const samePoints = (a: readonly Pt[], b: readonly Pt[]) =>
  a.length === b.length && a.every((p, i) => p[0] === b[i][0] && p[1] === b[i][1])

function createPointEditor(canvas: HTMLCanvasElement, spec: PointEditorSpec): PointEditor {
  const { hooks } = spec
  makeInteractive(canvas, spec.label)
  let selected = -1
  /** The last tap on a point, for a double tap. */
  let lastTap: (Tap & { index: number }) | null = null
  let gesture: PointGesture | null = null
  const nudge = createNudgeCommit(() => hooks.onCommit())
  const keys = createKeyIsolation()

  const surface = createSurface(canvas, draw)
  const box = () => spec.plot(surface.width, surface.height)

  function draw(): void {
    const ctx = surface.ctx!
    const { width, height, scaleX, scaleY } = surface
    const d = spec.domain()
    const points = spec.points()
    if (selected >= points.length) selected = -1
    const plot = box()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0)
    spec.paintBack(ctx, plot, width, height)
    const colour = spec.colour()
    for (let i = 0; i < points.length; i++) {
      const [px, py] = toCanvas(points[i][0], points[i][1], plot, d)
      for (const x of spec.pointXs(px, plot)) {
        // 6 px dots; the selected one ringed.
        ctx.fillStyle = colour
        ctx.beginPath()
        ctx.arc(x, py, 3, 0, TAU)
        ctx.fill()
        ctx.lineWidth = 1
        ctx.strokeStyle = PANEL_BG
        ctx.stroke()
        if (i === selected) {
          ctx.lineWidth = 1.5
          ctx.strokeStyle = '#fff'
          ctx.beginPath()
          ctx.arc(x, py, 6, 0, TAU)
          ctx.stroke()
        }
      }
    }
    setText(spec.readoutElement, spec.readout(points, selected))
    if (spec.removeButton) spec.removeButton.disabled = selected < 0 || removePoint(points, selected, d) === null
  }

  /** Writes new points (and where the moved one went), then bake and redraw. Rounded to 1e-6, far
   *  below an 8-bit level, so Copy values carries 100 rather than 99.99999999999999 for a hue the
   *  pointer maths lands on. */
  const write = (points: Pt[], index: number) => {
    spec.setPoints(points.map(([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6] as Pt))
    selected = index
    lastTap = null
    surface.schedule()
    hooks.onInput()
  }

  function removeSelected(): boolean {
    const d = spec.domain()
    const points = spec.points()
    if (selected < 0 || selected >= points.length) return false
    const removed = removePoint(points, selected, d)
    if (!removed) return false
    nudge.flush()
    write(removed, removed.length ? Math.max(selected - 1, 0) : -1)
    hooks.onCommit()
    return true
  }

  const local = (event: PointerEvent) =>
    localPoint(event.clientX, event.clientY, canvas.getBoundingClientRect(), canvas.clientLeft, canvas.clientTop)

  /** A tap or drag on empty space adds a point at the press, on the curve. */
  const addAt = (x0: number, y0: number): number => {
    const d = spec.domain()
    const points = spec.points()
    const [x] = fromCanvas(x0, y0, box(), d)
    const added = insertPoint(points, x, spec.curveAt(points, x, d), undefined, d)
    if (!added) return -1
    write(added.points, added.index)
    return added.index
  }

  // ---- scrolling by hand: a finger that missed swiped mostly vertically
  const onScrollMove = (event: PointerEvent) => {
    if (gesture?.kind !== 'scroll' || event.pointerId !== gesture.id) return
    if (gesture.scroller) gesture.scroller.scrollTop += gesture.lastY - event.clientY
    gesture.lastY = event.clientY
  }
  const onScrollEnd = (event: PointerEvent) => {
    if (gesture?.kind !== 'scroll' || event.pointerId !== gesture.id) return
    stopScroll()
  }
  function stopScroll(): void {
    window.removeEventListener('pointermove', onScrollMove, true)
    window.removeEventListener('pointerup', onScrollEnd, true)
    window.removeEventListener('pointercancel', onScrollEnd, true)
    if (gesture?.kind === 'scroll') gesture = null
  }
  function startScroll(event: PointerEvent, clientY0: number): void {
    const scroller = canvas.closest<HTMLElement>('.design-scroll')
    gesture = { kind: 'scroll', id: event.pointerId, lastY: event.clientY, scroller }
    release(canvas, event.pointerId)
    // The swipe so far, then the rest as it comes (the window sees it wherever the finger goes).
    if (scroller) scroller.scrollTop += clientY0 - event.clientY
    window.addEventListener('pointermove', onScrollMove, true)
    window.addEventListener('pointerup', onScrollEnd, true)
    window.addEventListener('pointercancel', onScrollEnd, true)
  }

  const onPointerDown = (event: PointerEvent) => {
    if (event.button > 0) return
    event.stopPropagation()
    if (gesture) return
    nudge.flush()
    capture(canvas, event.pointerId)
    canvas.focus({ preventScroll: true })
    const [x, y] = local(event)
    const d = spec.domain()
    const points = spec.points()
    const plot = box()
    const hit = hitPoint(points, x, y, event.pointerType, plot, d)
    const tap: Tap = { time: event.timeStamp, x: event.clientX, y: event.clientY }
    if (hit >= 0 && lastTap?.index === hit && isDoubleTap(lastTap, tap)) {
      // A double tap on a point removes it (an end stays).
      lastTap = null
      gesture = { kind: 'spent', id: event.pointerId, changed: false }
      selected = hit
      if (!removeSelected()) surface.schedule()
      return
    }
    if (hit >= 0) {
      selected = hit
      surface.schedule()
      const [px, py] = toCanvas(points[hit][0], points[hit][1], plot, d)
      gesture = {
        kind: 'point', id: event.pointerId, pointerType: event.pointerType, x0: x, y0: y, tap, index: hit,
        offsetX: px - x, offsetY: py - y, armed: false, changed: false,
      }
      return
    }
    gesture = { kind: 'miss', id: event.pointerId, pointerType: event.pointerType, x0: x, y0: y, clientY0: event.clientY }
  }

  const onPointerMove = (event: PointerEvent) => {
    if (!gesture || event.pointerId !== gesture.id) return
    if (gesture.kind === 'scroll' || gesture.kind === 'spent') return
    const [x, y] = local(event)
    if (gesture.kind === 'miss') {
      const intent = missIntent(x - gesture.x0, y - gesture.y0, gesture.pointerType)
      if (intent === 'wait') return
      if (intent === 'scroll') {
        startScroll(event, gesture.clientY0)
        return
      }
      const miss = gesture
      const index = addAt(miss.x0, miss.y0)
      if (index < 0) {
        gesture = { kind: 'spent', id: miss.id, changed: false }
        return
      }
      // The new point follows the pointer from here.
      gesture = {
        kind: 'point', id: miss.id, pointerType: miss.pointerType, x0: miss.x0, y0: miss.y0,
        tap: { time: event.timeStamp, x: event.clientX, y: event.clientY }, index, offsetX: 0, offsetY: 0, armed: true, changed: true,
      }
      hooks.onGrab?.(miss.id)
    }
    const drag = gesture
    if (!drag.armed) {
      if (Math.hypot(x - drag.x0, y - drag.y0) <= dragSlopPx(drag.pointerType)) return
      drag.armed = true
      lastTap = null
      hooks.onGrab?.(drag.id)
    }
    const d = spec.domain()
    const points = spec.points()
    const plot = box()
    const end = !d.periodic && (drag.index === 0 || drag.index === points.length - 1)
    // Where the point would go, not the pointer: it follows the pointer at the offset it was
    // taken at.
    if (!end && outsideBy(x + drag.offsetX, y + drag.offsetY, plot, d.periodic) > REMOVE_OUTSIDE_PX) {
      // Dragged off the plot: gone.
      const removed = removePoint(points, drag.index, d)
      if (removed) {
        write(removed, -1)
        gesture = { kind: 'spent', id: drag.id, changed: true }
        return
      }
    }
    const [ux, uy] = fromCanvas(x + drag.offsetX, y + drag.offsetY, plot, d)
    const moved = movePoint(points, drag.index, ux, spec.dragY(uy, d), d)
    if (!moved || samePoints(moved.points, points)) return
    drag.index = moved.index
    drag.changed = true
    write(moved.points, moved.index)
  }

  const onPointerEnd = (event: PointerEvent) => {
    if (!gesture || event.pointerId !== gesture.id) return
    // Letting go of the capture to scroll is no end.
    if (gesture.kind === 'scroll') {
      if (event.type !== 'lostpointercapture') stopScroll()
      return
    }
    const ended = gesture
    gesture = null
    release(canvas, event.pointerId)
    const lifted = event.type === 'pointerup'
    if (ended.kind === 'point') {
      if (ended.changed) hooks.onCommit()
      else if (lifted && !ended.armed) lastTap = { ...ended.tap, index: ended.index }
    } else if (ended.kind === 'miss') {
      // A tap on empty space adds a point on the curve there.
      if (lifted && addAt(ended.x0, ended.y0) >= 0) hooks.onCommit()
    } else if (ended.changed) hooks.onCommit()
    surface.schedule()
  }

  const onKey = (event: KeyboardEvent) => {
    if (event.type !== 'keydown') {
      if (keys.up(event)) event.stopPropagation()
      return
    }
    const altGraph = altGraphOf(event)
    if (keys.down(event, widgetIsolatesKey(event.key, isShortcut(event, altGraph)))) event.stopPropagation()
    const d = spec.domain()
    const action = curveKeyAction(event, altGraph, d)
    // Any other key ends an arrow-key run as its own undo step; a modifier alone does not.
    if (action?.action !== 'nudge' && !isModifierKey(event.key)) nudge.flush()
    const points = spec.points()
    switch (action?.action) {
      case 'nudge': {
        event.preventDefault()
        if (selected < 0 || selected >= points.length) {
          // The first arrow picks a point; the next ones move it.
          selected = stepSelection(-1, points.length, 1)
          surface.schedule()
          break
        }
        const [px, py] = points[selected]
        const moved = movePoint(points, selected, px + action.dx, py + action.dy, d)
        if (moved && !samePoints(moved.points, points)) {
          write(moved.points, moved.index)
          nudge.schedule()
        }
        break
      }
      case 'select':
        event.preventDefault()
        selected = stepSelection(selected, points.length, action.step)
        surface.schedule()
        break
      case 'remove':
        event.preventDefault()
        removeSelected()
        break
      case 'blur':
        canvas.blur()
        break
    }
  }

  const onRemoveClick = () => {
    removeSelected()
  }

  const listeners: Listener[] = [
    [canvas, 'pointerdown', onPointerDown],
    [canvas, 'pointermove', onPointerMove],
    [canvas, 'pointerup', onPointerEnd],
    [canvas, 'pointercancel', onPointerEnd],
    [canvas, 'lostpointercapture', onPointerEnd],
    [canvas, 'keydown', onKey],
    [canvas, 'keyup', onKey],
    [canvas, 'blur', () => {
      nudge.flush()
      keys.clear()
    }],
    [canvas, 'contextmenu', (event: Event) => event.preventDefault()],
  ]
  if (spec.removeButton) listeners.push([spec.removeButton, 'click', onRemoveClick])
  const unlisten = listenAll(listeners)

  return {
    redraw() {
      // The state may have been replaced: a remembered tap no longer means a point.
      lastTap = null
      surface.schedule()
    },
    flush: nudge.flush,
    setLabel(label) { canvas.setAttribute('aria-label', label) },
    selected: () => selected,
    deselect() {
      nudge.flush()
      selected = -1
      lastTap = null
      surface.schedule()
    },
    removeSelected,
    dispose() {
      nudge.cancel()
      stopScroll()
      unlisten()
      surface.dispose()
    },
  }
}

/** Strokes `ys` (curve y at evenly spaced x across the plot) as one line, clipped to the plot. */
function strokeSamples(ctx: CanvasRenderingContext2D, ys: Float64Array, box: PlotBox, d: CurveDomain): void {
  ctx.beginPath()
  for (let i = 0; i < ys.length; i++) {
    const px = box.left + (ys.length > 1 ? i / (ys.length - 1) : 0) * box.width
    const py = box.top + (d.yMax - ys[i]) / (d.yMax - d.yMin) * box.height
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.stroke()
}

/** Samples a curve every CSS pixel across the plot (at least two). */
const sampleCount = (box: PlotBox) => Math.max(Math.round(box.width) + 1, 2)

export interface CurveEditorOptions extends WidgetHooks {
  curves(): Readonly<GradeCurves>
  /** The curve edited; the other three are drawn faint. */
  channel(): CurveChannel
  /** Writes the edited channel's points. */
  setPoints(points: Pt[]): void
  label: string
  /** "Point 3 · in 128 → out 141". */
  readout?: HTMLElement
  /** Enabled while the selected point can go (not an end). */
  removeButton?: HTMLButtonElement
}

/**
 * The tone curve editor: a square plot with a quarter grid, the identity diagonal, the other
 * channels' curves faint, the edited curve and its 6 px points. A tap on empty space adds a point
 * on the curve (12 at most); a drag moves a point within its neighbours (the ends up and down
 * only); a double tap, a drag more than 24 px off the plot, Delete or Remove point removes one.
 * Hit radius 22 px for a finger, 10 px for a mouse.
 */
export function createCurveEditor(canvas: HTMLCanvasElement, options: CurveEditorOptions): PointEditor {
  return createPointEditor(canvas, {
    domain: () => TONE_CURVE,
    points: () => options.curves()[options.channel()],
    setPoints: options.setPoints,
    plot: (width, height) => curvePlot(width, height),
    curveAt: (points, x) => toneCurveAt(points, x),
    dragY: (y) => y,
    colour: () => CHANNEL_COLOURS[options.channel()],
    pointXs: (px) => [px],
    paintBack(ctx, box) {
      const d = TONE_CURVE
      ctx.lineWidth = 1
      // Quarter grid and the frame.
      ctx.strokeStyle = 'rgba(232,234,237,.07)'
      ctx.beginPath()
      for (let i = 1; i < 4; i++) {
        const x = box.left + box.width * i / 4
        const y = box.top + box.height * i / 4
        ctx.moveTo(x, box.top)
        ctx.lineTo(x, box.top + box.height)
        ctx.moveTo(box.left, y)
        ctx.lineTo(box.left + box.width, y)
      }
      ctx.stroke()
      ctx.strokeStyle = 'rgba(232,234,237,.16)'
      ctx.strokeRect(box.left, box.top, box.width, box.height)
      // The identity.
      ctx.setLineDash([3, 3])
      ctx.strokeStyle = 'rgba(232,234,237,.22)'
      ctx.beginPath()
      ctx.moveTo(box.left, box.top + box.height)
      ctx.lineTo(box.left + box.width, box.top)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.save()
      ctx.beginPath()
      ctx.rect(box.left, box.top, box.width, box.height)
      ctx.clip()
      const curves = options.curves()
      const active = options.channel()
      const count = sampleCount(box)
      // The other channels, faint, where they are not the diagonal.
      ctx.globalAlpha = 0.38
      for (const channel of CURVE_CHANNELS) {
        if (channel === active || isDefaultToneCurve(curves[channel])) continue
        ctx.strokeStyle = CHANNEL_COLOURS[channel]
        strokeSamples(ctx, toneCurveSamples(curves[channel], count), box, d)
      }
      ctx.globalAlpha = 1
      ctx.lineWidth = 1.5
      ctx.strokeStyle = CHANNEL_COLOURS[active]
      strokeSamples(ctx, toneCurveSamples(curves[active], count), box, d)
      ctx.restore()
    },
    readout: curveReadout,
    label: options.label,
    readoutElement: options.readout,
    removeButton: options.removeButton,
    hooks: options,
  })
}

export interface HueCurveEditorOptions extends WidgetHooks {
  /** Hue vs saturation or hue vs luma. */
  mode(): HueMode
  /** The edited curve's points. */
  points(): readonly Pt[]
  setPoints(points: Pt[]): void
  label: string
  /** "Point 2 · hue 104° → 120%". */
  readout?: HTMLElement
  removeButton?: HTMLButtonElement
}

/**
 * The hue curve editor: hue 0–360° across the full width over a hue strip, saturation 0–2 around
 * 1 or luma −1 to +1 stops around 0, a faint band over the canopy's hues (90–108°). The curve is
 * periodic: it and the points near an edge are drawn at both edges, and a point dragged past one
 * comes back in at the other. A dragged point within 0.01 of neutral snaps onto it; there are no
 * ends, so every point can go. Otherwise as the tone curve editor.
 */
export function createHueCurveEditor(canvas: HTMLCanvasElement, options: HueCurveEditorOptions): PointEditor {
  return createPointEditor(canvas, {
    domain: () => hueDomain(options.mode()),
    points: options.points,
    setPoints: options.setPoints,
    plot: huePlot,
    curveAt: (points, x, d) => hueCurveAt(points, x, d),
    dragY: (y, d) => snapNeutral(y, d),
    colour: () => ACCENT_LIGHT,
    pointXs: (px, box) => wrappedXs(px, box, 8),
    paintBack(ctx, box, width) {
      const mode = options.mode()
      const d = hueDomain(mode)
      const xOf = (hue: number) => toCanvas(hue, 0, box, d)[0]
      const yOf = (value: number) => toCanvas(0, value, box, d)[1]
      ctx.lineWidth = 1
      // The canopy's hues.
      const [from, to] = CANOPY_HUES
      ctx.fillStyle = 'rgba(232,234,237,.07)'
      ctx.fillRect(xOf(from), box.top, xOf(to) - xOf(from), box.height)
      ctx.font = FONT
      ctx.textBaseline = 'top'
      ctx.fillStyle = INK_FAINT
      ctx.fillText('canopy', xOf(to) + 3, box.top + 1)
      // The primaries and secondaries, faint.
      ctx.strokeStyle = 'rgba(232,234,237,.06)'
      ctx.beginPath()
      for (let hue = 60; hue < 360; hue += 60) {
        ctx.moveTo(xOf(hue), box.top)
        ctx.lineTo(xOf(hue), box.top + box.height)
      }
      ctx.stroke()
      // Neutral, and the scale at the left edge.
      ctx.strokeStyle = 'rgba(232,234,237,.28)'
      ctx.beginPath()
      ctx.moveTo(box.left, yOf(d.neutral ?? 0))
      ctx.lineTo(box.left + box.width, yOf(d.neutral ?? 0))
      ctx.stroke()
      ctx.fillStyle = INK_FAINT
      ctx.textBaseline = 'top'
      ctx.fillText(mode === 'sat' ? '200%' : '+1 stop', 3, box.top + 1)
      ctx.textBaseline = 'bottom'
      ctx.fillText(mode === 'sat' ? '0%' : '−1 stop', 3, box.top + box.height - 1)
      // The curve.
      ctx.save()
      ctx.beginPath()
      ctx.rect(0, box.top - 4, width, box.height + 8)
      ctx.clip()
      ctx.lineWidth = 1.5
      ctx.strokeStyle = ACCENT_LIGHT
      strokeSamples(ctx, hueCurveSamples(options.points(), d, sampleCount(box)), box, d)
      ctx.restore()
      // The hue strip: hexcone hue is linear between the six primaries and secondaries, so seven
      // stops draw it exactly.
      const strip = hueStrip(box)
      const gradient = ctx.createLinearGradient(box.left, 0, box.left + box.width, 0)
      for (let k = 0; k <= 6; k++) gradient.addColorStop(k / 6, `hsl(${k * 60}, 80%, 52%)`)
      ctx.fillStyle = gradient
      ctx.fillRect(box.left, strip.top, box.width, strip.height)
      ctx.fillStyle = 'rgba(13,17,23,.35)'
      ctx.fillRect(xOf(from), strip.top, xOf(to) - xOf(from), 2)
    },
    readout: (points, index) => hueReadout(points, index, options.mode()),
    label: options.label,
    readoutElement: options.readout,
    removeButton: options.removeButton,
    hooks: options,
  })
}
