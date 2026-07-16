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
import { XYZTilesPlugin, UpdateOnChangePlugin } from '3d-tiles-renderer/plugins'
import { maskDimNode, type CloudUniforms } from './point-cloud'

// Note: TilesFadePlugin is deliberately NOT used — its shader patching targets the
// WebGL program pipeline and is not safe on the WebGPU backend.

export interface Globe {
  tiles: TilesRenderer
  controls: GlobeControls
  ellipsoid: any
  update(): void
  setResolution(): void
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
  tiles.registerPlugin(new XYZTilesPlugin({
    shape: 'ellipsoid',
    useRecommendedSettings: true,
    tileDimension: 512,
    // same imagery endpoint as the Cesium viewer (buildMapTilerBaseLayer)
    url: `https://api.maptiler.com/maps/satellite-v4/{z}/{x}/{y}.jpg?key=${encodeURIComponent(maptilerKey)}`,
  }))
  tiles.registerPlugin(new UpdateOnChangePlugin())
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
      camera.updateMatrixWorld()
      tiles.update()
    },
    setResolution,
    dispose() {
      controls.dispose()
      tiles.dispose()
      scene.remove(tiles.group)
    },
  }
}
