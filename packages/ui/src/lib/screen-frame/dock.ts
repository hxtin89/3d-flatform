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

export type DockEdge = 'top-right' | 'bottom-center' | 'left-center' | 'right-center'
export type DockMode = 'outer' | 'frame'

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
    host.style.top = host.style.right = host.style.bottom = host.style.left = ''
    if (edge === 'top-right') {
      host.style.top = '0'
      host.style.right = '0'
      host.style.transformOrigin = 'top right'
    } else if (edge === 'bottom-center') {
      host.style.bottom = '0'
      host.style.left = '50%'
      host.style.transformOrigin = 'bottom center'
    } else if (edge === 'left-center') {
      host.style.left = '0'
      host.style.top = '50%'
      host.style.transformOrigin = 'left center'
    } else {
      host.style.right = '0'
      host.style.top = '50%'
      host.style.transformOrigin = 'right center'
    }
  }

  return {
    update() {
      const edge = typeof config.edge === 'function' ? config.edge() : config.edge
      applyEdgeAnchor(edge)
      let offsetX = 0
      let offsetY = 0
      if (config.mode === 'frame') {
        const margin = frame.getMargin()
        if (edge === 'top-right') {
          offsetX = -margin
          offsetY = margin
        } else if (edge === 'bottom-center') {
          offsetY = -margin
        } else if (edge === 'left-center') {
          offsetX = margin
        } else {
          offsetX = -margin
        }
      }
      const centering =
        edge === 'bottom-center' ? 'translateX(-50%) ' : edge === 'left-center' || edge === 'right-center' ? 'translateY(-50%) ' : ''
      host.style.transform = `${centering}translate(${offsetX}px, ${offsetY}px) scale(var(--screen-frame-content-scale, 1))`
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
