// Single-tree point-cloud streaming. The One LOD Tree links p02 -> p10 -> p100
// through external 3D Tiles documents, so one TilesRenderer owns traversal,
// requests, CPU cache and GPU residency for every density.
import * as THREE from 'three'
import { TilesRenderer } from '3d-tiles-renderer'
import { LoadRegionPlugin, SphereRegion, UnloadTilesPlugin } from '3d-tiles-renderer/plugins'
import { createCloudMaterial, type CloudUniforms } from './point-cloud'
import { denserBand, densityBandForUri, type DensityBand } from './adaptive-quality'
import { ViewerRequestVolumePlugin } from './viewer-request-volume'

export interface StreamingStats {
  visible: number
  points: number
  progress: number
  density: DensityBand
  cacheBytes: number
  gpuBytes: number
}

export interface StreamingCloud {
  tiles: TilesRenderer
  group: THREE.Object3D
  update(): void
  setErrorTarget(v: number): void
  setQualityPressure(v: number): void
  /** Restrict loading/refinement/rendering to a world-space sphere (null = off). */
  setMaskSphere(centerWorld: THREE.Vector3 | null, radius: number): void
  stats(): StreamingStats
  dispose(): void
}

export interface StreamingLimits {
  cacheMinTiles: number
  cacheMaxTiles: number
  cacheMinBytes: number
  cacheMaxBytes: number
  gpuBytesTarget: number
  maxDownloads: number
  maxParses: number
  maxProcesses: number
  maxTilesProcessed: number
}

const MIB = 1024 * 1024

const DEFAULT_LIMITS: StreamingLimits = {
  cacheMinTiles: 48,
  cacheMaxTiles: 160,
  cacheMinBytes: 48 * MIB,
  cacheMaxBytes: 96 * MIB,
  gpuBytesTarget: 64 * MIB,
  maxDownloads: 6,
  maxParses: 2,
  maxProcesses: 4,
  maxTilesProcessed: 120,
}

export function createStreamingCloud(opts: {
  tilesetUrl: string
  camera: THREE.PerspectiveCamera
  renderer: any
  scene: THREE.Scene
  uniforms: CloudUniforms
  errorTarget?: number
  limits?: Partial<StreamingLimits>
}): StreamingCloud {
  const { tilesetUrl, camera, renderer, scene, uniforms, errorTarget = 256 } = opts
  const limits = { ...DEFAULT_LIMITS, ...opts.limits }

  const tiles = new TilesRenderer(tilesetUrl)
  tiles.errorTarget = errorTarget
  tiles.lruCache.minSize = limits.cacheMinTiles
  tiles.lruCache.maxSize = limits.cacheMaxTiles
  tiles.lruCache.minBytesSize = limits.cacheMinBytes
  tiles.lruCache.maxBytesSize = limits.cacheMaxBytes
  tiles.downloadQueue.maxJobs = limits.maxDownloads
  tiles.parseQueue.maxJobs = limits.maxParses
  tiles.processNodeQueue.maxJobs = limits.maxProcesses
  tiles.maxTilesProcessed = limits.maxTilesProcessed
  tiles.setCamera(camera)
  tiles.setResolutionFromRenderer(camera, renderer)

  // The current 3DTilesRendererJS release ignores viewerRequestVolume. Without
  // this plugin p10 and p100 may refine together, defeating the One LOD Tree.
  const requestVolumePlugin = new ViewerRequestVolumePlugin()
  tiles.registerPlugin(requestVolumePlugin as any)

  // Real mask culling: outside tiles are not fetched, refined or rendered.
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
  maskRegion.calculateError = () => 0
  let maskActive = false
  tiles.registerPlugin(regionPlugin as any)

  const unloadPlugin = new UnloadTilesPlugin({
    delay: 350,
    bytesTarget: limits.gpuBytesTarget,
  })
  tiles.registerPlugin(unloadPlugin as any)

  const tileStats = new WeakMap<object, { points: number; density: DensityBand }>()

  // Materials must be tile-owned. A shared material is unsafe with
  // UnloadTilesPlugin because hiding one tile disposes its material and would
  // invalidate every other tile that shared the same instance.
  tiles.addEventListener('load-model', ({ scene: model, tile, url }: any) => {
    let points = 0
    model.traverse((object: any) => {
      if (!object.isPoints) return
      points += object.geometry?.attributes?.position?.count ?? 0
      if (Array.isArray(object.material)) object.material.forEach((material: any) => material?.dispose?.())
      else object.material?.dispose?.()
      object.material = createCloudMaterial(uniforms)
      object.frustumCulled = false // tile-level culling is handled by TilesRenderer
    })
    const source = `${url ?? ''} ${tile?.content?.uri ?? ''} ${tile?.internal?.basePath ?? ''}`
    tileStats.set(tile, { points, density: densityBandForUri(source) })
  })
  tiles.addEventListener('dispose-model', ({ tile }: any) => tileStats.delete(tile))
  tiles.addEventListener('load-error', ({ url, error }: any) =>
    console.error('[streaming] tile error', url, error?.message))

  scene.add(tiles.group)

  return {
    tiles,
    group: tiles.group,
    update() {
      tiles.update()
    },
    setErrorTarget(value: number) {
      tiles.errorTarget = value
    },
    setQualityPressure(value: number) {
      requestVolumePlugin.setPressure(value)
    },
    setMaskSphere(centerWorld: THREE.Vector3 | null, radius: number) {
      if (!centerWorld || !(radius > 0)) {
        if (maskActive) { regionPlugin.removeRegion(maskRegion); maskActive = false }
        return
      }
      if (!maskActive) { regionPlugin.addRegion(maskRegion); maskActive = true }
      tiles.group.updateWorldMatrix(true, false)
      maskRegion.sphere.center.copy(centerWorld)
      tiles.group.worldToLocal(maskRegion.sphere.center)
      maskRegion.sphere.radius = radius
    },
    stats() {
      let points = 0
      let density: DensityBand = 'Overview p02'
      for (const tile of tiles.visibleTiles) {
        const stats = tileStats.get(tile)
        if (!stats) continue
        points += stats.points
        density = denserBand(density, stats.density)
      }
      return {
        visible: tiles.visibleTiles.size,
        points,
        progress: tiles.loadProgress,
        density,
        cacheBytes: (tiles.lruCache as any).cachedBytes ?? 0,
        gpuBytes: (unloadPlugin as any).estimatedGpuBytes ?? 0,
      }
    },
    dispose() {
      scene.remove(tiles.group)
      tiles.dispose()
    },
  }
}
