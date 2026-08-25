// Donation shape — three/WebGPU layer.
//
// Four styles, because a 14 m parcel under a 74 m canopy is invisible from above
// in exactly one of them and unreadable from below in another:
//   column  footprint + translucent walls up through the canopy + a top rim
//   xray    footprint that shines through the trees (two passes, see below)
//   canopy  a plate resting on the crowns
//   wall    footprint + a low glowing wall
// and two forms: the authoritative staircase with its 1 m² cell grid, and the
// stylised organic ring. Geometry for both is built once at construction, so
// switching is visibility plus two scalars — no rebuild, no allocation.
//
// Everything under `root` is authored in local ENU metres relative to the parcel
// centroid; the root matrix carries the ENU->ECEF frame plus the ground-snap
// zOffset, exactly like marker-layer and field-model-layer.
import * as THREE from 'three'
import { MeshBasicNodeMaterial, PointsNodeMaterial } from 'three/webgpu'
import {
  Fn, abs, attribute, float, fract, instancedBufferAttribute, length, min, mix,
  positionLocal, pow, sin, smoothstep, uniform, uv, vec2, vec3, vec4,
} from 'three/tsl'
import { EXPERIENCE_CONFIG } from './config'
import { applyHighPrecisionAlways } from './point-cloud'
import {
  buildDonationShapeGeometry, buildOutlineRibbon, buildSegmentRibbon, buildWall,
  type DonationShapeForm, type DonationShapeGeometry, type DonationShapeSource,
  type DonationShapeStyle, type LonLatToLocal, type ShapeFill, type ShapeRibbon,
} from './donation-shape-data'

export interface GroundProbeResult {
  groundZ: number
  canopyZ: number
  samples: number
  support: number
}

export interface DonationShapeLayerOptions {
  /** ECEF-anchored parent — the floating-origin root, not the raw scene. */
  scene: THREE.Object3D
  overlay: HTMLElement
  /** ENU->ECEF, from the area manifest. */
  enuFrame: THREE.Matrix4
  /** Ground-snap lift the rest of the scene already carries. */
  zOffset: number
  source: DonationShapeSource
  /** lon/lat -> raw ENU x/y. Injected so the data module stays engine-free. */
  toLocal: LonLatToLocal
  /** Used until the point-cloud probe reports something better. */
  fallbackGroundZ: number
  canopyHeightM: number
  /** Statistical height probe over the resident tiles; null while too thin. */
  probe(centreEnu: THREE.Vector2, radiusM: number): GroundProbeResult | null
  reducedMotion: boolean
}

export interface DonationShapeInfo {
  groundZ: number
  canopyZ: number
  probeSettled: boolean
  style: DonationShapeStyle
  form: DonationShapeForm
  areaM2: number
  cellCount: number
  cellAreaM2: number
  gridSegmentCount: number
  rimSegmentCount: number
  gridExact: boolean
  group: string | null
}

export interface DonationShapeLayer {
  update(now: number, camera: THREE.PerspectiveCamera): void
  setStyle(style: DonationShapeStyle): void
  /** Re-measure the ground height. Only for a genuinely different point source
   * — the height is deliberately locked for the rest of the session. */
  resetGroundLock(): void
  setForm(form: DonationShapeForm): void
  setSmoothness(value: number): void
  setVisible(visible: boolean): void
  /** Parcel centroid at the current ground height, raw ENU. Null before ready. */
  flightTargetEnu(target?: THREE.Vector3): THREE.Vector3 | null
  groundCentreEnu(target?: THREE.Vector3): THREE.Vector3
  /** Bounding box of the active style, for framing the intro flight. */
  frameExtent(): { radiusM: number; heightM: number }
  info(): DonationShapeInfo
  dispose(): void
}

const worldPosition = new THREE.Vector3()
const viewPosition = new THREE.Vector3()
const projected = new THREE.Vector3()
const probeCentre = new THREE.Vector2()

function fillGeometry(fill: ShapeFill): THREE.BufferGeometry {
  const count = fill.positions.length / 2
  const positions = new Float32Array(count * 3)
  for (let index = 0; index < count; index += 1) {
    positions[index * 3] = fill.positions[index * 2]
    positions[index * 3 + 1] = fill.positions[index * 2 + 1]
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setIndex(new THREE.BufferAttribute(fill.indices, 1))
  geometry.computeBoundingSphere()
  return geometry
}

function ribbonGeometry(ribbon: ShapeRibbon): THREE.BufferGeometry {
  const count = ribbon.positions.length / 2
  const positions = new Float32Array(count * 3)
  for (let index = 0; index < count; index += 1) {
    positions[index * 3] = ribbon.positions[index * 2]
    positions[index * 3 + 1] = ribbon.positions[index * 2 + 1]
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('ribbonOffset', new THREE.BufferAttribute(ribbon.offsets, 2))
  geometry.setAttribute('arcU', new THREE.BufferAttribute(ribbon.arcU, 1))
  geometry.setAttribute('edgeD', new THREE.BufferAttribute(ribbon.edgeD, 1))
  geometry.setIndex(new THREE.BufferAttribute(ribbon.indices, 1))
  // Widened in the vertex stage, so the CPU bounds must allow for the widest
  // the uniform will ever push it.
  geometry.computeBoundingSphere()
  if (geometry.boundingSphere) geometry.boundingSphere.radius += 40
  return geometry
}

function wallGeometry(ring: Float32Array): THREE.BufferGeometry {
  const wall = buildWall(ring)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(wall.positions, 3))
  geometry.setAttribute('wallT', new THREE.BufferAttribute(wall.wallT, 1))
  geometry.setAttribute('arcU', new THREE.BufferAttribute(wall.arcU, 1))
  geometry.setIndex(new THREE.BufferAttribute(wall.indices, 1))
  geometry.computeBoundingSphere()
  return geometry
}

export function createDonationShapeLayer(options: DonationShapeLayerOptions): DonationShapeLayer {
  const config = EXPERIENCE_CONFIG.donationShape
  const colors = config.colors

  let data: DonationShapeGeometry = buildDonationShapeGeometry(options.source, options.toLocal, {
    cellSizeM: config.cellSizeM,
    smoothness: config.smoothness,
    sdfPixelM: config.sdfPixelM,
  })

  // ------------------------------------------------------------ scene graph
  const root = new THREE.Group()
  root.name = 'wilderness-donation-shape'
  root.matrixAutoUpdate = false
  root.matrix.copy(options.enuFrame).multiply(new THREE.Matrix4().makeTranslation(0, 0, options.zOffset))
  root.matrixWorldNeedsUpdate = true
  options.scene.add(root)

  const shapeRoot = new THREE.Group()
  shapeRoot.position.set(data.centroid[0], data.centroid[1], options.fallbackGroundZ)
  root.add(shapeRoot)

  // ------------------------------------------------------------ materials
  const shaderTime = uniform(0)
  // Reveal ramp: the parcel fades up instead of popping in, and every material
  // multiplies by it so one uniform drives the whole layer.
  const revealNode = uniform(0)
  const geometries: THREE.BufferGeometry[] = []

  const track = <T extends THREE.BufferGeometry>(value: T): T => { geometries.push(value); return value }

  // Typed loosely on purpose: attribute() widens its node type to `string`, so
  // the TSL operator overloads reject it — same reason rain-layer casts its
  // instanced attribute.
  const arcU: any = attribute('arcU', 'float')
  const edgeD: any = attribute('edgeD', 'float')
  const wallT: any = attribute('wallT', 'float')
  const ribbonOffset: any = attribute('ribbonOffset', 'vec2')
  // Half-widths in metres, recomputed every frame from the camera distance so a
  // line never drops below a readable pixel width. A fixed world width is what
  // made the rim and the 1 m² grid invisible from the navigation floor.
  const rimHalfWidth = uniform(config.rimWidthM * 0.5)
  const gridHalfWidth = uniform(config.gridWidthM * 0.5)
  const ribbonPosition = (halfWidth: any): any => {
    const centre: any = positionLocal
    return vec3(centre.xy.add(ribbonOffset.mul(halfWidth)) as any, centre.z)
  }

  /** Soft window travelling around the perimeter — the rim light run. */
  const sweep = (speed: number, width: number): any => {
    const phase = fract(arcU.sub(shaderTime.mul(speed)))
    const toBand = min(phase, float(1).sub(phase))
    return float(1).sub(smoothstep(float(0), float(width), toBand))
  }

  const flatBoost = uniform(1)
  const fillMaterial = new MeshBasicNodeMaterial()
  fillMaterial.transparent = true
  fillMaterial.depthWrite = false
  fillMaterial.side = THREE.DoubleSide
  fillMaterial.colorNode = vec3(...new THREE.Color(colors.fill).toArray())
  fillMaterial.opacityNode = float(colors.fillOpacity).mul(flatBoost).mul(revealNode)

  // The x-ray ghost is a *second* pass, never a single depth-less one: drawing
  // the footprint with depthTest off and normal alpha paints flat over the
  // canopy points instead of glowing through them.
  const ghostMaterial = new MeshBasicNodeMaterial()
  ghostMaterial.transparent = true
  ghostMaterial.depthTest = false
  ghostMaterial.depthWrite = false
  ghostMaterial.side = THREE.DoubleSide
  ghostMaterial.blending = THREE.AdditiveBlending
  ghostMaterial.colorNode = vec3(...new THREE.Color(colors.fill).toArray())
  ghostMaterial.opacityNode = Fn(() => {
    // Slow sonar ring outward from the centroid — no extra geometry, the
    // footprint's own local coordinates carry the radius.
    const radius = length(positionLocal.xy)
    const band = fract(radius.mul(0.09).sub(shaderTime.mul(0.11)))
    const pulse = float(1).sub(smoothstep(float(0), float(0.14), band))
    return float(colors.xrayGhostOpacity).mul(float(1).add(pulse.mul(1.6))).mul(revealNode)
  })()

  const rimMaterial = new MeshBasicNodeMaterial()
  rimMaterial.transparent = true
  rimMaterial.depthWrite = false
  rimMaterial.side = THREE.DoubleSide
  rimMaterial.blending = THREE.AdditiveBlending
  rimMaterial.positionNode = ribbonPosition(rimHalfWidth)
  rimMaterial.colorNode = vec3(...new THREE.Color(colors.rim).toArray())
  rimMaterial.opacityNode = Fn(() => {
    const halo = pow(float(1).sub(abs(edgeD)), float(1.6))
    return halo.mul(float(0.34).add(sweep(0.09, 0.16).mul(0.62)))
      .mul(colors.rimOpacity).mul(revealNode)
  })()

  const gridMaterial = new MeshBasicNodeMaterial()
  gridMaterial.transparent = true
  gridMaterial.depthWrite = false
  gridMaterial.side = THREE.DoubleSide
  gridMaterial.blending = THREE.AdditiveBlending
  gridMaterial.positionNode = ribbonPosition(gridHalfWidth)
  gridMaterial.colorNode = vec3(...new THREE.Color(colors.grid).toArray())
  gridMaterial.opacityNode = Fn(() => {
    const across = pow(float(1).sub(abs(edgeD)), float(1.2))
    return across.mul(colors.gridOpacity).mul(revealNode)
  })()

  const wallMaterial = new MeshBasicNodeMaterial()
  wallMaterial.transparent = true
  wallMaterial.depthWrite = false
  wallMaterial.side = THREE.DoubleSide
  wallMaterial.colorNode = vec3(...new THREE.Color(colors.wall).toArray())
  wallMaterial.opacityNode = Fn(() => {
    // Vertical alpha ramp: dense at the foot, fading to nothing at the top, so
    // the column reads as a volume of light rather than a wall of fog in front
    // of the canopy. pow() below 1 keeps the bright part low and the long tail
    // thin, which is what makes the falloff look continuous rather than linear.
    const vertical = mix(float(colors.wallBottomOpacity), float(colors.wallTopOpacity), pow(wallT, float(0.45)))
    // Bright band at the very base, so the column visibly stands on the parcel.
    const foot = float(1).sub(smoothstep(float(0), float(0.045), wallT))
    const breathe = float(0.88).add(sin(shaderTime.mul(1.4).sub(wallT.mul(5))).mul(0.12))
    const rise = float(1).add(sweep(0.06, 0.2).mul(0.55))
    return vertical.add(foot.mul(0.3)).mul(breathe).mul(rise).mul(revealNode)
  })()

  const materials = [fillMaterial, ghostMaterial, rimMaterial, gridMaterial, wallMaterial]
  // The parcel hangs off the same ECEF root as the point cloud. Without the
  // CPU-composed model-view matrix its vertices snap to the float32 grid at
  // ~6.4e6 m — half a metre, which is 3-4 px at the distance the parcel is
  // looked at from. Unlike the point cloud this is never a diagnostic A/B:
  // there is nothing to learn from a jittering outline.
  materials.forEach(applyHighPrecisionAlways)

  // ------------------------------------------------------------ geometry sets
  interface FormGeometry {
    fill: THREE.BufferGeometry
    rim: THREE.BufferGeometry
    wall: THREE.BufferGeometry
  }

  function buildFormGeometry(fill: ShapeFill, rings: Float32Array[]): FormGeometry {
    const rims = rings.map((ring) => ribbonGeometry(buildOutlineRibbon(ring)))
    const walls = rings.map((ring) => wallGeometry(ring))
    return {
      fill: track(fillGeometry(fill)),
      rim: track(mergeGeometries(rims)),
      wall: track(mergeGeometries(walls)),
    }
  }

  /** Small local merge — the shapes here are one ring in practice, and
   * BufferGeometryUtils is not otherwise pulled into this bundle. */
  function mergeGeometries(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
    if (list.length === 1) return list[0]
    const merged = new THREE.BufferGeometry()
    const names = new Set<string>()
    for (const geometry of list) for (const name of Object.keys(geometry.attributes)) names.add(name)
    let vertexTotal = 0
    let indexTotal = 0
    for (const geometry of list) {
      vertexTotal += geometry.attributes.position.count
      indexTotal += geometry.getIndex()?.count ?? 0
    }
    for (const name of names) {
      const itemSize = list[0].attributes[name].itemSize
      const array = new Float32Array(vertexTotal * itemSize)
      let offset = 0
      for (const geometry of list) {
        const attributeArray = geometry.attributes[name].array as Float32Array
        array.set(attributeArray, offset)
        offset += attributeArray.length
      }
      merged.setAttribute(name, new THREE.BufferAttribute(array, itemSize))
    }
    const indices = new Uint32Array(indexTotal)
    let indexOffset = 0
    let vertexOffset = 0
    for (const geometry of list) {
      const index = geometry.getIndex()
      if (index) {
        for (let position = 0; position < index.count; position += 1) {
          indices[indexOffset + position] = index.getX(position) + vertexOffset
        }
        indexOffset += index.count
      }
      vertexOffset += geometry.attributes.position.count
      geometry.dispose()
    }
    merged.setIndex(new THREE.BufferAttribute(indices, 1))
    merged.computeBoundingSphere()
    return merged
  }

  let exactGeometry = buildFormGeometry(data.fillExact, data.outlineExact)
  let organicGeometry = buildFormGeometry(data.fillOrganic, data.outlineOrganic)
  const gridGeometry = track(ribbonGeometry(buildSegmentRibbon(data.gridSegments)))

  // ------------------------------------------------------------ meshes
  const footprint = new THREE.Group()
  footprint.position.z = config.footprintLiftM
  shapeRoot.add(footprint)

  const fillMesh = new THREE.Mesh(exactGeometry.fill, fillMaterial)
  fillMesh.renderOrder = 10
  fillMesh.frustumCulled = false
  footprint.add(fillMesh)

  const ghostMesh = new THREE.Mesh(exactGeometry.fill, ghostMaterial)
  ghostMesh.renderOrder = 30
  ghostMesh.frustumCulled = false
  ghostMesh.visible = false
  footprint.add(ghostMesh)

  const gridMesh = new THREE.Mesh(gridGeometry, gridMaterial)
  gridMesh.position.z = 0.006
  gridMesh.renderOrder = 18
  gridMesh.frustumCulled = false
  footprint.add(gridMesh)

  const rimMesh = new THREE.Mesh(exactGeometry.rim, rimMaterial)
  rimMesh.position.z = 0.012
  rimMesh.renderOrder = 20
  rimMesh.frustumCulled = false
  footprint.add(rimMesh)

  // Built at unit height so one scale.z covers both the 4 m wall and the full
  // canopy column.
  const wallGroup = new THREE.Group()
  wallGroup.position.z = config.footprintLiftM
  shapeRoot.add(wallGroup)

  const wallMesh = new THREE.Mesh(exactGeometry.wall, wallMaterial)
  wallMesh.renderOrder = 12
  wallMesh.frustumCulled = false
  wallGroup.add(wallMesh)

  const topRimMesh = new THREE.Mesh(exactGeometry.rim, rimMaterial)
  topRimMesh.position.z = 1
  topRimMesh.renderOrder = 22
  topRimMesh.frustumCulled = false
  wallGroup.add(topRimMesh)

  // Canopy plate: same geometry, parked at the measured crown height.
  const cap = new THREE.Group()
  cap.visible = false
  shapeRoot.add(cap)

  const capFillMesh = new THREE.Mesh(exactGeometry.fill, fillMaterial)
  capFillMesh.renderOrder = 11
  capFillMesh.frustumCulled = false
  cap.add(capFillMesh)

  const capGridMesh = new THREE.Mesh(gridGeometry, gridMaterial)
  capGridMesh.position.z = 0.01
  capGridMesh.renderOrder = 19
  capGridMesh.frustumCulled = false
  cap.add(capGridMesh)

  const capRimMesh = new THREE.Mesh(exactGeometry.rim, rimMaterial)
  capRimMesh.position.z = 0.02
  capRimMesh.renderOrder = 21
  capRimMesh.frustumCulled = false
  cap.add(capRimMesh)

  // ------------------------------------------------------------ rising motes
  const moteCount = options.reducedMotion ? 0 : config.moteCount
  let motes: THREE.Sprite | null = null
  if (moteCount > 0) {
    const seeds = new Float32Array(moteCount * 4)
    let state = 0x574c4432
    const random = (): number => {
      state += 0x6d2b79f5
      let value = state
      value = Math.imul(value ^ (value >>> 15), value | 1)
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296
    }
    for (let index = 0; index < moteCount; index += 1) {
      // Rejection-sample inside the parcel so no mote rises outside the border.
      let x = 0
      let y = 0
      for (let attempt = 0; attempt < 24; attempt += 1) {
        x = data.bbox[0] + random() * (data.bbox[2] - data.bbox[0])
        y = data.bbox[1] + random() * (data.bbox[3] - data.bbox[1])
        if (pointInsideFill(data.fillExact, x, y)) break
      }
      seeds[index * 4] = x
      seeds[index * 4 + 1] = y
      seeds[index * 4 + 2] = 0.6 + random() * 0.8
      seeds[index * 4 + 3] = random()
    }
    const seedAttribute = new THREE.InstancedBufferAttribute(seeds, 4)
    const seed: any = instancedBufferAttribute(seedAttribute)
    const moteMaterial = new PointsNodeMaterial()
    applyHighPrecisionAlways(moteMaterial)
    moteMaterial.transparent = true
    moteMaterial.depthWrite = false
    moteMaterial.blending = THREE.AdditiveBlending
    const rise: any = fract(shaderTime.div(config.moteRiseSeconds).mul(seed.z).add(seed.w))
    moteMaterial.positionNode = vec3(seed.x, seed.y, rise.mul(config.canopyFallbackM))
    moteMaterial.scaleNode = vec2(float(0.28), float(0.28))
    moteMaterial.colorNode = Fn(() => {
      const disc: any = float(1).sub(smoothstep(float(0.16), float(0.5), length(uv().sub(0.5))))
      const fade: any = smoothstep(float(0), float(0.12), rise)
        .mul(float(1).sub(smoothstep(float(0.7), float(1), rise)))
      const moteColor = new THREE.Color(colors.mote)
      return vec4(vec3(moteColor.r, moteColor.g, moteColor.b), disc.mul(fade).mul(0.75).mul(revealNode))
    })()
    motes = new THREE.Sprite(moteMaterial)
    motes.count = moteCount
    motes.frustumCulled = false
    motes.renderOrder = 24
    motes.visible = false
    shapeRoot.add(motes)
    materials.push(moteMaterial as any)
  }

  function pointInsideFill(fill: ShapeFill, x: number, y: number): boolean {
    for (let index = 0; index < fill.indices.length; index += 3) {
      const a = fill.indices[index] * 2
      const b = fill.indices[index + 1] * 2
      const c = fill.indices[index + 2] * 2
      const ax = fill.positions[a]
      const ay = fill.positions[a + 1]
      const bx = fill.positions[b]
      const by = fill.positions[b + 1]
      const cx = fill.positions[c]
      const cy = fill.positions[c + 1]
      const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by)
      const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy)
      const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay)
      const negative = d1 < 0 || d2 < 0 || d3 < 0
      const positive = d1 > 0 || d2 > 0 || d3 > 0
      if (!(negative && positive)) return true
    }
    return false
  }

  // ------------------------------------------------------------ label chip
  const label = document.createElement('div')
  label.className = 'map-marker-label donation-shape-label'
  label.hidden = true
  const areaElement = document.createElement('span')
  areaElement.className = 'donation-shape-area'
  const groupElement = document.createElement('span')
  groupElement.className = 'donation-shape-group'
  label.append(areaElement, groupElement)
  options.overlay.append(label)

  const labelAnchor = new THREE.Object3D()
  shapeRoot.add(labelAnchor)

  function syncLabelText(): void {
    areaElement.textContent = `${Math.round(data.areaM2)} m²`
    const cells = data.gridExact ? ` · ${data.cellCount} × 1 m²` : ''
    groupElement.textContent = `${(options.source.group ?? 'geschützte Fläche').toUpperCase()}${cells}`
  }
  syncLabelText()
  let labelWidth = 0
  let labelHeight = 0
  let measuredViewportWidth = -1

  // ------------------------------------------------------------ state
  let style: DonationShapeStyle = config.defaultStyle
  let form: DonationShapeForm = config.defaultForm
  let smoothness: number = config.smoothness
  let visible = true
  let disposed = false

  let groundZ = options.fallbackGroundZ
  let canopyZ = options.fallbackGroundZ + options.canopyHeightM
  let targetGroundZ = groundZ
  let targetCanopyZ = canopyZ
  let lastProbe = -Infinity
  let firstProbeAt = -Infinity
  /** Accepted probes, kept until the height locks. The percentile is taken over
   * whichever tiles happen to be resident, so it shifts as the camera moves and
   * streaming refines — a running median over several probes is stable where a
   * single one is not. */
  const groundSamples: number[] = []
  const canopySamples: number[] = []
  let settled = config.groundZOverrideM !== null
  let lastFrame = -Infinity
  let revealStart = -Infinity
  if (config.groundZOverrideM !== null) {
    groundZ = config.groundZOverrideM
    targetGroundZ = groundZ
    canopyZ = groundZ + options.canopyHeightM
    targetCanopyZ = canopyZ
  }

  function currentGeometry(): FormGeometry {
    return form === 'exact' ? exactGeometry : organicGeometry
  }

  function applyGeometry(): void {
    const set = currentGeometry()
    fillMesh.geometry = set.fill
    ghostMesh.geometry = set.fill
    capFillMesh.geometry = set.fill
    rimMesh.geometry = set.rim
    topRimMesh.geometry = set.rim
    capRimMesh.geometry = set.rim
    wallMesh.geometry = set.wall
    gridMesh.visible = form === 'exact'
    capGridMesh.visible = form === 'exact'
  }

  function applyStyle(): void {
    const column = style === 'column'
    const wall = style === 'wall'
    const xray = style === 'xray'
    const canopy = style === 'canopy'

    footprint.visible = !canopy
    ghostMesh.visible = xray
    for (const material of [fillMaterial, rimMaterial, gridMaterial]) {
      if (material.depthTest === !xray) continue
      material.depthTest = !xray
      material.needsUpdate = true
    }
    flatBoost.value = column || wall ? 1 : config.flatFillBoost
    const depthlessOrder = xray ? 9_000 : 0
    fillMesh.renderOrder = 10 + depthlessOrder
    gridMesh.renderOrder = 18 + depthlessOrder
    rimMesh.renderOrder = 20 + depthlessOrder
    cap.visible = canopy
    wallGroup.visible = column || wall
    if (motes) motes.visible = column
    // The 1 m² lattice belongs to the exact form in every style — it is the
    // whole point of that form, so it is never distance- or style-gated.
    gridMesh.visible = form === 'exact'
    capGridMesh.visible = form === 'exact'

    // The footprint is depth-tested in every style; only the ghost pass ignores
    // depth, so the point cloud in front still reads.
    // The column's height is a fixed product value, not the measured canopy: it
    // has to tower over the 74 m crowns to be readable from the navigation
    // floor, and it must not shrink to nothing while the ground probe is still
    // waiting for tiles.
    const canopyDepth = Math.max(0, canopyZ - groundZ)
    const wallHeight = Math.max(config.wallHeightM, canopyDepth + config.wallCanopyClearanceM)
    const height = column ? config.columnHeightM : wallHeight
    wallGroup.scale.z = height
    cap.position.z = canopyDepth
    labelAnchor.position.z = (canopy ? canopyDepth : column ? height * 0.62 : wallHeight)
      + config.labelLiftM
  }

  applyGeometry()
  applyStyle()

  function rebuildOrganic(): void {
    data = buildDonationShapeGeometry(options.source, options.toLocal, {
      cellSizeM: config.cellSizeM,
      smoothness,
      sdfPixelM: config.sdfPixelM,
    })
    const previous = organicGeometry
    organicGeometry = buildFormGeometry(data.fillOrganic, data.outlineOrganic)
    for (const geometry of [previous.fill, previous.rim, previous.wall]) {
      const slot = geometries.indexOf(geometry)
      if (slot >= 0) geometries.splice(slot, 1)
      geometry.dispose()
    }
    applyGeometry()
    syncLabelText()
  }

  function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b)
    const middle = sorted.length >> 1
    return sorted.length % 2 === 1
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) * 0.5
  }

  function runProbe(now: number): void {
    if (settled || now - lastProbe < config.probeIntervalMs) return
    lastProbe = now
    probeCentre.set(data.centroid[0], data.centroid[1])
    const sample = options.probe(probeCentre, config.probeRadiusM)
    if (!sample) return
    if (sample.support < config.probeSupportCells) return
    if (Math.abs(sample.groundZ - options.fallbackGroundZ) > config.probeMaxDeviationM) {
      console.warn(
        `[donation-shape] probe rejected: ground ${sample.groundZ.toFixed(1)} m is `
        + `${Math.round(Math.abs(sample.groundZ - options.fallbackGroundZ))} m off the manifest floor `
        + `${options.fallbackGroundZ.toFixed(1)} m`,
      )
      return
    }
    if (firstProbeAt === -Infinity) firstProbeAt = now

    groundSamples.push(sample.groundZ)
    canopySamples.push(sample.canopyZ)
    targetGroundZ = median(groundSamples)
    targetCanopyZ = Math.max(median(canopySamples), targetGroundZ + 6)
    console.info(
      `[donation-shape] ground ${sample.groundZ.toFixed(1)} m · canopy ${sample.canopyZ.toFixed(1)} m`
      + ` · ${sample.samples} samples · support ${sample.support}/25`
      + ` · median ${targetGroundZ.toFixed(2)} m (${groundSamples.length}/${config.probeLockSamples})`,
    )

    // Lock once the median rests on enough agreeing probes. After the lock the
    // parcel never moves vertically again: a height that keeps following the
    // resident tile set slides visibly under the camera, which reads as the
    // whole overlay bobbing up and down.
    const spread = groundSamples.length > 1
      ? Math.max(...groundSamples) - Math.min(...groundSamples)
      : Infinity
    const timedOut = now - firstProbeAt > config.probeTimeoutMs
    if ((groundSamples.length >= config.probeLockSamples && spread <= config.probeLockSpreadM) || timedOut) {
      settled = true
      console.info(
        `[donation-shape] ground locked at ${targetGroundZ.toFixed(2)} m`
        + ` (${groundSamples.length} probes, spread ${Number.isFinite(spread) ? spread.toFixed(2) : '—'} m`
        + `${timedOut ? ', timeout' : ''})`,
      )
    }
  }

  function updateLabel(camera: THREE.PerspectiveCamera): void {
    if (!visible) { if (!label.hidden) label.hidden = true; return }
    if (measuredViewportWidth !== window.innerWidth || labelWidth === 0) {
      label.hidden = false
      labelWidth = label.offsetWidth
      labelHeight = label.offsetHeight
      measuredViewportWidth = window.innerWidth
    }
    labelAnchor.getWorldPosition(worldPosition)
    viewPosition.copy(worldPosition).applyMatrix4(camera.matrixWorldInverse)
    projected.copy(worldPosition).project(camera)
    const onScreen = viewPosition.z < 0
      && projected.z > -1 && projected.z < 1
      && Math.abs(projected.x) < 1.1 && Math.abs(projected.y) < 1.1
    if (label.hidden !== !onScreen) label.hidden = !onScreen
    if (!onScreen) return
    const half = labelWidth * 0.5
    const x = THREE.MathUtils.clamp(
      (projected.x * 0.5 + 0.5) * window.innerWidth, half + 7, window.innerWidth - half - 7,
    )
    const y = THREE.MathUtils.clamp(
      (-projected.y * 0.5 + 0.5) * window.innerHeight, labelHeight + 7, window.innerHeight - 7,
    )
    const transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`
    if (label.style.transform !== transform) label.style.transform = transform
  }

  return {
    update(now, camera) {
      if (disposed || !visible) return
      const elapsed = lastFrame === -Infinity ? 16 : Math.min(64, Math.max(0, now - lastFrame))
      lastFrame = now
      shaderTime.value = now * 0.001
      if (revealStart === -Infinity) revealStart = now
      const revealMs = options.reducedMotion ? 1 : 900
      revealNode.value = Math.min(1, (now - revealStart) / revealMs)

      // One metre of the parcel, in metres per screen pixel at its distance.
      shapeRoot.getWorldPosition(worldPosition)
      const range = Math.max(1, camera.position.distanceTo(worldPosition))
      const metresPerPixel = (2 * range * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5))
        / Math.max(1, window.innerHeight)
      rimHalfWidth.value = Math.max(config.rimWidthM, config.rimMinPx * metresPerPixel) * 0.5
      gridHalfWidth.value = Math.max(config.gridWidthM, config.gridMinPx * metresPerPixel) * 0.5

      runProbe(now)
      // Exponential follow rather than assignment: tiles stream in, and the
      // parcel must not pop while they do.
      const blend = 1 - Math.exp(-elapsed / config.probeSmoothingMs)
      groundZ += (targetGroundZ - groundZ) * blend
      canopyZ += (targetCanopyZ - canopyZ) * blend
      shapeRoot.position.z = groundZ
      applyStyle()

      root.updateMatrixWorld(true)
      updateLabel(camera)
    },
    setStyle(next) {
      if (next === style) return
      style = next
      applyStyle()
    },
    resetGroundLock() {
      if (config.groundZOverrideM !== null) return
      groundSamples.length = 0
      canopySamples.length = 0
      settled = false
      firstProbeAt = -Infinity
      lastProbe = -Infinity
    },
    setForm(next) {
      if (next === form) return
      form = next
      applyGeometry()
      applyStyle()
    },
    setSmoothness(value) {
      const clamped = Math.max(0, Math.min(1, value))
      if (Math.abs(clamped - smoothness) < 1e-4) return
      smoothness = clamped
      rebuildOrganic()
    },
    setVisible(next) {
      if (next && !visible) revealStart = -Infinity
      visible = next
      root.visible = next
      if (!next) label.hidden = true
    },
    flightTargetEnu(target = new THREE.Vector3()) {
      // Part way up the volume, not the footprint: the camera has to look at the
      // middle of the column or the column leaves the frame upwards.
      const canopyDepth = Math.max(0, canopyZ - groundZ)
      const height = style === 'column'
        ? config.columnHeightM
        : style === 'wall' ? Math.max(config.wallHeightM, canopyDepth + config.wallCanopyClearanceM)
          : canopyDepth
      return target.set(
        data.centroid[0], data.centroid[1], groundZ + height * config.lookHeightFraction,
      )
    },
    /** Footprint centroid on the measured ground — the parcel itself. */
    groundCentreEnu(target = new THREE.Vector3()) {
      return target.set(data.centroid[0], data.centroid[1], groundZ)
    },
    frameExtent() {
      const radiusM = Math.max(
        Math.hypot(data.bbox[0], data.bbox[1]),
        Math.hypot(data.bbox[2], data.bbox[3]),
        Math.hypot(data.bbox[0], data.bbox[3]),
        Math.hypot(data.bbox[2], data.bbox[1]),
      )
      const canopyDepth = Math.max(0, canopyZ - groundZ)
      const heightM = style === 'column'
        ? config.columnHeightM
        : style === 'wall' ? Math.max(config.wallHeightM, canopyDepth + config.wallCanopyClearanceM)
          : style === 'canopy' ? Math.max(config.wallHeightM, canopyDepth)
            : Math.max(2 * radiusM, canopyDepth)
      return { radiusM, heightM }
    },
    info() {
      return {
        groundZ,
        canopyZ,
        probeSettled: settled,
        style,
        form,
        areaM2: data.areaM2,
        cellCount: data.cellCount,
        cellAreaM2: data.cellAreaM2,
        gridSegmentCount: data.gridSegmentCount,
        rimSegmentCount: data.rimSegmentCount,
        gridExact: data.gridExact,
        group: options.source.group,
      }
    },
    dispose() {
      disposed = true
      options.scene.remove(root)
      label.remove()
      for (const geometry of geometries) geometry.dispose()
      for (const material of materials) material.dispose()
    },
  }
}
