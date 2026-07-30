import * as Cesium from 'cesium'
import { EXPERIENCE_CONFIG } from './config'
import type { EnuFrame } from './enu'

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
  scene: Cesium.Scene
  overlay: HTMLElement
  enuFrame: EnuFrame
  areaBbox: [number, number, number, number, number, number]
  centre: readonly [number, number]
  dataset: string
  reducedMotion: boolean
  onOpenVideo(): void
  onFlyToMarker?(targetEnu: Cesium.Cartesian3, stationName: string): void
}

interface MarkerPart {
  primitive: Cesium.Primitive
  instanceId: string
  z: number
  baseColor: number
  baseOpacity: number
  currentColor: number
  currentOpacity: number
}

interface MarkerRecord {
  positionEnu: Cesium.Cartesian3
  anchorHeight: number
  parts: MarkerPart[]
  ring: MarkerPart
  head?: MarkerPart
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
  markerScale: number
  ringScale: number
}

export interface MarkerActionTarget {
  id: string
  label: string
  activate(): void
}

export interface MarkerLayer {
  /** Hide/show 3D pins and DOM chips (compare mode); skip update() while hidden. */
  setVisible(visible: boolean): void
  update(
    now: number,
    camera: Cesium.Camera,
    cameraGroundRange: number,
    maskCenter: Cesium.Cartesian2,
    maskRadius: number,
    maskActive: boolean,
  ): void
  pickCenteredAction(camera: Cesium.Camera, tolerancePx: number): MarkerActionTarget | null
  setFocusedAction(id: string | null): void
  setTowerSensorTransform(
    positionM: readonly [number, number, number],
    sensorHeightM: number,
  ): void
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

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) return value < edge0 ? 0 : 1
  const amount = Cesium.Math.clamp((value - edge0) / (edge1 - edge0), 0, 1)
  return amount * amount * (3 - 2 * amount)
}

function colorFromHex(hex: number, opacity: number): Cesium.Color {
  return Cesium.Color.fromBytes(
    (hex >> 16) & 0xff,
    (hex >> 8) & 0xff,
    hex & 0xff,
    Math.round(Cesium.Math.clamp(opacity, 0, 1) * 255),
  )
}

function createTemperatureLabel(
  index: number,
  stationName = `CANOPY 0${index + 1}`,
): { label: HTMLButtonElement; value: HTMLSpanElement } {
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

/** Small local-space annulus used for the pulsing ground ring. */
function createRingGeometry(innerRadius: number, outerRadius: number, segments: number): Cesium.Geometry {
  const positions = new Float64Array(segments * 2 * 3)
  const indices = new Uint16Array(segments * 6)
  for (let index = 0; index < segments; index++) {
    const angle = index / segments * Math.PI * 2
    const cosine = Math.cos(angle)
    const sine = Math.sin(angle)
    const vertex = index * 6
    positions[vertex] = cosine * innerRadius
    positions[vertex + 1] = sine * innerRadius
    positions[vertex + 2] = 0
    positions[vertex + 3] = cosine * outerRadius
    positions[vertex + 4] = sine * outerRadius
    positions[vertex + 5] = 0

    const next = (index + 1) % segments
    const target = index * 6
    indices[target] = index * 2
    indices[target + 1] = index * 2 + 1
    indices[target + 2] = next * 2 + 1
    indices[target + 3] = index * 2
    indices[target + 4] = next * 2 + 1
    indices[target + 5] = next * 2
  }

  const attributes = new Cesium.GeometryAttributes()
  attributes.position = new Cesium.GeometryAttribute({
    componentDatatype: Cesium.ComponentDatatype.DOUBLE,
    componentsPerAttribute: 3,
    values: positions,
  })
  return new Cesium.Geometry({
    attributes,
    indices,
    primitiveType: Cesium.PrimitiveType.TRIANGLES,
    boundingSphere: new Cesium.BoundingSphere(Cesium.Cartesian3.ZERO, outerRadius),
  })
}

export function createMarkerLayer(options: MarkerLayerOptions): MarkerLayer {
  const {
    scene,
    overlay,
    enuFrame,
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

  // The scene owns one collection. Individual tiny primitives let their model
  // matrices carry the source pin's group/head/ring animation independently.
  const primitives = scene.primitives.add(new Cesium.PrimitiveCollection({ show: false }))
  const stemGeometry = new Cesium.CylinderGeometry({
    length: 17,
    topRadius: 0.35,
    bottomRadius: 1.45,
    slices: 8,
    vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
  })
  const temperatureHeadGeometry = new Cesium.EllipsoidGeometry({
    radii: new Cesium.Cartesian3(3.4, 3.4, 3.4),
    stackPartitions: 8,
    slicePartitions: 12,
    vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
  })
  const mediaHeadGeometry = new Cesium.EllipsoidGeometry({
    radii: new Cesium.Cartesian3(4.8, 4.8, 4.8),
    stackPartitions: 8,
    slicePartitions: 12,
    vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
  })
  let nextPartId = 0

  function createPart(
    geometry: Cesium.Geometry | Cesium.GeometryFactory,
    z: number,
    baseColor: number,
    baseOpacity = 1,
    closed = true,
  ): MarkerPart {
    const instanceId = `wilderness-marker-${nextPartId++}`
    const instance = new Cesium.GeometryInstance({
      geometry,
      id: instanceId,
      attributes: {
        color: Cesium.ColorGeometryInstanceAttribute.fromColor(
          colorFromHex(baseColor, baseOpacity),
        ),
      },
    })
    const primitive = primitives.add(new Cesium.Primitive({
      geometryInstances: instance,
      appearance: new Cesium.PerInstanceColorAppearance({
        flat: true,
        translucent: true,
        closed,
      }),
      modelMatrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY),
      asynchronous: false,
      allowPicking: false,
      releaseGeometryInstances: true,
      shadows: Cesium.ShadowMode.DISABLED,
    })) as Cesium.Primitive
    return {
      primitive,
      instanceId,
      z,
      baseColor,
      baseOpacity,
      currentColor: -1,
      currentOpacity: -1,
    }
  }

  const markers: MarkerRecord[] = []
  const flyToListeners: Array<{ element: HTMLElement; listener: () => void }> = []

  function wireFlyTo(
    label: HTMLElement,
    positionEnu: Cesium.Cartesian3,
    stationName: string,
  ): void {
    if (!onFlyToMarker) return
    const listener = () => onFlyToMarker(Cesium.Cartesian3.clone(positionEnu), stationName)
    label.addEventListener('click', listener)
    flyToListeners.push({ element: label, listener })
  }

  for (let index = 0; index < 4; index++) {
    const angle = index * Math.PI * 0.5 + (random() - 0.5) * 0.5
    const radial = EXPERIENCE_CONFIG.markers.radialBase
      + random() * EXPERIENCE_CONFIG.markers.radialJitter
    const positionEnu = new Cesium.Cartesian3(
      centreX + Math.cos(angle) * width * radial,
      centreY + Math.sin(angle) * depth * radial,
      minZ + 48 + random() * 18,
    )
    const stem = createPart(stemGeometry, 8.5, 0xd9f99d)
    const head = createPart(temperatureHeadGeometry, 19.5, 0xf4f0df)
    const ring = createPart(
      createRingGeometry(4.8, 6.1, 24),
      0.4,
      0xb7dd58,
      0.42,
      false,
    )
    const { label, value } = createTemperatureLabel(index)
    overlay.append(label)
    wireFlyTo(label, positionEnu, `CANOPY 0${index + 1}`)
    markers.push({
      positionEnu,
      anchorHeight: 28,
      parts: [stem, head, ring],
      ring,
      head,
      label,
      valueElement: value,
      phase: random() * Math.PI * 2,
      baseTemperature: MIN_TEMPERATURE + 0.35
        + random() * (MAX_TEMPERATURE - MIN_TEMPERATURE - 0.7),
      temperatureAmplitude: 0.12 + random() * 0.22,
      temperaturePeriod: 12_000 + random() * 9_000,
      labelOffsetX: Math.cos(angle) * 36,
      labelOffsetY: -Math.sin(angle) * 24,
      labelWidth: 0,
      labelHeight: 0,
      opacity: 1,
      markerScale: 1,
      ringScale: 1,
    })
  }

  // The observation tower is the fifth sensor: only its pulse and label are
  // rendered here, while FieldModelLayer supplies the physical tower mesh.
  const towerPositionEnu = new Cesium.Cartesian3(
    centreX + EXPERIENCE_CONFIG.tower.positionM[0],
    centreY + EXPERIENCE_CONFIG.tower.positionM[1],
    minZ + EXPERIENCE_CONFIG.tower.positionM[2] + EXPERIENCE_CONFIG.tower.sensorHeightM,
  )
  const towerRing = createPart(
    createRingGeometry(4.8, 6.1, 24),
    0,
    0xb7dd58,
    0.42,
    false,
  )
  const towerTemperature = createTemperatureLabel(4, 'RIVER 05')
  overlay.append(towerTemperature.label)
  wireFlyTo(towerTemperature.label, towerPositionEnu, 'RIVER 05')
  const towerMarker: MarkerRecord = {
    positionEnu: towerPositionEnu,
    anchorHeight: 12,
    parts: [towerRing],
    ring: towerRing,
    label: towerTemperature.label,
    valueElement: towerTemperature.value,
    phase: random() * Math.PI * 2,
    baseTemperature: MIN_TEMPERATURE + 0.35
      + random() * (MAX_TEMPERATURE - MIN_TEMPERATURE - 0.7),
    temperatureAmplitude: 0.14 + random() * 0.16,
    temperaturePeriod: 15_000 + random() * 7_000,
    labelOffsetX: 12,
    labelOffsetY: -12,
    labelWidth: 0,
    labelHeight: 0,
    opacity: 1,
    markerScale: 1,
    ringScale: 1,
  }
  markers.push(towerMarker)

  // The media hotspot is deliberately offset from the four sensor stations.
  const mediaPositionEnu = new Cesium.Cartesian3(
    centreX + width * 0.1,
    centreY - depth * 0.06,
    minZ + 58,
  )
  const mediaStem = createPart(stemGeometry, 8.5, 0xffb65f)
  const mediaHead = createPart(mediaHeadGeometry, 20, 0xffb65f)
  const mediaRing = createPart(
    createRingGeometry(4.8, 6.1, 24),
    0.5,
    0xffd19a,
    0.48,
    false,
  )
  const mediaButton = document.createElement('button')
  mediaButton.type = 'button'
  mediaButton.className = 'map-marker-label media-marker-label'
  mediaButton.setAttribute('aria-label', 'Wilderness-Imagefilm ansehen')
  mediaButton.setAttribute('aria-keyshortcuts', 'Enter')
  mediaButton.innerHTML = '<span class="media-marker-icon" aria-hidden="true">▶</span><span><b>FIELD FILM</b><small>15 SEC · PLAY</small></span>'
  mediaButton.addEventListener('click', onOpenVideo)
  overlay.append(mediaButton)
  const mediaMarker: MarkerRecord = {
    positionEnu: mediaPositionEnu,
    anchorHeight: 30,
    parts: [mediaStem, mediaHead, mediaRing],
    ring: mediaRing,
    head: mediaHead,
    label: mediaButton,
    phase: random() * Math.PI * 2,
    labelWidth: 0,
    labelHeight: 0,
    opacity: 1,
    markerScale: 1,
    ringScale: 1,
  }
  markers.push(mediaMarker)

  const mediaAction: MarkerActionTarget = {
    id: 'field-film',
    label: 'Field Film',
    activate: () => {
      mediaButton.focus({ preventScroll: true })
      onOpenVideo()
    },
  }
  const markerTranslation = new Cesium.Matrix4()
  const markerScaleMatrix = new Cesium.Matrix4()
  const partTranslation = new Cesium.Matrix4()
  const partScaleMatrix = new Cesium.Matrix4()
  const markerLocal = new Cesium.Matrix4()
  const partLocal = new Cesium.Matrix4()
  const fullLocal = new Cesium.Matrix4()
  const anchorEnu = new Cesium.Cartesian3()
  const anchorWorld = new Cesium.Cartesian3()
  const toAnchor = new Cesium.Cartesian3()
  const projected = new Cesium.Cartesian2()
  const cameraScaled = new Cesium.Cartesian3()
  const anchorScaled = new Cesium.Cartesian3()
  const unitEarthOccluder = new Cesium.Occluder(
    new Cesium.BoundingSphere(Cesium.Cartesian3.ZERO, 1),
    Cesium.Cartesian3.UNIT_Z,
  )
  const lastMediaScreen = new Cesium.Cartesian2()
  let mediaScreenVisible = false
  let focusedActionId: string | null = null
  let lastTemperatureUpdate = -Infinity
  let labelMode: LabelMode | null = null
  let measuredViewportWidth = -1
  let visible = true
  let initialized = false
  let disposed = false

  function syncLabelMode(nextMode: LabelMode): void {
    const compact = nextMode === 'compact'
    for (const marker of markers) {
      marker.label.classList.toggle('is-compact', compact)
      marker.label.hidden = false
    }
    // Measurements happen only when the LOD or responsive breakpoint changes,
    // never in the hot projection path.
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

  function updatePartMatrix(
    marker: MarkerRecord,
    part: MarkerPart,
    relativeScale: number,
  ): void {
    Cesium.Matrix4.fromTranslation(marker.positionEnu, markerTranslation)
    Cesium.Matrix4.fromUniformScale(marker.markerScale, markerScaleMatrix)
    Cesium.Matrix4.multiply(markerTranslation, markerScaleMatrix, markerLocal)
    Cesium.Matrix4.fromTranslation(
      Cesium.Cartesian3.fromElements(0, 0, part.z, toAnchor),
      partTranslation,
    )
    Cesium.Matrix4.fromUniformScale(relativeScale, partScaleMatrix)
    Cesium.Matrix4.multiply(partTranslation, partScaleMatrix, partLocal)
    Cesium.Matrix4.multiply(markerLocal, partLocal, fullLocal)
    Cesium.Matrix4.multiply(enuFrame.matrix, fullLocal, part.primitive.modelMatrix)
  }

  function updatePartColor(
    part: MarkerPart,
    markerOpacity: number,
    color = part.baseColor,
  ): void {
    const opacity = part.baseOpacity * markerOpacity
    if (!part.primitive.ready
      || (part.currentColor === color && Math.abs(part.currentOpacity - opacity) < 0.001)) return
    const attributes = part.primitive.getGeometryInstanceAttributes(part.instanceId)
    attributes.color = Cesium.ColorGeometryInstanceAttribute.toValue(
      colorFromHex(color, opacity),
      attributes.color,
    )
    part.currentColor = color
    part.currentOpacity = opacity
  }

  function markerAnchorWorld(marker: MarkerRecord, result: Cesium.Cartesian3): Cesium.Cartesian3 {
    Cesium.Cartesian3.fromElements(
      marker.positionEnu.x,
      marker.positionEnu.y,
      marker.positionEnu.z + marker.anchorHeight * marker.markerScale,
      anchorEnu,
    )
    return enuFrame.enuToWorld(anchorEnu, result)
  }

  function projectMarker(
    marker: MarkerRecord,
    camera: Cesium.Camera,
    canvasRect: DOMRect,
  ): Cesium.Cartesian2 | null {
    markerAnchorWorld(marker, anchorWorld)
    Cesium.Cartesian3.subtract(anchorWorld, camera.positionWC, toAnchor)
    const forwardDistance = Cesium.Cartesian3.dot(toAnchor, camera.directionWC)
    if (forwardDistance <= camera.frustum.near || forwardDistance >= camera.frustum.far) {
      return null
    }

    // Occluder runs in ellipsoid-scaled space, turning WGS84 into a unit
    // sphere. This rejects labels on the far side of the globe before DOM work.
    scene.globe.ellipsoid.transformPositionToScaledSpace(camera.positionWC, cameraScaled)
    scene.globe.ellipsoid.transformPositionToScaledSpace(anchorWorld, anchorScaled)
    unitEarthOccluder.cameraPosition = cameraScaled
    if (!unitEarthOccluder.isPointVisible(anchorScaled)) return null

    const windowPosition = Cesium.SceneTransforms.worldToWindowCoordinates(
      scene,
      anchorWorld,
      projected,
    )
    if (!windowPosition) return null
    const x = canvasRect.left + windowPosition.x
    const y = canvasRect.top + windowPosition.y
    const marginX = canvasRect.width * 0.04
    const marginY = canvasRect.height * 0.04
    if (x < canvasRect.left - marginX || x > canvasRect.right + marginX
      || y < canvasRect.top - marginY || y > canvasRect.bottom + marginY) return null
    return Cesium.Cartesian2.fromElements(x, y, projected)
  }

  function updateLabel(
    marker: MarkerRecord,
    camera: Cesium.Camera,
    canvasRect: DOMRect,
    opacity: number,
  ): ScreenBox | null {
    const screen = projectMarker(marker, camera, canvasRect)
    const isMedia = marker === mediaMarker
    if (isMedia) {
      mediaScreenVisible = Boolean(screen)
      if (screen) Cesium.Cartesian2.clone(screen, lastMediaScreen)
    }
    const labelVisible = Boolean(screen) && opacity > 0 && labelMode !== 'pins'
    marker.label.hidden = !labelVisible
    if (!screen || !labelVisible) return null

    const halfWidth = marker.labelWidth * 0.5
    const labelHeight = marker.labelHeight
    const x = Cesium.Math.clamp(
      screen.x + (marker.labelOffsetX ?? 0),
      halfWidth + 7,
      window.innerWidth - halfWidth - 7,
    )
    const y = Cesium.Math.clamp(
      screen.y + (marker.labelOffsetY ?? 0),
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

  // DOM projection must observe the matrices Cesium actually rendered. It
  // therefore runs after the frame, not in update()'s pre-render hot path.
  const removePostRender = scene.postRender.addEventListener(() => {
    mediaScreenVisible = false
    if (disposed || !visible || !labelMode) {
      for (const marker of markers) marker.label.hidden = true
      return
    }
    const canvasRect = scene.canvas.getBoundingClientRect()
    const labelOpacity = labelMode === 'compact'
      ? Cesium.Math.clamp(
        (COMPACT_LABEL_MAX_RANGE
          - (Number.isFinite(lastCameraGroundRange) ? lastCameraGroundRange : COMPACT_LABEL_MAX_RANGE))
          / 1000,
        0,
        1,
      )
      : 1
    const acceptedBoxes: ScreenBox[] = []
    for (const marker of markers) {
      const box = updateLabel(
        marker,
        scene.camera,
        canvasRect,
        labelOpacity * marker.opacity,
      )
      if (!box) continue
      // Temperature stations have priority. The media action is deliberately
      // last, so it disappears before obscuring live environmental data.
      if (acceptedBoxes.some((accepted) => overlaps(box, accepted))) {
        marker.label.hidden = true
        continue
      }
      acceptedBoxes.push(box)
    }
  })
  let lastCameraGroundRange = Infinity

  return {
    setVisible(nextVisible) {
      visible = nextVisible
      primitives.show = nextVisible && initialized
      overlay.classList.toggle('markers-hidden', !nextVisible)
      if (!nextVisible) {
        mediaScreenVisible = false
        for (const marker of markers) marker.label.hidden = true
      }
    },

    update(now, _camera, cameraGroundRange, maskCenter, maskRadius, maskActive) {
      if (!initialized) {
        initialized = true
        primitives.show = visible
      }
      lastCameraGroundRange = cameraGroundRange
      const markerScale = Cesium.Math.clamp(cameraGroundRange / 1500, 0.72, 4)
      const updateTemperatures = now - lastTemperatureUpdate >= 1000
      if (updateTemperatures) lastTemperatureUpdate = now

      for (const marker of markers) {
        const distanceToMask = Math.hypot(
          marker.positionEnu.x - maskCenter.x,
          marker.positionEnu.y - maskCenter.y,
        )
        const edgeFade = EXPERIENCE_CONFIG.markers.maskEdgeFadeM
        const outsideBlend = maskActive
          ? smoothstep(maskRadius - edgeFade, maskRadius + edgeFade, distanceToMask)
          : 0
        marker.opacity = Cesium.Math.lerp(
          1,
          EXPERIENCE_CONFIG.markers.outsideMaskOpacity,
          outsideBlend,
        )
        marker.markerScale = markerScale
        marker.ringScale = reducedMotion
          ? 1.25
          : 1.05 + (Math.sin(now * 0.003 + marker.phase) * 0.5 + 0.5) * 1.25

        for (const part of marker.parts) {
          const relativeScale = part === marker.ring
            ? marker.ringScale
            : part === marker.head && marker === mediaMarker
              && focusedActionId === mediaAction.id
              ? 1.45
              : 1
          updatePartMatrix(marker, part, relativeScale)
          const color = part === mediaRing && focusedActionId === mediaAction.id
            ? 0xd9f99d
            : part.baseColor
          updatePartColor(part, marker.opacity, color)
        }

        if (updateTemperatures && marker.valueElement && marker.baseTemperature !== undefined) {
          const value = Cesium.Math.clamp(
            marker.baseTemperature
              + Math.sin(now / marker.temperaturePeriod! + marker.phase)
              * marker.temperatureAmplitude!,
            MIN_TEMPERATURE,
            MAX_TEMPERATURE,
          )
          marker.valueElement.textContent = `${value.toFixed(1).replace('.', ',')} °C`
        }
      }

      const nextMode: LabelMode = cameraGroundRange < FULL_LABEL_MAX_RANGE
        ? 'full'
        : cameraGroundRange < COMPACT_LABEL_MAX_RANGE
          ? 'compact'
          : 'pins'
      if (labelMode !== nextMode || measuredViewportWidth !== window.innerWidth) {
        syncLabelMode(nextMode)
      }
    },

    pickCenteredAction(_camera, tolerancePx) {
      if (!visible || !mediaScreenVisible) return null
      const offsetX = lastMediaScreen.x - window.innerWidth * 0.5
      const offsetY = lastMediaScreen.y - window.innerHeight * 0.5
      return offsetX * offsetX + offsetY * offsetY <= tolerancePx * tolerancePx
        ? mediaAction
        : null
    },

    setFocusedAction(id) {
      if (focusedActionId === id) return
      focusedActionId = id
      mediaButton.classList.toggle('is-aimed', id === mediaAction.id)
      // Matrix/color changes are applied by the next update before rendering.
      mediaHead.currentColor = -1
      mediaRing.currentColor = -1
    },

    setTowerSensorTransform(positionM, sensorHeightM) {
      Cesium.Cartesian3.fromElements(
        centreX + positionM[0],
        centreY + positionM[1],
        minZ + positionM[2] + sensorHeightM,
        towerMarker.positionEnu,
      )
    },

    dispose() {
      if (disposed) return
      disposed = true
      removePostRender()
      mediaButton.removeEventListener('click', onOpenVideo)
      for (const { element, listener } of flyToListeners) {
        element.removeEventListener('click', listener)
      }
      for (const marker of markers) marker.label.remove()
      const sceneDestroyed = (scene as any).isDestroyed?.() ?? false
      const wasRemoved = !sceneDestroyed
        && scene.primitives.contains(primitives)
        && scene.primitives.remove(primitives)
      if (!wasRemoved && !primitives.isDestroyed()) primitives.destroy()
    },
  }
}
