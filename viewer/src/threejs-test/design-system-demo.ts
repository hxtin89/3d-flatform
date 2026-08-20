// Proof-of-concept mount for the @wi/ui design-system package inside this
// Vite+Three.js app. Static example data in a fixed corner, so the Figma ->
// tokens -> Svelte component pipeline is proven end-to-end. Not the real
// habitat info panel (species row, weather cluster, "Dein Habitat" stack) --
// that needs a real data model and a trigger, designed separately.
import { mount, unmount, type Component } from 'svelte'
import { BentoWidget, LabelLine, silhouette } from '@wi/ui'
import '@wi/tokens/css'

export interface DesignSystemDemo {
  dispose(): void
}

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
  const widgetHost = document.createElement('div')
  container.append(labelHost, widgetHost)

  const width = 320
  const height = 220
  const corners = ['convex', 'convex', 'convex', 'convex'] as const

  const label = mount(LabelLine as Component, {
    target: labelHost,
    props: { text: 'Dein Habitat', fontSize: 34, accent: 'forest-green' },
  })

  const widget = mount(BentoWidget as Component, {
    target: widgetHost,
    props: {
      path: silhouette(width, height, [...corners], 60),
      width,
      height,
      corners: [...corners],
      title: 'PERUANISCHER AUWALD',
      value: '29°',
      description: '@wi/ui proof of concept',
      accent: 'forest-green',
      state: 'default',
    },
  })

  return {
    dispose() {
      unmount(label)
      unmount(widget)
      container.remove()
    },
  }
}
