import * as THREE from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'

const MIN_TEMPERATURE = 28.6
const MAX_TEMPERATURE = 34.2
const LABEL_MAX_RANGE = 12_000

interface MarkerLayerOptions {
  scene: THREE.Scene
  overlay: HTMLElement
  enuFrame: THREE.Matrix4
  zOffset: number
  areaBbox: [number, number, number, number, number, number]
  dataset: string
  reducedMotion: boolean
  onOpenVideo(): void
}

interface MarkerRecord {
  group: THREE.Group
  ring: THREE.Mesh
  anchor: THREE.Object3D
  label: HTMLElement
  phase: number
  baseTemperature?: number
  temperatureAmplitude?: number
  temperaturePeriod?: number
  valueElement?: HTMLElement
  labelOffsetX?: number
  labelOffsetY?: number
}

export interface MarkerLayer {
  update(now: number, camera: THREE.PerspectiveCamera, cameraGroundRange: number): void
  dispose(): void
}

function hashString(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function createMaterial(color: number, opacity = 1): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial()
  material.color.setHex(color)
  material.transparent = opacity < 1
  material.opacity = opacity
  material.depthWrite = opacity >= 1
  return material
}

function createTemperatureLabel(index: number): { label: HTMLDivElement; value: HTMLSpanElement } {
  const label = document.createElement('div')
  label.className = 'map-marker-label temperature-marker-label'
  label.setAttribute('aria-hidden', 'true')

  const live = document.createElement('span')
  live.className = 'temperature-live'
  live.textContent = 'LIVE'

  const station = document.createElement('span')
  station.className = 'temperature-station'
  station.textContent = `CANOPY 0${index + 1}`

  const value = document.createElement('span')
  value.className = 'temperature-value'

  label.append(live, station, value)
  return { label, value }
}

export function createMarkerLayer(options: MarkerLayerOptions): MarkerLayer {
  const {
    scene,
    overlay,
    enuFrame,
    zOffset,
    areaBbox,
    dataset,
    reducedMotion,
    onOpenVideo,
  } = options
  const [minX, minY, minZ, maxX, maxY] = areaBbox
  const centreX = (minX + maxX) / 2
  const centreY = (minY + maxY) / 2
  const width = Math.max(maxX - minX, 240)
  const depth = Math.max(maxY - minY, 240)
  const random = createRandom(hashString(dataset))

  const root = new THREE.Group()
  root.name = 'wilderness-marker-layer'
  root.matrixAutoUpdate = false
  root.matrix.copy(enuFrame).multiply(new THREE.Matrix4().makeTranslation(0, 0, zOffset))
  root.matrixWorldNeedsUpdate = true
  scene.add(root)

  // Every temperature pin shares these GPU resources.
  const stemGeometry = new THREE.CylinderGeometry(0.35, 1.45, 17, 8)
  stemGeometry.rotateX(Math.PI / 2)
  const headGeometry = new THREE.SphereGeometry(3.4, 12, 8)
  const ringGeometry = new THREE.RingGeometry(4.8, 6.1, 24)
  const mediaHeadGeometry = new THREE.OctahedronGeometry(4.8, 0)
  const temperatureMaterial = createMaterial(0xd9f99d)
  const temperatureHeadMaterial = createMaterial(0xf4f0df)
  const temperatureRingMaterial = createMaterial(0xb7dd58, 0.42)
  const mediaMaterial = createMaterial(0xffb65f)
  const mediaRingMaterial = createMaterial(0xffd19a, 0.48)
  const geometries = [stemGeometry, headGeometry, ringGeometry, mediaHeadGeometry]
  const materials = [
    temperatureMaterial,
    temperatureHeadMaterial,
    temperatureRingMaterial,
    mediaMaterial,
    mediaRingMaterial,
  ]

  const markers: MarkerRecord[] = []

  for (let index = 0; index < 4; index++) {
    const angle = index * Math.PI * 0.5 + (random() - 0.5) * 0.5
    const radial = 0.38 + random() * 0.08
    const group = new THREE.Group()
    group.position.set(
      centreX + Math.cos(angle) * width * radial,
      centreY + Math.sin(angle) * depth * radial,
      minZ + 48 + random() * 18,
    )

    const stem = new THREE.Mesh(stemGeometry, temperatureMaterial)
    stem.position.z = 8.5
    const head = new THREE.Mesh(headGeometry, temperatureHeadMaterial)
    head.position.z = 19.5
    const ring = new THREE.Mesh(ringGeometry, temperatureRingMaterial)
    ring.position.z = 0.4
    ring.renderOrder = 3
    const anchor = new THREE.Object3D()
    anchor.position.z = 28
    group.add(stem, head, ring, anchor)
    root.add(group)

    const { label, value } = createTemperatureLabel(index)
    overlay.append(label)
    markers.push({
      group,
      ring,
      anchor,
      label,
      valueElement: value,
      phase: random() * Math.PI * 2,
      baseTemperature: MIN_TEMPERATURE + 0.35 + random() * (MAX_TEMPERATURE - MIN_TEMPERATURE - 0.7),
      temperatureAmplitude: 0.12 + random() * 0.22,
      temperaturePeriod: 12_000 + random() * 9_000,
      labelOffsetX: Math.cos(angle) * 36,
      labelOffsetY: -Math.sin(angle) * 24,
    })
  }

  // The media hotspot is deliberately offset from the four sensor stations.
  const mediaGroup = new THREE.Group()
  mediaGroup.position.set(centreX + width * 0.1, centreY - depth * 0.06, minZ + 58)
  const mediaStem = new THREE.Mesh(stemGeometry, mediaMaterial)
  mediaStem.position.z = 8.5
  const mediaHead = new THREE.Mesh(mediaHeadGeometry, mediaMaterial)
  mediaHead.position.z = 20
  const mediaRing = new THREE.Mesh(ringGeometry, mediaRingMaterial)
  mediaRing.position.z = 0.5
  mediaRing.renderOrder = 3
  const mediaAnchor = new THREE.Object3D()
  mediaAnchor.position.z = 30
  mediaGroup.add(mediaStem, mediaHead, mediaRing, mediaAnchor)
  root.add(mediaGroup)

  const mediaButton = document.createElement('button')
  mediaButton.type = 'button'
  mediaButton.className = 'map-marker-label media-marker-label'
  mediaButton.setAttribute('aria-label', 'Wilderness-Imagefilm ansehen')
  mediaButton.innerHTML = '<span class="media-marker-icon" aria-hidden="true">▶</span><span><b>FIELD FILM</b><small>15 SEC · PLAY</small></span>'
  mediaButton.addEventListener('click', onOpenVideo)
  overlay.append(mediaButton)
  markers.push({
    group: mediaGroup,
    ring: mediaRing,
    anchor: mediaAnchor,
    label: mediaButton,
    phase: random() * Math.PI * 2,
  })

  root.updateMatrixWorld(true)

  const worldPosition = new THREE.Vector3()
  const viewPosition = new THREE.Vector3()
  const projected = new THREE.Vector3()
  let lastTemperatureUpdate = -Infinity

  function updateLabel(marker: MarkerRecord, camera: THREE.PerspectiveCamera, opacity: number): void {
    marker.anchor.getWorldPosition(worldPosition)
    viewPosition.copy(worldPosition).applyMatrix4(camera.matrixWorldInverse)
    projected.copy(worldPosition).project(camera)
    const visible = opacity > 0
      && viewPosition.z < 0
      && projected.z > -1 && projected.z < 1
      && Math.abs(projected.x) < 1.08
      && Math.abs(projected.y) < 1.08

    marker.label.hidden = !visible
    if (!visible) return
    const halfWidth = marker.label.offsetWidth * 0.5
    const labelHeight = marker.label.offsetHeight
    const x = THREE.MathUtils.clamp(
      (projected.x * 0.5 + 0.5) * window.innerWidth + (marker.labelOffsetX ?? 0),
      halfWidth + 7,
      window.innerWidth - halfWidth - 7,
    )
    const y = THREE.MathUtils.clamp(
      (-projected.y * 0.5 + 0.5) * window.innerHeight + (marker.labelOffsetY ?? 0),
      labelHeight + 7,
      window.innerHeight - 7,
    )
    marker.label.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`
    marker.label.style.opacity = opacity.toFixed(3)
  }

  return {
    update(now, camera, cameraGroundRange) {
      root.updateMatrixWorld(true)
      const markerScale = THREE.MathUtils.clamp(cameraGroundRange / 1500, 0.72, 4)
      const labelOpacity = THREE.MathUtils.clamp((LABEL_MAX_RANGE - cameraGroundRange) / 3500, 0, 1)
      const updateTemperatures = now - lastTemperatureUpdate >= 1000
      if (updateTemperatures) lastTemperatureUpdate = now

      for (const marker of markers) {
        marker.group.scale.setScalar(markerScale)
        const pulse = reducedMotion ? 1.25 : 1.05 + (Math.sin(now * 0.003 + marker.phase) * 0.5 + 0.5) * 1.25
        marker.ring.scale.setScalar(pulse)

        if (updateTemperatures && marker.valueElement && marker.baseTemperature !== undefined) {
          const value = THREE.MathUtils.clamp(
            marker.baseTemperature + Math.sin(now / marker.temperaturePeriod! + marker.phase) * marker.temperatureAmplitude!,
            MIN_TEMPERATURE,
            MAX_TEMPERATURE,
          )
          marker.valueElement.textContent = `${value.toFixed(1).replace('.', ',')} °C`
        }
        updateLabel(marker, camera, labelOpacity)
      }
    },
    dispose() {
      mediaButton.removeEventListener('click', onOpenVideo)
      for (const marker of markers) marker.label.remove()
      scene.remove(root)
      for (const geometry of geometries) geometry.dispose()
      for (const material of materials) material.dispose()
    },
  }
}
