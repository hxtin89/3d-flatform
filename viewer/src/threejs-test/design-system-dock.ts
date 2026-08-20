// Generic docking: positions a host element against either the true
// viewport edge ('outer') or the frame's current, possibly-animating
// window edge ('frame'), then reports its own rendered bounds to the frame
// as a notch. Works for content of any size -- it always reads the host's
// live getBoundingClientRect(), never an assumed fixed size.
import type { Frame } from './design-system-frame'

export type DockEdge = 'top-right' | 'bottom-center'
export type DockMode = 'outer' | 'frame'

export interface DockConfig {
  edge: DockEdge
  mode: DockMode
}

export interface Docked {
  /** Recomputes position (for 'frame' mode, against the live margin) and notch. Call on resize and on every frame-margin animation tick. */
  update(): void
}

export function dockElement(host: HTMLElement, config: DockConfig, frame: Frame, notchId: string): Docked {
  host.style.position = 'fixed'
  host.style.zIndex = '50'

  if (config.edge === 'top-right') {
    host.style.top = '0'
    host.style.right = '0'
    host.style.transformOrigin = 'top right'
  } else {
    host.style.bottom = '0'
    host.style.left = '50%'
    host.style.transformOrigin = 'bottom center'
  }

  return {
    update() {
      let offsetX = 0
      let offsetY = 0
      if (config.mode === 'frame') {
        const margin = frame.getMargin()
        if (config.edge === 'top-right') {
          offsetX = -margin
          offsetY = margin
        } else {
          offsetY = -margin
        }
      }
      const centering = config.edge === 'bottom-center' ? 'translateX(-50%) ' : ''
      host.style.transform = `${centering}translate(${offsetX}px, ${offsetY}px) scale(var(--design-system-demo-content-scale, 1))`
      frame.setNotch(notchId, host.getBoundingClientRect())
    },
  }
}
