import * as THREE from 'three'
import { Line2NodeMaterial } from 'three/webgpu'
import { LineSegments2 } from 'three/addons/lines/webgpu/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { applyHighPrecisionAlways } from './point-cloud'
import { clusterByDistance, type LabelAnchor } from './science-geometry'
import type { Position } from './science-data-format'

/**
 * WI's protected areas and trails on the globe (the science data, science-data-format.ts),
 * as lines with name chips.
 *
 * The vertices sit on the WGS84 ellipsoid, where the basemap is draped, in ECEF under the
 * floating-origin root. That places Peru and British Columbia with the same code; the
 * survey's ENU frame could not, because it is a tangent plane at one Peru point and leaves
 * the globe by d²/2R (8 m at 10 km, 785 m at 100 km).
 *
 * The lines ignore depth and draw after the scene, like ink on a map seen through the
 * canopy. The cloud is lowered onto the map, but its forest floor still sits 4–30 m above
 * it, and there is no ground model yet to put a trail on that floor: a depth-tested line
 * would vanish under the points exactly where the trails matter. Until the preparation
 * step adds ground heights, that gap shows as parallax when the camera tilts.
 *
 * Opaque on purpose: a transparent Line2NodeMaterial blends against
 * viewportOpaqueMipTexture(), which costs a copy of the opaque pass every frame. One draw
 * call per cluster: features within `clusterRadiusM` of each other share one segment
 * geometry around one anchor, so the float32 offsets stay at millimetres.
 */
export interface EcefEllipsoid {
  getCartographicToPosition(lat: number, lon: number, height: number, target: THREE.Vector3): THREE.Vector3
}

export interface LabelBox {
  left: number
  right: number
  top: number
  bottom: number
}

export interface ScienceLineStyle {
  color: number
  widthPx: number
  heightM: number
  labelMaxDistanceM: number
  renderOrder: number
}

export interface ScienceLineLayerOptions {
  name: string
  /** The floating-origin ECEF root. */
  scene: THREE.Object3D
  overlay: HTMLElement
  ellipsoid: EcefEllipsoid
  /** Each feature's paths in lon/lat: rings closed by repeating their first point, or open lines. */
  features: Position[][][]
  labels: LabelAnchor[]
  labelClass: string
  clusterRadiusM: number
  style: ScienceLineStyle
}

export interface ScienceLineLayer {
  setVisible(visible: boolean): void
  /**
   * Places this layer's chips, nearest first. `taken` holds the boxes earlier layers placed
   * this frame; this layer adds its own, so the second layer gives way to the first.
   */
  update(camera: THREE.Camera, taken: LabelBox[]): void
  count(): number
  dispose(): void
}

const LABEL_GAP_PX = 6
const DEG = Math.PI / 180

interface LabelRecord {
  element: HTMLElement
  ecef: THREE.Vector3
  world: THREE.Vector3
  distance: number
  width: number
  height: number
  /** What the chip shows now; the DOM is only written when this changes. */
  shownHidden: boolean
  shownTransform: string
}

function showLabel(label: LabelRecord, hidden: boolean, transform = ''): void {
  if (hidden !== label.shownHidden) {
    label.element.hidden = hidden
    label.shownHidden = hidden
  }
  if (!hidden && transform !== label.shownTransform) {
    label.element.style.transform = transform
    label.shownTransform = transform
  }
}

function centreOf(paths: Position[][]): Position {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity
  for (const path of paths) {
    for (const [lon, lat] of path) {
      if (lon < w) w = lon
      if (lon > e) e = lon
      if (lat < s) s = lat
      if (lat > n) n = lat
    }
  }
  return [(w + e) / 2, (s + n) / 2]
}

export function createScienceLineLayer(options: ScienceLineLayerOptions): ScienceLineLayer {
  const { scene, overlay, ellipsoid, style } = options
  const toEcef = (p: Position, out: THREE.Vector3) =>
    ellipsoid.getCartographicToPosition(p[1] * DEG, p[0] * DEG, style.heightM, out)

  const root = new THREE.Group()
  root.name = options.name
  scene.add(root)

  const material = new Line2NodeMaterial({ linewidth: style.widthPx, worldUnits: false })
  // On the ECEF root the lines jitter unless the model-view matrix is composed on the CPU.
  applyHighPrecisionAlways(material)
  material.color.setHex(style.color)
  material.depthTest = false
  material.depthWrite = false
  // A map annotation stays legible at distance; the haze would fade it with the map.
  material.userData.noHaze = true

  const geometries: LineSegmentsGeometry[] = []
  const anchor = new THREE.Vector3()
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const features = options.features.filter(paths => paths.some(path => path.length >= 2))
  for (const cluster of clusterByDistance(features, centreOf, options.clusterRadiusM)) {
    toEcef(centreOf(cluster[0]), anchor)
    const segments: number[] = []
    for (const paths of cluster) {
      for (const path of paths) {
        toEcef(path[0], a).sub(anchor)
        for (let i = 1; i < path.length; i++) {
          toEcef(path[i], b).sub(anchor)
          segments.push(a.x, a.y, a.z, b.x, b.y, b.z)
          a.copy(b)
        }
      }
    }
    const geometry = new LineSegmentsGeometry().setPositions(segments)
    geometries.push(geometry)
    const lines = new LineSegments2(geometry, material)
    lines.position.copy(anchor)
    lines.renderOrder = style.renderOrder
    root.add(lines)
  }

  const labels: LabelRecord[] = options.labels.map((label) => {
    const element = document.createElement('div')
    element.className = `map-marker-label science-label ${options.labelClass}`
    element.textContent = label.text
    element.hidden = true
    overlay.append(element)
    return {
      element, ecef: toEcef([label.lon, label.lat], new THREE.Vector3()), world: new THREE.Vector3(),
      distance: 0, width: 0, height: 0, shownHidden: true, shownTransform: '',
    }
  })
  const byDistance = [...labels]

  const cameraWorld = new THREE.Vector3()
  const view = new THREE.Vector3()
  const projected = new THREE.Vector3()
  let visible = true
  let measured = false

  function hideLabels(): void {
    for (const label of labels) showLabel(label, true)
  }

  return {
    setVisible(next) {
      visible = next
      root.visible = next
      if (!next) hideLabels()
    },
    update(camera, taken) {
      if (!visible) return
      if (!measured) {
        // Once, all writes before all reads, so the measuring costs one layout.
        for (const label of labels) label.element.hidden = false
        for (const label of labels) {
          label.width = label.element.offsetWidth
          label.height = label.element.offsetHeight
        }
        for (const label of labels) label.element.hidden = true
        for (const label of labels) label.shownHidden = true
        // A chip measured while the overlay is hidden reads 0 × 0; try again next frame.
        measured = labels.length === 0 || labels.some(label => label.width > 0)
      }
      camera.getWorldPosition(cameraWorld)
      for (const label of labels) {
        label.world.copy(label.ecef).applyMatrix4(scene.matrixWorld)
        label.distance = label.world.distanceTo(cameraWorld)
      }
      byDistance.sort((p, q) => p.distance - q.distance)
      for (const label of byDistance) {
        if (label.distance > style.labelMaxDistanceM) { showLabel(label, true); continue }
        view.copy(label.world).applyMatrix4(camera.matrixWorldInverse)
        projected.copy(label.world).project(camera)
        if (view.z >= 0 || Math.abs(projected.x) > 1.05 || Math.abs(projected.y) > 1.05 || projected.z >= 1) {
          showLabel(label, true)
          continue
        }
        const x = (projected.x * 0.5 + 0.5) * window.innerWidth
        const y = (-projected.y * 0.5 + 0.5) * window.innerHeight
        const box = {
          left: x - label.width / 2, right: x + label.width / 2,
          top: y - label.height / 2, bottom: y + label.height / 2,
        }
        const collides = taken.some(other => box.left < other.right + LABEL_GAP_PX
          && box.right > other.left - LABEL_GAP_PX
          && box.top < other.bottom + LABEL_GAP_PX
          && box.bottom > other.top - LABEL_GAP_PX)
        if (collides) { showLabel(label, true); continue }
        taken.push(box)
        showLabel(label, false, `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%)`)
      }
    },
    count: () => features.length,
    dispose() {
      for (const label of labels) label.element.remove()
      scene.remove(root)
      for (const geometry of geometries) geometry.dispose()
      material.dispose()
    },
  }
}
