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
const MOBILE_REFERENCE_HEIGHT = 1920
const DESKTOP_REFERENCE_WIDTH = 1920
const DESKTOP_REFERENCE_HEIGHT = 1080
const FIGMA_MARGIN_PX = 60
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
 * The window's boundary as a single path: a rounded rect with two notches
 * bitten into its top corners. Each notch's inner elbow is a genuine 270deg
 * reflex vertex: the two adjoining edges reach the vertex exactly, overshoot
 * past it by r (continuing their own direction of travel), and an r-radius
 * arc centered ON the vertex connects the two overshoot points -- this is
 * NOT the same shape as a plain convex corner with the sweep flag flipped
 * (that reads as smooth but is a much tighter, wrong flare than Figma's
 * real one). `tl`/`tr` are how far each notch reaches into the window from
 * that corner (width = horizontal reach, height = vertical reach).
 *
 * `radius` is the already-SCALED corner radius. It has to be passed in rather
 * than read from WINDOW_CORNER_RADIUS directly: that constant is Figma px
 * against the 1080-wide mobile frame, and the margin and notch reach are both
 * scaled by currentScale() before they get here. Leaving the radius unscaled
 * made the window's corners hold a fixed 60 CSS px at every viewport, so at
 * the viewer's ~0.49 scale they were about twice as round as the photo they
 * are meant to match in Figma.
 */
function windowPath(win: Rect, tl: { width: number; height: number }, tr: { width: number; height: number }, radius: number): string {
  const r = Math.max(0, Math.min(radius, tl.width, tl.height, tr.width, tr.height, win.width / 2, win.height / 2))
  const R = Math.max(0, Math.min(radius, win.width / 2, win.height / 2))
  const { x, y, width: w, height: h } = win
  const tlW = tl.width
  const tlH = tl.height
  const trW = tr.width
  const trH = tr.height
  return [
    `M${x + tlW + r},${y}`,
    `H${x + w - trW - r}`,
    r > 0 ? `A${r},${r} 0 0 1 ${x + w - trW},${y + r}` : '',
    `V${y + trH}`,
    // Elbow: a genuine 270deg reflex vertex, not a plain radius -- the
    // adjoining edges reach the vertex exactly and overshoot PAST it (by r,
    // continuing each edge's own direction of travel) before the arc (radius
    // r, centered on the vertex itself) connects the two overshoot points.
    // A direct short arc between pulled-back endpoints still reads as
    // "smooth" but is a much tighter, wrong-shaped flare than Figma's real
    // one -- see this file's header.
    r > 0 ? `L${x + w - trW},${y + trH + r} A${r},${r} 0 0 1 ${x + w - trW - r},${y + trH} L${x + w - trW},${y + trH}` : '',
    `H${x + w - r}`,
    r > 0 ? `A${r},${r} 0 0 1 ${x + w},${y + trH + r}` : '',
    `V${y + h - R}`,
    R > 0 ? `A${R},${R} 0 0 1 ${x + w - R},${y + h}` : '',
    `H${x + R}`,
    R > 0 ? `A${R},${R} 0 0 1 ${x},${y + h - R}` : '',
    `V${y + tlH + r}`,
    r > 0 ? `A${r},${r} 0 0 1 ${x + r},${y + tlH}` : '',
    `H${x + tlW}`,
    r > 0 ? `L${x + tlW + r},${y + tlH} A${r},${r} 0 0 1 ${x + tlW},${y + tlH + r} L${x + tlW},${y + tlH}` : '',
    `V${y + r}`,
    r > 0 ? `A${r},${r} 0 0 1 ${x + tlW + r},${y}` : '',
    'Z',
  ]
    .filter(Boolean)
    .join(' ')
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
