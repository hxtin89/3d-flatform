// Generic docking: positions a host element against either the true
// container edge ('outer') or the frame's current, possibly-animating
// window edge ('frame'). Works for content of any size -- it always reads
// the host's live getBoundingClientRect(), never an assumed fixed size.
//
// `host` must be an absolutely-positioned child of the SAME positioning
// container the Frame's svg was built against (see frame.ts) -- that's what
// makes `top/right/bottom/left: 0` anchor to the container's edges instead
// of the viewport's.
//
// Reporting the docked rect to the frame (as a notch, or as a top-right
// reach for the concave-elbow corner notch) is the caller's job via
// `onRect`, not this module's -- different clusters need different Frame
// APIs (see ScreenFrame.svelte), and dockElement only knows positioning.
//
// Collision avoidance (DockConfig.avoid) lives here rather than in the
// caller for the same reason: it is positioning, and it needs the composed
// transform's own maths to convert "put the visual centre HERE" into the
// translate the transform actually takes. Every caller doing that
// conversion itself would be the same derivation copied twice, and it is
// the sort of derivation that is wrong quietly rather than loudly.
import type { Frame } from './frame'

export type DockEdge = 'top-right' | 'bottom-center' | 'bottom-left' | 'bottom-right' | 'left-center' | 'right-center'
export type DockMode = 'outer' | 'frame'

// Per-edge: which CSS inset properties anchor it, which direction is "inward"
// (the sign/axis animateMarginTo's margin should push the element as the
// frame's window shrinks), and whether centering translate is needed for an
// edge that isn't corner-anchored on both axes (bottom-center, *-center).
const EDGE_ANCHOR: Record<DockEdge, { top?: string; right?: string; bottom?: string; left?: string; origin: string; centering: string; inward: (margin: number) => [number, number] }> = {
  'top-right': { top: '0', right: '0', origin: 'top right', centering: '', inward: (m) => [-m, m] },
  'bottom-center': { bottom: '0', left: '50%', origin: 'bottom center', centering: 'translateX(-50%) ', inward: (m) => [0, -m] },
  'bottom-left': { bottom: '0', left: '0', origin: 'bottom left', centering: '', inward: (m) => [m, -m] },
  'bottom-right': { bottom: '0', right: '0', origin: 'bottom right', centering: '', inward: (m) => [-m, -m] },
  'left-center': { left: '0', top: '50%', origin: 'left center', centering: 'translateY(-50%) ', inward: (m) => [m, 0] },
  'right-center': { right: '0', top: '50%', origin: 'right center', centering: 'translateY(-50%) ', inward: (m) => [-m, 0] },
}

export interface DockConfig {
  /** A function is re-resolved on every update() -- lets a dock switch sides (e.g. left in portrait, right in landscape). */
  edge: DockEdge | (() => DockEdge)
  mode: DockMode
  /**
   * Overrides the shared --screen-frame-content-scale for THIS dock only,
   * re-resolved on every update() (so it can track the live, animating
   * margin). Everything docked to the frame normally scales by the one
   * shared factor; the species row is the exception, because Figma authors
   * it exactly as wide as the mobile frame's window (960 inside 1080-120),
   * i.e. as a fill-the-window band rather than a fixed-size cluster -- see
   * ScreenFrame.svelte's speciesScale().
   */
  scale?: () => number
  /**
   * Extra downward offset, in CSS px, for a `*-center` edge -- re-resolved on
   * every update() so it can track the live content scale and the live
   * margin. Only honoured for 'left-center'/'right-center': those are the
   * only edges whose vertical placement is a free choice (a corner edge is
   * pinned on both axes by definition, and nudging it off its corner would
   * just be a different, undeclared edge).
   *
   * Exists because the habitat label stack is NOT vertically centred in
   * Figma. Measured off Frame 1 Mobile: the window spans y 71..1860 (centre
   * 965.5) and the three pills span y 924..1145 (centre 1034.5), i.e. the
   * stack's centre sits 69px BELOW the window's centre. Centring it instead
   * is visibly wrong against the reference -- it lifts the stack a full
   * pill-height too high. The caller passes 69 * contentScale, the same way
   * every other fixed Figma px in this engine is scaled.
   */
  verticalDrop?: () => number
  /**
   * Widget rects (container-relative, i.e. the same space onRect reports in)
   * that this dock must never overlap. Re-resolved on every update(), so it
   * reads whatever the other docks last measured rather than an assumed
   * size -- the species row in particular grows TALL when one of its cards
   * is expanded, and a fixed-size assumption here would be wrong the moment
   * a card opens.
   *
   * Honoured for the same `*-center` edges verticalDrop is, and for the same
   * reason: clearing an obstacle means moving along the axis the edge leaves
   * free. Rects that don't overlap this dock horizontally are ignored (a
   * top-right weather cluster simply isn't in a narrow left-docked stack's
   * way on a wide frame), and one that does shrinks the free vertical band
   * from whichever side it sits on. The dock is then CLAMPED into that band
   * -- never relocated to another corner, which would re-introduce exactly
   * the two-arrangement split this replaced.
   */
  avoid?: () => Rect[]
  /** Called with the host's rect in CONTAINER-relative coordinates (matching the Frame svg's own coordinate space), not viewport-relative. */
  onRect: (rect: Rect) => void
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Docked {
  /** Recomputes position (for 'frame' mode, against the live margin) and calls onRect. Call on resize and on every frame-margin animation tick. */
  update(): void
}

/**
 * Whether the species row's real bottom-anchored height leaves enough room
 * above it for the label stack to sit at its natural Figma-mobile height
 * without the two colliding. A container-aspect-ratio guess (e.g. "portrait
 * means tall enough") breaks down for any near-square size: the species
 * row's real rendered height doesn't shrink with aspect ratio the same way
 * the frame's own margin/notch geometry does, so a fixed ratio threshold
 * that's safe for one species dataset (or one expand/collapse state) is
 * wrong for another. Measuring the actual boxes -- both already
 * docked/rendered by the time this runs -- is the only check that can't
 * drift out of sync with real content. It reads whatever size the species
 * row is CURRENTLY rendered at, so callers can ask it the same question
 * twice: once with the row filling the window's width, and again with the
 * row back at Figma's own content scale (see ScreenFrame.svelte's layout()).
 *
 * `labelCentreY` is where the stack's centre WANTS to be (container-relative
 * px) before any collision clamping -- container.clientHeight / 2 plus the
 * dock's verticalDrop. It has to be passed rather than assumed to be the
 * midpoint: the stack is not centred (see DockConfig.verticalDrop), so
 * assuming the midpoint asks a question about a position the stack never
 * occupies, and answers "fits" for sizes where the real, lower position
 * does not.
 *
 * What the answer now decides is ONLY whether the species row may stretch to
 * span the window's full width (a full-width row is taller, so it reaches
 * further up). It no longer picks between two label placements -- the label
 * has exactly one placement now, and dockElement's `avoid` clamps it when
 * even the un-stretched row is in the way. Keeping this test as the stretch
 * crossover is still worth it: it means the clamp is a last resort for the
 * genuinely cramped sizes rather than the everyday path, so on every size
 * that can afford it the stack sits exactly where Figma puts it.
 */
export function fitsPortraitArrangement(
  speciesHost: HTMLElement,
  labelHost: HTMLElement,
  container: HTMLElement,
  labelCentreY: number = container.clientHeight / 2,
): boolean {
  const speciesTop = speciesHost.getBoundingClientRect().top - container.getBoundingClientRect().top
  const labelHeight = labelHost.getBoundingClientRect().height
  return speciesTop > labelCentreY + labelHeight / 2
}

/**
 * Where a `*-center` dock's visual centre should land vertically, in
 * container-relative px: its natural position (the container's vertical
 * midpoint plus `drop`) clamped into the largest obstacle-free band of the
 * window.
 *
 * Split out of update() so the maths is readable and so its one non-obvious
 * step is documented in one place: `bandTop`/`bandBottom` start as the
 * window's own edges and are then bitten into by each obstacle that overlaps
 * the dock horizontally. Which side an obstacle bites from is decided by
 * where the obstacle's OWN centre sits relative to the window's midpoint,
 * not by hardcoding "weather is on top, species is on the bottom" -- those
 * happen to be true today, but a rect is the only thing this function is
 * given and deriving the side from it means a future dock can't quietly get
 * pushed the wrong way.
 *
 * Each obstacle bites `bound` (the frame's live margin) further than its own
 * edge, so a clamped dock keeps a real gap instead of landing flush against
 * the widget it just avoided. Not-overlapping and looking un-collided are
 * different bars: at 1920x1080 the flush clamp put the stack's bottom edge on
 * exactly the species row's top edge -- zero overlap by the arithmetic, and
 * unmistakably a collision to look at, with no row of pixels between them for
 * a pixel probe to find either. The margin is the right size for that gap
 * rather than a new constant: it is already the design's own unit of
 * separation (it is what every dock is inset by), it is already scaled with
 * the frame, and it animates with the reveal so the gap doesn't pop.
 *
 * When the free band is narrower than the dock itself no position satisfies
 * both constraints, so the fallback keeps the dock fully inside the window
 * and lets it overlap: a stack clipped by the frame edge is unreadable,
 * while one overlapping a widget is at least still legible, and the frame's
 * own `overflow: hidden` would silently eat the clipped case rather than
 * making it obvious. That branch is reachable only when the window is
 * shorter than weather + stack + species + two margins stacked, which none
 * of the captured sizes is.
 */
function clampedCentreY(
  container: HTMLElement,
  bound: number,
  height: number,
  left: number,
  width: number,
  drop: number,
  obstacles: Rect[],
): number {
  const containerHeight = container.clientHeight
  const midpoint = containerHeight / 2
  let bandTop = bound
  let bandBottom = containerHeight - bound
  for (const rect of obstacles) {
    if (rect.width <= 0 || rect.height <= 0) continue
    // Cull obstacles that miss this element horizontally -- but ONLY when we
    // actually know how wide it is. A text-driven host measures 0 until its
    // content resolves after mount, and with width 0 the second half of this
    // test reads `rect.x >= left`, which is TRUE for every obstacle sharing the
    // same left margin -- i.e. the normal case here. Every obstacle was culled,
    // the clamp quietly did nothing, and the label overlapped the species row at
    // every landscape size while still reporting a clean band. Unknown width now
    // means "might overlap", not "definitely doesn't".
    if (width > 0 && (rect.x + rect.width <= left || rect.x >= left + width)) continue
    if (rect.y + rect.height / 2 < midpoint) bandTop = Math.max(bandTop, rect.y + rect.height + bound)
    else bandBottom = Math.min(bandBottom, rect.y - bound)
  }
  const [lo, hi] =
    bandBottom - bandTop >= height
      ? [bandTop, bandBottom - height]
      : [bound, containerHeight - bound - height]
  return Math.min(Math.max(midpoint + drop - height / 2, lo), hi) + height / 2
}

/** `host` and `container` must both already be in the DOM -- `container` is the same positioning context the Frame (see frame.ts) was built against. */
export function dockElement(host: HTMLElement, container: HTMLElement, config: DockConfig, frame: Frame): Docked {
  host.style.position = 'absolute'
  host.style.zIndex = '50'

  function applyEdgeAnchor(edge: DockEdge) {
    const a = EDGE_ANCHOR[edge]
    host.style.top = a.top ?? ''
    host.style.right = a.right ?? ''
    host.style.bottom = a.bottom ?? ''
    host.style.left = a.left ?? ''
    host.style.transformOrigin = a.origin
  }

  return {
    update() {
      const edge = typeof config.edge === 'function' ? config.edge() : config.edge
      applyEdgeAnchor(edge)
      let [offsetX, offsetY] = config.mode === 'frame' ? EDGE_ANCHOR[edge].inward(frame.getMargin()) : [0, 0]
      const scale = config.scale ? String(config.scale()) : 'var(--screen-frame-content-scale, 1)'
      if ((config.verticalDrop || config.avoid) && (edge === 'left-center' || edge === 'right-center')) {
        // The numeric twin of the `scale` string above: with no per-dock
        // override the transform reads --screen-frame-content-scale, which
        // ScreenFrame/design-system-demo both set from exactly this value.
        // Reading it back out of getComputedStyle instead would be a
        // round-trip through the CSSOM for a number we already have.
        const s = config.scale ? config.scale() : frame.getContentScale()
        // offsetHeight/offsetWidth, not getBoundingClientRect: the rect is
        // post-transform, so feeding it back into the transform that produced
        // it would compound this dock's own scale once more on every
        // update() -- and update() runs on every frame of the reveal
        // animation, so the error would accumulate rather than settle. The
        // untransformed layout box is the fixed point that can't drift.
        const height = host.offsetHeight * s
        const width = host.offsetWidth * s
        // With `top: 50%`, `transform-origin: <side> center` and the
        // translateY(-50%) that EDGE_ANCHOR already prepends, the composed
        // transform puts the host's VISUAL centre at
        // container.clientHeight / 2 + offsetY, at any scale (the origin is
        // the centre the scale pivots on, so scaling can't move it, and the
        // -50% cancels the top:50% against the same unscaled height it is a
        // percentage of). So offsetY is exactly "how far below the midpoint",
        // which is the quantity clampedCentreY returns.
        const bound = config.mode === 'frame' ? frame.getMargin() : 0
        const left = edge === 'left-center' ? offsetX : container.clientWidth + offsetX - width
        offsetY =
          clampedCentreY(container, bound, height, left, width, config.verticalDrop?.() ?? 0, config.avoid?.() ?? []) -
          container.clientHeight / 2
      }
      host.style.transform = `${EDGE_ANCHOR[edge].centering}translate(${offsetX}px, ${offsetY}px) scale(${scale})`
      const hostRect = host.getBoundingClientRect()
      const containerRect = container.getBoundingClientRect()
      config.onRect({
        x: hostRect.x - containerRect.x,
        y: hostRect.y - containerRect.y,
        width: hostRect.width,
        height: hostRect.height,
      })
    },
  }
}
