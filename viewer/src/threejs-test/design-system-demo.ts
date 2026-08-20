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
// The frame/notch/docking system lives in design-system-frame.ts and
// design-system-dock.ts -- this file just wires content to them. See those
// files' headers for the Figma geometry (the real notched-polygon "S1:
// Photo" shape) and docking rules this was built from.
//
// Not reproduced: the bird/frog/butterfly line-art icons (no icon system
// wired into @wi/ui content yet) and the frog widget's extra measurement/
// status block (its own bespoke sub-layout, outside BentoWidget's current
// prop shape).
import { mount, unmount, type Component } from 'svelte'
import { LabelLine, BentoGrid, type BentoGridItem } from '@wi/ui'
import '@wi/tokens/css'
import { createFrame } from './design-system-frame'
import { dockElement } from './design-system-dock'

export interface DesignSystemDemo {
  /** Animates the frame margin in (grey border appears, docked clusters shift to the window edge). */
  reveal(durationMs?: number): Promise<void>
  /** Animates the frame margin back to 0 (full-bleed, no grey). */
  retract(durationMs?: number): Promise<void>
  dispose(): void
}

// Figma frame sizes this layout is scaled against -- portrait viewports use
// the mobile frame as the scale basis, landscape viewports the desktop one.
const MOBILE_FRAME = { width: 1080, height: 1920 }
const DESKTOP_FRAME = { width: 1920, height: 1080 }

const WEATHER_CLUSTER: BentoGridItem[] = [
  { id: 'weatherBar', x: 0, y: 0, width: 255, height: 180, title: 'Leicht bewölkt', description: 'Nordwest Wind', accent: 'grey-light', cornerOverrides: { topLeft: 'fill-left', topRight: 'convex', bottomRight: 'convex', bottomLeft: 'none' } },
  { id: 'weather29', x: 0, y: 180, width: 180, height: 180, value: '29°', description: 'Celsius', accent: 'gold', cornerOverrides: { topLeft: 'fill-top', topRight: 'none', bottomRight: 'convex', bottomLeft: 'convex' } },
  { id: 'weather83', x: 180, y: 180, width: 180, height: 180, value: '83%', description: 'Luftfeuchtigkeit', accent: 'forest-green', cornerOverrides: { topLeft: 'fill-left', topRight: 'convex', bottomRight: 'none', bottomLeft: 'none' } },
]

const SPECIES_ROW: BentoGridItem[] = [
  { id: 'vogel', x: 0, y: 270, width: 300, height: 300, title: 'SCHNURRVOGEL', description: 'pipra fasciicauda', accent: 'grey-light', cornerOverrides: { topLeft: 'fill-top', topRight: 'none', bottomRight: 'convex', bottomLeft: 'convex' } },
  { id: 'giftfrosch', x: 300, y: 0, width: 360, height: 570, title: 'SIRA GIFTFROSCH', description: 'ranitomeya sirensis', accent: 'grey-dark', cornerOverrides: { topLeft: 'convex', topRight: 'convex', bottomRight: 'fill-left', bottomLeft: 'none' } },
  { id: 'morphofalter', x: 660, y: 270, width: 300, height: 300, title: 'BLAUER MORPHOFALTER', description: 'morpho deidamia', accent: 'grey-light', cornerOverrides: { topLeft: 'none', topRight: 'convex', bottomRight: 'none', bottomLeft: 'none' } },
]

/** viewportWidth / referenceFrameWidth, portrait vs. landscape picking the frame -- recomputed on resize. */
function computeContentScale(): number {
  const isPortrait = window.innerHeight >= window.innerWidth
  const reference = isPortrait ? MOBILE_FRAME : DESKTOP_FRAME
  return window.innerWidth / reference.width
}

export function createDesignSystemDemo(): DesignSystemDemo {
  const frame = createFrame()

  const weatherHost = document.createElement('div')
  document.body.append(weatherHost)
  const weatherDock = dockElement(weatherHost, { edge: 'top-right', mode: 'frame' }, frame, 'weather')

  const speciesHost = document.createElement('div')
  speciesHost.style.display = 'flex'
  speciesHost.style.flexDirection = 'column'
  speciesHost.style.alignItems = 'center'
  speciesHost.style.gap = '12px'
  document.body.append(speciesHost)
  const speciesDock = dockElement(speciesHost, { edge: 'bottom-center', mode: 'frame' }, frame, 'species')

  const labelTarget = document.createElement('div')
  const speciesTarget = document.createElement('div')
  speciesHost.append(labelTarget, speciesTarget)

  const label = mount(LabelLine as Component, {
    target: labelTarget,
    props: { text: 'Dein Habitat', fontSize: 34, accent: 'forest-green' },
  })

  const weatherCluster = mount(BentoGrid as Component, {
    target: weatherHost,
    props: { items: WEATHER_CLUSTER, radius: 60 },
  })

  const speciesRow = mount(BentoGrid as Component, {
    target: speciesTarget,
    props: { items: SPECIES_ROW, radius: 60 },
  })

  let revealed = false

  function applyContentScale() {
    const scale = String(computeContentScale())
    weatherHost.style.setProperty('--design-system-demo-content-scale', scale)
    speciesHost.style.setProperty('--design-system-demo-content-scale', scale)
  }

  function updateDocks() {
    weatherDock.update()
    speciesDock.update()
  }

  function handleResize() {
    applyContentScale()
    frame.handleResize()
    if (revealed) frame.setMargin(frame.getTargetMargin())
    updateDocks()
  }

  applyContentScale()
  updateDocks()
  window.addEventListener('resize', handleResize)

  // Auto-reveal once, shortly after mount -- no real "select a habitat"
  // interaction exists yet to hang this on. reveal()/retract() are exposed
  // below for whoever wires that interaction later.
  function reveal(durationMs = 600) {
    return frame.animateMarginTo(frame.getTargetMargin(), durationMs, updateDocks).then(() => {
      revealed = true
    })
  }
  function retract(durationMs = 400) {
    revealed = false
    return frame.animateMarginTo(0, durationMs, updateDocks)
  }
  reveal()

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
      weatherHost.remove()
      speciesHost.remove()
      if (import.meta.env.DEV) delete (window as any).__designSystemDemo
    },
  }
}
