// Donation shape — CesiumJS primitive layer.
//
// Port of src/threejs-test/donation-shape-layer.ts. The product rationale is
// unchanged and documented there: four styles, because a 14 m parcel under a
// 74 m canopy is invisible from above in exactly one of them and unreadable
// from below in another —
//   column  footprint + a translucent 200 m volume of light + a top rim
//   xray    footprint that stops depth-testing and shines through the trees
//   canopy  the same footprint parked on the measured crowns
//   wall    footprint + a wall sized to clear the canopy
// and two forms: the authoritative staircase with its 1 m² cell grid, and the
// stylised organic ring.
//
// Engine deltas that shape this file:
//   * Primitive-level API only. This app uses none of Cesium's entity or
//     data-source machinery anywhere, so the plates and walls are hand-built
//     Cesium.Geometry in the style of marker-layer's ring geometry.
//   * Every outline is a Cesium.PolylineGeometry, not a triangle ribbon. Line
//     width has to be locked to screen pixels: the rim's 0.16 m is 0.8 px and
//     the 1 m² grid's 0.035 m is 0.17 px at the distance the intro flight ends
//     at, i.e. invisible. Three.js solves this with a width uniform applied to
//     the ribbon's unit `offsets` attribute in the vertex stage; Cesium's
//     polyline width is already in pixels, so the pixel floors from config go
//     straight in and the world widths are not used at all.
//   * No custom shader. The viewer runs with logarithmicDepthBuffer = true, so
//     staying on the built-in Primitive / PerInstanceColorAppearance /
//     PolylineColorAppearance path is a hard requirement — nothing here may
//     write gl_FragDepth. The three.js TSL effects therefore become
//     per-instance colour writes: the wall's vertical alpha ramp is a stack of
//     horizontal bands, each its own GeometryInstance, and the reveal fade is a
//     shared alpha scale.
//   * Depth testing is a property of an Appearance, fixed once a Primitive is
//     built, so x-ray is a second set of primitives rather than a material flag.
//     Both forms are likewise built up front and switched by Primitive#show.
//
// All geometry is authored in local ENU metres relative to the parcel centroid;
// the per-frame modelMatrix carries the ENU→ECEF frame plus the measured ground
// height, exactly like marker-layer and field-model-layer.
import * as Cesium from 'cesium'
import { EXPERIENCE_CONFIG } from './config'
import type { EnuFrame } from './enu'
import {
  buildDonationShapeGeometry,
  type DonationShapeForm, type DonationShapeGeometry, type DonationShapeSource,
  type DonationShapeStyle, type LonLatToLocal, type ShapeFill,
} from './donation-shape-data'

export interface GroundProbeResult {
  groundZ: number
  canopyZ: number
  samples: number
  support: number
}

export interface DonationShapeLayerOptions {
  scene: Cesium.Scene
  overlay: HTMLElement
  /** ENU↔ECEF frame of the survey, from the area manifest. */
  enuFrame: EnuFrame
  source: DonationShapeSource
  /** lon/lat -> raw ENU x/y. Injected so the data module stays engine-free. */
  toLocal: LonLatToLocal
  /** Used until the depth probe reports something better. */
  fallbackGroundZ: number
  canopyHeightM: number
  /** Statistical height probe over the resident tiles; null while too thin. */
  probe(centreEnu: Cesium.Cartesian2, radiusM: number): GroundProbeResult | null
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
  /** Cesium reads scene.camera itself, so unlike the three.js twin this takes
   * no camera argument. */
  update(now: number): void
  setStyle(style: DonationShapeStyle): void
  setForm(form: DonationShapeForm): void
  setSmoothness(value: number): void
  setVisible(visible: boolean): void
  /** Part way up the active volume — the camera has to look at the middle of a
   * 200 m column or the column leaves the frame upwards. */
  flightTargetEnu(result?: Cesium.Cartesian3): Cesium.Cartesian3
  /** Footprint centroid on the measured ground — the parcel itself. */
  groundCentreEnu(result?: Cesium.Cartesian3): Cesium.Cartesian3
  /** Bounding box of the active style, for framing the intro flight. */
  frameExtent(): { radiusM: number; heightM: number }
  info(): DonationShapeInfo
  dispose(): void
}

/** Stacked bands standing in for the three.js vertical alpha gradient. Ten is
 * the point where the steps stop reading as steps at flight distance. */
const WALL_BAND_COUNT = 10
/** Sub-samples per band when integrating the three.js opacity curve. */
const BAND_SAMPLES = 8

type PartKind = 'footprint' | 'wall' | 'wallTop'

interface ShapePart {
  primitive: Cesium.Primitive
  kind: PartKind
  /** Static lift within the part's local frame (z-fighting separation). */
  zOffset: number
  instanceIds: string[]
  baseColor: number
  baseAlphas: number[]
  /** Style-dependent multiplier — flatFillBoost on the fills. */
  alphaScale: number
  appliedAlphas: number[]
  /** Band centre 0..1, for the wall's travelling breathe. */
  bandT: number[]
  breathes: boolean
}

interface FormParts {
  fill: ShapePart
  rim: ShapePart
  xrayFill: ShapePart
  xrayRim: ShapePart
  wall: ShapePart
  topRim: ShapePart
  parts: ShapePart[]
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) return value < edge0 ? 0 : 1
  const amount = Cesium.Math.clamp((value - edge0) / (edge1 - edge0), 0, 1)
  return amount * amount * (3 - 2 * amount)
}

function geometryFrom(
  values: Float64Array,
  indices: Uint32Array,
  radius: number,
): Cesium.Geometry {
  const attributes = new Cesium.GeometryAttributes()
  attributes.position = new Cesium.GeometryAttribute({
    componentDatatype: Cesium.ComponentDatatype.DOUBLE,
    componentsPerAttribute: 3,
    values,
  })
  return new Cesium.Geometry({
    attributes,
    indices,
    primitiveType: Cesium.PrimitiveType.TRIANGLES,
    boundingSphere: new Cesium.BoundingSphere(Cesium.Cartesian3.ZERO, Math.max(1, radius)),
  })
}

/** Triangulated fill (flat xy pairs + indices) -> a z = 0 plate. */
function fillGeometry(fill: ShapeFill): Cesium.Geometry {
  const count = fill.positions.length / 2
  const values = new Float64Array(count * 3)
  let radius = 0
  for (let index = 0; index < count; index += 1) {
    const x = fill.positions[index * 2]
    const y = fill.positions[index * 2 + 1]
    values[index * 3] = x
    values[index * 3 + 1] = y
    radius = Math.max(radius, Math.hypot(x, y))
  }
  return geometryFrom(values, Uint32Array.from(fill.indices), radius)
}

/**
 * One horizontal slice of the wall, standing on `ring` between `bottom` and
 * `top` in unit-height space, so a single scale.z covers both the low wall and
 * the 200 m column.
 */
function wallBandGeometry(ring: Float32Array, bottom: number, top: number): Cesium.Geometry {
  const count = ring.length / 2
  const values = new Float64Array(count * 2 * 3)
  const indices = new Uint32Array(count * 6)
  let radius = 0
  for (let index = 0; index < count; index += 1) {
    const x = ring[index * 2]
    const y = ring[index * 2 + 1]
    const base = index * 6
    values[base] = x
    values[base + 1] = y
    values[base + 2] = bottom
    values[base + 3] = x
    values[base + 4] = y
    values[base + 5] = top
    radius = Math.max(radius, Math.hypot(x, y))

    const next = (index + 1) % count
    const a = index * 2
    const b = index * 2 + 1
    const c = next * 2
    const d = next * 2 + 1
    indices[base] = a
    indices[base + 1] = c
    indices[base + 2] = d
    indices[base + 3] = a
    indices[base + 4] = d
    indices[base + 5] = b
  }
  return geometryFrom(values, indices, radius)
}

/** Closed ring (flat xy, first vertex not repeated) -> one pixel-wide polyline. */
function ringPolyline(ring: Float32Array, widthPx: number): Cesium.PolylineGeometry | null {
  const count = ring.length / 2
  if (count < 2) return null
  const positions: Cesium.Cartesian3[] = []
  for (let index = 0; index <= count; index += 1) {
    const at = (index % count) * 2
    positions.push(new Cesium.Cartesian3(ring[at], ring[at + 1], 0))
  }
  return new Cesium.PolylineGeometry({
    positions,
    width: widthPx,
    // NONE keeps the vertices where they were authored. The default GEODESIC
    // would read them as ECEF and subdivide them along the ellipsoid.
    arcType: Cesium.ArcType.NONE,
    vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT,
  })
}

/** The 1 m² lattice: independent x0,y0,x1,y1 segments, one polyline each. */
function segmentPolylines(segments: Float32Array, widthPx: number): Cesium.PolylineGeometry[] {
  const out: Cesium.PolylineGeometry[] = []
  for (let index = 0; index + 3 < segments.length; index += 4) {
    const x0 = segments[index]
    const y0 = segments[index + 1]
    const x1 = segments[index + 2]
    const y1 = segments[index + 3]
    if (Math.hypot(x1 - x0, y1 - y0) < 1e-4) continue
    out.push(new Cesium.PolylineGeometry({
      positions: [new Cesium.Cartesian3(x0, y0, 0), new Cesium.Cartesian3(x1, y1, 0)],
      width: widthPx,
      arcType: Cesium.ArcType.NONE,
      vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT,
    }))
  }
  return out
}

/**
 * Mean opacity of the three.js wall shader over one band.
 *
 * The three version mixes bottom→top opacity by pow(t, 0.45) — below 1 so the
 * bright part stays low and the long tail stays thin, which is what makes the
 * falloff look continuous rather than linear — and adds a bright foot at the
 * very base so the column visibly stands on the parcel. Integrating instead of
 * point-sampling keeps the ten-band staircase faithful to that curve.
 */
function bandOpacity(bottom: number, top: number): number {
  const colors = EXPERIENCE_CONFIG.donationShape.colors
  let total = 0
  for (let index = 0; index < BAND_SAMPLES; index += 1) {
    const t = bottom + ((index + 0.5) / BAND_SAMPLES) * (top - bottom)
    const vertical = colors.wallBottomOpacity
      + (colors.wallTopOpacity - colors.wallBottomOpacity) * Math.pow(t, 0.45)
    const foot = 1 - smoothstep(0, 0.045, t)
    total += vertical + foot * 0.3
  }
  return total / BAND_SAMPLES
}

export function createDonationShapeLayer(options: DonationShapeLayerOptions): DonationShapeLayer {
  const config = EXPERIENCE_CONFIG.donationShape
  const colors = config.colors
  const { scene, enuFrame } = options

  let data: DonationShapeGeometry = buildDonationShapeGeometry(options.source, options.toLocal, {
    cellSizeM: config.cellSizeM,
    smoothness: config.smoothness,
    sdfPixelM: config.sdfPixelM,
  })

  // ------------------------------------------------------------ collections
  // Two roots so the depth-less x-ray pass is always submitted after everything
  // else this layer draws.
  const opaqueCollection = scene.primitives.add(new Cesium.PrimitiveCollection()) as Cesium.PrimitiveCollection
  const ghostCollection = scene.primitives.add(new Cesium.PrimitiveCollection()) as Cesium.PrimitiveCollection

  /** Depth testing off, depth writes off — the x-ray pass. Note that
   * Appearance#getRenderState pins ALPHA_BLEND for any translucent appearance,
   * so this is an alpha pass where three.js additionally blends additively. */
  const depthlessRenderState = (): object => (Cesium.Appearance as unknown as {
    getDefaultRenderState(translucent: boolean, closed: boolean, additional?: object): object
  }).getDefaultRenderState(true, false, {
    depthTest: { enabled: false },
    depthMask: false,
  })

  const surfaceAppearance = (depthless: boolean) => new Cesium.PerInstanceColorAppearance({
    flat: true,
    translucent: true,
    closed: false,
    ...(depthless ? { renderState: depthlessRenderState() } : {}),
  })
  const lineAppearance = (depthless: boolean) => new Cesium.PolylineColorAppearance({
    translucent: true,
    ...(depthless ? { renderState: depthlessRenderState() } : {}),
  })

  let nextPartId = 0
  const scratchColor = new Cesium.Color()

  function colorFromHex(hex: number, alpha: number, result: Cesium.Color): Cesium.Color {
    return Cesium.Color.fromBytes(
      (hex >> 16) & 0xff,
      (hex >> 8) & 0xff,
      hex & 0xff,
      Math.round(Cesium.Math.clamp(alpha, 0, 1) * 255),
      result,
    )
  }

  function createPart(spec: {
    geometries: Array<Cesium.Geometry | Cesium.PolylineGeometry>
    alphas: number[]
    bandT?: number[]
    kind: PartKind
    zOffset?: number
    color: number
    depthless?: boolean
    line?: boolean
    breathes?: boolean
  }): ShapePart {
    const instanceIds: string[] = []
    const instances = spec.geometries.map((geometry, index) => {
      const id = `donation-shape-${nextPartId++}`
      instanceIds.push(id)
      return new Cesium.GeometryInstance({
        geometry,
        id,
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(
            colorFromHex(spec.color, spec.alphas[index], new Cesium.Color()),
          ),
        },
      })
    })
    const collection = spec.depthless ? ghostCollection : opaqueCollection
    const primitive = collection.add(new Cesium.Primitive({
      geometryInstances: instances,
      appearance: spec.line
        ? lineAppearance(Boolean(spec.depthless))
        : surfaceAppearance(Boolean(spec.depthless)),
      // Identity here on purpose: with scene3DOnly the primitive's modelMatrix
      // stays live and is multiplied per frame, so the geometry keeps its small
      // local-metre coordinates (and their precision).
      modelMatrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY),
      asynchronous: false,
      allowPicking: false,
      releaseGeometryInstances: true,
      shadows: Cesium.ShadowMode.DISABLED,
    })) as Cesium.Primitive
    primitive.show = false
    return {
      primitive,
      kind: spec.kind,
      zOffset: spec.zOffset ?? 0,
      instanceIds,
      baseColor: spec.color,
      baseAlphas: spec.alphas.slice(),
      alphaScale: 1,
      appliedAlphas: spec.alphas.map(() => -1),
      bandT: spec.bandT ?? spec.alphas.map(() => 0),
      breathes: Boolean(spec.breathes) && !options.reducedMotion,
    }
  }

  function buildFormParts(fill: ShapeFill, rings: Float32Array[]): FormParts {
    // A fresh set per primitive: Primitive consumes and releases its instances,
    // so the three rim passes must not share PolylineGeometry descriptions.
    const rimLines = (): Cesium.PolylineGeometry[] =>
      rings.map((ring) => ringPolyline(ring, config.rimMinPx))
        .filter((line): line is Cesium.PolylineGeometry => line !== null)
    const rimAlphas = rimLines().map(() => colors.rimOpacity)

    const bandGeometries: Cesium.Geometry[] = []
    const bandAlphas: number[] = []
    const bandCentres: number[] = []
    for (let band = 0; band < WALL_BAND_COUNT; band += 1) {
      const bottom = band / WALL_BAND_COUNT
      const top = (band + 1) / WALL_BAND_COUNT
      const alpha = bandOpacity(bottom, top)
      for (const ring of rings) {
        bandGeometries.push(wallBandGeometry(ring, bottom, top))
        bandAlphas.push(alpha)
        bandCentres.push((bottom + top) * 0.5)
      }
    }

    const parts: FormParts = {
      fill: createPart({
        geometries: [fillGeometry(fill)],
        alphas: [colors.fillOpacity],
        kind: 'footprint',
        color: colors.fill,
      }),
      rim: createPart({
        geometries: rimLines(),
        alphas: rimAlphas,
        kind: 'footprint',
        zOffset: 0.012,
        color: colors.rim,
        line: true,
      }),
      xrayFill: createPart({
        geometries: [fillGeometry(fill)],
        alphas: [colors.fillOpacity],
        kind: 'footprint',
        color: colors.fill,
        depthless: true,
      }),
      xrayRim: createPart({
        geometries: rimLines(),
        alphas: rimAlphas,
        kind: 'footprint',
        zOffset: 0.012,
        color: colors.rim,
        line: true,
        depthless: true,
      }),
      wall: createPart({
        geometries: bandGeometries,
        alphas: bandAlphas,
        bandT: bandCentres,
        kind: 'wall',
        color: colors.wall,
        breathes: true,
      }),
      topRim: createPart({
        geometries: rimLines(),
        alphas: rimAlphas,
        kind: 'wallTop',
        color: colors.rim,
        line: true,
      }),
      parts: [],
    }
    parts.parts = [parts.fill, parts.rim, parts.xrayFill, parts.xrayRim, parts.wall, parts.topRim]
    return parts
  }

  let exactParts = buildFormParts(data.fillExact, data.outlineExact)
  let organicParts = buildFormParts(data.fillOrganic, data.outlineOrganic)

  // The 1 m² lattice is a property of the exact form, not of a style, so it is
  // built once and shown whenever that form is active — including on the canopy
  // plate, where the footprint parts simply move up with it.
  const buildGridPart = (depthless: boolean): ShapePart => {
    // Fresh PolylineGeometry descriptions per primitive: Primitive consumes and
    // releases its instances, so the two passes must not share them.
    const lines = segmentPolylines(data.gridSegments, config.gridMinPx)
    return createPart({
      geometries: lines,
      alphas: lines.map(() => colors.gridOpacity),
      kind: 'footprint',
      zOffset: 0.006,
      color: colors.grid,
      line: true,
      depthless,
    })
  }
  const gridPart = buildGridPart(false)
  const xrayGridPart = buildGridPart(true)

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
  let wallHeight: number = config.wallHeightM
  let footprintOnCanopy = false
  let labelAnchorZ = 0
  let reveal = 0

  let groundZ = options.fallbackGroundZ
  let canopyZ = options.fallbackGroundZ + options.canopyHeightM
  let targetGroundZ = groundZ
  let targetCanopyZ = canopyZ
  let lastProbe = -Infinity
  let firstProbeAt = -Infinity
  let settleStreak = 0
  let settled = config.groundZOverrideM !== null
  let lastFrame = -Infinity
  let revealStart = -Infinity
  if (config.groundZOverrideM !== null) {
    groundZ = config.groundZOverrideM
    targetGroundZ = groundZ
    canopyZ = groundZ + options.canopyHeightM
    targetCanopyZ = canopyZ
  }

  const probeCentre = new Cesium.Cartesian2()
  const shapeOrigin = new Cesium.Cartesian3()
  const shapeTranslation = new Cesium.Matrix4()
  const shapeMatrix = new Cesium.Matrix4()
  const localTranslation = new Cesium.Cartesian3()
  const localScale = new Cesium.Cartesian3()
  const localMatrix = new Cesium.Matrix4()

  function allParts(): ShapePart[] {
    return [...exactParts.parts, ...organicParts.parts, gridPart, xrayGridPart]
  }

  const canopyDepth = (): number => Math.max(0, canopyZ - groundZ)
  /** The low wall must still clear the crowns, or it is invisible from every
   * useful viewing height. The measured canopy is only ~29 m on this site, so
   * the fixed fallback alone buried it. */
  const measuredWallHeight = (): number =>
    Math.max(config.wallHeightM, canopyDepth() + config.wallCanopyClearanceM)
  /** Height of the active style's volume above the footprint. */
  const activeHeight = (): number => style === 'column'
    ? config.columnHeightM
    : style === 'wall' ? measuredWallHeight() : canopyDepth()

  function setShow(part: ShapePart, show: boolean): void {
    if (part.primitive.show === show) return
    part.primitive.show = show
    // Force a colour write on the next frame — a hidden part's alpha may have
    // drifted while the reveal ramp ran.
    if (show) part.appliedAlphas.fill(-1)
  }

  function setAlphaScale(part: ShapePart, scale: number): void {
    if (part.alphaScale === scale) return
    part.alphaScale = scale
    part.appliedAlphas.fill(-1)
  }

  function applyStyle(): void {
    const column = style === 'column'
    const wall = style === 'wall'
    const xray = style === 'xray'
    const canopy = style === 'canopy'

    const active = form === 'exact' ? exactParts : organicParts
    const idle = form === 'exact' ? organicParts : exactParts
    for (const part of idle.parts) setShow(part, false)

    // X-ray means the WHOLE footprint stops depth-testing — fill, rim and grid.
    // A faint additive ghost over a depth-tested footprint left the parcel
    // invisible under the crowns, which is the bug this replaces.
    setShow(active.fill, !xray)
    setShow(active.rim, !xray)
    setShow(active.xrayFill, xray)
    setShow(active.xrayRim, xray)
    setShow(active.wall, column || wall)
    setShow(active.topRim, column || wall)
    // The 1 m² lattice belongs to the exact form in every style — it is the
    // whole point of that form, so it is never distance- or style-gated.
    setShow(gridPart, form === 'exact' && !xray)
    setShow(xrayGridPart, form === 'exact' && xray)

    // The flat styles have no wall to carry them, so they need more fill to
    // read against a bright canopy.
    const boost = column || wall ? 1 : config.flatFillBoost
    setAlphaScale(active.fill, boost)
    setAlphaScale(active.xrayFill, boost)

    // The column's height is a fixed product value, not the measured canopy: it
    // has to tower over the crowns to be readable from the navigation floor,
    // and it must not shrink to nothing while the ground probe is still waiting
    // for tiles.
    wallHeight = column ? config.columnHeightM : measuredWallHeight()
    footprintOnCanopy = canopy
    labelAnchorZ = (canopy
      ? canopyDepth()
      : column ? config.columnHeightM * 0.62 : measuredWallHeight()) + config.labelLiftM
  }

  function partLocalZ(part: ShapePart): number {
    switch (part.kind) {
      case 'wall': return config.footprintLiftM
      case 'wallTop': return config.footprintLiftM + wallHeight
      default: return (footprintOnCanopy ? canopyDepth() : config.footprintLiftM) + part.zOffset
    }
  }

  function updateMatrices(): void {
    Cesium.Cartesian3.fromElements(data.centroid[0], data.centroid[1], groundZ, shapeOrigin)
    Cesium.Matrix4.fromTranslation(shapeOrigin, shapeTranslation)
    Cesium.Matrix4.multiply(enuFrame.matrix, shapeTranslation, shapeMatrix)
    for (const part of allParts()) {
      if (!part.primitive.show) continue
      Cesium.Cartesian3.fromElements(0, 0, partLocalZ(part), localTranslation)
      Cesium.Matrix4.fromTranslation(localTranslation, localMatrix)
      if (part.kind === 'wall') {
        Cesium.Cartesian3.fromElements(1, 1, wallHeight, localScale)
        Cesium.Matrix4.multiplyByScale(localMatrix, localScale, localMatrix)
      }
      Cesium.Matrix4.multiply(shapeMatrix, localMatrix, part.primitive.modelMatrix)
    }
  }

  function updateColors(now: number): void {
    for (const part of allParts()) {
      if (!part.primitive.show || !part.primitive.ready) continue
      for (let index = 0; index < part.instanceIds.length; index += 1) {
        let alpha = part.baseAlphas[index] * part.alphaScale * reveal
        if (part.breathes) {
          // Travelling breathe, ported from the three.js wall shader — the one
          // motion worth keeping without a custom shader.
          alpha *= 0.88 + Math.sin(now * 0.0014 - part.bandT[index] * 5) * 0.12
        }
        if (Math.abs(alpha - part.appliedAlphas[index]) < 0.004) continue
        const attributes = part.primitive.getGeometryInstanceAttributes(part.instanceIds[index])
        if (!attributes) continue
        attributes.color = Cesium.ColorGeometryInstanceAttribute.toValue(
          colorFromHex(part.baseColor, alpha, scratchColor),
          attributes.color,
        )
        part.appliedAlphas[index] = alpha
      }
    }
  }

  applyStyle()
  updateMatrices()

  function rebuildOrganic(): void {
    data = buildDonationShapeGeometry(options.source, options.toLocal, {
      cellSizeM: config.cellSizeM,
      smoothness,
      sdfPixelM: config.sdfPixelM,
    })
    for (const part of organicParts.parts) {
      const collection = ghostCollection.contains(part.primitive)
        ? ghostCollection
        : opaqueCollection
      collection.remove(part.primitive)
    }
    organicParts = buildFormParts(data.fillOrganic, data.outlineOrganic)
    applyStyle()
    updateMatrices()
    syncLabelText()
  }

  function runProbe(now: number): void {
    if (settled || now - lastProbe < config.probeIntervalMs) return
    lastProbe = now
    Cesium.Cartesian2.fromElements(data.centroid[0], data.centroid[1], probeCentre)
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

    if (Math.abs(sample.groundZ - targetGroundZ) < config.probeSettleEpsilonM) settleStreak += 1
    else settleStreak = 0
    targetGroundZ = sample.groundZ
    targetCanopyZ = Math.max(sample.canopyZ, sample.groundZ + 6)
    console.info(
      `[donation-shape] ground ${sample.groundZ.toFixed(1)} m · canopy ${sample.canopyZ.toFixed(1)} m`
      + ` · ${sample.samples} samples · support ${sample.support}/25`,
    )
    if (settleStreak >= config.probeSettleStreak || now - firstProbeAt > config.probeTimeoutMs) {
      settled = true
    }
  }

  // ------------------------------------------------------------ label projection
  const labelEnu = new Cesium.Cartesian3()
  const labelWorld = new Cesium.Cartesian3()
  const toLabel = new Cesium.Cartesian3()
  const cameraScaled = new Cesium.Cartesian3()
  const anchorScaled = new Cesium.Cartesian3()
  const projected = new Cesium.Cartesian2()
  const unitEarthOccluder = new Cesium.Occluder(
    new Cesium.BoundingSphere(Cesium.Cartesian3.ZERO, 1),
    Cesium.Cartesian3.UNIT_Z,
  )

  function projectLabel(): void {
    const camera = scene.camera
    Cesium.Cartesian3.fromElements(
      data.centroid[0],
      data.centroid[1],
      groundZ + labelAnchorZ,
      labelEnu,
    )
    enuFrame.enuToWorld(labelEnu, labelWorld)
    Cesium.Cartesian3.subtract(labelWorld, camera.positionWC, toLabel)
    const forwardDistance = Cesium.Cartesian3.dot(toLabel, camera.directionWC)
    if (forwardDistance <= camera.frustum.near || forwardDistance >= camera.frustum.far) {
      label.hidden = true
      return
    }

    // Occluder runs in ellipsoid-scaled space, turning WGS84 into a unit
    // sphere. This rejects the chip on the far side of the globe before DOM work.
    scene.globe.ellipsoid.transformPositionToScaledSpace(camera.positionWC, cameraScaled)
    scene.globe.ellipsoid.transformPositionToScaledSpace(labelWorld, anchorScaled)
    unitEarthOccluder.cameraPosition = cameraScaled
    if (!unitEarthOccluder.isPointVisible(anchorScaled)) {
      label.hidden = true
      return
    }

    const windowPosition = Cesium.SceneTransforms.worldToWindowCoordinates(
      scene,
      labelWorld,
      projected,
    )
    if (!windowPosition) {
      label.hidden = true
      return
    }

    if (measuredViewportWidth !== window.innerWidth || labelWidth === 0) {
      label.hidden = false
      labelWidth = label.offsetWidth
      labelHeight = label.offsetHeight
      measuredViewportWidth = window.innerWidth
    }

    const canvasRect = scene.canvas.getBoundingClientRect()
    const rawX = canvasRect.left + windowPosition.x
    const rawY = canvasRect.top + windowPosition.y
    const marginX = canvasRect.width * 0.06
    const marginY = canvasRect.height * 0.06
    if (rawX < canvasRect.left - marginX || rawX > canvasRect.right + marginX
      || rawY < canvasRect.top - marginY || rawY > canvasRect.bottom + marginY) {
      label.hidden = true
      return
    }

    const half = labelWidth * 0.5
    const x = Cesium.Math.clamp(rawX, half + 7, window.innerWidth - half - 7)
    const y = Cesium.Math.clamp(rawY, labelHeight + 7, window.innerHeight - 7)
    label.hidden = false
    label.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`
    label.style.opacity = reveal.toFixed(3)
  }

  // DOM projection must observe the matrices Cesium actually rendered, so it
  // runs after the frame rather than in update()'s pre-render path.
  const removePostRender = scene.postRender.addEventListener(() => {
    if (disposed || !visible) {
      label.hidden = true
      return
    }
    projectLabel()
  })

  return {
    update(now) {
      if (disposed || !visible) return
      const elapsed = lastFrame === -Infinity ? 16 : Math.min(64, Math.max(0, now - lastFrame))
      lastFrame = now
      if (revealStart === -Infinity) revealStart = now
      const revealMs = options.reducedMotion ? 1 : 900
      reveal = Math.min(1, (now - revealStart) / revealMs)

      runProbe(now)
      // Exponential follow rather than assignment: tiles stream in, and the
      // parcel must not pop while they do.
      const blend = 1 - Math.exp(-elapsed / config.probeSmoothingMs)
      groundZ += (targetGroundZ - groundZ) * blend
      canopyZ += (targetCanopyZ - canopyZ) * blend

      applyStyle()
      updateMatrices()
      updateColors(now)
    },
    setStyle(next) {
      if (next === style) return
      style = next
      applyStyle()
      updateMatrices()
    },
    setForm(next) {
      if (next === form) return
      form = next
      applyStyle()
      updateMatrices()
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
      opaqueCollection.show = next
      ghostCollection.show = next
      if (!next) label.hidden = true
    },
    flightTargetEnu(result = new Cesium.Cartesian3()) {
      // Part way up the volume, not the footprint: the camera has to look at the
      // middle of the column or the column leaves the frame upwards.
      return Cesium.Cartesian3.fromElements(
        data.centroid[0],
        data.centroid[1],
        groundZ + activeHeight() * config.lookHeightFraction,
        result,
      )
    },
    groundCentreEnu(result = new Cesium.Cartesian3()) {
      return Cesium.Cartesian3.fromElements(data.centroid[0], data.centroid[1], groundZ, result)
    },
    frameExtent() {
      const radiusM = Math.max(
        Math.hypot(data.bbox[0], data.bbox[1]),
        Math.hypot(data.bbox[2], data.bbox[3]),
        Math.hypot(data.bbox[0], data.bbox[3]),
        Math.hypot(data.bbox[2], data.bbox[1]),
      )
      const depth = canopyDepth()
      const heightM = style === 'column'
        ? config.columnHeightM
        : style === 'wall' ? measuredWallHeight()
          : style === 'canopy' ? Math.max(config.wallHeightM, depth)
            : Math.max(2 * radiusM, depth)
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
      if (disposed) return
      disposed = true
      removePostRender()
      label.remove()
      const sceneDestroyed = (scene as any).isDestroyed?.() ?? false
      for (const collection of [opaqueCollection, ghostCollection]) {
        const wasRemoved = !sceneDestroyed
          && scene.primitives.contains(collection)
          && scene.primitives.remove(collection)
        if (!wasRemoved && !collection.isDestroyed()) collection.destroy()
      }
    },
  }
}
