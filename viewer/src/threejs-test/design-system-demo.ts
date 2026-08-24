// Proof-of-concept mount for the @wi/ui design-system package inside this
// Vite+Three.js app. Real content pulled from the "Bento Grid — Recreation"
// Figma page: Frame 1 (1080x1920, mobile) for layout/sizes, Frame 1 Desktop
// (1920x1080) for the weather cluster's real desktop position (top-right).
// Frame 1 Desktop has no finished species-row layout yet (only leftover
// unstyled placeholder rects outside its own bounds) -- per explicit
// direction, the species cluster reuses Frame 1's real mobile geometry at
// every viewport size rather than inventing a desktop arrangement Figma
// doesn't have.
//
// The frame/notch/docking engine (createFrame/dockElement) lives in @wi/ui
// now (packages/ui/src/lib/screen-frame/) -- it used to be viewer-local, but
// moved so the same, already Figma-verified math backs both this live app
// AND the ScreenFrame.svelte Storybook examples. This file just wires real
// content + the loader-triggered reveal/retract animation to it -- see
// @wi/ui's screen-frame/frame.ts and dock.ts for the geometry/docking rules.
//
// Not reproduced: the bird/frog/butterfly line-art icons (no icon system
// wired into @wi/ui content yet) and the frog widget's extra measurement/
// status block (its own bespoke sub-layout, outside BentoWidget's current
// prop shape).
//
// WEATHER_CLUSTER/SPECIES_ROW content lives in @wi/ui's
// screen-frame/recreation-content.ts -- shared with BentoGrid.stories.ts and
// Screen.stories.ts so the real Figma data has one source, not three copies.
import { mount, unmount, type Component } from 'svelte'
import { LabelLine, BentoGrid, createFrame, dockElement, WEATHER_CLUSTER, SPECIES_ROW } from '@wi/ui'
import '@wi/tokens/css'

export interface DesignSystemDemo {
  /** Animates the frame margin in (grey border appears, docked clusters shift to the window edge). */
  reveal(durationMs?: number): Promise<void>
  /** Animates the frame margin back to 0 (full-bleed, no grey). */
  retract(durationMs?: number): Promise<void>
  dispose(): void
}

export function createDesignSystemDemo(): DesignSystemDemo {
  // createFrame/dockElement need a real positioning container -- this div
  // takes over the role the SVG root used to play directly (position:fixed,
  // full viewport), so the frame's window and every docked host below
  // resolve position:absolute against IT, not the true viewport.
  const container = document.createElement('div')
  Object.assign(container.style, { position: 'fixed', inset: '0' })
  document.body.append(container)

  const frame = createFrame(container)

  const weatherHost = document.createElement('div')
  container.append(weatherHost)
  // Weather's rect feeds the frame's precise top-right corner notch (with
  // the correct concave elbow) rather than a generic unioned rect -- see
  // @wi/ui's screen-frame/frame.ts header for why that distinction matters here.
  const weatherDock = dockElement(weatherHost, container, {
    edge: 'top-right',
    mode: 'frame',
    onRect: (rect) => frame.setTopRightReach(rect.width, rect.height),
  }, frame)

  const speciesHost = document.createElement('div')
  container.append(speciesHost)
  // Species sits fully inside the window (its bottom edge is flush with
  // the window's own bottom edge in Figma) -- a generic notch here is
  // always a no-op, which is correct: no cutout needed at all.
  const speciesDock = dockElement(speciesHost, container, {
    edge: 'bottom-center',
    mode: 'frame',
    onRect: (rect) => frame.setNotch('species', rect),
  }, frame)

  // The habitat label docks to a side border, not the bottom -- left in
  // portrait, right in landscape. It's a fully solid pill (no corner
  // overrides, so no gaps in its own silhouette) -- unlike weather/species
  // it never needs a frame notch, since there's nothing behind it that
  // would need to show through.
  const labelHost = document.createElement('div')
  container.append(labelHost)
  const labelDock = dockElement(labelHost, container, {
    edge: () => (container.clientHeight >= container.clientWidth ? 'left-center' : 'right-center'),
    mode: 'frame',
    onRect: () => {},
  }, frame)

  const label = mount(LabelLine as Component, {
    target: labelHost,
    props: { text: 'Dein Habitat', fontSize: 34, accent: 'forest-green' },
  })

  const weatherCluster = mount(BentoGrid as Component, {
    target: weatherHost,
    props: { items: WEATHER_CLUSTER, radius: 60 },
  })

  const speciesRow = mount(BentoGrid as Component, {
    target: speciesHost,
    props: { items: SPECIES_ROW, radius: 60 },
  })

  let revealed = false

  function updateDocks() {
    weatherDock.update()
    speciesDock.update()
    labelDock.update()
  }

  function handleResize() {
    container.style.setProperty('--screen-frame-content-scale', String(frame.getContentScale()))
    frame.handleResize()
    if (revealed) frame.setMargin(frame.getTargetMargin())
    updateDocks()
  }

  handleResize()
  window.addEventListener('resize', handleResize)

  // Starts fully retracted (margin 0, full-bleed) -- the caller decides when
  // to reveal (main.ts calls it from onLoaderStart, the same moment the
  // loading screen begins fading and the flight-in begins, so the animation
  // is actually visible instead of finishing during the ~60-90s load that
  // happens entirely behind the loader).
  function reveal(durationMs = 600) {
    return frame.animateMarginTo(frame.getTargetMargin(), durationMs, updateDocks).then(() => {
      revealed = true
    })
  }
  function retract(durationMs = 400) {
    revealed = false
    return frame.animateMarginTo(0, durationMs, updateDocks)
  }

  // Manual trigger for the reveal/retract animation, independent of the
  // loader flow in main.ts -- lets anyone replay it on demand.
  const toggleButton = document.createElement('button')
  toggleButton.type = 'button'
  toggleButton.textContent = 'Frame ein/aus'
  Object.assign(toggleButton.style, {
    position: 'fixed',
    left: '16px',
    bottom: '16px',
    zIndex: '60',
    padding: '10px 16px',
    borderRadius: '999px',
    border: 'none',
    background: 'var(--gray-900)',
    color: 'var(--gray-50)',
    font: '600 14px sans-serif',
    cursor: 'pointer',
  })
  toggleButton.addEventListener('click', () => {
    revealed ? retract() : reveal()
  })
  document.body.append(toggleButton)

  if (import.meta.env.DEV) {
    ;(window as any).__designSystemDemo = { frame, reveal, retract }
  }

  return {
    reveal,
    retract,
    dispose() {
      window.removeEventListener('resize', handleResize)
      unmount(label)
      unmount(weatherCluster)
      unmount(speciesRow)
      frame.dispose()
      container.remove()
      toggleButton.remove()
      if (import.meta.env.DEV) delete (window as any).__designSystemDemo
    },
  }
}
