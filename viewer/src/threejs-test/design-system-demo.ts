// Proof-of-concept mount for the @wi/ui design-system package inside this
// Vite+Three.js app. Real content pulled from the "Bento Grid — Recreation"
// Figma page, Frame 1 (S1), so the Figma -> tokens -> Svelte component
// pipeline is proven end-to-end against production data, not placeholders.
// Not the real habitat info panel (a data model + interaction trigger) --
// this is a fixed-corner proof that the pieces render correctly together.
//
// Position/size/corner-Type/accent-mode were read directly off the real
// Figma instances (not re-solved) -- see BentoGrid.stories.ts's
// WeatherCluster/SpeciesRow stories, which use the exact same data. Not
// reproduced: the bird/frog/butterfly line-art icons and the frog widget's
// extra measurement/status block (own bespoke sub-layout).
import { mount, unmount, type Component } from 'svelte'
import { LabelLine, BentoGrid, type BentoGridItem } from '@wi/ui'
import '@wi/tokens/css'

export interface DesignSystemDemo {
  dispose(): void
}

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

export function createDesignSystemDemo(): DesignSystemDemo {
  const container = document.createElement('div')
  container.id = 'design-system-demo'
  container.style.position = 'fixed'
  container.style.left = '20px'
  container.style.bottom = '20px'
  container.style.zIndex = '50'
  container.style.display = 'flex'
  container.style.flexDirection = 'column'
  container.style.gap = '12px'
  container.style.transform = 'scale(0.4)'
  container.style.transformOrigin = 'bottom left'
  document.body.append(container)

  const labelHost = document.createElement('div')
  const weatherHost = document.createElement('div')
  const speciesHost = document.createElement('div')
  container.append(labelHost, weatherHost, speciesHost)

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

  return {
    dispose() {
      unmount(label)
      unmount(weatherCluster)
      unmount(speciesRow)
      container.remove()
    },
  }
}
