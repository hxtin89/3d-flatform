// Streaming point-cloud mode: a second TilesRenderer streams the overview octree
// with real screen-space-error LOD, exactly like the Cesium viewer does. The globe
// dataset's tileset root already carries the ENU→ECEF transform, so tiles land on
// the correct spot on the globe without any manual placement.
import * as THREE from 'three'
import { TilesRenderer } from '3d-tiles-renderer'
import { LoadRegionPlugin, SphereRegion, UnloadTilesPlugin } from '3d-tiles-renderer/plugins'
import { createCloudMaterial, type CloudUniforms } from './point-cloud'

export interface StreamingCloud {
  tiles: TilesRenderer
  group: THREE.Object3D
  update(): void
  setErrorTarget(v: number): void
  /** Restrict loading/refinement/rendering to a world-space sphere (null = off). */
  setMaskSphere(centerWorld: THREE.Vector3 | null, radius: number): void
  stats(): { visible: number; points: number; progress: number }
  dispose(): void
}

export interface StreamingLimits {
  cacheMinTiles: number
  cacheMaxTiles: number
  cacheMinBytes: number
  cacheMaxBytes: number
  maxDownloads: number
}

export function createStreamingCloud(opts: {
  tilesetUrl: string
  camera: THREE.PerspectiveCamera
  renderer: any
  scene: THREE.Scene
  uniforms: CloudUniforms
  errorTarget?: number
  /** memory caps — LOW on mobile: Safari kills the tab (jetsam) well below 1.5 GB */
  limits?: Partial<StreamingLimits>
}): StreamingCloud {
  const { tilesetUrl, camera, renderer, scene, uniforms, errorTarget = 16, limits = {} } = opts

  const tiles = new TilesRenderer(tilesetUrl)
  tiles.errorTarget = errorTarget
  tiles.lruCache.minSize = limits.cacheMinTiles ?? 600
  tiles.lruCache.maxSize = limits.cacheMaxTiles ?? 1200
  // default LRU byte limits are 300/400 MB PER RENDERER (×3 tiers!) — cap them
  tiles.lruCache.minBytesSize = limits.cacheMinBytes ?? 150e6
  tiles.lruCache.maxBytesSize = limits.cacheMaxBytes ?? 250e6
  if (limits.maxDownloads) tiles.downloadQueue.maxJobs = limits.maxDownloads
  tiles.setCamera(camera)
  tiles.setResolutionFromRenderer(camera, renderer)

  // Real culling for the masks: tiles outside the region sphere are suppressed in the
  // traversal (never fetched, refined or rendered) and their GPU memory is freed.
  //
  // A plain mask SphereRegion would also FORCE-load in-sphere tiles that are outside
  // the camera frustum (a LoadRegion's purpose is loading regardless of the view) —
  // so intersect against the camera frustums too: visible = frustum ∧ sphere.
  class FrustumMaskRegion extends SphereRegion {
    intersectsTile(boundingVolume: any, _tile?: any, tilesRenderer?: any): boolean {
      if (!boundingVolume.intersectsSphere(this.sphere)) return false
      const info = tilesRenderer?.cameraInfo
      if (!info || info.length === 0) return true
      for (let i = 0; i < info.length; i++) {
        if (boundingVolume.intersectsFrustum(info[i].frustum)) return true
      }
      return false
    }
  }
  const regionPlugin = new LoadRegionPlugin()
  const maskRegion = new FrustumMaskRegion({ mask: true, errorTarget })
  // The region must only CULL, not drive refinement: the default calculateError
  // returns the raw geometric error (metres) which the traversal compares against
  // the pixel error target — that would force max-depth refinement everywhere
  // inside the sphere. Neutralise it so the camera SSE alone decides detail.
  maskRegion.calculateError = () => 0
  let maskActive = false
  tiles.registerPlugin(regionPlugin as any)
  tiles.registerPlugin(new UnloadTilesPlugin({ delay: 400 }) as any)

  // Each loaded .pnts arrives as THREE.Points; swap in the shared node material so
  // colours (sRGB decode), point-size uniform and the ENU mask match the flat modes.
  const material = createCloudMaterial('rgb', uniforms)
  tiles.addEventListener('load-model', ({ scene: s }: any) => {
    s.traverse((o: any) => {
      if (o.isPoints) {
        o.material = material
        o.frustumCulled = false // tile-level culling is done by the tiles renderer
      }
    })
  })
  tiles.addEventListener('load-error', ({ url, error }: any) =>
    console.error('[streaming] tile error', url, error?.message))

  scene.add(tiles.group)

  return {
    tiles,
    group: tiles.group,
    update() {
      tiles.update()
    },
    setErrorTarget(v: number) {
      tiles.errorTarget = v
    },
    setMaskSphere(centerWorld: THREE.Vector3 | null, radius: number) {
      if (!centerWorld || !(radius > 0)) {
        if (maskActive) { regionPlugin.removeRegion(maskRegion); maskActive = false }
        return
      }
      if (!maskActive) { regionPlugin.addRegion(maskRegion); maskActive = true }
      // tile bounding volumes live in the group's local frame (the tileset's ECEF
      // coords) — the group itself only carries the ground-snap shift
      tiles.group.updateWorldMatrix(true, false)
      maskRegion.sphere.center.copy(centerWorld)
      tiles.group.worldToLocal(maskRegion.sphere.center)
      maskRegion.sphere.radius = radius
    },
    stats() {
      let points = 0
      tiles.group.traverse((o: any) => {
        if (o.isPoints && o.visible) points += o.geometry?.attributes?.position?.count ?? 0
      })
      return { visible: (tiles as any).visibleTiles?.size ?? 0, points, progress: (tiles as any).loadProgress ?? 1 }
    },
    dispose() {
      scene.remove(tiles.group)
      tiles.dispose()
      material.dispose()
    },
  }
}
