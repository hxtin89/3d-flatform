// Small DOM overlays: containers the imperative layers fill, plus the aim
// reticle, live region, attribution and splat hint.
import { bindTarget } from '../dom-targets'
import { useUiStore } from '../state/ui-store'

export function Vignette() {
  return <div id="vignette" ref={bindTarget('vignette')}></div>
}

export function MarkerOverlay() {
  return <div id="markerOverlay" ref={bindTarget('markerOverlay')}></div>
}

export function Captions() {
  return <div id="captions" ref={bindTarget('captions')}></div>
}

export function AimReticle() {
  const hasTarget = useUiStore((s) => s.aimHasTarget)
  const label = useUiStore((s) => s.aimLabel)
  return (
    <div id="aimReticle" className={hasTarget ? 'has-target' : ''} aria-hidden="true">
      <span className="aim-reticle-core"></span>
      <span id="aimReticleLabel">{label}</span>
    </div>
  )
}

export function InteractionStatus() {
  const message = useUiStore((s) => s.interactionMessage)
  return <div id="interactionStatus" className="sr-only" role="status" aria-live="polite" aria-atomic="true">{message}</div>
}

export function Attribution() {
  return (
    <div id="attribution" className="card">
      © <a href="https://www.maptiler.com/copyright/" target="_blank" rel="noreferrer">MapTiler</a>{' '}
      © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors
    </div>
  )
}

export function SplatHint() {
  return (
    <div id="splatHint" aria-hidden="true">
      <div className="splat-caps">
        <span className="keycap" data-key="KeyW">W</span>
        <div>
          <span className="keycap" data-key="KeyA">A</span>
          <span className="keycap" data-key="KeyS">S</span>
          <span className="keycap" data-key="KeyD">D</span>
        </div>
      </div>
      <span className="splat-hint-text">Click = look around (mouse) · WASD = walk · Esc = release</span>
    </div>
  )
}
