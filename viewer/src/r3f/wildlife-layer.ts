import * as THREE from 'three'
import { responseEntries, type FeatureEntry, type FeatureResponse } from './wildlife-api'

interface MarkerRecord { feature: FeatureEntry; group: THREE.Group; anchor: THREE.Object3D; label: HTMLButtonElement; width: number; height: number; rangeVisible: boolean }
export interface FeatureLayer { setResponse(response: FeatureResponse | null): void; setVisible(visible: boolean): void; update(camera: THREE.PerspectiveCamera, cameraRangeM: number): void; clear(): void; dispose(): void }
export interface FeatureLayerOptions {
  scene: THREE.Object3D; overlay: HTMLElement; enuFrame: THREE.Matrix4; zOffset: number
  toEnu(longitude: number, latitude: number, altitudeM: number, target: THREE.Vector3): THREE.Vector3
  onFlyTo(feature: FeatureEntry, targetEnu: THREE.Vector3): void
}

const TYPE_ICON: Record<FeatureEntry['type'], string> = { cluster: '◉', animal: '●', camera: '◈', sensor: '⌁' }
const TYPE_NAME: Record<FeatureEntry['type'], string> = { cluster: 'Animal cluster', animal: 'Animal observation', camera: 'Field camera', sensor: 'Field sensor' }
function labelText(feature: FeatureEntry): string { return feature.type === 'cluster' ? `${feature.count} observations` : feature.type === 'sensor' ? `${feature.label} · ${feature.value}${feature.unit}` : feature.label }
function popupDetail(feature: FeatureEntry): string {
  switch (feature.type) {
    case 'cluster': return `${feature.count} nearby animal observations`
    case 'animal': return `${feature.speciesName} · confidence ${Math.round(feature.confidence * 100)}%`
    case 'camera': return `${feature.status} · last seen ${feature.lastSeenAt}`
    case 'sensor': return `${feature.sensorType} · ${feature.value}${feature.unit} · ${feature.status}`
  }
}
function markerHeight(feature: FeatureEntry): number { return feature.type === 'cluster' ? 28 : feature.type === 'camera' ? 22 : feature.type === 'sensor' ? 18 : 13 }
function labelRange(feature: FeatureEntry): number { return feature.type === 'cluster' ? 20_000 : feature.type === 'camera' || feature.type === 'sensor' ? 8_000 : 3_000 }
function priority(feature: FeatureEntry): number { return feature.type === 'cluster' ? 0 : feature.type === 'camera' ? 1 : feature.type === 'sensor' ? 2 : 3 }
function thumbnailUrl(feature: FeatureEntry): string | null { return feature.type === 'animal' || feature.type === 'cluster' ? feature.thumbnailUrl : null }
function sameFeature(left: FeatureEntry, right: FeatureEntry): boolean { return JSON.stringify(left) === JSON.stringify(right) }

/** Projected DOM markers with invisible Three.js anchors for R3F wildlife data. */
export function createFeatureLayer(options: FeatureLayerOptions): FeatureLayer {
  const root = new THREE.Group()
  root.name = 'wildlife-feature-layer'; root.matrixAutoUpdate = false
  root.matrix.copy(options.enuFrame).multiply(new THREE.Matrix4().makeTranslation(0, 0, options.zOffset)); root.matrixWorldNeedsUpdate = true
  options.scene.add(root)
  const host = document.createElement('div'); host.className = 'wildlife-overlay'; options.overlay.append(host)
  const worldPosition = new THREE.Vector3(), viewPosition = new THREE.Vector3(), projected = new THREE.Vector3()
  const records = new Map<string, MarkerRecord>()
  let visible = true
  let selectedId: string | null = null
  let hoveredId: string | null = null
  const popup = document.createElement('section'); popup.className = 'wildlife-popup'; popup.hidden = true
  const popupType = document.createElement('span'); popupType.className = 'wildlife-popup-type'
  const popupTitle = document.createElement('strong')
  const popupDetailEl = document.createElement('span'); popupDetailEl.className = 'wildlife-popup-detail'
  const popupActions = document.createElement('div'); popupActions.className = 'wildlife-popup-actions'
  const flyButton = document.createElement('button'); flyButton.type = 'button'; flyButton.textContent = 'Fly to'
  const closeButton = document.createElement('button'); closeButton.type = 'button'; closeButton.className = 'wildlife-popup-close'; closeButton.textContent = '×'; closeButton.setAttribute('aria-label', 'Close wildlife details')
  popupActions.append(flyButton, closeButton); popup.append(popupType, popupTitle, popupDetailEl, popupActions); host.append(popup)
  const selected = () => selectedId ? records.get(selectedId) ?? null : null
  const hovered = () => hoveredId ? records.get(hoveredId) ?? null : null
  const active = () => hovered() ?? selected()
  const updateActiveMarker = () => {
    const activeId = active()?.feature.id
    for (const item of records.values()) item.label.classList.toggle('is-selected', item.feature.id === activeId)
  }
  const showPopup = (record: MarkerRecord) => {
    updateActiveMarker()
    popupType.textContent = TYPE_NAME[record.feature.type]; popupTitle.textContent = record.feature.label; popupDetailEl.textContent = popupDetail(record.feature); popup.hidden = false
  }
  const closePopup = () => { selectedId = null; hoveredId = null; popup.hidden = true; updateActiveMarker() }
  const select = (record: MarkerRecord) => { selectedId = record.feature.id; hoveredId = null; showPopup(record) }
  const showHover = (record: MarkerRecord) => { hoveredId = record.feature.id; showPopup(record) }
  const clearHover = (record: MarkerRecord) => {
    if (hoveredId !== record.feature.id) return
    hoveredId = null
    const retained = selected()
    if (retained) showPopup(retained)
    else { popup.hidden = true; updateActiveMarker() }
  }
  const onDocumentKeydown = (event: KeyboardEvent) => { if (event.key === 'Escape' && selectedId) closePopup() }
  document.addEventListener('keydown', onDocumentKeydown); closeButton.addEventListener('click', closePopup)
  flyButton.addEventListener('click', () => { const record = selected(); if (record) options.onFlyTo(record.feature, record.group.position.clone()) })
  const removeRecord = (record: MarkerRecord) => {
    record.label.remove(); root.remove(record.group)
    if (selectedId === record.feature.id) selectedId = null
    if (hoveredId === record.feature.id) hoveredId = null
    const retained = active()
    if (retained) showPopup(retained)
    else { popup.hidden = true; updateActiveMarker() }
  }
  const clearRecords = () => { closePopup(); for (const record of records.values()) removeRecord(record); records.clear() }
  const makeMarkerVisual = (feature: FeatureEntry): HTMLElement => {
    const visual = document.createElement('span'); visual.className = 'wildlife-marker-icon'
    if (feature.type === 'camera') {
      visual.classList.add('is-vector')
      visual.style.setProperty('--wildlife-icon-url', `url("${feature.iconUrl}")`)
      return visual
    }
    const source = thumbnailUrl(feature)
    if (!source) { visual.textContent = TYPE_ICON[feature.type]; return visual }
    const image = document.createElement('img'); image.src = source; image.alt = ''; image.decoding = 'async'; image.loading = 'lazy'
    image.addEventListener('error', () => { image.remove(); visual.textContent = TYPE_ICON[feature.type]; visual.classList.add('is-fallback') }, { once: true })
    visual.append(image)
    return visual
  }
  const makeMarker = (feature: FeatureEntry): MarkerRecord => {
    const group = new THREE.Group(); options.toEnu(feature.position[0], feature.position[1], feature.position[2], group.position)
    const anchor = new THREE.Object3D(); anchor.position.z = markerHeight(feature); group.add(anchor); root.add(group)
    const label = document.createElement('button'); label.type = 'button'; label.className = `map-marker-label wildlife-marker-label wildlife-${feature.type}`; label.setAttribute('aria-label', `${TYPE_NAME[feature.type]}: ${labelText(feature)}`)
    const visual = makeMarkerVisual(feature)
    const text = document.createElement('span'); text.className = 'wildlife-marker-text'; text.textContent = labelText(feature)
    label.append(visual, text)
    if (feature.type === 'cluster') { const count = document.createElement('span'); count.className = 'wildlife-marker-count'; count.textContent = String(feature.count); label.append(count) }
    host.append(label)
    const record = { feature, group, anchor, label, width: 0, height: 0, rangeVisible: true }
    label.addEventListener('pointerenter', () => showHover(record))
    label.addEventListener('pointerleave', () => clearHover(record))
    label.addEventListener('focus', () => showHover(record))
    label.addEventListener('blur', () => clearHover(record))
    label.addEventListener('click', () => select(record))
    return record
  }
  const updatePopup = (camera: THREE.PerspectiveCamera) => {
    const record = active(); if (!record || record.label.hidden || !visible) { popup.hidden = true; return }
    record.anchor.getWorldPosition(worldPosition); projected.copy(worldPosition).project(camera)
    const x = THREE.MathUtils.clamp((projected.x * .5 + .5) * window.innerWidth + 18, 10, window.innerWidth - 238)
    const y = THREE.MathUtils.clamp((-projected.y * .5 + .5) * window.innerHeight + 10, 10, window.innerHeight - 145)
    popup.hidden = false; popup.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`
  }
  return {
    setResponse(response) {
      if (!response) { clearRecords(); return }
      const next = new Map(responseEntries(response).map((feature) => [feature.id, feature]))
      for (const record of Array.from(records.values())) if (!next.has(record.feature.id)) { removeRecord(record); records.delete(record.feature.id) }
      for (const feature of next.values()) {
        const existing = records.get(feature.id)
        if (existing && sameFeature(existing.feature, feature)) continue
        if (existing) removeRecord(existing)
        const record = makeMarker(feature); records.set(feature.id, record)
      }
      root.updateMatrixWorld(true)
    },
    setVisible(nextVisible) { visible = nextVisible; root.visible = nextVisible; host.hidden = !nextVisible; if (!nextVisible) closePopup() },
    update(camera, cameraRangeM) {
      if (!visible) return
      root.updateMatrixWorld(true)
      const ordered = Array.from(records.values()).sort((left, right) => priority(left.feature) - priority(right.feature))
      for (const record of ordered) {
        const range = labelRange(record.feature)
        // Keep the current range state inside a small band so camera-distance jitter
        // cannot make a marker repeatedly cross its show/hide threshold.
        const threshold = record.rangeVisible ? range * 1.12 : range * .88
        record.rangeVisible = cameraRangeM <= threshold
        record.anchor.getWorldPosition(worldPosition); viewPosition.copy(worldPosition).applyMatrix4(camera.matrixWorldInverse); projected.copy(worldPosition).project(camera)
        const onScreen = record.rangeVisible && viewPosition.z < 0 && projected.z > -1 && projected.z < 1 && Math.abs(projected.x) < 1.08 && Math.abs(projected.y) < 1.08
        if (!onScreen) { record.label.hidden = true; continue }
        record.label.hidden = false
        record.label.classList.toggle('is-compact', cameraRangeM > range * .38); record.width = record.label.offsetWidth; record.height = record.label.offsetHeight
        const x = THREE.MathUtils.clamp((projected.x * .5 + .5) * window.innerWidth, record.width / 2 + 7, window.innerWidth - record.width / 2 - 7)
        const y = THREE.MathUtils.clamp((-projected.y * .5 + .5) * window.innerHeight, record.height + 7, window.innerHeight - 7)
        record.label.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`
      }
      updatePopup(camera)
    },
    clear: clearRecords,
    dispose() { clearRecords(); document.removeEventListener('keydown', onDocumentKeydown); closeButton.removeEventListener('click', closePopup); host.remove(); options.scene.remove(root) },
  }
}
