// Cesium Viewer construction for the full-feature variant. Every knob that
// silently boosts or throttles Cesium is pinned here so the browser comparison
// against the three.js/WebGPU app stays honest — see PORT_NOTES.md.
import * as Cesium from 'cesium'

const MAPTILER_SATELLITE_URL = 'https://api.maptiler.com/maps/satellite-v4/{z}/{x}/{y}.jpg'

export interface CesiumViewerSetup {
  viewer: Cesium.Viewer
  scene: Cesium.Scene
  camera: Cesium.Camera
  imageryLayer: Cesium.ImageryLayer | null
  /** Mirror of three's renderer.setPixelRatio(min(dpr, cap)). */
  setPixelRatioCap(cap: number | null): void
  dispose(): void
}

export function createCesiumViewer(opts: {
  container: HTMLElement
  maptilerKey: string
}): CesiumViewerSetup {
  Cesium.Ion.defaultAccessToken = ''

  const imageryLayer = opts.maptilerKey
    ? new Cesium.ImageryLayer(new Cesium.UrlTemplateImageryProvider({
      url: `${MAPTILER_SATELLITE_URL}?key=${encodeURIComponent(opts.maptilerKey)}`,
      minimumLevel: 0,
      maximumLevel: 20,
      tileWidth: 512,
      tileHeight: 512,
    }))
    : null

  const viewer = new Cesium.Viewer(opts.container, {
    animation: false,
    timeline: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    creditContainer: document.createElement('div'),
    baseLayer: imageryLayer ?? false,
    requestRenderMode: false,
    useBrowserRecommendedResolution: false,
    scene3DOnly: true,
    shadows: false,
    msaaSamples: 1,
    contextOptions: {
      webgl: { antialias: false, powerPreference: 'high-performance' },
    },
  })

  const scene = viewer.scene
  ;(viewer as any).targetFrameRate = undefined
  scene.postProcessStages.fxaa.enabled = false
  scene.highDynamicRange = false
  // Kept ON: globe precision + reliable merged-depth reconstruction for the
  // volumetric cloud post stage. Documented delta vs the three.js depth path.
  scene.logarithmicDepthBuffer = true
  scene.globe.baseColor = Cesium.Color.fromCssColorString('#0c1417')
  scene.globe.enableLighting = false
  if (scene.skyBox) scene.skyBox.show = false
  if (scene.moon) scene.moon.show = false
  if (scene.sun) scene.sun.show = false
  scene.backgroundColor = Cesium.Color.fromCssColorString('#8bc9ec')
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false
  scene.fog.enabled = false

  let pixelRatioCap: number | null = 1.25
  const applyResolutionScale = () => {
    const dpr = window.devicePixelRatio || 1
    // resolutionScale multiplies the browser-recommended resolution (pinned to
    // dpr via useBrowserRecommendedResolution:false) — dividing yields the same
    // drawing-buffer size as three's setPixelRatio(min(dpr, cap)).
    viewer.resolutionScale = pixelRatioCap === null ? 1 : Math.min(dpr, pixelRatioCap) / dpr
  }
  applyResolutionScale()
  const onResize = () => applyResolutionScale()
  window.addEventListener('resize', onResize)

  return {
    viewer,
    scene,
    camera: viewer.camera,
    imageryLayer,
    setPixelRatioCap(cap) {
      pixelRatioCap = cap
      applyResolutionScale()
    },
    dispose() {
      window.removeEventListener('resize', onResize)
      viewer.destroy()
    },
  }
}
