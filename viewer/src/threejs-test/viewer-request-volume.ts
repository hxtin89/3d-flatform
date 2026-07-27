import * as THREE from 'three'

type RequestVolume = {
  box?: number[]
  sphere?: number[]
  region?: number[]
}

type RequestVolumeTile = {
  viewerRequestVolume?: RequestVolume
  content?: { uri?: string; url?: string }
  internal?: { basePath?: string }
  engineData?: { transform?: THREE.Matrix4 }
}

type ViewErrorTarget = {
  inView: boolean
  error: number
  distance: number
}

type VolumeTester = (position: THREE.Vector3) => boolean

/**
 * 3DTilesRendererJS 0.4.x does not evaluate viewerRequestVolume. The generated
 * One LOD Tree uses oriented request boxes to keep p10 and p100 dormant until
 * the camera is near an area. This plugin adds that missing traversal mask.
 */
export class ViewerRequestVolumePlugin {
  readonly name = 'VIEWER_REQUEST_VOLUME_PLUGIN'

  /** Horizontal slack on the request box, in multiples of its own footprint.
   * The generated boxes hug the chunk exactly, so a camera hovering between
   * two chunks — where the intro flight ends — never opens either of them and
   * stays on the overview no matter how far it zooms. Vertical extent is left
   * alone; the pipeline already stretches it by the stage ratio. */
  private xyScale = 1

  private tiles: any = null
  private testers = new WeakMap<object, VolumeTester | null>()
  private warned = new WeakSet<object>()
  private densityCeiling = 2
  /** Diagnostics only, and off by default: this counts inside the traversal
   * hot path, which runs millions of times per second. */
  readonly debugCounts = { blockedByCeiling: [0, 0, 0], inside: [0, 0, 0], outside: [0, 0, 0], noVolume: [0, 0, 0] }
  private debug = false

  constructor(options?: { xyScale?: number; debug?: boolean }) {
    if (options?.xyScale && options.xyScale > 0) this.xyScale = options.xyScale
    this.debug = Boolean(options?.debug)
  }

  init(tiles: any): void {
    this.tiles = tiles
  }

  calculateTileViewError(tile: RequestVolumeTile, target: ViewErrorTarget): boolean {
    const rank = this.densityRank(tile)
    if (rank > this.densityCeiling) {
      if (this.debug) this.debugCounts.blockedByCeiling[rank]++
      target.inView = false
      target.error = 0
      target.distance = Infinity
      return true
    }

    const definition = tile.viewerRequestVolume
    if (!definition) { if (this.debug) this.debugCounts.noVolume[rank]++; return false }

    let tester = this.testers.get(tile as object)
    if (tester === undefined) {
      tester = this.createTester(tile, definition)
      this.testers.set(tile as object, tester)
    }

    const cameraInfo = this.tiles?.cameraInfo as Array<{ position: THREE.Vector3 }> | undefined
    const inside = Boolean(tester && cameraInfo?.some(({ position }) => tester!(position)))
    if (this.debug) this.debugCounts[inside ? 'inside' : 'outside'][rank]++
    target.inView = inside
    target.error = 0
    target.distance = inside ? 0 : Infinity
    return true
  }

  dispose(): void {
    this.tiles = null
    this.testers = new WeakMap()
    this.warned = new WeakSet()
  }

  /** Highest tier this camera position may load: 0 = p02, 1 = p10, 2 = p100.
   * Driven by camera height, not by frame rate — the screen-space error alone
   * does not stop p100 from being fetched, so without this ceiling a distant
   * camera pulls full-density tiles and a phone drops to single-digit fps. */
  setDensityCeiling(level: number): void {
    this.densityCeiling = Math.max(0, Math.min(2, Math.round(level)))
  }

  private createTester(tile: RequestVolumeTile, definition: RequestVolume): VolumeTester | null {
    const transform = tile.engineData?.transform
    if (!transform) return this.reject(tile, 'viewerRequestVolume has no tile transform')

    if (Array.isArray(definition.box) && definition.box.length === 12 && definition.box.every(Number.isFinite)) {
      const box = definition.box
      // Unit cube -> request OBB -> renderer root coordinates.
      const boxToWorld = new THREE.Matrix4().set(
        box[3], box[6], box[9], box[0],
        box[4], box[7], box[10], box[1],
        box[5], box[8], box[11], box[2],
        0, 0, 0, 1,
      ).premultiply(transform)
      if (Math.abs(boxToWorld.determinant()) < 1e-12) return this.reject(tile, 'degenerate viewer request box')
      const inverse = boxToWorld.invert()
      const local = new THREE.Vector3()
      const xy = this.xyScale + 0.00001
      return (position) => {
        local.copy(position).applyMatrix4(inverse)
        return Math.abs(local.x) <= xy && Math.abs(local.y) <= xy && Math.abs(local.z) <= 1.00001
      }
    }

    if (Array.isArray(definition.sphere) && definition.sphere.length === 4 && definition.sphere.every(Number.isFinite)) {
      const centre = new THREE.Vector3(definition.sphere[0], definition.sphere[1], definition.sphere[2])
        .applyMatrix4(transform)
      const scale = new THREE.Vector3().setFromMatrixScale(transform)
      const radius = definition.sphere[3] * Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z))
      return (position) => position.distanceToSquared(centre) <= radius * radius
    }

    // The generated sidecar currently uses boxes. Fail closed if a future build
    // emits an unsupported region so p100 cannot accidentally load worldwide.
    return this.reject(tile, 'unsupported or malformed viewerRequestVolume')
  }

  private reject(tile: RequestVolumeTile, reason: string): null {
    if (!this.warned.has(tile as object)) {
      this.warned.add(tile as object)
      console.error(`[streaming] viewerRequestVolume rejected: ${reason}`)
    }
    return null
  }

  private densityRank(tile: RequestVolumeTile): number {
    const uri = `${tile.content?.uri ?? ''} ${tile.content?.url ?? ''} ${tile.internal?.basePath ?? ''}`
    if (uri.includes('chunked-copc') || uri.includes('detail-p100')) return 2
    if (uri.includes('explore-p10')) return 1
    return 0
  }
}
