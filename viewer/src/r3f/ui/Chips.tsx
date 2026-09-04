import { useUiStore } from '../state/ui-store'
import { fpsClass } from './Hud'

export function Chips() {
  const fps = useUiStore((s) => s.hud?.fps ?? 0)
  return (
    <>
      <button className="chip" id="hudChip" aria-label="Statistics" onClick={() => useUiStore.setState((s) => ({ hudOpen: !s.hudOpen }))}>
        ⓘ <span id="chipFps" className={fps ? fpsClass(fps) : ''}>{fps ? `${fps.toFixed(0)} fps` : '—'}</span>
      </button>
      <button className="chip" id="panelChip" aria-label="Settings" onClick={() => useUiStore.setState((s) => ({ panelOpen: !s.panelOpen }))}>⚙</button>
    </>
  )
}
