// WGS84 basemap + controls for the React app. Copy of src/threejs-test/globe.ts
// with WildGlobeControls (no per-frame raycasts, no near/far writes) and the
// update split so the frame phases can interleave the navigation floor.
import * as THREE from 'three'
import { TilesRenderer } from '3d-tiles-renderer'
import { UnloadTilesPlugin, UpdateOnChangePlugin, XYZTilesPlugin } from '3d-tiles-renderer/plugins'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import { texture } from 'three/tsl'
import { EXPERIENCE_CONFIG } from '../../threejs-test/config'
import { applyHighPrecisionAlways, maskDimNode, type CloudUniforms } from '../../threejs-test/point-cloud'
import { installPointerEasing, type PointerEasing } from '../../threejs-test/pointer-easing'
import type { MemoryBudgetSnapshot } from '../../threejs-test/streaming'
import type { MouseOrbitPivot } from '../../threejs-test/smoothed-globe-controls'
import { WildGlobeControls } from '../controls/wild-globe-controls'
import { createNavigationGestures, type NavigationOptions } from '../controls/navigation-gestures'

export interface Globe {
  tiles: TilesRenderer
  controls: WildGlobeControls
  pointerEasing: PointerEasing
  navigation: ReturnType<typeof createNavigationGestures>
  ellipsoid: any
  /** controls.update(), then the optional camera constraint. */
  updateControls(constrainCamera?: () => void): void
  /** Basemap traversal — after the camera is final for this frame. */
  updateTiles(): void
  setResolution(): void
  setMemoryBudget(cacheMaxBytes: number, gpuBytesTarget: number): void
  getMemoryBudget(): MemoryBudgetSnapshot
  setMemoryBudgetExact(budget: MemoryBudgetSnapshot): void
  stats(): { visible: number; cacheBytes: number; gpuBytes: number }
  dispose(): void
}

export function createGlobe(opts: {
  renderer: {
    domElement: HTMLCanvasElement
    getDrawingBufferSize(v: THREE.Vector2): THREE.Vector2
    getMaxAnisotropy(): number
  }
  camera: THREE.PerspectiveCamera
  /** ECEF-anchored parent — the floating-origin root. */
  scene: THREE.Object3D
  maptilerKey: string
  cameraClearance: number
  uniforms: CloudUniforms
  mouseOrbitEaseMs: number
  mouseRotationSpeed: number
  mouseInertia: boolean
  mouseOrbitPivot: MouseOrbitPivot
  adjustOrbitPivot?: (pivot: THREE.Vector3) => void
  navigation: Omit<NavigationOptions, 'controls' | 'camera' | 'canvas' | 'mode'>
  onImageryStatus?(message: string | null): void
}): Globe {
  const {
    renderer, camera, scene, maptilerKey, cameraClearance, uniforms,
    mouseOrbitEaseMs, mouseRotationSpeed, mouseInertia, mouseOrbitPivot, adjustOrbitPivot,
  } = opts

  const tiles = new TilesRenderer()
  tiles.lruCache.minSize = 24
  tiles.lruCache.maxSize = 320
  tiles.lruCache.minBytesSize = 32 * 1024 * 1024
  tiles.lruCache.maxBytesSize = 256 * 1024 * 1024
  tiles.downloadQueue.maxJobs = 10
  tiles.parseQueue.maxJobs = 4
  tiles.processNodeQueue.maxJobs = 4
  tiles.maxTilesProcessed = 80
  tiles.registerPlugin(new XYZTilesPlugin({
    shape: 'ellipsoid',
    useRecommendedSettings: true,
    tileDimension: 512,
    // MapTiler satellite-v4 TileJSON advertises zoom 0 through 22, inclusive.
    // The XYZ plugin otherwise stops at zoom 19 (20 levels).
    levels: 23,
    // Dev proxy forwards the actual localhost origin for its separate key.
    url: `${import.meta.env.DEV ? '/maptiler' : 'https://api.maptiler.com'}/maps/satellite-v4/{z}/{x}/{y}.jpg?key=${encodeURIComponent(maptilerKey)}`,
  }))
  const updatePlugin = new UpdateOnChangePlugin()
  tiles.registerPlugin(updatePlugin)
  // CPU eviction runs after traversal. Wake a stationary camera when that
  // frees room for queued detail; otherwise it can stay on a coarse parent.
  tiles.addEventListener('dispose-model', () => tiles.dispatchEvent({ type: 'needs-update' }))
  const unloadPlugin = new UnloadTilesPlugin({ delay: 750, bytesTarget: 64 * 1024 * 1024 })
  tiles.registerPlugin(unloadPlugin as any)
  tiles.setCamera(camera)
  scene.add(tiles.group)

  // flipY: the image plugin pre-flips ImageBitmaps for WebGL; three's WebGPU
  // backend honours flipY itself → double flip. Node material with the shared
  // daylight/vignette dim so the imagery fades with the point cloud.
  const failedTiles = new Set<any>()
  let retryAt = Infinity
  let retryCount = 0
  let lastFailure = -Infinity
  tiles.addEventListener('load-root-tileset', () => {
    failedTiles.delete(null)
    if (failedTiles.size === 0) opts.onImageryStatus?.(null)
  })
  tiles.addEventListener('load-model', ({ scene: s, tile }: any) => {
    failedTiles.delete(tile)
    if (failedTiles.size === 0) opts.onImageryStatus?.(null)
    s.traverse((o: any) => {
      const map = o.material?.map
      if (!map) return
      map.flipY = false
      map.anisotropy = renderer.getMaxAnisotropy()
      map.needsUpdate = true
      const mat = new MeshBasicNodeMaterial()
      mat.map = map
      applyHighPrecisionAlways(mat)
      mat.colorNode = texture(map)
        .mul(uniforms.daylightColor)
        .mul(uniforms.daylightIntensity)
        .mul(maskDimNode(uniforms, 0.50))
      o.material.dispose()
      o.material = mat
    })
  })
  tiles.addEventListener('load-error', ({ error, tile }: any) => {
    failedTiles.add(tile)
    const code = /(?:code|status)\s+(\d{3})/i.exec(String(error?.message ?? ''))?.[1]
    opts.onImageryStatus?.(`MapTiler-Basemap nicht verfügbar${code ? ` (HTTP ${code})` : ''}`)
    // A temporary network/server failure must not leave a tile permanently
    // failed. Bound retries; permission and missing-resource errors need a fix.
    const now = performance.now()
    if (now - lastFailure > 60_000) retryCount = 0
    lastFailure = now
    const transient = !code || code === '408' || code === '429' || Number(code) >= 500
    if (transient && retryCount < 3 && !Number.isFinite(retryAt)) {
      retryAt = now + 1000 * 2 ** retryCount
    }
  })

  const controls = new WildGlobeControls(scene, camera, renderer.domElement, tiles, {
    mouseOrbitPivot,
    adjustOrbitPivot,
  })
  const pointerEasing = installPointerEasing(controls, {
    responseMs: mouseOrbitEaseMs,
    immediateShare: 0,
    mouseInertia,
  })
  controls.cameraRadius = cameraClearance
  controls.minDistance = cameraClearance
  controls.minAltitude = 0
  controls.maxAltitude = THREE.MathUtils.degToRad(EXPERIENCE_CONFIG.navigation.maximumOrbitDegrees)
  controls.enableDamping = true
  controls.rotationSpeed = mouseRotationSpeed
  const navigation = createNavigationGestures({
    ...opts.navigation, controls, camera, canvas: renderer.domElement, mode: mouseOrbitPivot,
  })

  const resolution = new THREE.Vector2()
  const setResolution = () => {
    renderer.getDrawingBufferSize(resolution)
    tiles.setResolution(camera, resolution.x, resolution.y)
  }
  setResolution()

  return {
    tiles,
    controls,
    pointerEasing,
    navigation,
    ellipsoid: (tiles as any).ellipsoid,
    setMemoryBudget(cacheMaxBytes, gpuBytesTarget) {
      tiles.lruCache.maxBytesSize = cacheMaxBytes
      tiles.lruCache.maxSize = Math.max(tiles.lruCache.maxSize, Math.round(cacheMaxBytes / (400 * 1024)))
      ;(unloadPlugin as any).bytesTarget = gpuBytesTarget
    },
    getMemoryBudget() {
      return {
        maxBytesSize: tiles.lruCache.maxBytesSize,
        minBytesSize: tiles.lruCache.minBytesSize,
        maxSize: tiles.lruCache.maxSize,
        gpuBytesTarget: (unloadPlugin as any).bytesTarget as number,
      }
    },
    setMemoryBudgetExact(budget) {
      tiles.lruCache.maxBytesSize = budget.maxBytesSize
      tiles.lruCache.minBytesSize = budget.minBytesSize
      tiles.lruCache.maxSize = budget.maxSize
      ;(unloadPlugin as any).bytesTarget = budget.gpuBytesTarget
    },
    updateControls(constrainCamera) {
      navigation.beforeUpdate()
      controls.update()
      navigation.afterUpdate()
      constrainCamera?.()
      // The library's GLSL pivot marker is not a node material; WebGPURenderer
      // rejects it even on its WebGL2 backend.
      ;(controls as any).pivotMesh?.removeFromParent()
      camera.updateMatrixWorld()
    },
    updateTiles() {
      // Hiding imagery must also stop network traversal (Anni's branch fix).
      if (tiles.group.visible) {
        if (performance.now() >= retryAt) {
          retryAt = Infinity
          retryCount++
          // resetFailedTiles only changes loadingState in 0.4.28. Its stale
          // LRU entry still prevents requestTileContents from enqueueing it.
          for (const tile of failedTiles) if (tile) tiles.lruCache.remove(tile)
          tiles.resetFailedTiles()
          tiles.dispatchEvent({ type: 'needs-update' })
        }
        tiles.update()
      }
    },
    setResolution,
    stats() {
      return {
        visible: tiles.visibleTiles.size,
        cacheBytes: (tiles.lruCache as any).cachedBytes ?? 0,
        gpuBytes: (unloadPlugin as any).estimatedGpuBytes ?? 0,
      }
    },
    dispose() {
      navigation.dispose()
      pointerEasing.dispose()
      controls.dispose()
      tiles.dispose()
      scene.remove(tiles.group)
    },
  }
}
