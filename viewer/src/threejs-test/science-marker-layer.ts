import * as THREE from 'three'
import type { EcefEllipsoid, LabelBox } from './science-layer'
import type { ScienceCardContent, ScienceMarker } from './science-markers'

/**
 * Point records of the science data — big trees, plots, survey sites — as DOM markers over
 * the canvas: a dot that stays while the marker is in range, a chip with its name that
 * gives way when it would cover another, and a card with the record that opens on click.
 *
 * DOM rather than geometry: there are tens to a few hundred markers, each one a button
 * that must take a click and show text, and a dot a few pixels wide reads the same from
 * 100 m and 10 km. They sit on the ellipsoid like the science lines (science-layer.ts),
 * in ECEF under the floating-origin root, and like them ignore the canopy above.
 */
export interface ScienceMarkerStyle {
  heightM: number
  /** Beyond this the dot goes too. */
  markerMaxDistanceM: number
  /** Beyond this only the dot stays. */
  labelMaxDistanceM: number
}

export interface ScienceMarkerLayerOptions {
  scene: THREE.Object3D
  overlay: HTMLElement
  ellipsoid: EcefEllipsoid
  markers: ScienceMarker[]
  /** Modifier class for the dataset's colour, e.g. 'science-marker--tree'. */
  className: string
  style: ScienceMarkerStyle
  card: ScienceCard
}

export interface ScienceMarkerLayer {
  setVisible(visible: boolean): void
  update(camera: THREE.Camera, taken: LabelBox[]): void
  count(): number
  dispose(): void
}

/** The one record card on screen, shared by every marker layer. */
export interface ScienceCard {
  open(owner: object, id: string, content: ScienceCardContent): void
  isOpen(owner: object, id: string): boolean
  /** Closes the card if `owner` holds it, or whatever is open when called without one. */
  close(owner?: object): void
  /** The open marker's screen position this frame, or null while it is off screen. */
  place(owner: object, id: string, x: number | null, y: number | null): void
  dispose(): void
}

const DEG = Math.PI / 180
const LABEL_GAP_PX = 4
/** Half the dot's width: the button's left edge sits this far left of the point. */
const DOT_RADIUS_PX = 5
const CARD_OFFSET_PX = 14

/** `onChange` runs when the card opens, so a still camera still gets it placed. */
export function createScienceCard(host: HTMLElement, onChange: () => void = () => {}): ScienceCard {
  const element = document.createElement('section')
  element.className = 'science-card'
  element.hidden = true
  element.setAttribute('role', 'dialog')
  element.innerHTML = '<button type="button" class="science-card-close" aria-label="Close">×</button>'
    + '<h3 class="science-card-title"></h3><p class="science-card-subtitle"></p><dl class="science-card-rows"></dl>'
    + '<div class="science-card-list"><h4></h4><ol></ol></div>'
  host.append(element)
  const title = element.querySelector<HTMLElement>('.science-card-title')!
  const subtitle = element.querySelector<HTMLElement>('.science-card-subtitle')!
  const rowsEl = element.querySelector<HTMLElement>('.science-card-rows')!
  const listEl = element.querySelector<HTMLElement>('.science-card-list')!
  let holder: { owner: object; id: string } | null = null
  // Measured once per opening: reading it every frame, after the markers' writes, would
  // force a layout per frame.
  let size: { width: number; height: number } | null = null
  let lastTransform = ''

  const close = () => {
    holder = null
    element.hidden = true
  }
  element.querySelector('.science-card-close')!.addEventListener('click', close)
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && holder) close()
  }
  window.addEventListener('keydown', onKey)

  return {
    open(owner, id, content) {
      holder = { owner, id }
      title.textContent = content.title
      subtitle.textContent = content.subtitle ?? ''
      subtitle.hidden = !content.subtitle
      rowsEl.replaceChildren(...content.rows.flatMap(([key, value]) => {
        const dt = document.createElement('dt')
        dt.textContent = key
        const dd = document.createElement('dd')
        dd.textContent = value
        return [dt, dd]
      }))
      listEl.hidden = !content.list
      if (content.list) {
        listEl.querySelector('h4')!.textContent = content.list.heading
        listEl.querySelector('ol')!.replaceChildren(...content.list.items.map((item) => {
          const li = document.createElement('li')
          li.textContent = item
          return li
        }))
      }
      // Placed by the owning layer on its next update.
      element.hidden = true
      size = null
      lastTransform = ''
      onChange()
    },
    isOpen: (owner, id) => holder?.owner === owner && holder.id === id,
    close(owner) {
      if (!owner || holder?.owner === owner) close()
    },
    place(owner, id, x, y) {
      if (holder?.owner !== owner || holder.id !== id) return
      if (x === null || y === null) {
        if (!element.hidden) element.hidden = true
        return
      }
      if (element.hidden) element.hidden = false
      size ??= { width: element.offsetWidth, height: element.offsetHeight }
      // Right of the dot, flipped left near the right edge, kept inside the window.
      const left = x + CARD_OFFSET_PX + size.width > window.innerWidth - 8 ? x - CARD_OFFSET_PX - size.width : x + CARD_OFFSET_PX
      const top = Math.min(Math.max(8, y - 24), window.innerHeight - size.height - 8)
      const transform = `translate3d(${Math.max(8, left).toFixed(1)}px, ${top.toFixed(1)}px, 0)`
      if (transform !== lastTransform) {
        element.style.transform = transform
        lastTransform = transform
      }
    },
    dispose() {
      window.removeEventListener('keydown', onKey)
      element.remove()
    },
  }
}

interface MarkerRecord {
  marker: ScienceMarker
  element: HTMLButtonElement
  ecef: THREE.Vector3
  world: THREE.Vector3
  distance: number
  width: number
  height: number
  /** What the element shows now; the DOM is only written when this changes. */
  shown: { hidden: boolean; bare: boolean; transform: string }
}

/** Writes a marker's state to the DOM only where it changed: a still camera writes nothing. */
function show(record: MarkerRecord, hidden: boolean, bare = false, transform = ''): void {
  const { element, shown } = record
  if (hidden !== shown.hidden) {
    element.hidden = hidden
    shown.hidden = hidden
  }
  if (hidden) return
  if (bare !== shown.bare) {
    element.classList.toggle('science-marker--bare', bare)
    shown.bare = bare
  }
  if (transform !== shown.transform) {
    element.style.transform = transform
    shown.transform = transform
  }
}

export function createScienceMarkerLayer(options: ScienceMarkerLayerOptions): ScienceMarkerLayer {
  const { scene, overlay, ellipsoid, style, card } = options
  const owner = {}
  const records: MarkerRecord[] = options.markers.map((marker) => {
    const element = document.createElement('button')
    element.type = 'button'
    element.className = `science-marker ${options.className}`
    element.setAttribute('aria-label', marker.card.title)
    const dot = document.createElement('span')
    dot.className = 'science-marker-dot'
    const label = document.createElement('span')
    label.className = 'science-marker-label'
    label.textContent = marker.label
    element.append(dot, label)
    element.hidden = true
    element.addEventListener('click', (event) => {
      event.stopPropagation()
      if (card.isOpen(owner, marker.id)) card.close(owner)
      else card.open(owner, marker.id, marker.card)
    })
    // The canvas must not start a drag under a marker.
    element.addEventListener('pointerdown', event => event.stopPropagation())
    overlay.append(element)
    const ecef = ellipsoid.getCartographicToPosition(marker.lat * DEG, marker.lon * DEG, style.heightM, new THREE.Vector3())
    return {
      marker, element, ecef, world: new THREE.Vector3(), distance: 0, width: 0, height: 0,
      shown: { hidden: true, bare: false, transform: '' },
    }
  })
  const byDistance = [...records]

  const cameraWorld = new THREE.Vector3()
  const view = new THREE.Vector3()
  const projected = new THREE.Vector3()
  let visible = true
  let measured = false

  function hideAll(): void {
    for (const record of records) show(record, true)
  }

  return {
    setVisible(next) {
      visible = next
      if (!next) {
        hideAll()
        card.close(owner)
      }
    },
    update(camera, taken) {
      if (!visible) return
      if (!measured) {
        // Once, all writes before all reads, so the measuring costs one layout.
        for (const record of records) record.element.hidden = false
        for (const record of records) {
          record.width = record.element.offsetWidth
          record.height = record.element.offsetHeight
        }
        for (const record of records) record.element.hidden = true
        for (const record of records) record.shown.hidden = true
        // Measured while the overlay is hidden, everything reads 0 × 0; try next frame.
        measured = records.length === 0 || records.some(record => record.width > 0)
      }
      camera.getWorldPosition(cameraWorld)
      for (const record of records) {
        record.world.copy(record.ecef).applyMatrix4(scene.matrixWorld)
        record.distance = record.world.distanceTo(cameraWorld)
      }
      byDistance.sort((a, b) => a.distance - b.distance)
      for (const record of byDistance) {
        const { marker } = record
        let onScreen = record.distance <= style.markerMaxDistanceM
        let x = 0
        let y = 0
        if (onScreen) {
          view.copy(record.world).applyMatrix4(camera.matrixWorldInverse)
          projected.copy(record.world).project(camera)
          onScreen = view.z < 0 && Math.abs(projected.x) <= 1.02 && Math.abs(projected.y) <= 1.02 && projected.z < 1
          x = (projected.x * 0.5 + 0.5) * window.innerWidth
          y = (-projected.y * 0.5 + 0.5) * window.innerHeight
        }
        if (!onScreen) {
          show(record, true)
          card.place(owner, marker.id, null, null)
          continue
        }
        let showLabel = record.distance <= style.labelMaxDistanceM
        if (showLabel) {
          const box = { left: x - DOT_RADIUS_PX, right: x - DOT_RADIUS_PX + record.width, top: y - record.height / 2, bottom: y + record.height / 2 }
          showLabel = !taken.some(other => box.left < other.right + LABEL_GAP_PX
            && box.right > other.left - LABEL_GAP_PX
            && box.top < other.bottom + LABEL_GAP_PX
            && box.bottom > other.top - LABEL_GAP_PX)
          if (showLabel) taken.push(box)
        }
        show(record, false, !showLabel, `translate3d(${(x - DOT_RADIUS_PX).toFixed(1)}px, ${y.toFixed(1)}px, 0) translateY(-50%)`)
        card.place(owner, marker.id, x, y)
      }
    },
    count: () => records.length,
    dispose() {
      card.close(owner)
      for (const record of records) record.element.remove()
    },
  }
}
