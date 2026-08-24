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
      const [offsetX, offsetY] = config.mode === 'frame' ? EDGE_ANCHOR[edge].inward(frame.getMargin()) : [0, 0]
      host.style.transform = `${EDGE_ANCHOR[edge].centering}translate(${offsetX}px, ${offsetY}px) scale(var(--screen-frame-content-scale, 1))`
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
