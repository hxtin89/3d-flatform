// MapTiler satellite imagery draped on a real WGS84 ellipsoid — the map context
// for the point cloud. Same architecture as the Cesium viewer's ?basemap=maptiler,
// but pure three.js via 3DTilesRendererJS:
//   TilesRenderer + XYZTilesPlugin({ shape: 'ellipsoid' })  → round Earth
//   GlobeControls                                           → map-style navigation
// No Cesium, no Ion. Uses the same satellite-v4 raster endpoint as the Cesium viewer.
import * as THREE from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import { texture } from 'three/tsl'
import { TilesRenderer, GlobeControls } from '3d-tiles-renderer'
import { XYZTilesPlugin, UpdateOnChangePlugin, UnloadTilesPlugin } from '3d-tiles-renderer/plugins'
import { maskDimNode, type CloudUniforms } from './point-cloud'

// Note: TilesFadePlugin is deliberately NOT used — its shader patching targets the
// WebGL program pipeline and is not safe on the WebGPU backend.

export interface Globe {
  tiles: TilesRenderer
  controls: GlobeControls
  ellipsoid: any
  update(): void
  setResolution(): void
  stats(): { visible: number; cacheBytes: number; gpuBytes: number }
  dispose(): void
}

export function createGlobe(opts: {
  renderer: { domElement: HTMLCanvasElement; getSize(v: THREE.Vector2): THREE.Vector2 }
  camera: THREE.PerspectiveCamera
  scene: THREE.Scene
  maptilerKey: string
  /** shared mask uniforms — the vignette fades the imagery to black with the cloud */
  uniforms: CloudUniforms
}): Globe {
  const { renderer, camera, scene, maptilerKey, uniforms } = opts

  const tiles = new TilesRenderer()
  // XYZ imagery otherwise inherits the library's ~300/400 MB CPU cache. That
  // cache exists in addition to point-cloud geometry and was the largest
  // unbounded allocation in the mobile path.
  tiles.lruCache.minSize = 24
  tiles.lruCache.maxSize = 96
  tiles.lruCache.minBytesSize = 24 * 1024 * 1024
  tiles.lruCache.maxBytesSize = 48 * 1024 * 1024
  tiles.downloadQueue.maxJobs = 4
  tiles.parseQueue.maxJobs = 2
  tiles.processNodeQueue.maxJobs = 4
  tiles.maxTilesProcessed = 80
  tiles.registerPlugin(new XYZTilesPlugin({
    shape: 'ellipsoid',
    useRecommendedSettings: true,
    tileDimension: 512,
    // same imagery endpoint as the Cesium viewer (buildMapTilerBaseLayer)
    url: `https://api.maptiler.com/maps/satellite-v4/{z}/{x}/{y}.jpg?key=${encodeURIComponent(maptilerKey)}`,
  }))
  tiles.registerPlugin(new UpdateOnChangePlugin())
  const unloadPlugin = new UnloadTilesPlugin({ delay: 750, bytesTarget: 32 * 1024 * 1024 })
  tiles.registerPlugin(unloadPlugin as any)
  tiles.setCamera(camera)
  scene.add(tiles.group)

  // The image plugin pre-flips tiles via createImageBitmap({imageOrientation:'flipY'})
  // because WebGL ignores Texture.flipY for ImageBitmaps. three's WebGPU backend,
  // however, DOES honour flipY for ImageBitmaps (in-shader UV flip) → double flip →
  // scrambled continents at low zoom. Clear the flag before first upload; harmless
  // on WebGL where it is ignored anyway.
  //
  // Each tile also gets a node material whose colour is multiplied by the shared
  // world-anchored vignette dim — in vignette mode the imagery fades to black around
  // the mask radius, so the point-cloud cutout blends seamlessly instead of sitting
  // as a bright hard circle on the map (dim is 1 in the other mask modes).
  tiles.addEventListener('load-model', ({ scene: s }: any) => {
    s.traverse((o: any) => {
      const map = o.material?.map
      if (!map) return
      map.flipY = false
      const mat = new MeshBasicNodeMaterial()
      mat.map = map // keep the texture discoverable for the tile disposal path
      mat.colorNode = texture(map).mul(maskDimNode(uniforms, 0.25))
      o.material.dispose()
      o.material = mat
    })
  })

  const controls = new GlobeControls(scene, camera, renderer.domElement, tiles)
  controls.enableDamping = true

  const setResolution = () => tiles.setResolutionFromRenderer(camera, renderer as any)
  setResolution()

  return {
    tiles,
    controls,
    ellipsoid: (tiles as any).ellipsoid,
    update() {
      controls.update()
      // EnvironmentControls adds a decorative GLSL ShaderMaterial pivot marker
      // during mouse drags. WebGPURenderer only accepts node materials, including
      // when it uses its WebGL2 backend. The marker is not part of navigation, so
      // remove it before rendering; touch controls already hide it themselves.
      ;(controls as any).pivotMesh?.removeFromParent()
      camera.updateMatrixWorld()
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
      controls.dispose()
      tiles.dispose()
      scene.remove(tiles.group)
    },
  }
}
