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

  private tiles: any = null
  private testers = new WeakMap<object, VolumeTester | null>()
  private warned = new WeakSet<object>()
  private densityCeiling = 2

  init(tiles: any): void {
    this.tiles = tiles
  }

  calculateTileViewError(tile: RequestVolumeTile, target: ViewErrorTarget): boolean {
    if (this.densityRank(tile) > this.densityCeiling) {
      target.inView = false
      target.error = 0
      target.distance = Infinity
      return true
    }

    const definition = tile.viewerRequestVolume
    if (!definition) return false

    let tester = this.testers.get(tile as object)
    if (tester === undefined) {
      tester = this.createTester(tile, definition)
      this.testers.set(tile as object, tester)
    }

    const cameraInfo = this.tiles?.cameraInfo as Array<{ position: THREE.Vector3 }> | undefined
    const inside = Boolean(tester && cameraInfo?.some(({ position }) => tester!(position)))
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

  /** Pressure 1 shows every zoom-eligible tier. Sustained frame pressure first
   * suppresses p100, then p10. Recovery uses the same tree in reverse. */
  setPressure(pressure: number): void {
    // Separate entry/exit thresholds prevent p10 or p100 from flapping when the
    // measured frame rate sits on a boundary.
    if (this.densityCeiling === 2 && pressure >= 1.25) this.densityCeiling = 1
    else if (this.densityCeiling === 1 && pressure >= 2.2) this.densityCeiling = 0
    else if (this.densityCeiling === 1 && pressure <= 1.05) this.densityCeiling = 2
    else if (this.densityCeiling === 0 && pressure <= 1.6) this.densityCeiling = 1
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
      return (position) => {
        local.copy(position).applyMatrix4(inverse)
        return Math.abs(local.x) <= 1.00001 && Math.abs(local.y) <= 1.00001 && Math.abs(local.z) <= 1.00001
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
