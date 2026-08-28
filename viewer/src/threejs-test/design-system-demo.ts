// Proof-of-concept mount for the @wi/ui design-system package inside this
// Vite+Three.js app. Real content pulled from the "Bento Grid — Recreation"
// Figma page: Frame 1 (1080x1920, mobile) and Frame 1 Desktop (1920x1080)
// both have a real, finished species row and habitat label. The species row
// differs per orientation (spanning the window's full width on mobile, at
// its own fixed size in the window's bottom-left corner on desktop), read
// off both frames' real instance x/y directly from Figma. The habitat label
// does NOT: it uses Figma's MOBILE placement at every size -- the window's
// left edge, 69px (scaled) below the window's vertical centre -- clamped
// vertically when another widget would be in the way rather than jumping to
// the desktop frame's bottom-right corner. See ScreenFrame.svelte's layout()
// and dock.ts's DockConfig.verticalDrop/avoid for the full reasoning; this
// file mirrors that wiring.
//
// The frame/notch/docking engine (createFrame/dockElement) lives in @wi/ui
// now (packages/ui/src/lib/screen-frame/) -- it used to be viewer-local, but
// moved so the same, already Figma-verified math backs both this live app
// AND the ScreenFrame.svelte Storybook examples. This file just wires real
// content + the loader-triggered reveal/retract animation to it -- see
// @wi/ui's screen-frame/frame.ts and dock.ts for the geometry/docking rules.
//
// Species icons are line-art illustration, not the real Figma vectors (see
// @wi/ui's screen-frame/species-icons.ts). Not reproduced: the frog widget's
// extra measurement/status block (its own bespoke sub-layout, outside
// BentoWidget's current prop shape).
//
// WEATHER_CLUSTER/SPECIES_ROW content lives in @wi/ui's
// screen-frame/recreation-content.ts -- shared with BentoGrid.stories.ts and
// Screen.stories.ts so the real Figma data has one source, not three copies.
import { mount, unmount, type Component } from 'svelte'
import { HabitatLabelStack, BentoGrid, createFrame, dockElement, fitsPortraitArrangement, WEATHER_CLUSTER, SPECIES_ROW, EAGLE_LOGO_SVG } from '@wi/ui'
import type { Rect } from '@wi/ui'
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

  // Figma's real eagle mark, fixed at a (51,30) px offset from the frame's
  // own top-left corner in BOTH Frame 1 and Frame 1 Desktop -- same fixed
  // offset ScreenFrame.svelte's `.screen-frame__logo` uses for its `logo`
  // slot, duplicated here (not exported as a shared constant) because this
  // file already duplicates every other dock/edge choice against
  // ScreenFrame.svelte rather than factoring out one-off Figma numbers --
  // see the species/label docks below for the same pattern. z-index 45 sits
  // above the frame's own mask svg (z-index 40, see frame.ts) but below the
  // weather/species/label docks (z-index 50, see dock.ts).
  const logoHost = document.createElement('div')
  logoHost.innerHTML = EAGLE_LOGO_SVG
  Object.assign(logoHost.style, { position: 'absolute', zIndex: '45', transformOrigin: 'top left', pointerEvents: 'none' })
  container.append(logoHost)

  // The two clusters the label stack must never overlap, in
  // container-relative coordinates, captured live from each dock's own
  // onRect. Same reasoning as ScreenFrame.svelte's copies: the species row
  // grows TALL when a card expands, so only a measured rect is right for the
  // states where the collision actually happens.
  let weatherRect: Rect = { x: 0, y: 0, width: 0, height: 0 }
  let speciesRect: Rect = { x: 0, y: 0, width: 0, height: 0 }

  // Figma px against the 1080-wide mobile frame: the window spans y 71..1860
  // (centre 965.5) and the label stack's three pills span y 924..1145
  // (centre 1034.5), so the stack's centre sits 69px BELOW the window's --
  // it is not centred. Scaled by content scale like every other fixed Figma
  // px here. Duplicated from ScreenFrame.svelte's LABEL_FIGMA_DROP_PX rather
  // than exported, the same way every other dock/edge choice in this file is
  // duplicated rather than factored out (see the logo note above).
  const LABEL_FIGMA_DROP_PX = 69
  const labelDrop = () => LABEL_FIGMA_DROP_PX * frame.getContentScale()

  const weatherHost = document.createElement('div')
  container.append(weatherHost)
  // Weather's rect feeds the frame's precise top-right corner notch (with
  // the correct concave elbow) rather than a generic unioned rect -- see
  // @wi/ui's screen-frame/frame.ts header for why that distinction matters here.
  const weatherDock = dockElement(weatherHost, container, {
    edge: 'top-right',
    mode: 'frame',
    onRect: (rect) => {
      frame.setTopRightReach(rect.width, rect.height)
      weatherRect = rect
    },
  }, frame)

  const speciesHost = document.createElement('div')
  container.append(speciesHost)
  // Whether the species row is stretched to span the window's full width --
  // decided from real measured rects in handleResize() below, mirroring
  // ScreenFrame.svelte's layout()/speciesScale() (which carry the full
  // reasoning and where the fill/no-fill crossover comes from).
  let speciesFillsWidth = true
  function speciesScale(): number {
    const natural = speciesHost.offsetWidth
    if (!speciesFillsWidth || natural <= 0) return frame.getContentScale()
    return (container.clientWidth - 2 * frame.getMargin()) / natural
  }
  // Species sits fully inside the window (its bottom edge is flush with the
  // window's own bottom edge in Figma) -- a generic notch here is always a
  // no-op, which is correct: no cutout needed at all. Docked bottom-left at
  // every size: that's Frame 1 Desktop's real instance x/y, and it's also
  // Frame 1 mobile's, since there the row is exactly as wide as the window
  // (960 inside 1080 - 2x60) and so fills it from that same corner.
  const speciesDock = dockElement(speciesHost, container, {
    edge: 'bottom-left',
    mode: 'frame',
    scale: speciesScale,
    onRect: (rect) => {
      frame.setNotch('species', rect)
      speciesRect = rect
    },
  }, frame)

  // The habitat label: ONE placement at every size -- the window's left edge
  // at Figma's mobile vertical drop, clamped clear of the weather cluster
  // and species row rather than relocated to another corner. It's a stack of
  // 3 pills (HabitatLabelStack), not a single line -- see that component for
  // the real "Test: Label Stack" content this reproduces. Docked LAST of the
  // three: `avoid` reads the rects the other two just reported, so they have
  // to have updated first (see updateDocks()).
  const labelHost = document.createElement('div')
  container.append(labelHost)
  const labelDock = dockElement(labelHost, container, {
    edge: 'left-center',
    mode: 'frame',
    verticalDrop: labelDrop,
    avoid: () => [weatherRect, speciesRect],
    onRect: () => {},
  }, frame)

  // align is always 'left' now -- the stack only ever docks left, and
  // HabitatLabelStack's left variant is the one whose corner fillets match
  // that edge. No remount-on-flip any more, which also drops the one place
  // this file could lose the component's internal measured-width state
  // mid-resize.
  const label = mount(HabitatLabelStack as Component, {
    target: labelHost,
    props: { align: 'left' },
  })

  // topLeftIsScreenCorner: false on both -- neither cluster sits at the real
  // screen's actual top-left, see BentoGrid's own doc comment.
  const weatherCluster = mount(BentoGrid as Component, {
    target: weatherHost,
    props: { items: WEATHER_CLUSTER, radius: 60, topLeftIsScreenCorner: false },
  })

  const speciesRow = mount(BentoGrid as Component, {
    target: speciesHost,
    props: { items: SPECIES_ROW, radius: 60, topLeftIsScreenCorner: false },
  })

  let revealed = false

  function updateDocks() {
    weatherDock.update()
    speciesDock.update()
    labelDock.update()
  }

  function handleResize() {
    const scale = frame.getContentScale()
    container.style.setProperty('--screen-frame-content-scale', String(scale))
    logoHost.style.top = `${30 * scale}px`
    logoHost.style.left = `${51 * scale}px`
    logoHost.style.transform = `scale(${scale})`
    frame.handleResize()
    if (revealed) frame.setMargin(frame.getTargetMargin())
    // Same fixed-order species pick as ScreenFrame.svelte's layout() --
    // start optimistic (row filling the window's width) and un-stretch it
    // only if the label can't clear it at its real, dropped position. Fixed
    // order, so the result is a pure function of the container's size rather
    // than of the previous pass. The label's own overlap guarantee does not
    // depend on this choice; dockElement's `avoid` clamps it either way.
    speciesFillsWidth = true
    updateDocks()
    if (!fitsPortraitArrangement(speciesHost, labelHost, container, container.clientHeight / 2 + labelDrop())) {
      speciesFillsWidth = false
      updateDocks()
    }
    // Final pass so the label clamps against the rects the species row
    // actually settled at, not the ones it had before the crossover ran.
    updateDocks()
  }

  handleResize()
  window.addEventListener('resize', handleResize)
  // ScreenFrame.svelte observes its own container, so it gets a second layout
  // pass for free and self-corrects once async widths land. This file had only
  // the one synchronous call plus window resize, and the label stack's width is
  // text-driven -- it resolves after mount, so every layout decision here was
  // taken against a 0-width label box and never revisited. That is what let the
  // stack sit on top of the species row at 1920x1080 and 1440x900 in the app
  // while Storybook, which does get the second pass, looked correct.
  const relayout = new ResizeObserver(() => handleResize())
  relayout.observe(container)

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
  // loader flow in main.ts -- lets anyone replay it on demand. DEV-only, same
  // gate as the __designSystemDemo debug hook below: this is a development
  // aid for poking at the animation, not part of the finished composition,
  // so it shouldn't sit on top of a production/preview build's viewport.
  let toggleButton: HTMLButtonElement | undefined
  if (import.meta.env.DEV) {
    toggleButton = document.createElement('button')
    toggleButton.type = 'button'
    // Dev chrome, not part of the widget set -- the id is what lets
    // threejs-test.html's `body.chrome-hidden` rule hide this alongside the
    // fps chip, map billboards, attribution and field-keys button when the
    // cogwheel is toggled (see main.ts's #panelChip handler).
    toggleButton.id = 'frameToggleButton'
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

    ;(window as any).__designSystemDemo = { frame, reveal, retract }
  }

  return {
    reveal,
    retract,
    dispose() {
      window.removeEventListener('resize', handleResize)
      relayout.disconnect()
      unmount(label)
      unmount(weatherCluster)
      unmount(speciesRow)
      frame.dispose()
      container.remove()
      toggleButton?.remove()
      if (import.meta.env.DEV) delete (window as any).__designSystemDemo
    },
  }
}
