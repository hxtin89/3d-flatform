import * as THREE from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import { EXPERIENCE_CONFIG } from './config'

const MIN_TEMPERATURE = 28.6
const MAX_TEMPERATURE = 34.2
const FULL_LABEL_MAX_RANGE = 1_800
const COMPACT_LABEL_MAX_RANGE = 6_800
const LABEL_COLLISION_GAP = 7

type LabelMode = 'full' | 'compact' | 'pins'

interface ScreenBox {
  left: number
  right: number
  top: number
  bottom: number
}

interface MarkerLayerOptions {
  scene: THREE.Scene
  overlay: HTMLElement
  enuFrame: THREE.Matrix4
  zOffset: number
  areaBbox: [number, number, number, number, number, number]
  centre: readonly [number, number]
  dataset: string
  reducedMotion: boolean
  onOpenVideo(): void
  onFlyToMarker?(targetEnu: THREE.Vector3, stationName: string): void
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
  labelWidth: number
  labelHeight: number
  opacity: number
  opacityMaterials: Array<{ material: MeshBasicNodeMaterial; baseOpacity: number }>
}

export interface MarkerActionTarget {
  id: string
  label: string
  activate(): void
}

export interface MarkerLayer {
  update(
    now: number,
    camera: THREE.PerspectiveCamera,
    cameraGroundRange: number,
    maskCenter: THREE.Vector2,
    maskRadius: number,
    maskActive: boolean,
  ): void
  pickCenteredAction(camera: THREE.PerspectiveCamera, tolerancePx: number): MarkerActionTarget | null
  setFocusedAction(id: string | null): void
  setTowerSensorTransform(positionM: readonly [number, number, number], sensorHeightM: number): void
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

function createTemperatureLabel(index: number, stationName = `CANOPY 0${index + 1}`): { label: HTMLButtonElement; value: HTMLSpanElement } {
  // A real button: clicking a station flies the camera to it.
  const label = document.createElement('button')
  label.type = 'button'
  label.className = 'map-marker-label temperature-marker-label'
  label.setAttribute('aria-label', `Messstation ${stationName} anfliegen`)

  const live = document.createElement('span')
  live.className = 'temperature-live'
  live.textContent = 'LIVE'

  const station = document.createElement('span')
  station.className = 'temperature-station'
  station.textContent = stationName

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
    centre,
    dataset,
    reducedMotion,
    onOpenVideo,
    onFlyToMarker,
  } = options
  const [minX, minY, minZ, maxX, maxY] = areaBbox
  const [centreX, centreY] = centre
  const width = Math.max(maxX - minX, EXPERIENCE_CONFIG.markers.minimumSpreadM)
  const depth = Math.max(maxY - minY, EXPERIENCE_CONFIG.markers.minimumSpreadM)
  const random = createRandom(hashString(dataset))

  const root = new THREE.Group()
  root.name = 'wilderness-marker-layer'
  root.matrixAutoUpdate = false
  root.matrix.copy(enuFrame).multiply(new THREE.Matrix4().makeTranslation(0, 0, zOffset))
  root.matrixWorldNeedsUpdate = true
  scene.add(root)

  // Every marker shares geometry; material clones keep one shader program but
  // allow independent opacity at the moving point-cloud mask edge.
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

  function markerMaterial(source: MeshBasicNodeMaterial): {
    material: MeshBasicNodeMaterial
    baseOpacity: number
  } {
    const material = source.clone()
    // Per-marker opacity needs a transparent pipeline, but all clones still
    // share the same shader program and every marker keeps shared geometry.
    material.transparent = true
    material.depthWrite = false
    materials.push(material)
    return { material, baseOpacity: source.opacity }
  }

  const markers: MarkerRecord[] = []
  const flyToListeners: Array<{ element: HTMLElement; listener: () => void }> = []

  function wireFlyTo(label: HTMLElement, group: THREE.Group, stationName: string): void {
    if (!onFlyToMarker) return
    const listener = () => onFlyToMarker(group.position.clone(), stationName)
    label.addEventListener('click', listener)
    flyToListeners.push({ element: label, listener })
  }

  for (let index = 0; index < 4; index++) {
    const angle = index * Math.PI * 0.5 + (random() - 0.5) * 0.5
    const radial = EXPERIENCE_CONFIG.markers.radialBase
      + random() * EXPERIENCE_CONFIG.markers.radialJitter
    const group = new THREE.Group()
    group.position.set(
      centreX + Math.cos(angle) * width * radial,
      centreY + Math.sin(angle) * depth * radial,
      minZ + 48 + random() * 18,
    )

    const stemOpacity = markerMaterial(temperatureMaterial)
    const headOpacity = markerMaterial(temperatureHeadMaterial)
    const ringOpacity = markerMaterial(temperatureRingMaterial)
    const stem = new THREE.Mesh(stemGeometry, stemOpacity.material)
    stem.position.z = 8.5
    const head = new THREE.Mesh(headGeometry, headOpacity.material)
    head.position.z = 19.5
    const ring = new THREE.Mesh(ringGeometry, ringOpacity.material)
    ring.position.z = 0.4
    ring.renderOrder = 3
    const anchor = new THREE.Object3D()
    anchor.position.z = 28
    group.add(stem, head, ring, anchor)
    root.add(group)

    const { label, value } = createTemperatureLabel(index)
    overlay.append(label)
    wireFlyTo(label, group, `CANOPY 0${index + 1}`)
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
      labelWidth: 0,
      labelHeight: 0,
      opacity: 1,
      opacityMaterials: [stemOpacity, headOpacity, ringOpacity],
    })
  }

  // The observation tower is the fifth sensor: only its pulse and label are
  // rendered here, while FieldModelLayer supplies the physical tower mesh.
  const towerSensorGroup = new THREE.Group()
  towerSensorGroup.position.set(
    centreX + EXPERIENCE_CONFIG.tower.positionM[0],
    centreY + EXPERIENCE_CONFIG.tower.positionM[1],
    minZ + EXPERIENCE_CONFIG.tower.positionM[2] + EXPERIENCE_CONFIG.tower.sensorHeightM,
  )
  const towerRingOpacity = markerMaterial(temperatureRingMaterial)
  const towerRing = new THREE.Mesh(ringGeometry, towerRingOpacity.material)
  towerRing.renderOrder = 3
  const towerAnchor = new THREE.Object3D()
  towerAnchor.position.z = 12
  towerSensorGroup.add(towerRing, towerAnchor)
  root.add(towerSensorGroup)
  const towerTemperature = createTemperatureLabel(4, 'RIVER 05')
  overlay.append(towerTemperature.label)
  wireFlyTo(towerTemperature.label, towerSensorGroup, 'RIVER 05')
  markers.push({
    group: towerSensorGroup,
    ring: towerRing,
    anchor: towerAnchor,
    label: towerTemperature.label,
    valueElement: towerTemperature.value,
    phase: random() * Math.PI * 2,
    baseTemperature: MIN_TEMPERATURE + 0.35 + random() * (MAX_TEMPERATURE - MIN_TEMPERATURE - 0.7),
    temperatureAmplitude: 0.14 + random() * 0.16,
    temperaturePeriod: 15_000 + random() * 7_000,
    labelOffsetX: 12,
    labelOffsetY: -12,
    labelWidth: 0,
    labelHeight: 0,
    opacity: 1,
    opacityMaterials: [towerRingOpacity],
  })

  // The media hotspot is deliberately offset from the four sensor stations.
  const mediaGroup = new THREE.Group()
  mediaGroup.position.set(centreX + width * 0.1, centreY - depth * 0.06, minZ + 58)
  const mediaStemOpacity = markerMaterial(mediaMaterial)
  const mediaHeadOpacity = markerMaterial(mediaMaterial)
  const mediaRingOpacity = markerMaterial(mediaRingMaterial)
  const mediaStem = new THREE.Mesh(stemGeometry, mediaStemOpacity.material)
  mediaStem.position.z = 8.5
  const mediaHead = new THREE.Mesh(mediaHeadGeometry, mediaHeadOpacity.material)
  mediaHead.position.z = 20
  const mediaRing = new THREE.Mesh(ringGeometry, mediaRingOpacity.material)
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
  mediaButton.setAttribute('aria-keyshortcuts', 'Enter')
  mediaButton.innerHTML = '<span class="media-marker-icon" aria-hidden="true">▶</span><span><b>FIELD FILM</b><small>15 SEC · PLAY</small></span>'
  mediaButton.addEventListener('click', onOpenVideo)
  overlay.append(mediaButton)
  markers.push({
    group: mediaGroup,
    ring: mediaRing,
    anchor: mediaAnchor,
    label: mediaButton,
    phase: random() * Math.PI * 2,
    labelWidth: 0,
    labelHeight: 0,
    opacity: 1,
    opacityMaterials: [mediaStemOpacity, mediaHeadOpacity, mediaRingOpacity],
  })

  root.updateMatrixWorld(true)

  const worldPosition = new THREE.Vector3()
  const viewPosition = new THREE.Vector3()
  const projected = new THREE.Vector3()
  const mediaAction: MarkerActionTarget = {
    id: 'field-film',
    label: 'Field Film',
    activate: () => {
      mediaButton.focus({ preventScroll: true })
      onOpenVideo()
    },
  }
  let focusedActionId: string | null = null
  let lastTemperatureUpdate = -Infinity
  let labelMode: LabelMode | null = null
  let measuredViewportWidth = -1

  function syncLabelMode(nextMode: LabelMode): void {
    const compact = nextMode === 'compact'
    for (const marker of markers) {
      marker.label.classList.toggle('is-compact', compact)
      marker.label.hidden = false
    }
    // Measurements happen only when the LOD or responsive breakpoint changes,
    // never in the hot render path.
    for (const marker of markers) {
      marker.labelWidth = marker.label.offsetWidth
      marker.labelHeight = marker.label.offsetHeight
    }
    labelMode = nextMode
    measuredViewportWidth = window.innerWidth
  }

  function overlaps(left: ScreenBox, right: ScreenBox): boolean {
    return left.left < right.right + LABEL_COLLISION_GAP
      && left.right > right.left - LABEL_COLLISION_GAP
      && left.top < right.bottom + LABEL_COLLISION_GAP
      && left.bottom > right.top - LABEL_COLLISION_GAP
  }

  function updateLabel(marker: MarkerRecord, camera: THREE.PerspectiveCamera, opacity: number): ScreenBox | null {
    marker.anchor.getWorldPosition(worldPosition)
    viewPosition.copy(worldPosition).applyMatrix4(camera.matrixWorldInverse)
    projected.copy(worldPosition).project(camera)
    const visible = opacity > 0
      && viewPosition.z < 0
      && projected.z > -1 && projected.z < 1
      && Math.abs(projected.x) < 1.08
      && Math.abs(projected.y) < 1.08

    marker.label.hidden = !visible
    if (!visible) return null
    const halfWidth = marker.labelWidth * 0.5
    const labelHeight = marker.labelHeight
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
    return {
      left: x - halfWidth,
      right: x + halfWidth,
      top: y - labelHeight,
      bottom: y,
    }
  }

  return {
    update(now, camera, cameraGroundRange, maskCenter, maskRadius, maskActive) {
      const markerScale = THREE.MathUtils.clamp(cameraGroundRange / 1500, 0.72, 4)
      const updateTemperatures = now - lastTemperatureUpdate >= 1000
      if (updateTemperatures) lastTemperatureUpdate = now

      for (const marker of markers) {
        const distanceToMask = Math.hypot(
          marker.group.position.x - maskCenter.x,
          marker.group.position.y - maskCenter.y,
        )
        const edgeFade = EXPERIENCE_CONFIG.markers.maskEdgeFadeM
        const outsideBlend = maskActive
          ? THREE.MathUtils.smoothstep(distanceToMask, maskRadius - edgeFade, maskRadius + edgeFade)
          : 0
        marker.opacity = THREE.MathUtils.lerp(
          1,
          EXPERIENCE_CONFIG.markers.outsideMaskOpacity,
          outsideBlend,
        )
        for (const entry of marker.opacityMaterials) {
          entry.material.opacity = entry.baseOpacity * marker.opacity
        }
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
      }
      mediaHead.scale.setScalar(focusedActionId === mediaAction.id ? 1.45 : 1)

      const nextMode: LabelMode = cameraGroundRange < FULL_LABEL_MAX_RANGE
        ? 'full'
        : cameraGroundRange < COMPACT_LABEL_MAX_RANGE
          ? 'compact'
          : 'pins'
      if (labelMode !== nextMode || measuredViewportWidth !== window.innerWidth) syncLabelMode(nextMode)

      root.updateMatrixWorld(true)
      if (nextMode === 'pins') {
        for (const marker of markers) marker.label.hidden = true
        return
      }

      const labelOpacity = nextMode === 'compact'
        ? THREE.MathUtils.clamp((COMPACT_LABEL_MAX_RANGE - cameraGroundRange) / 1000, 0, 1)
        : 1
      const acceptedBoxes: ScreenBox[] = []
      for (const marker of markers) {
        const box = updateLabel(marker, camera, labelOpacity * marker.opacity)
        if (!box) continue
        // Temperature stations have priority. The media action is deliberately
        // last, so it disappears before obscuring live environmental data.
        if (acceptedBoxes.some((accepted) => overlaps(box, accepted))) {
          marker.label.hidden = true
          continue
        }
        acceptedBoxes.push(box)
      }
    },
    pickCenteredAction(camera, tolerancePx) {
      mediaAnchor.getWorldPosition(worldPosition)
      viewPosition.copy(worldPosition).applyMatrix4(camera.matrixWorldInverse)
      if (viewPosition.z >= 0) return null
      projected.copy(worldPosition).project(camera)
      if (projected.z <= -1 || projected.z >= 1) return null

      const offsetX = projected.x * window.innerWidth * 0.5
      const offsetY = projected.y * window.innerHeight * 0.5
      return offsetX * offsetX + offsetY * offsetY <= tolerancePx * tolerancePx
        ? mediaAction
        : null
    },
    setFocusedAction(id) {
      if (focusedActionId === id) return
      focusedActionId = id
      const focused = id === mediaAction.id
      mediaButton.classList.toggle('is-aimed', focused)
      mediaRingOpacity.material.color.setHex(focused ? 0xd9f99d : 0xffd19a)
    },
    setTowerSensorTransform(positionM, sensorHeightM) {
      towerSensorGroup.position.set(
        centreX + positionM[0],
        centreY + positionM[1],
        minZ + positionM[2] + sensorHeightM,
      )
      root.updateMatrixWorld(true)
    },
    dispose() {
      mediaButton.removeEventListener('click', onOpenVideo)
      for (const { element, listener } of flyToListeners) element.removeEventListener('click', listener)
      for (const marker of markers) marker.label.remove()
      scene.remove(root)
      for (const geometry of geometries) geometry.dispose()
      for (const material of materials) material.dispose()
    },
  }
}
