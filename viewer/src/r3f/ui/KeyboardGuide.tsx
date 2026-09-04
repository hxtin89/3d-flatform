// Markup only — keyboard-navigation.ts drives the guide through the refs.
import { bindTarget } from '../dom-targets'

export function KeyboardGuide() {
  return (
    <>
      <button id="keyboardGuideToggle" ref={bindTarget('keyboardGuideToggle')} type="button" aria-controls="keyboardGuide" aria-expanded={false}>⌨ Field keys</button>
      <aside id="keyboardGuide" ref={bindTarget('keyboardGuide')} role="region" aria-labelledby="keyboardGuideTitle" aria-hidden="true">
        <div className="keyboard-guide-head">
          <span id="keyboardGuideTitle">Field navigation</span>
          <span className="keyboard-guide-context">Physical keyboard</span>
          <button id="keyboardGuideClose" ref={bindTarget('keyboardGuideClose')} className="keyboard-guide-close" type="button" aria-label="Field Navigation ausblenden">×</button>
        </div>
        <div className="wasd-pad" aria-label="W A S D for directional movement">
          <kbd className="keycap" data-key="KeyW" data-nav-task="KeyW">W</kbd>
          <kbd className="keycap" data-key="KeyA" data-nav-task="KeyA">A</kbd>
          <kbd className="keycap" data-key="KeyS" data-nav-task="KeyS">S</kbd>
          <kbd className="keycap" data-key="KeyD" data-nav-task="KeyD">D</kbd>
        </div>
        <div className="keyboard-zoom">
          <div className="keyboard-action" data-nav-task="zoom-in">
            <span className="keyboard-combo"><kbd className="keycap" data-key="Space">Space</kbd></span><span>Zoom in</span>
          </div>
          <div className="keyboard-action" data-nav-task="zoom-out">
            <span className="keyboard-combo"><kbd className="keycap" data-key="Shift">Shift</kbd><span className="keyboard-plus">+</span><kbd className="keycap" data-key="Space">Space</kbd></span><span>Zoom out</span>
          </div>
          <div className="keyboard-action">
            <span className="keyboard-combo"><kbd className="keycap" data-key="ArrowLeft">◀</kbd><kbd className="keycap" data-key="ArrowRight">▶</kbd></span><span>Orbit</span>
          </div>
          <div className="keyboard-action">
            <span className="keyboard-combo"><kbd className="keycap" data-key="ArrowUp">▲</kbd><kbd className="keycap" data-key="ArrowDown">▼</kbd></span><span>Tilt</span>
          </div>
        </div>
        <div className="keyboard-access">
          <button id="aimModeButton" ref={bindTarget('aimModeButton')} type="button" aria-pressed={false} aria-keyshortcuts="C">
            <kbd className="keycap" data-key="KeyC">C</kbd><span>Focus target</span>
          </button>
          <span className="keyboard-enter-hint"><kbd className="keycap" data-key="Enter">Enter</kbd><span>Open</span></span>
        </div>
      </aside>
    </>
  )
}
