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
// Not reproduced: the bird/frog/butterfly line-art icons (no icon system
// wired into @wi/ui content yet) and the frog widget's extra measurement/
// status block (its own bespoke sub-layout, outside BentoWidget's current
// prop shape).
import { mount, unmount, type Component } from 'svelte'
import { LabelLine, BentoGrid, type BentoGridItem } from '@wi/ui'
import '@wi/tokens/css'

export interface DesignSystemDemo {
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
function computeScale(): number {
  const isPortrait = window.innerHeight >= window.innerWidth
  const reference = isPortrait ? MOBILE_FRAME : DESKTOP_FRAME
  return window.innerWidth / reference.width
}

// Fixed corner offset for the eagle logo notch, matching where the "Vector"
// eagle icon sits in Figma (165,30,114,68) in BOTH the mobile and desktop
// frames -- it's anchored to the corner at a constant pixel offset rather
// than scaling with the frame, so this stays constant too, not tied to
// computeScale().
const LOGO_NOTCH = { x: 20, y: 20, width: 130, height: 74 }

/**
 * "Rahmen" from Figma is a flat gray/200 rectangle sized to the whole
 * frame, sitting behind the photo and every widget -- the "cutout" look
 * there comes entirely from the photo and widgets opaquely stacking on
 * top, not from the rectangle itself having holes.
 *
 * The 3D scene here can't sit "on top of" a DOM backdrop the way a static
 * photo layer can, so this builds Rahmen's grey as an actual frame shape
 * with real holes: a big rounded window over the point-cloud viewport,
 * plus one notch per thing that needs to read clearly against the 3D scene
 * rather than the grey -- the logo corner, the weather cluster, the species
 * cluster. Implemented as a solid gray/200 rect behind an SVG luminance
 * mask (white = grey shows, black = hole) so the notches can freely
 * overlap the window without needing polygon boolean math.
 */
const SVG_NS = 'http://www.w3.org/2000/svg'

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value)
  return el
}

function createFrameBackdrop() {
  const svg = svgEl('svg')
  svg.style.position = 'fixed'
  svg.style.inset = '0'
  svg.style.zIndex = '40'
  svg.style.pointerEvents = 'none'

  const maskId = 'design-system-demo-frame-mask'
  const mask = svgEl('mask', { id: maskId })
  const maskBackground = svgEl('rect', { x: '0', y: '0', fill: 'white' })
  const windowNotch = svgEl('rect', { id: 'frame-window', fill: 'black' })
  const logoNotch = svgEl('rect', { id: 'frame-logo-notch', fill: 'black' })
  const weatherNotch = svgEl('rect', { id: 'frame-weather-notch', fill: 'black' })
  const speciesNotch = svgEl('rect', { id: 'frame-species-notch', fill: 'black' })
  mask.append(maskBackground, windowNotch, logoNotch, weatherNotch, speciesNotch)

  const gray = svgEl('rect', { x: '0', y: '0', fill: 'var(--gray-200)' })
  gray.setAttribute('mask', `url(#${maskId})`)

  function resizeSurface() {
    const w = String(window.innerWidth)
    const h = String(window.innerHeight)
    svg.setAttribute('width', w)
    svg.setAttribute('height', h)
    maskBackground.setAttribute('width', w)
    maskBackground.setAttribute('height', h)
    gray.setAttribute('width', w)
    gray.setAttribute('height', h)
  }
  resizeSurface()

  svg.append(mask, gray)
  document.body.append(svg)
  // Observed in testing: a mask="url(#id)" reference set in the same tick
  // the <mask> element is inserted can render as if the mask weren't there
  // at all (fully opaque, no cutouts) until something forces the browser to
  // re-resolve the reference. A same-frame requestAnimationFrame reset
  // wasn't a long enough delay to fix it reliably; toggling the attribute
  // off and back on after the page has had a moment to settle is what
  // verified clean across repeated fresh loads.
  setTimeout(() => {
    gray.removeAttribute('mask')
    gray.setAttribute('mask', `url(#${maskId})`)
  }, 200)

  const notchElements: Record<string, SVGRectElement> = {
    'frame-window': windowNotch,
    'frame-logo-notch': logoNotch,
    'frame-weather-notch': weatherNotch,
    'frame-species-notch': speciesNotch,
  }

  function setNotch(id: string, rect: { x: number; y: number; width: number; height: number }, radius = 32) {
    const el = notchElements[id]
    el.setAttribute('x', String(rect.x))
    el.setAttribute('y', String(rect.y))
    el.setAttribute('width', String(Math.max(0, rect.width)))
    el.setAttribute('height', String(Math.max(0, rect.height)))
    el.setAttribute('rx', String(radius))
  }

  function updateWindow() {
    resizeSurface()
    // Frame border thickness: a real visible border, not a thin sliver --
    // 12% of the shorter viewport side, so the point-cloud window stays the
    // dominant focus at every size.
    const margin = Math.min(window.innerWidth, window.innerHeight) * 0.12
    setNotch(
      'frame-window',
      { x: margin, y: margin, width: window.innerWidth - margin * 2, height: window.innerHeight - margin * 2 },
      60,
    )
    setNotch('frame-logo-notch', LOGO_NOTCH, 16)
  }

  function updateClusterNotch(id: string, host: HTMLElement) {
    const rect = host.getBoundingClientRect()
    setNotch(id, rect, 40)
  }

  return {
    updateWindow,
    updateClusterNotch,
    dispose() {
      svg.remove()
    },
  }
}

export function createDesignSystemDemo(): DesignSystemDemo {
  const frame = createFrameBackdrop()

  const weatherHost = document.createElement('div')
  weatherHost.style.position = 'fixed'
  weatherHost.style.top = '0'
  weatherHost.style.right = '0'
  weatherHost.style.zIndex = '50'
  weatherHost.style.transformOrigin = 'top right'
  weatherHost.style.padding = '24px'
  document.body.append(weatherHost)

  const speciesHost = document.createElement('div')
  speciesHost.style.position = 'fixed'
  speciesHost.style.bottom = '0'
  speciesHost.style.left = '50%'
  speciesHost.style.zIndex = '50'
  speciesHost.style.transformOrigin = 'bottom center'
  speciesHost.style.display = 'flex'
  speciesHost.style.flexDirection = 'column'
  speciesHost.style.alignItems = 'center'
  speciesHost.style.gap = '12px'
  speciesHost.style.padding = '24px'
  document.body.append(speciesHost)

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

  function applyLayout() {
    const scale = computeScale()
    weatherHost.style.transform = `scale(${scale})`
    speciesHost.style.transform = `translateX(-50%) scale(${scale})`
    frame.updateWindow()
    // Transforms above apply synchronously, so getBoundingClientRect() inside
    // updateClusterNotch() already reflects the new scale/position -- no need
    // to wait a frame.
    frame.updateClusterNotch('frame-weather-notch', weatherHost)
    frame.updateClusterNotch('frame-species-notch', speciesHost)
  }
  applyLayout()
  window.addEventListener('resize', applyLayout)

  return {
    dispose() {
      window.removeEventListener('resize', applyLayout)
      unmount(label)
      unmount(weatherCluster)
      unmount(speciesRow)
      frame.dispose()
      weatherHost.remove()
      speciesHost.remove()
    },
  }
}
