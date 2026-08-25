// MapTiler satellite imagery draped on a real WGS84 ellipsoid — the map context
// for the point cloud. Same architecture as the Cesium viewer's ?basemap=maptiler,
// but pure three.js via 3DTilesRendererJS:
//   TilesRenderer + XYZTilesPlugin({ shape: 'ellipsoid' })  → round Earth
//   GlobeControls                                           → map-style navigation
// No Cesium, no Ion. Uses the same satellite-v4 raster endpoint as the Cesium viewer.
import * as THREE from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import { texture, mix } from 'three/tsl'
import { TilesRenderer, GlobeControls } from '3d-tiles-renderer'
import { XYZTilesPlugin, UpdateOnChangePlugin, UnloadTilesPlugin } from '3d-tiles-renderer/plugins'
import {
  applyHighPrecisionAlways, applyMaskSurround, groundFogNode, gradeImageryNode,
  applyGroundPatch, rebuildEffectMaterial,
  type CloudUniforms,
} from './point-cloud'
import { EXPERIENCE_CONFIG } from './config'
import type { MemoryBudgetSnapshot } from './streaming'

// Note: TilesFadePlugin is deliberately NOT used — its shader patching targets the
// WebGL program pipeline and is not safe on the WebGPU backend.

export interface Globe {
  tiles: TilesRenderer
  controls: GlobeControls
  /**
   * Time constant in ms for easing the rotation pointer, 0 to disable. See the
   * comment where it is installed — this exists because a mouse reports whole
   * device pixels far more coarsely than the frame rate consumes them.
   */
  setPointerSmoothing(ms: number): void
  ellipsoid: any
  update(constrainCamera?: () => void): void
  setResolution(): void
  setMemoryBudget(cacheMaxBytes: number, gpuBytesTarget: number): void
  /** Exact snapshot & restore — setMemoryBudget never shrinks maxSize. */
  getMemoryBudget(): MemoryBudgetSnapshot
  setMemoryBudgetExact(budget: MemoryBudgetSnapshot): void
  /** Rebuild loaded imagery shaders after an effect switch — see setCloudEffectEnabled. */
  refreshEffects(): void
  /**
   * Stop or resume imagery traversal. Hiding `tiles.group` is not enough to stop
   * the network cost: the renderer keeps traversing and downloading whatever the
   * camera moves over, so a hidden basemap still spends the tile provider's
   * request quota — which is what suspended our MapTiler account. Skipping
   * `tiles.update()` is what actually stops the fetching. Navigation is
   * unaffected: controls and the camera constraint still run every frame.
   */
  setImageryEnabled(enabled: boolean): void
  /**
   * Screen-space error budget in pixels — how sharply the imagery refines, and
   * the main lever on how many tiles one view costs. See
   * `design.basemapErrorTarget` for the measured trade-off.
   */
  setErrorTarget(pixels: number): void
  stats(): { visible: number; cacheBytes: number; gpuBytes: number }
  dispose(): void
}

export function createGlobe(opts: {
  renderer: { domElement: HTMLCanvasElement; getSize(v: THREE.Vector2): THREE.Vector2 }
  camera: THREE.PerspectiveCamera
  /** ECEF-anchored parent — the floating-origin root, not the raw scene. */
  scene: THREE.Object3D
  maptilerKey: string
  /** Minimum height above the globe, derived from the point-cloud height. */
  cameraClearance: number
  /** shared mask uniforms — the vignette fades the imagery to black with the cloud */
  uniforms: CloudUniforms
}): Globe {
  const { renderer, camera, scene, maptilerKey, cameraClearance, uniforms } = opts

  /** Gates traversal in update(); see setImageryEnabled for why hiding is not enough. */
  let imageryEnabled = true

  const tiles = new TilesRenderer()
  // XYZ imagery otherwise inherits the library's ~300/400 MB CPU cache. That
  // cache exists in addition to point-cloud geometry and was the largest
  // unbounded allocation in the mobile path.
  tiles.lruCache.minSize = 24
  tiles.lruCache.maxSize = 160
  tiles.lruCache.minBytesSize = 32 * 1024 * 1024
  tiles.lruCache.maxBytesSize = 96 * 1024 * 1024
  // The XYZ plugin targets errorTarget = 1 (sharp imagery), which needs many
  // tiles per view. Four parallel downloads made deep zooms sharpen visibly
  // slowly and small caches thrashed below the working set — the "extremely
  // blurry basemap" reports. JPEG tiles are cheap next to point geometry.
  tiles.downloadQueue.maxJobs = 10
  tiles.parseQueue.maxJobs = 4
  tiles.processNodeQueue.maxJobs = 4
  tiles.maxTilesProcessed = 80
  tiles.registerPlugin(new XYZTilesPlugin({
    shape: 'ellipsoid',
    useRecommendedSettings: true,
    tileDimension: 512,
    // TilingScheme.generateLevels uses maxLevel = levels - 1, so +1 turns the
    // configured deepest zoom into a level count. Caps refinement at the depth
    // where the imagery still holds real detail — see design.basemapMaxZoom.
    levels: EXPERIENCE_CONFIG.design.basemapMaxZoom + 1,
    // Same imagery endpoint as the Cesium viewer (buildMapTilerBaseLayer). In dev
    // it goes through the vite proxy, which strips the Referer the domain-restricted
    // key rejects from localhost — see vite.config.ts.
    url: `${import.meta.env.DEV ? '/maptiler' : 'https://api.maptiler.com'}/maps/satellite-v4/{z}/{x}/{y}.jpg?key=${encodeURIComponent(maptilerKey)}`,
  }))
  tiles.registerPlugin(new UpdateOnChangePlugin())
  // After the plugin: useRecommendedSettings above writes errorTarget = 1, so the
  // configured value has to land afterwards to win.
  tiles.errorTarget = Math.max(EXPERIENCE_CONFIG.design.basemapErrorTarget, 0.5)
  const unloadPlugin = new UnloadTilesPlugin({ delay: 750, bytesTarget: 64 * 1024 * 1024 })
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
      // Imagery hangs off the same ECEF transforms as the point tiles and jitters
      // with them, but never follows the point-cloud precision toggle — mediump
      // tears visible gaps between the map tiles. See applyHighPrecisionAlways.
      applyHighPrecisionAlways(mat)
      // Keep enough satellite context outside the cloud spotlight to read paths
      // and terrain while the CSS vignette still provides a strong focal frame.
      // .rgb, not the raw vec4: gradeImageryNode mixes against a vec3 luma.
      // Rebuilt rather than parameterised, because the effect switches compile their
      // code out entirely instead of turning it down — see setCloudEffectEnabled.
      const buildColorNode = () => {
        const raw = texture(map).rgb
        const graded = gradeImageryNode(uniforms, raw)
          .mul(uniforms.daylightColor)
          .mul(uniforms.daylightIntensity)
        const fog = groundFogNode(uniforms)
        const fogged = fog ? mix(graded, fog.color, fog.amount) : graded
        const atmospheric = applyMaskSurround(uniforms, fogged, 0.50)
        // Last, on purpose: fog and the vignette are atmosphere for the map, and under
        // the point cloud there is no map to give atmosphere to. Applying the patch
        // after them is what makes the chosen colour or brightness the thing you
        // actually see — see applyGroundPatch.
        return applyGroundPatch(uniforms, atmospheric, raw)
      }
      mat.colorNode = buildColorNode()
      mat.userData.rebuildColorNode = () => { mat.colorNode = buildColorNode() }
      o.material.dispose()
      o.material = mat
    })
  })

  const controls = new GlobeControls(scene, camera, renderer.domElement, tiles)
  // Keep touch zoom and orbit above the surveyed canopy. cameraRadius is the
  // hard clearance from the globe, while minDistance prevents a zoom pivot
  // from pulling the camera through the surface. A 72° orbit ceiling keeps the
  // view downward instead of allowing it to roll under the data.
  controls.cameraRadius = cameraClearance
  controls.minDistance = cameraClearance
  controls.minAltitude = 0
  controls.maxAltitude = THREE.MathUtils.degToRad(EXPERIENCE_CONFIG.navigation.maximumOrbitDegrees)
  controls.enableDamping = true

  // Ease the rotation pointer toward where the mouse actually is, once per frame.
  //
  // The controls derive rotation from (pointer - previousPointer), and previousPointer
  // is refreshed once per frame by pointerTracker.updateFrame(). A mouse, though,
  // reports whole device pixels at its own rate, so most frames see no movement and
  // the occasional one sees a whole pixel step — a visible judder on mouse rotation
  // that the keyboard, being time-based, never had. The library's damping only applies
  // inertia after the drag is released, so it does not help here.
  //
  // updateFrame() runs at EnvironmentControls.js:1033, after _updateRotation() at :960,
  // so easing the live position here is read as a smooth step on the *next* frame and
  // previousPointer stays consistent with it.
  const tracker = (controls as any).pointerTracker
  const pointerTargets: Record<number, THREE.Vector2> = {}
  let smoothingMs: number = EXPERIENCE_CONFIG.navigation.pointerSmoothingMs
  let lastEaseMs = 0
  const originalUpdatePointer = tracker.updatePointer.bind(tracker)
  tracker.updatePointer = (event: PointerEvent) => {
    if (smoothingMs <= 0) return originalUpdatePointer(event)
    const id = event.pointerId
    const live = tracker.pointerPositions[id]
    if (!live) return originalUpdatePointer(event)
    // Let the original compute the raw position, then keep it as the target and put the
    // eased value back, so nothing downstream ever sees the raw jump.
    const eased = live.clone()
    const ok = originalUpdatePointer(event)
    if (ok) {
      ;(pointerTargets[id] ??= new THREE.Vector2()).copy(live)
      live.copy(eased)
    }
    return ok
  }
  const originalUpdateFrame = tracker.updateFrame.bind(tracker)
  tracker.updateFrame = () => {
    originalUpdateFrame()
    const now = performance.now()
    const elapsed = lastEaseMs ? Math.min(now - lastEaseMs, 100) : 0
    lastEaseMs = now
    if (smoothingMs <= 0 || elapsed <= 0) return
    // Time-based, so the feel does not change with frame rate.
    const alpha = 1 - Math.exp(-elapsed / smoothingMs)
    for (const id in tracker.pointerPositions) {
      const target = pointerTargets[id as unknown as number]
      if (target) tracker.pointerPositions[id].lerp(target, alpha)
    }
  }
  const setPointerSmoothing = (ms: number) => {
    smoothingMs = Math.max(0, ms)
    // Drop any easing in flight, or turning it off would leave a stale offset behind.
    for (const id in tracker.pointerPositions) {
      const target = pointerTargets[id as unknown as number]
      if (target) tracker.pointerPositions[id].copy(target)
    }
  }

  const setResolution = () => tiles.setResolutionFromRenderer(camera, renderer as any)
  setResolution()

  const setMemoryBudget = (cacheMaxBytes: number, gpuBytesTarget: number) => {
    tiles.lruCache.maxBytesSize = cacheMaxBytes
    tiles.lruCache.maxSize = Math.max(tiles.lruCache.maxSize, Math.round(cacheMaxBytes / (400 * 1024)))
    ;(unloadPlugin as any).bytesTarget = gpuBytesTarget
  }

  return {
    tiles,
    controls,
    setPointerSmoothing,
    ellipsoid: (tiles as any).ellipsoid,
    setMemoryBudget,
    getMemoryBudget() {
      return {
        maxBytesSize: tiles.lruCache.maxBytesSize,
        minBytesSize: tiles.lruCache.minBytesSize,
        maxSize: tiles.lruCache.maxSize,
        gpuBytesTarget: (unloadPlugin as any).bytesTarget as number,
      }
    },
    setMemoryBudgetExact(budget: MemoryBudgetSnapshot) {
      tiles.lruCache.maxBytesSize = budget.maxBytesSize
      tiles.lruCache.minBytesSize = budget.minBytesSize
      tiles.lruCache.maxSize = budget.maxSize
      ;(unloadPlugin as any).bytesTarget = budget.gpuBytesTarget
    },
    update(constrainCamera) {
      controls.update()
      constrainCamera?.()
      // EnvironmentControls adds a decorative GLSL ShaderMaterial pivot marker
      // during mouse drags. WebGPURenderer only accepts node materials, including
      // when it uses its WebGL2 backend. The marker is not part of navigation, so
      // remove it before rendering; touch controls already hide it themselves.
      ;(controls as any).pivotMesh?.removeFromParent()
      camera.updateMatrixWorld()
      // Navigation above always runs; only traversal and downloads are gated.
      if (imageryEnabled) tiles.update()
    },
    setResolution,
    refreshEffects() {
      tiles.group.traverse((object: any) => rebuildEffectMaterial(object.material))
    },
    setImageryEnabled(enabled) {
      if (enabled === imageryEnabled) return
      imageryEnabled = enabled
      tiles.group.visible = enabled
    },
    setErrorTarget(pixels) {
      tiles.errorTarget = Math.max(pixels, 0.5)
      // UpdateOnChangePlugin skips update() unless a camera moved or this event
      // fired, so without it the new budget only takes effect on the next camera
      // move — the slider would look broken while standing still.
      tiles.dispatchEvent({ type: 'needs-update' })
    },
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
