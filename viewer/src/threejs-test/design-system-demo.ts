// Proof-of-concept mount for the @wi/ui design-system package inside this
// Vite+Three.js app. Static example data in a fixed corner, so the Figma ->
// tokens -> Svelte component pipeline is proven end-to-end. Not the real
// habitat info panel (species row, weather cluster, "Dein Habitat" stack) --
// that needs a real data model and a trigger, designed separately.
//
// The grid below is the "Test: Bento Docking" reference layout from
// Corner.doc.json (a 3-widget L-shape) run through the real solveDocking()
// algorithm -- same shape as the BentoGrid Storybook story, so its concave
// reflex point is solved from plain rectangle adjacency here too, not
// hand-picked.
import { mount, unmount, type Component } from 'svelte'
import { LabelLine, BentoGrid, type BentoGridItem } from '@wi/ui'
import '@wi/tokens/css'

export interface DesignSystemDemo {
  dispose(): void
}

const GRID_ITEMS: BentoGridItem[] = [
  { id: 'canopy', x: 0, y: 0, width: 160, height: 160, title: 'PERUANISCHER AUWALD', description: 'Kronendach', accent: 'forest-green' },
  { id: 'temp', x: 160, y: 0, width: 160, height: 160, title: 'Temperatur', value: '29°', accent: 'coral' },
  { id: 'species', x: 0, y: 160, width: 160, height: 160, title: 'MANAKIN', description: 'pipra fasciicauda', accent: 'gold' },
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
  document.body.append(container)

  const labelHost = document.createElement('div')
  const gridHost = document.createElement('div')
  container.append(labelHost, gridHost)

  const label = mount(LabelLine as Component, {
    target: labelHost,
    props: { text: 'Dein Habitat', fontSize: 34, accent: 'forest-green' },
  })

  const grid = mount(BentoGrid as Component, {
    target: gridHost,
    props: { items: GRID_ITEMS, radius: 40 },
  })

  return {
    dispose() {
      unmount(label)
      unmount(grid)
      container.remove()
    },
  }
}
