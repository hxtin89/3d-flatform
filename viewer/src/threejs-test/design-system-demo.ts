// Proof-of-concept mount for the @wi/ui design-system package inside this
// Vite+Three.js app. Real content pulled from the "Bento Grid — Recreation"
// Figma page: Frame 1 (1080x1920, mobile) and Frame 1 Desktop (1920x1080)
// both have a real, finished species row and habitat label -- but at
// DIFFERENT dock positions per orientation (label left-center on mobile,
// bottom-right on desktop; species row spanning the window's full width on
// mobile, at its own fixed size in the window's bottom-left corner on
// desktop), not the same layout just scaled up. Verified by reading both
// frames' real instance x/y directly from Figma -- see ScreenFrame.svelte's
// dock wiring for the exact edges this reproduces.
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

  // Figma's real eagle mark, fixed at a (165,30) px offset from the frame's
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
  // Whether the label drops to the wide-frame corner, and whether the
  // species row is stretched to span the window's full width -- both
  // decided from real measured rects in handleResize() below, mirroring
  // ScreenFrame.svelte's layout()/speciesScale() (which carry the full
  // reasoning for the three arrangements and where the fill/no-fill
  // crossover comes from).
  let useWideArrangement = false
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
    onRect: (rect) => frame.setNotch('species', rect),
  }, frame)

  // The habitat label: tall-frame arrangement docks left-center, wide-frame
  // docks bottom-right (sitting low next to the species cluster, not
  // vertically centered) -- same source as the species note above. It's a
  // stack of 3 pills (HabitatLabelStack), not a single line -- see that
  // component for the real "Test: Label Stack" content this reproduces.
  const labelHost = document.createElement('div')
  container.append(labelHost)
  const labelDock = dockElement(labelHost, container, {
    edge: () => (useWideArrangement ? 'bottom-right' : 'left-center'),
    mode: 'frame',
    onRect: () => {},
  }, frame)

  let labelAlign: 'left' | 'right' = 'left'
  let label = mount(HabitatLabelStack as Component, {
    target: labelHost,
    props: { align: labelAlign },
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
    logoHost.style.left = `${165 * scale}px`
    logoHost.style.transform = `scale(${scale})`
    frame.handleResize()
    if (revealed) frame.setMargin(frame.getTargetMargin())
    // Same fixed-order three-arrangement pick as ScreenFrame.svelte's
    // layout() -- start optimistic (row filling the window's width, label
    // left-center), then step down only as far as the measured rects
    // actually force. Fixed order, so the result is a pure function of the
    // container's size rather than of the previous pass.
    speciesFillsWidth = true
    useWideArrangement = false
    updateDocks()
    if (!fitsPortraitArrangement(speciesHost, labelHost, container)) {
      speciesFillsWidth = false
      updateDocks()
      useWideArrangement = !fitsPortraitArrangement(speciesHost, labelHost, container)
    }
    const nextAlign = useWideArrangement ? 'right' : 'left'
    if (nextAlign !== labelAlign) {
      labelAlign = nextAlign
      unmount(label)
      label = mount(HabitatLabelStack as Component, { target: labelHost, props: { align: labelAlign } })
    }
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
  // loader flow in main.ts -- lets anyone replay it on demand. DEV-only, same
  // gate as the __designSystemDemo debug hook below: this is a development
  // aid for poking at the animation, not part of the finished composition,
  // so it shouldn't sit on top of a production/preview build's viewport.
  let toggleButton: HTMLButtonElement | undefined
  if (import.meta.env.DEV) {
    toggleButton = document.createElement('button')
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
      toggleButton?.remove()
      if (import.meta.env.DEV) delete (window as any).__designSystemDemo
    },
  }
}
