// Generic docking: positions a host element against either the true
// viewport edge ('outer') or the frame's current, possibly-animating
// window edge ('frame'). Works for content of any size -- it always reads
// the host's live getBoundingClientRect(), never an assumed fixed size.
//
// Reporting the docked rect to the frame (as a notch, or as a top-right
// reach for the concave-elbow corner notch) is the caller's job via
// `onRect`, not this module's -- different clusters need different Frame
// APIs (see design-system-demo.ts), and dockElement only knows positioning.
import type { Frame } from './design-system-frame'

export type DockEdge = 'top-right' | 'bottom-center' | 'left-center' | 'right-center'
export type DockMode = 'outer' | 'frame'

export interface DockConfig {
  /** A function is re-resolved on every update() -- lets a dock switch sides (e.g. left in portrait, right in landscape). */
  edge: DockEdge | (() => DockEdge)
  mode: DockMode
  onRect: (rect: DOMRect) => void
}

export interface Docked {
  /** Recomputes position (for 'frame' mode, against the live margin) and calls onRect. Call on resize and on every frame-margin animation tick. */
  update(): void
}

export function dockElement(host: HTMLElement, config: DockConfig, frame: Frame): Docked {
  host.style.position = 'fixed'
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
      host.style.transform = `${centering}translate(${offsetX}px, ${offsetY}px) scale(var(--design-system-demo-content-scale, 1))`
      config.onRect(host.getBoundingClientRect())
    },
  }
}
