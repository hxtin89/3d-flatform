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

export interface Globe {
  tiles: TilesRenderer
  controls: WildGlobeControls
  pointerEasing: PointerEasing
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
  renderer: { domElement: HTMLCanvasElement; getSize(v: THREE.Vector2): THREE.Vector2 }
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
}): Globe {
  const {
    renderer, camera, scene, maptilerKey, cameraClearance, uniforms,
    mouseOrbitEaseMs, mouseRotationSpeed, mouseInertia, mouseOrbitPivot, adjustOrbitPivot,
  } = opts

  const tiles = new TilesRenderer()
  tiles.lruCache.minSize = 24
  tiles.lruCache.maxSize = 160
  tiles.lruCache.minBytesSize = 32 * 1024 * 1024
  tiles.lruCache.maxBytesSize = 96 * 1024 * 1024
  tiles.downloadQueue.maxJobs = 10
  tiles.parseQueue.maxJobs = 4
  tiles.processNodeQueue.maxJobs = 4
  tiles.maxTilesProcessed = 80
  tiles.registerPlugin(new XYZTilesPlugin({
    shape: 'ellipsoid',
    useRecommendedSettings: true,
    tileDimension: 512,
    // Dev goes through the vite proxy that strips the Referer (domain-restricted key).
    url: `${import.meta.env.DEV ? '/maptiler' : 'https://api.maptiler.com'}/maps/satellite-v4/{z}/{x}/{y}.jpg?key=${encodeURIComponent(maptilerKey)}`,
  }))
  tiles.registerPlugin(new UpdateOnChangePlugin())
  const unloadPlugin = new UnloadTilesPlugin({ delay: 750, bytesTarget: 64 * 1024 * 1024 })
  tiles.registerPlugin(unloadPlugin as any)
  tiles.setCamera(camera)
  scene.add(tiles.group)

  // flipY: the image plugin pre-flips ImageBitmaps for WebGL; three's WebGPU
  // backend honours flipY itself → double flip. Node material with the shared
  // daylight/vignette dim so the imagery fades with the point cloud.
  tiles.addEventListener('load-model', ({ scene: s }: any) => {
    s.traverse((o: any) => {
      const map = o.material?.map
      if (!map) return
      map.flipY = false
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

  const controls = new WildGlobeControls(scene, camera, renderer.domElement, tiles, {
    mouseOrbitPivot,
    adjustOrbitPivot,
  })
  const pointerEasing = installPointerEasing(controls, {
    responseMs: mouseOrbitEaseMs,
    immediateShare: EXPERIENCE_CONFIG.navigation.mouseImmediateShare,
    mouseInertia,
  })
  controls.cameraRadius = cameraClearance
  controls.minDistance = cameraClearance
  controls.minAltitude = 0
  controls.maxAltitude = THREE.MathUtils.degToRad(EXPERIENCE_CONFIG.navigation.maximumOrbitDegrees)
  controls.enableDamping = true
  controls.rotationSpeed = mouseRotationSpeed

  const setResolution = () => tiles.setResolutionFromRenderer(camera, renderer as any)
  setResolution()

  return {
    tiles,
    controls,
    pointerEasing,
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
      controls.update()
      constrainCamera?.()
      // The library's GLSL pivot marker is not a node material; WebGPURenderer
      // rejects it even on its WebGL2 backend.
      ;(controls as any).pivotMesh?.removeFromParent()
      camera.updateMatrixWorld()
    },
    updateTiles() {
      tiles.update()
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
      pointerEasing.dispose()
      controls.dispose()
      tiles.dispose()
      scene.remove(tiles.group)
    },
  }
}
