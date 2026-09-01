// Owns the "grey frame" backdrop: a gray/200 SVG rect masked to show a big
// rounded window (the point-cloud viewport) with two notches bitten into
// its own top corners, matching how Figma's real "S1: Photo" node works --
// it's a VECTOR whose vertex list gives EVERY vertex the same cornerRadius
// (60), including the two reflex/concave "elbow" vertices where a notch
// turns the corner:
//   M 0 1789 L 0 57.5 L 122.78 57.5 L 122.78 0 L 600 0 L 600 359.1
//   L 960 359.1 L 960 1789 Z
// (mobile Frame 1, local to the photo). Frame 1 Desktop has the identical
// two-notch pattern at desktop scale, confirming it's deliberate, not a
// mobile-only shape. Both notches are bites taken INTO the photo's own
// bounding box from its top-left/top-right corners -- they never reach
// past the photo's own edges into the outer margin.
//
// Concretely: (0,57.5), (122.78,0), (600,0), (960,359.1) are plain convex
// corners (material fills one quadrant around them, like a normal rounded
// rect corner). (122.78,57.5) and (600,359.1) -- the inner elbow of each
// notch -- are concave/reflex: material fills THREE of the four quadrants
// around them, so the rounding has to bulge outward into the missing
// quadrant instead of cutting the corner off. A plain rect-with-rx per
// notch can't express that concave elbow -- this builds one continuous
// path instead, reusing the same "same two endpoints, opposite arc sweep"
// trick used for the Corner atom's concave type in geometry/silhouette.ts.
//
// Margin is live, animatable state (not a fixed computed constant), so the
// frame can reveal/retract by tweening margin between 0 and its resting
// value -- see animateMarginTo().
//
// Sized against its own `container` element (via ResizeObserver), not the
// browser window -- this is what lets the SAME engine fill the real
// viewer's full-viewport container AND a fixed-size Storybook screen
// example, with no special-casing. The container must establish a
// positioning context (e.g. `position: relative`) and its own size --
// this module only reads it, never sets it.

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Frame {
  /** Sets the margin instantly (no animation) and re-renders the window and every notch. */
  setMargin(px: number): void
  getMargin(): number
  /** The frame's resting margin for the current container size -- a real visible border, not a thin sliver. */
  getTargetMargin(): number
  /** containerWidth / referenceFrameWidth (portrait vs. landscape picking Figma's mobile/desktop frame) -- the one scale factor content docked to this frame should size itself against, so it's not re-derived per caller. */
  getContentScale(): number
  /** getContentScale(), floored at MIN_TYPE_SCALE. Text that can grow without breaking its container should size against THIS instead, so it stays legible when the layout scale drops below reading size. */
  getTypeScale(): number
  /** How far the weather-cluster notch reaches into the window from its top-right corner. Call every layout pass with the cluster's live rendered size. */
  setTopRightReach(width: number, height: number): void
  /**
   * Registers/updates a named notch's cutout rect (container-relative pixel
   * coords), for anything docked away from the two corner notches above
   * (e.g. the species cluster, which sits fully inside the window and so
   * reports a no-op rect). A plain rect is fine here since there's no
   * concave elbow to get right for these.
   */
  setNotch(id: string, rect: Rect): void
  /** Tweens margin from its current value to `px` over `durationMs`, calling onTick after every frame's setMargin (so callers can reposition frame-docked elements as the margin moves). */
  animateMarginTo(px: number, durationMs: number, onTick?: () => void): Promise<void>
  /** Recomputes svg/window sizing for the container's current size -- called automatically on resize, exposed for callers who need to force one. */
  handleResize(): void
  dispose(): void
}

const SVG_NS = 'http://www.w3.org/2000/svg'

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value)
  return el
}

// Reference-frame widths the caller's content is expected to scale against
// too (see screen-frame's dock/content-scale usage), reused here so the
// margin and the logo-notch reach stay visually proportional to Figma
// instead of independent guesses. Rahmen's real margin in Figma is a
// constant 60px within the 1080-wide mobile frame (~60-70px within the
// 1920-wide desktop frame -- close enough to treat as the same constant);
// the logo notch's real reach is ~123x58.
const MOBILE_REFERENCE_WIDTH = 1080
// 19.5:9, not the 16:9 the Figma frames are drawn at. Every iPhone since the X is
// 19.5:9; 16:9 stopped being a phone shape in 2017 and now only matches the SE.
// Because currentScale() takes the MINIMUM of both axis ratios, a reference whose
// aspect differs from the device's leaves the slack axis unused: at 390x844 the
// old 1920 reference bound on width and left ~150px of height that the design had
// no plan for. Matching the aspect makes both axes bind at once (0.3611 vs 0.3607
// there) so there is no leftover.
//
// This does NOT make type bigger -- measured at 390x844 the scale moves from
// 0.3611 to 0.3607. Legibility is a separate problem, see MIN_TYPE_SCALE.
const MOBILE_REFERENCE_HEIGHT = 2340
const DESKTOP_REFERENCE_WIDTH = 1920
const DESKTOP_REFERENCE_HEIGHT = 1080
const FIGMA_MARGIN_PX = 60
/**
 * Floor for the scale TYPE is drawn at, independent of the scale the layout is
 * drawn at.
 *
 * The composition is authored 1080 wide and shown on a ~390px phone, so
 * everything is reduced by ~2.8x. Measured at 390x844, that puts the widget
 * captions at 4.3 CSS px and the species names at 8.7 -- not small, unreadable.
 * A 34px Figma label needs a scale of ~0.47 to land at 16px, hence this floor.
 *
 * It is deliberately NOT applied to the layout scale. Flooring that would inflate
 * the boxes too, and the species row (960 Figma px) already fills the window at
 * 0.36 -- at 0.47 it would run off the screen. So only text is floored, and only
 * where the container can absorb it: the label and subtitle pills hug their text
 * and simply grow. Fixed-size widgets keep scaling with the layout, because
 * bigger text inside a fixed box overflows it. Making THOSE legible is a design
 * change (larger type in the source frames, or a mobile-specific arrangement),
 * not something a scale factor can fix.
 */
const MIN_TYPE_SCALE = 0.47
const FIGMA_TOP_LEFT_NOTCH_PX = { width: 123, height: 58 }
const WINDOW_CORNER_RADIUS = 60

/**
 * True when the container is portrait ENOUGH to measure itself against
 * Figma's mobile reference frame (1080x1920) rather than the desktop one
 * (1920x1080) -- this drives currentScale() below, and with it the frame's
 * margin and notch reach.
 *
 * A plain `height >= width` tie-break routes every near-square container
 * (e.g. a 900x900 window) to the mobile reference, where the fixed-px
 * content sized against a 1080-wide frame ends up far too large for the
 * near-square window it's actually in. 1.2 keeps both Figma-verified
 * frames on their intended side (1920/1080 ~= 1.78 either way) while
 * routing the ambiguous near-square middle to the desktop reference.
 *
 * Note this is NOT what picks the species/label dock arrangement -- that's
 * a real measured collision check (dock.ts's fitsPortraitArrangement, used
 * by ScreenFrame.svelte's layout()), because an aspect-ratio guess can't
 * know how tall the row actually renders for the current content.
 */
export function isPortraitAspect(width: number, height: number): boolean {
  return height >= width * 1.2
}

// Both dimensions are checked (not just width) because a window can be
// stretched thin on either axis independently of the other -- a wide-but-
// short window (e.g. 2200x500) has plenty of width to justify the desktop
// reference's full scale, but at that scale the species row's real content
// height (its collapsed/expanded card heights are fixed Figma px, scaled by
// this same factor) is taller than the window itself, so it pokes out
// through the frame's own top edge (clipped by `.screen-frame`'s
// `overflow: hidden`) while the weather cluster and label -- both anchored
// to opposite corners at that same too-large scale -- collide in the
// leftover middle. Taking the smaller of the two axis scales (the standard
// "letterbox"/`object-fit: contain` rule) keeps every docked cluster's real
// pixel size inside whichever dimension is actually the tighter fit,
// trading unused margin on the generous axis for guaranteed no overflow --
// exactly like the 1280x720 and 390x844 reference sizes already get (their
// two axis scales happen to match, so this is a no-op for both).
function currentScale(containerWidth: number, containerHeight: number): number {
  const portrait = isPortraitAspect(containerWidth, containerHeight)
  const referenceWidth = portrait ? MOBILE_REFERENCE_WIDTH : DESKTOP_REFERENCE_WIDTH
  const referenceHeight = portrait ? MOBILE_REFERENCE_HEIGHT : DESKTOP_REFERENCE_HEIGHT
  return Math.min(containerWidth / referenceWidth, containerHeight / referenceHeight)
}

/**
 * The window's boundary as a single path.
 *
 * Figma does not model this as "a rounded rect with two notches" -- it is ONE
 * polygon whose every vertex carries the same cornerRadius (60), and the notch
 * elbows are simply the vertices where the polygon turns the other way. The
 * real "S1: Photo" vertex list, photo-local:
 *
 *   (0,1789) (0,57.5) (122.78,57.5) (122.78,0) (600,0) (600,359.1)
 *   (960,359.1) (960,1789)
 *
 * so this builds exactly that and lets filletPath do the rest. Two consequences
 * fall out of the uniform treatment that hand-rolling the elbow got wrong:
 *
 *  - The elbow fillet is CONCAVE, and that is load-bearing, not cosmetic. At
 *    the weather notch's elbow the photo bulges into the corner on an r=60 arc
 *    centred at exactly the same point as the r=60 convex corner of the widget
 *    that sits there -- so the two are perfect complements and the surfaces
 *    meet with nothing between them. Get the elbow wrong and a band of frame
 *    grey shows through the join (measured: 3px under the weather cluster).
 *
 *  - Each vertex's radius is clamped to HALF its shortest adjoining edge, so
 *    two fillets can never overrun each other. On the 57.5-tall logo notch that
 *    clamps both its vertices to 28.75 and the fillets meet exactly, which is
 *    why Figma's logo elbow reads as one continuous S-curve with no straight
 *    segment between the two arcs.
 *
 * `tl`/`tr` are how far each notch reaches into the window from that corner
 * (width = horizontal reach, height = vertical reach), and must be the docked
 * cluster's real rect -- the notch is the hole the cluster sits in, so any
 * slack between the two is frame grey the design does not have.
 *
 * `radius` is the already-SCALED corner radius. It has to be passed in rather
 * than read from WINDOW_CORNER_RADIUS directly: that constant is Figma px
 * against the 1080-wide mobile frame, and the margin and notch reach are both
 * scaled by currentScale() before they get here. Leaving the radius unscaled
 * made the window's corners hold a fixed 60 CSS px at every viewport, so at
 * the viewer's ~0.49 scale they were about twice as round as the photo they
 * are meant to match in Figma.
 */
export function windowPath(win: Rect, tl: { width: number; height: number }, tr: { width: number; height: number }, radius: number): string {
  const { x, y, width: w, height: h } = win
  return filletPath(
    [
      [x, y + h],
      [x, y + tl.height],
      [x + tl.width, y + tl.height],
      [x + tl.width, y],
      [x + w - tr.width, y],
      [x + w - tr.width, y + tr.height],
      [x + w, y + tr.height],
      [x + w, y + h],
    ],
    radius,
  )
}

type Point = readonly [number, number]

/**
 * Rounds every vertex of a closed polygon, the way Figma rounds every vertex of
 * a vector network: pull back along each adjoining edge and join the two
 * tangent points with an arc.
 *
 * Convex and reflex vertices need no special casing -- the construction is the
 * same and only the sweep direction differs, which the turn's cross product
 * already tells us. (Hand-rolling the reflex case separately is what put a
 * grey wedge in the notch elbows.) Both are 90deg turns here, so the tangent
 * pull-back is just r.
 *
 * A vertex is clamped to half of its shortest adjoining edge so neighbouring
 * fillets meet at worst exactly, never overrun. Collinear and repeated vertices
 * pass straight through, so a notch whose reach collapses to zero degenerates
 * into a plain rounded rect with no caller-side branching.
 */
function filletPath(vertices: readonly Point[], radius: number): string {
  const pts: Point[] = []
  for (const v of vertices) {
    const last = pts[pts.length - 1]
    if (!last || Math.abs(last[0] - v[0]) > 1e-6 || Math.abs(last[1] - v[1]) > 1e-6) pts.push(v)
  }
  while (pts.length > 1 && Math.abs(pts[0][0] - pts[pts.length - 1][0]) < 1e-6 && Math.abs(pts[0][1] - pts[pts.length - 1][1]) < 1e-6) pts.pop()
  const n = pts.length
  if (n < 3) return ''

  const round = (v: number) => Number(v.toFixed(3))
  const heads: string[] = []
  const arcs: string[] = []

  for (let i = 0; i < n; i++) {
    const [px, py] = pts[(i - 1 + n) % n]
    const [cx, cy] = pts[i]
    const [nx, ny] = pts[(i + 1) % n]
    const inLen = Math.hypot(cx - px, cy - py)
    const outLen = Math.hypot(nx - cx, ny - cy)
    const ux = (cx - px) / inLen
    const uy = (cy - py) / inLen
    const vx = (nx - cx) / outLen
    const vy = (ny - cy) / outLen
    const cross = ux * vy - uy * vx
    const r = Math.abs(cross) < 1e-9 ? 0 : Math.max(0, Math.min(radius, inLen / 2, outLen / 2))
    if (r === 0) {
      heads.push(`${round(cx)},${round(cy)}`)
      arcs.push('')
      continue
    }
    heads.push(`${round(cx - ux * r)},${round(cy - uy * r)}`)
    arcs.push(`A${round(r)},${round(r)} 0 0 ${cross > 0 ? 1 : 0} ${round(cx + vx * r)},${round(cy + vy * r)}`)
  }

  const d = [`M${heads[0]}`]
  for (let i = 0; i < n; i++) {
    if (arcs[i]) d.push(arcs[i])
    d.push(`L${heads[(i + 1) % n]}`)
  }
  d.push('Z')
  return d.join(' ')
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

export function createFrame(container: HTMLElement): Frame {
  const svg = svgEl('svg')
  svg.style.position = 'absolute'
  svg.style.inset = '0'
  svg.style.zIndex = '40'
  svg.style.pointerEvents = 'none'

  const maskId = `screen-frame-mask-${Math.random().toString(36).slice(2, 9)}`
  const mask = svgEl('mask', { id: maskId })
  const maskBackground = svgEl('rect', { x: '0', y: '0', fill: 'white' })
  const windowShape = svgEl('path', { fill: 'black' })
  mask.append(maskBackground, windowShape)

  const gray = svgEl('rect', { x: '0', y: '0', fill: 'var(--gray-200)' })
  gray.setAttribute('mask', `url(#${maskId})`)

  // NO sheen over the margin. An earlier version layered the same
  // light-from-top-left/shadow-at-bottom-right gradient here that BentoWidget
  // puts on its card fills, so the margin would read as art-directed material
  // rather than a flat grey letterbox. Measured against the Figma raster that
  // is simply wrong: Figma's margin is a dead-flat rgb(220,220,220) on every
  // frame, while the sheen spread ours across 28 luminance levels corner to
  // corner (231 top-left to 203 bottom-right). Figma is the spec for how this
  // looks, so the margin stays flat.
  svg.append(mask, gray)
  container.append(svg)

  const notchElements = new Map<string, SVGRectElement>()

  function setNotchRect(el: SVGRectElement, rect: Rect, radius: number) {
    el.setAttribute('x', String(rect.x))
    el.setAttribute('y', String(rect.y))
    el.setAttribute('width', String(Math.max(0, rect.width)))
    el.setAttribute('height', String(Math.max(0, rect.height)))
    el.setAttribute('rx', String(radius))
  }

  let margin = 0
  let topRightReach = { width: 0, height: 0 }

  function render() {
    const containerWidth = container.clientWidth
    const containerHeight = container.clientHeight
    const w = String(containerWidth)
    const h = String(containerHeight)
    svg.setAttribute('width', w)
    svg.setAttribute('height', h)
    maskBackground.setAttribute('width', w)
    maskBackground.setAttribute('height', h)
    gray.setAttribute('width', w)
    gray.setAttribute('height', h)

    const scale = currentScale(containerWidth, containerHeight)
    const topLeftReach = { width: FIGMA_TOP_LEFT_NOTCH_PX.width * scale, height: FIGMA_TOP_LEFT_NOTCH_PX.height * scale }
    const win: Rect = { x: margin, y: margin, width: containerWidth - margin * 2, height: containerHeight - margin * 2 }
    windowShape.setAttribute('d', windowPath(win, topLeftReach, topRightReach, WINDOW_CORNER_RADIUS * scale))
  }
  render()

  // Observed in testing: a mask="url(#id)" reference set in the same tick
  // the <mask> element is inserted can render as if the mask weren't there
  // at all (fully opaque, no cutouts) until something forces the browser to
  // re-resolve the reference. A same-frame requestAnimationFrame reset
  // wasn't a long enough delay to fix it reliably; toggling the attribute
  // off and back on after the page has had a moment to settle is what
  // verified clean across repeated fresh loads.
  setTimeout(() => {
    gray.removeAttribute('mask')
    gray.setAttribute('mask', `url(#${maskId})`)
  }, 200)

  const resizeObserver = new ResizeObserver(() => render())
  resizeObserver.observe(container)

  function apply(px: number) {
    margin = px
    render()
  }

  let animationFrame = 0

  return {
    setMargin: apply,
    getMargin() {
      return margin
    },
    getTargetMargin() {
      return FIGMA_MARGIN_PX * currentScale(container.clientWidth, container.clientHeight)
    },
    getTypeScale() {
      return Math.max(currentScale(container.clientWidth, container.clientHeight), MIN_TYPE_SCALE)
    },
    getContentScale() {
      return currentScale(container.clientWidth, container.clientHeight)
    },
    setTopRightReach(width, height) {
      topRightReach = { width, height }
      render()
    },
    setNotch(id, rect) {
      let el = notchElements.get(id)
      if (!el) {
        el = svgEl('rect', { fill: 'black' })
        mask.append(el)
        notchElements.set(id, el)
      }
      setNotchRect(el, rect, 40)
    },
    animateMarginTo(target, durationMs, onTick) {
      // A zero (or negative) duration is a JUMP, and jumping through the
      // animation path is wrong twice over: (now - startTime) / 0 is NaN on the
      // first tick, which applies a NaN margin and collapses the frame; and it
      // still waits on a rAF, which a throttled or backgrounded tab may never
      // deliver -- so the promise hangs on exactly the code path a caller picked
      // BECAUSE it wanted the result immediately. Apply and resolve inline.
      if (!(durationMs > 0)) {
        cancelAnimationFrame(animationFrame)
        apply(target)
        onTick?.()
        return Promise.resolve()
      }
      return new Promise((resolve) => {
        cancelAnimationFrame(animationFrame)
        const start = margin
        const startTime = performance.now()
        function tick(now: number) {
          const t = Math.min(1, (now - startTime) / durationMs)
          apply(start + (target - start) * easeOutCubic(t))
          onTick?.()
          if (t < 1) {
            animationFrame = requestAnimationFrame(tick)
          } else {
            resolve()
          }
        }
        animationFrame = requestAnimationFrame(tick)
      })
    },
    handleResize: render,
    dispose() {
      cancelAnimationFrame(animationFrame)
      resizeObserver.disconnect()
      svg.remove()
    },
  }
}
