// MapTiler satellite imagery draped on a real WGS84 ellipsoid — the map context
// for the point cloud. Same architecture as the Cesium viewer's ?basemap=maptiler,
// but pure three.js via 3DTilesRendererJS:
//   TilesRenderer + XYZTilesPlugin({ shape: 'ellipsoid' })  → round Earth
//   GlobeControls                                           → map-style navigation
// No Cesium, no Ion. Uses the same satellite-v4 raster endpoint as the Cesium viewer.
import * as THREE from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import { float, materialReference, max, mix, positionWorld, vec4 } from 'three/tsl'
import { TilesRenderer, GlobeControls } from '3d-tiles-renderer'
import { XYZTilesPlugin, UpdateOnChangePlugin } from '3d-tiles-renderer/plugins'
import {
  applyHighPrecisionAlways, applyMaskSurround, groundFogNode, gradeImageryNode,
  applyGroundPatch, rebuildEffectMaterial, cloudEffectsVersion, imageryEffectsKey,
  isCloudEffectEnabled, sunLight, effectMaterialStale,
  type CloudUniforms,
} from './point-cloud'
import { EXPERIENCE_CONFIG } from './config'
import { onRebase } from './origin'
import type { MemoryBudgetSnapshot } from './streaming'
import { releaseVertexArraysOnDispose } from './vertex-arrays'
import { retryFailedTiles } from './tile-retry'
import { createOrthoComposite, type OrthoComposite, type OrthoCompositeConfig, type OrthoStats } from './ortho-composite'
import { parseSatelliteZxy, createPlanner, type OrthoDensity, type OrthoMeta } from './ortho-plan'
import { keepSatelliteBytes } from './ortho-upgrade'
import { canopyTransmittance } from './sun-shadows'
import { cloudTransmittance } from './sky-clouds'

// Note: TilesFadePlugin is deliberately NOT used — its shader patching targets the
// WebGL program pipeline and is not safe on the WebGPU backend.

export interface Globe {
  tiles: TilesRenderer
  controls: GlobeControls
  /**
   * Reset the controls even while a mouse button is held. `controls.resetState` is
   * deliberately ignored during a held drag — see where it is wrapped — so anything
   * that means to cancel a drag from our own side has to say so explicitly.
   */
  forceResetState(): void
  /** True while the pointer tracker holds a pointer but the controls have no state:
   * a press the library refused, or one whose data was lost. */
  hasStrandedPointer(): boolean
  /**
   * Solve this drag as though the press had happened at the centre of the screen, by
   * shifting the pointer the controls read by (x, y) CSS pixels. Set on a press that was
   * re-aimed at the view centre — see the bounded pan note in globe.ts — and cleared
   * automatically when the drag ends.
   */
  setPanPointerShift(x: number, y: number): void
  /** Where the cursor sits in CSS pixels relative to the canvas, unshifted. */
  getRawPointer(target: THREE.Vector2): THREE.Vector2 | null
  /**
   * Time constant in ms for easing the rotation pointer, 0 to disable. See the
   * comment where it is installed — this exists because a mouse reports whole
   * device pixels far more coarsely than the frame rate consumes them.
   */
  setPointerResponse(ms: number): void
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
  /** `cacheBytesCeiling` is the limit at which this tileset stops queueing downloads —
   *  reported so the HUD can put the basemap's share of memory against the basemap's own
   *  ceiling rather than against the point cloud's. */
  stats(): { visible: number; cacheBytes: number; cacheBytesCeiling: number; reuploadsAfterClose: number }
  /**
   * Paint the drone orthos into the satellite tiles they cover (ortho-composite.ts): settled
   * covered tiles are upgraded in their own texture, the ones already loaded included, so
   * nothing is reloaded. Resolves false when the ortho cannot run here; the basemap then stays
   * satellite only.
   */
  attachOrtho(ortho: {
    meta: OrthoMeta; rootTransform: ArrayLike<number>; fieldBaseUrl: string
    config: OrthoCompositeConfig; density: OrthoDensity | 'off'; thinUnderPatch: boolean; debugKinds: boolean
    /** False until the Start click and while a camera flight runs. */
    upgradesAllowed: () => boolean
    /** Point tiles arrived so far: a swap waits out a frame that uploads an arriving point tile. */
    pointArrivals: () => number
    /** The point stream has tiles queued, downloading or parsing: ortho requests wait for it. */
    pointsBusy: () => boolean
  }): Promise<boolean>
  /** Off puts the satellite back into upgraded tiles from their kept bytes; On upgrades again. */
  setOrthoEnabled(on: boolean): void
  /** Re-composes upgraded tiles in place at the new density ('off' reverts them). */
  setOrthoDensity(density: OrthoDensity | 'off'): void
  orthoStats(): OrthoStats | null
  /** Stops keeping satellite bytes when the ortho will not run in this session. A no-op after
   *  attachOrtho, whose reverts need them. */
  releaseOrthoBytes(): void
  dispose(): void
}

/**
 * The imagery colour graph, built once and shared by every basemap tile.
 *
 * It used to be built per tile inside the `load-model` handler, and that cost more than
 * anything else in bringing a map tile online: three keys its node-builder cache on node
 * *identity*, so two structurally identical graphs built separately always miss and each
 * re-runs a full TSL build inside the render pass. Measured by material type on a high
 * tilted view, after the same fix landed for the point cloud: 27 builds at 9.1 ms each,
 * 246 ms in a single drag, and by then it was the largest remaining item.
 *
 * The one genuinely per-tile input is the texture, and `materialReference` is three's own
 * answer for that — with no material passed it resolves against the material of the object
 * currently being drawn, so one node reads each tile's own `map`. That is why `mat.map`
 * has to keep being set; it was previously kept only for the disposal path.
 *
 * Keyed on the effect flags the map graph reads, because the effect switches compile their
 * code out entirely rather than turning it down: a flip of one of those has to produce a
 * different graph, and a flip of any other must not cost the map a build.
 */
const imageryGraphCache = new Map<string, any>()

/** In dev the vite proxy, which claims an origin the domain-restricted key accepts. */
const MAPTILER_BASE = import.meta.env.DEV ? '/maptiler' : 'https://api.maptiler.com'

/** z of an XYZ tile URL ending in /{z}/{x}/{y}.<ext>, or -1. */
export function zoomOfTileUrl(url: string | undefined): number {
  const m = /\/(\d+)\/\d+\/\d+\.[a-z]+(?:\?|$)/i.exec(url ?? '')
  return m ? Number(m[1]) : -1
}

function imageryColorNode(uniforms: CloudUniforms): any {
  const key = imageryEffectsKey()
  const cached = imageryGraphCache.get(key)
  if (cached) return cached
  // Any older graph is for a flag set that no longer holds. Dropped rather than kept,
  // because each one's map reference still holds the last tile material it drew.
  imageryGraphCache.clear()

  const raw = (materialReference('map', 'texture') as any).rgb
  // Physically lit (effects.sunLight): flat ground takes the sun by the sine of its elevation.
  const lit = isCloudEffectEnabled('sunLight')
  const enu = (uniforms.enuInverse as any).mul(vec4(positionWorld, 1)).xyz
  const canopy = lit && isCloudEffectEnabled('canopyShadows') ? canopyTransmittance(enu, float(0)) : float(1)
  // The sky's cloud shadows with or without the sun light, as on the points.
  const skyClouds = isCloudEffectEnabled('cloudShadows') && isCloudEffectEnabled('skyCloudShadows')
  const clouds = skyClouds ? cloudTransmittance(enu) : float(1)
  const graded = lit
    ? gradeImageryNode(uniforms, raw).mul(sunLight(uniforms, max(uniforms.sunDirectionEnu.z, 0), (canopy as any).mul(clouds)))
    : skyClouds
      ? gradeImageryNode(uniforms, raw).mul(uniforms.daylightColor).mul(uniforms.daylightIntensity).mul(clouds)
      : gradeImageryNode(uniforms, raw)
        .mul(uniforms.daylightColor)
        .mul(uniforms.daylightIntensity)
  const fog = groundFogNode(uniforms)
  const fogged = fog ? mix(graded, fog.color, fog.amount) : graded
  const atmospheric = applyMaskSurround(uniforms, fogged, 0.50)
  // Last, on purpose: fog and the vignette are atmosphere for the map, and under the point
  // cloud there is no map to give atmosphere to. Applying the patch after them is what
  // makes the chosen colour or brightness the thing you actually see — see applyGroundPatch.
  const node = applyGroundPatch(uniforms, atmospheric, raw)
  // Versions only grow, so an older graph is never looked up again; dropping it lets go of
  // the last material and texture its reference nodes still point at.
  imageryGraphCache.clear()
  imageryGraphCache.set(key, node)
  return node
}

export function createGlobe(opts: {
  renderer: { domElement: HTMLCanvasElement; getSize(v: THREE.Vector2): THREE.Vector2; initTexture?(texture: THREE.Texture): void }
  camera: THREE.PerspectiveCamera
  /** ECEF-anchored parent — the floating-origin root, not the raw scene. */
  scene: THREE.Object3D
  maptilerKey: string
  /** Minimum height above the globe, derived from the point-cloud height. */
  cameraClearance: number
  /** shared mask uniforms — the vignette fades the imagery to black with the cloud */
  uniforms: CloudUniforms
  /**
   * Metres one drag may pan before it stops. Asked for when a drag is armed rather than
   * pushed in beforehand: the height it scales with is only known in main.ts (the
   * ellipsoid altitude reachable from here reads 0 while the cloud is ground-snapped),
   * and pulling it removes any ordering contract between the two modules.
   */
  panBudgetM?: () => number
  /** Keep each covered tile's satellite JPEG from the start, for the drone ortho's upgrades
   *  and reverts. Off when the ortho cannot run in this session. */
  keepSatelliteBytes?: boolean
}): Globe {
  const { renderer, camera, scene, maptilerKey, cameraClearance, uniforms } = opts

  /** Gates traversal in update(); see setImageryEnabled for why hiding is not enough. */
  let imageryEnabled = true

  const tiles = new TilesRenderer()
  // A dropped imagery request would otherwise leave its whole subtree missing for the
  // session: a square of sky through the ground. See tile-retry.ts.
  const stopRetrying = retryFailedTiles(tiles as any, 'globe')
  // XYZ imagery otherwise inherits the library's ~300/400 MB CPU cache. That
  // cache exists in addition to point-cloud geometry and was the largest
  // unbounded allocation in the mobile path — hence a cap. But the cap has to
  // clear the working set, or it costs far more than it saves.
  //
  // Measured 2026-09-04 at the old 96 MB ceiling: 94 tiles of ~1.02 MB, every one
  // of them marked used. Eviction only removes *unused* tiles, so there was
  // nothing to free, while `isFull()` refused every further request in
  // queueTileForDownload. Tiles still missing were therefore never fetched — and
  // since the draped imagery is the only surface the globe has, those gaps showed
  // the sky through the map. A ceiling under the working set does not save memory,
  // it just stops the basemap completing.
  //
  // The count ceiling has to clear it too, or it simply becomes the new binder:
  // 256 MB is roughly 250 tiles at the measured size.
  tiles.lruCache.minSize = 24
  tiles.lruCache.maxSize = 320
  tiles.lruCache.minBytesSize = 32 * 1024 * 1024
  tiles.lruCache.maxBytesSize = 256 * 1024 * 1024
  // The XYZ plugin targets errorTarget = 1 (sharp imagery), which needs many
  // tiles per view. Four parallel downloads made deep zooms sharpen visibly
  // slowly and small caches thrashed below the working set — the "extremely
  // blurry basemap" reports. JPEG tiles are cheap next to point geometry.
  tiles.downloadQueue.maxJobs = 10
  tiles.parseQueue.maxJobs = 4
  tiles.processNodeQueue.maxJobs = 4
  tiles.maxTilesProcessed = 80
  const xyz = new XYZTilesPlugin({
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
    url: `${MAPTILER_BASE}/maps/satellite-v4/{z}/{x}/{y}.jpg?key=${encodeURIComponent(maptilerKey)}`,
  })
  tiles.registerPlugin(xyz)
  // The satellite JPEG of every tile the ortho may upgrade, kept with its texture from the first
  // tile on (the ortho attaches later, after the loader). About 28 KB a tile; dropped below the
  // ortho's lowest zoom and, once its coverage is known, for tiles it does not cover.
  const satellite = keepSatelliteBytes((xyz as any).imageSource, opts.keepSatelliteBytes === true)
  const ORTHO_MIN_ZOOM = EXPERIENCE_CONFIG.design.droneOrtho.minZoom
  let orthoCovers: ((tile: any) => boolean) | null = null
  let ortho: OrthoComposite | null = null
  tiles.registerPlugin(new UpdateOnChangePlugin())
  // After the plugin: useRecommendedSettings above writes errorTarget = 1, so the
  // configured value has to land afterwards to win.
  tiles.errorTarget = Math.max(EXPERIENCE_CONFIG.design.basemapErrorTarget, 0.5)
  // No UnloadTilesPlugin: each tile's image is closed once it is on the GPU (below), so a
  // GPU copy cannot be rebuilt and has to live as long as the tile's cache entry. The
  // cache itself drops tiles that leave the view within frames, and at a settled view the
  // plugin never freed anything; at most it unloaded hidden ancestors on the constrained
  // tier, which now stay on the GPU instead (on phones that is one-for-one against the
  // image that is no longer kept). Do not bring it back without dropping the close.
  tiles.setCamera(camera)
  scene.add(tiles.group)

  // The backstop under refreshEffects: a tile shown again with a graph older than the effect
  // flags is rebuilt before it draws (the event fires inside tiles.update(), before the render).
  const onTileShown = ({ scene: s, visible }: any) => {
    if (!visible || !s) return
    s.traverse((o: any) => { if (effectMaterialStale(o.material)) rebuildEffectMaterial(o.material) })
  }
  tiles.addEventListener('tile-visibility-change', onTileShown)

  // The image plugin pre-flips tiles via createImageBitmap({imageOrientation:'flipY'})
  // because WebGL ignores Texture.flipY for ImageBitmaps. three's WebGPU backend,
  // however, DOES honour flipY for ImageBitmaps (copyExternalImageToTexture flips) → double
  // flip → scrambled continents at low zoom. Clear the flag before first upload; harmless
  // on WebGL where it is ignored anyway. The drone ortho's composites are pre-flipped the
  // same way, so the flag stays right when one replaces the image.
  //
  // Each tile also gets a node material whose colour is multiplied by the shared
  // world-anchored vignette dim — in vignette mode the imagery fades to black around
  // the mask radius, so the point-cloud cutout blends seamlessly instead of sitting
  // as a bright hard circle on the map (compiled out in the other mask modes).
  //
  // And on the WebGL2 fallback each tile's vertex-array objects are deleted with its
  // geometry, which three never does — see vertex-arrays.ts. Registered here because the
  // tile has not been drawn yet, so the listener lands before three's own.
  //
  // Each tile's decoded image (a 512² ImageBitmap, 1 MiB) is closed once three has copied
  // it to the GPU: until now every resident tile held it for nothing, next to its texture.
  // A microtask later rather than inside onUpdate, because three counts the texture's
  // size from the image right after calling it. The callback stays on as a tripwire: a
  // second upload of a live map would read a closed image and leave the tile's imagery
  // as it was, so it is counted and warned about. Anything that bumps a map's version
  // would cause one — needsUpdate, mipmaps, a new colour space — so none of that may
  // touch these textures. It is switched off once the tile is evicted: three can briefly
  // re-create an evicted map through a binding the tiles share, which is harmless (the
  // library closes the image on eviction either way) and not what the tripwire is for.
  let reuploadsAfterClose = 0
  const releaseImageAfterUpload = (texture: THREE.Texture): void => {
    const image = texture.image as ImageBitmap | undefined
    if (!image || typeof image.close !== 'function') return
    if (image.width === 0) {
      if (reuploadsAfterClose++ === 0) console.warn('[globe] a basemap texture was uploaded again after its image was closed')
      return
    }
    queueMicrotask(() => image.close())
  }
  tiles.addEventListener('load-model', ({ scene: s, tile }: any) => {
    // The XYZ zoom, for the per-zoom colour gain (gradeImageryNode). From the tile's own URL
    // (…/{z}/{x}/{y}.jpg): the plugin keeps level/x/y under module-private Symbols.
    const zoom = zoomOfTileUrl(tile?.content?.uri)
    s.traverse((o: any) => {
      if (o.geometry) releaseVertexArraysOnDispose(renderer, o.geometry)
      const map = o.material?.map
      if (!map) return
      map.flipY = false
      // The image's size outlives the image: the ortho upgrade (ortho-upgrade.ts) checks a
      // replacement bitmap against it once the image below has been closed.
      if (map.image) map.userData.imageSize = { width: map.image.width, height: map.image.height }
      map.onUpdate = releaseImageAfterUpload
      map.addEventListener('dispose', () => { map.onUpdate = null })
      // Tagged for the upload probe in arrival-cost.ts, which books imagery uploads apart.
      map.userData.basemapImagery = true
      if (zoom < ORTHO_MIN_ZOOM || (orthoCovers && !orthoCovers(tile))) satellite.drop(map)
      const mat = new MeshBasicNodeMaterial()
      mat.map = map // keep the texture discoverable for the tile disposal path
      mat.userData.basemapZoom = zoom
      // Imagery hangs off the same ECEF transforms as the point tiles and jitters
      // with them, but never follows the point-cloud precision toggle — mediump
      // tears visible gaps between the map tiles. See applyHighPrecisionAlways.
      applyHighPrecisionAlways(mat)
      // Keep enough satellite context outside the cloud spotlight to read paths
      // and terrain while the CSS vignette still provides a strong focal frame.
      // .rgb, not the raw vec4: gradeImageryNode mixes against a vec3 luma.
      // Rebuilt rather than parameterised, because the effect switches compile their
      // code out entirely instead of turning it down — see setCloudEffectEnabled.
      mat.colorNode = imageryColorNode(uniforms)
      mat.userData.rebuildEffectGraph = () => { mat.colorNode = imageryColorNode(uniforms) }
      // Stamped like the point tiles, so one parked in the cache across an effect switch is
      // caught when it is shown again (onTileShown below).
      mat.userData.effectsVersion = cloudEffectsVersion()
      // The ground for the physical haze: colour transmittance, and the exact ground lookup from
      // a high camera (atmosphere-haze.ts volumeHaze).
      mat.userData.hazeGround = true
      o.material.dispose()
      o.material = mat
      // The library lists a tile's materials before this event and disposes that list on
      // eviction, so the replacement has to join it; the unload plugin used to dispose it
      // as a side effect. Left out, every evicted tile would keep its render object's
      // uniform buffers in three's memory map.
      tile?.engineData?.materials?.push(mat)
    })
  })

  const controls = new GlobeControls(scene, camera, renderer.domElement, tiles)
  // Mouse drags are not pointer-captured by the library (touch is), so the document's
  // pointerleave — fired the moment the cursor crosses the window edge mid-drag —
  // resets the drag while the button is still held: moves stop arriving, the leftover
  // rotation inertia coasts uncontrolled, and the held button stays dead until it is
  // released and pressed again. Capturing the pointer keeps moves and the release
  // flowing from outside the window and suppresses that pointerleave entirely.
  renderer.domElement.addEventListener('pointerdown', (event: PointerEvent) => {
    if (event.pointerType !== 'mouse') return
    try {
      renderer.domElement.setPointerCapture(event.pointerId)
    } catch {
      // Synthetic events and already-released pointers have no capturable pointer.
    }
  })
  //
  // The capture alone is not enough, because that pointerleave can still fire (a
  // synthetic release, a lost capture) and its reset empties the pointer tracker while
  // the library keeps the drag state — and the very next frame the library reads
  // getCenterPoint() on an empty tracker, which copies `undefined` and throws inside
  // the render loop. So the true button state is tracked here and resetState is ignored
  // while a mouse button is genuinely still down.
  //
  // Everything below is mouse-only: touch keeps the library's own pointer capture and
  // its multi-touch resets untouched, which is what mobile depends on. Deliberate
  // resets from our own code go through forceResetState so they still land.
  let mouseButtonDown = false
  const originalResetState = controls.resetState.bind(controls)
  const forceResetState = (): void => originalResetState()
  // Only the window-edge pointerleave is suppressed, and only while a mouse button is
  // genuinely down. Blocking resetState wholesale — the first attempt — also blocked the
  // library's own escapes, and one of them matters enormously: when the cursor ray misses
  // the globe sphere, GlobeControls does `resetState(); _updateInertia()` to end the drag
  // and coast. With the reset swallowed, the drag never ended and that escape re-fired
  // every frame, each time applying globe inertia at ~1/dt. Measured: state stuck at DRAG,
  // globeInertiaFactor 130-196 every frame, steps growing 242 -> 1278 m, 11 km travelled
  // on one upward drag. Capture phase on window, so it lands before the library's own
  // document listener.
  const suppressEdgeLeave = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse' || !mouseButtonDown) return
    event.stopImmediatePropagation()
  }
  window.addEventListener('pointerleave', suppressEdgeLeave, true)
  // An abnormal end — the release went missing, or the window lost focus — is a plain
  // reset. A rescue used to sit here, clearing inertiaStableFrames so an interrupted spin
  // kept coasting, on the theory that the library kills inertia once that counter climbs.
  // Measured over the abnormal ends this can actually produce: the counter was never above
  // 1, because a quiet event stream makes the library skip the update that increments it.
  // The abrupt stop it was written for turned out to be the floor clamp, fixed separately.
  // Capture phase on window, so these run before the library's own document handlers
  // and the button state is already current when its listeners look at it.
  const trackPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'mouse') mouseButtonDown = true
  }
  const trackPointerUp = (event: PointerEvent) => {
    if (event.pointerType === 'mouse') mouseButtonDown = false
  }
  const trackPointerMove = (event: PointerEvent) => {
    // A mouse move reporting no pressed button while a drag is live means the release
    // went missing — it landed outside an uncaptured pointer, or the capture was lost.
    if (event.pointerType !== 'mouse' || event.buttons !== 0) return
    mouseButtonDown = false
    if ((controls as any).state !== 0) forceResetState()
  }
  const trackBlur = () => {
    mouseButtonDown = false
    forceResetState()
  }
  window.addEventListener('pointerdown', trackPointerDown, true)
  window.addEventListener('pointerup', trackPointerUp, true)
  window.addEventListener('pointercancel', trackPointerUp, true)
  window.addEventListener('pointermove', trackPointerMove, true)
  window.addEventListener('blur', trackBlur)
  // Keep touch zoom and orbit above the surveyed canopy. cameraRadius is the
  // hard clearance from the globe, while minDistance prevents a zoom pivot
  // from pulling the camera through the surface. A 72° orbit ceiling keeps the
  // view downward instead of allowing it to roll under the data.
  controls.cameraRadius = cameraClearance
  controls.minDistance = cameraClearance
  controls.minAltitude = 0
  controls.maxAltitude = THREE.MathUtils.degToRad(EXPERIENCE_CONFIG.navigation.maximumOrbitDegrees)
  controls.enableDamping = true

  // ---------------------------------------------------------------- bounded pan
  //
  // A grab near the horizon pans absurdly fast. GlobeControls pans by intersecting the
  // cursor ray with a sphere through the grabbed point and rotating about the Earth's
  // centre; up there the ray meets that sphere at a grazing angle, so a pixel of cursor
  // motion sweeps an enormous arc. Two things that do NOT fix it, both measured: pulling
  // the grabbed point closer to the camera (the sphere's radius is the Earth's, so a few
  // hundred metres changes nothing), and clamping the ray to a minimum descent (the clamp
  // then absorbs all vertical cursor motion — the pan froze at 0.01 m/frame after a 52 m
  // first-frame jump).
  //
  // What works is to make the gesture *be* a mid-screen drag, which is well conditioned
  // by construction: main.ts re-aims such a press at the point in the centre of the view
  // and hands the offset here, and this shifts the pointer the controls read by it. The
  // cursor's own motion still drives the pan unchanged — only the geometry it is solved
  // against moves to the middle of the screen. All of the library's globe maths, inertia
  // and edge handling stay in play.
  //
  // The shift lives exactly as long as the drag: main.ts sets it on the press it re-aims,
  // and update() clears it as soon as the drag state is gone.
  const DRAG_STATE = 1
  const panShift = new THREE.Vector2()
  let panShiftActive = false

  const originalGetCenterPoint = (controls as any).pointerTracker.getCenterPoint
    .bind((controls as any).pointerTracker)
  // Applied where the controls read the pointer, so the ray, the previous position and
  // the move distance all see one consistent pointer. Differences are unaffected — the
  // same shift cancels out of both terms.
  ;(controls as any).pointerTracker.getCenterPoint = (target: THREE.Vector2, positions?: any) => {
    const result = originalGetCenterPoint(target, positions)
    if (result && panShiftActive) target.sub(panShift)
    return result
  }

  // How far this drag has taken the world, and the budget it may spend.
  //
  // Net displacement from the press, so dragging out and back costs nothing and only the
  // ground actually covered is bounded. Needed even with the re-aim: the shift is fixed
  // for the length of a drag, so carrying the cursor on toward the horizon takes the
  // re-aimed pointer into the shallow region with it and the world can be pushed
  // enormously far. At the budget the pan simply stops — lift the button and drag again
  // to continue.
  const panDragStart = new THREE.Vector3()
  let panBudget = 0
  let panBudgetArmed = false
  // Rebase-aware, like the held pivot in main.ts. Both this and camera.position are
  // render-space, and a rebase moves every render-space point: without this the start
  // stays in the old frame while the camera is measured in the new one, so the distance
  // is nonsense and the budget never bites. Measured before the fix: a drag budgeted at
  // 1.68 km travelled 8.5 km, while render-space arithmetic reported it as being inside
  // the budget the whole way.
  const detachPanRebase = onRebase((delta) => { panDragStart.add(delta) })

  const originalUpdatePosition = (controls as any)._updatePosition.bind(controls)
  ;(controls as any)._updatePosition = (deltaTime: number): void => {
    // Arming only. The budget is enforced in update(), which also sees the coast frames.
    if ((controls as any).state === DRAG_STATE && !panBudgetArmed) {
      panBudgetArmed = true
      panDragStart.copy(camera.position)
      const requested = opts.panBudgetM?.() ?? 0
      panBudget = requested > 0 ? requested : EXPERIENCE_CONFIG.navigation.maxPanPerDragMinM
    }
    originalUpdatePosition(deltaTime)
  }

  /** True while a released pan is still coasting. */
  const panCoasting = (): boolean =>
    ((controls as any).dragInertia?.lengthSq() ?? 0) > 0
    || ((controls as any).globeInertiaFactor ?? 0) !== 0

  /**
   * Hold the pan inside its budget, drag and coast alike.
   *
   * Enforced here rather than inside the pan step because the drag is not the only thing
   * that spends the budget: a drag that ends under it hands its velocity to the damping,
   * and measured, that coast carried a 626 m pan on to 1056 m — past a budget of 800.
   * The budget therefore lives until the coast has died, not until the button comes up.
   */
  const holdPanBudget = (): void => {
    if (!panBudgetArmed) return
    if ((controls as any).state !== DRAG_STATE && !panCoasting()) {
      panBudgetArmed = false
      return
    }
    const moved = camera.position.distanceTo(panDragStart)
    // "Not within budget" rather than "over", so a non-finite camera is left to the
    // recovery in main.ts instead of being lerped here.
    if (!(moved > panBudget)) return
    camera.position.lerpVectors(panDragStart, camera.position, panBudget / moved)
    camera.updateMatrixWorld()
    ;(controls as any).dragInertia.set(0, 0, 0)
    ;(controls as any).globeInertia.identity()
    ;(controls as any).globeInertiaFactor = 0
  }

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
  const pointerTargets: Record<number, THREE.Vector2 | undefined> = {}
  let responseMs: number = EXPERIENCE_CONFIG.navigation.pointerResponseMs
  let lastEaseMs = 0
  // The pointer id is stable for a mouse, so a target left over from the previous drag
  // would still be there at the next press — and the first frame would ease toward it
  // before any movement arrived, throwing the view sideways on every click. Targets
  // therefore live exactly as long as the press does.
  const originalAddPointer = tracker.addPointer.bind(tracker)
  tracker.addPointer = (event: PointerEvent) => {
    originalAddPointer(event)
    delete pointerTargets[event.pointerId]
  }
  const originalDeletePointer = tracker.deletePointer.bind(tracker)
  tracker.deletePointer = (event: PointerEvent) => {
    originalDeletePointer(event)
    delete pointerTargets[event.pointerId]
  }
  const originalUpdatePointer = tracker.updatePointer.bind(tracker)
  tracker.updatePointer = (event: PointerEvent) => {
    const id = event.pointerId
    const live = tracker.pointerPositions[id]
    if (!live) return originalUpdatePointer(event)
    // Let the original compute the raw position, then keep it as the target and put the
    // eased value back, so nothing downstream ever sees the raw jump.
    const eased = live.clone()
    const ok = originalUpdatePointer(event)
    if (ok && responseMs > 0) {
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
    if (responseMs <= 0 || elapsed <= 0) return
    // Time-based, so the feel does not change with frame rate.
    const alpha = 1 - Math.exp(-elapsed / responseMs)
    for (const id in tracker.pointerPositions) {
      const target = pointerTargets[id as unknown as number]
      if (target) tracker.pointerPositions[id].lerp(target, alpha)
    }
  }
  const setPointerResponse = (ms: number) => {
    responseMs = Math.max(0, ms)
    // Drop any easing in flight, or turning it off would leave a stale offset behind.
    for (const id in tracker.pointerPositions) {
      const target = pointerTargets[id as unknown as number]
      if (target) tracker.pointerPositions[id].copy(target)
    }
  }

  const setResolution = () => tiles.setResolutionFromRenderer(camera, renderer as any)
  setResolution()

  // The basemap has no GPU target of its own any more: its GPU copies live exactly as
  // long as the cache entries, so the cache ceiling bounds both. The value is only kept
  // so a budget snapshot has the same shape as the point cloud's and restores exactly.
  let gpuBytesTarget = 64 * 1024 * 1024
  // A full cache refuses requests during a traversal and asks again only in the next one,
  // and UpdateOnChangePlugin runs one only when the camera moves. So a ceiling raised under
  // a still camera loaded nothing until the view was touched; ask for the traversal here.
  const requestTraversal = () => tiles.dispatchEvent({ type: 'needs-update' } as any)
  const setMemoryBudget = (cacheMaxBytes: number, nextGpuBytesTarget: number) => {
    tiles.lruCache.maxBytesSize = cacheMaxBytes
    tiles.lruCache.maxSize = Math.max(tiles.lruCache.maxSize, Math.round(cacheMaxBytes / (400 * 1024)))
    gpuBytesTarget = nextGpuBytesTarget
    requestTraversal()
  }

  return {
    tiles,
    controls,
    forceResetState,
    setPanPointerShift(x, y) {
      panShift.set(x, y)
      panShiftActive = true
    },
    getRawPointer(target) {
      return originalGetCenterPoint(target) ? target : null
    },
    hasStrandedPointer() {
      const tracker = (controls as any).pointerTracker
      return (controls as any).state === 0 && (tracker?.getPointerCount?.() ?? 0) > 0
    },
    setPointerResponse,
    ellipsoid: (tiles as any).ellipsoid,
    setMemoryBudget,
    getMemoryBudget() {
      return {
        maxBytesSize: tiles.lruCache.maxBytesSize,
        minBytesSize: tiles.lruCache.minBytesSize,
        maxSize: tiles.lruCache.maxSize,
        gpuBytesTarget,
      }
    },
    setMemoryBudgetExact(budget: MemoryBudgetSnapshot) {
      tiles.lruCache.maxBytesSize = budget.maxBytesSize
      tiles.lruCache.minBytesSize = budget.minBytesSize
      tiles.lruCache.maxSize = budget.maxSize
      gpuBytesTarget = budget.gpuBytesTarget
      requestTraversal()
    },
    update(constrainCamera) {
      // The pointer shift belongs to one drag only. The budget clears itself once the
      // coast it also governs has died — see holdPanBudget.
      if ((controls as any).state !== DRAG_STATE) panShiftActive = false
      // Freeze the terrain-clearance push while anything is held.
      //
      // adjustHeight re-reads the ground directly under the camera every frame and, when
      // it is closer than cameraRadius, lifts camera AND pivotPoint by the difference.
      // That ground height comes from whichever tiles happen to be resident, so a tile
      // landing mid-drag changes it and the pivot moves out from under the cursor — the
      // reported "pivot drifts while new tiles load". Nothing is lost by freezing it for
      // the length of a gesture: a drag orbits at constant radius or rides a horizontal
      // plane, and enforceNavigationBounds still holds the camera above the survey floor
      // every frame. It resumes the moment the pointer is released.
      const interacting = (controls as any).state !== 0
        || ((controls as any).pointerTracker?.getPointerCount?.() ?? 0) > 0
      controls.adjustHeight = !interacting
      controls.update()
      holdPanBudget()
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
      // Every loaded tile, not just the ones in the scene group: a tile hidden in the cache
      // is out of the group, and would otherwise come back with the graph it left with.
      tiles.forEachLoadedModel((model: any) => {
        model.traverse((object: any) => rebuildEffectMaterial(object.material))
      })
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
        cacheBytesCeiling: (tiles.lruCache as any).maxBytesSize ?? 0,
        reuploadsAfterClose,
      }
    },
    async attachOrtho(options) {
      if (ortho) return true
      const hadBytes = satellite.capturing
      satellite.setCapturing(true)
      const covers = createPlanner(options.meta.sources, { minZoom: options.config.minZoom, density: 'half', disabled: new Set() })
      orthoCovers = (tile) => {
        const zxy = parseSatelliteZxy(tile?.content?.uri ?? '')
        return !!zxy && covers(zxy.z, zxy.x, zxy.y) !== null
      }
      tiles.forEachLoadedModel((scene: any, tile: any) => {
        const map = scene?.material?.map
        if (map && !orthoCovers!(tile)) satellite.drop(map)
      })
      ortho = createOrthoComposite({
        ...options,
        tiles,
        satellite,
        // Only a texture three holds a GPU copy of: a freed one is rebuilt at its next draw
        // anyway, from whatever image it has then.
        upload: (texture) => {
          if ((renderer as any)._textures?.has?.(texture) === false) return
          renderer.initTexture?.(texture as THREE.Texture)
        },
        orthoTileUrl: (id, format, z, x, y) =>
          `${MAPTILER_BASE}/tiles/${id}/${z}/${x}/${y}.${format}?key=${encodeURIComponent(maptilerKey)}`,
      })
      const ok = await ortho.ready
      if (!ok) {
        // Nothing was or will be composited.
        satellite.setCapturing(false)
        return ok
      }
      // Turned on after ?ortho=off or an 'off' at the start: the covered tiles already loaded
      // kept no bytes, so they are loaded again (their parents keep the ground drawn meanwhile)
      // and come back with them, to be upgraded like any other.
      if (!hadBytes) {
        const cache = (tiles as any).lruCache
        for (const tile of Array.isArray(cache?.itemList) ? cache.itemList.slice() : []) {
          const map = tile?.engineData?.scene?.material?.map
          if (!map || satellite.get(map) || zoomOfTileUrl(tile?.content?.uri) < ORTHO_MIN_ZOOM || !orthoCovers(tile)) continue
          cache.remove(tile)
        }
        tiles.dispatchEvent({ type: 'needs-update' })
      }
      return ok
    },
    setOrthoEnabled(on) {
      ortho?.setEnabled(on)
    },
    setOrthoDensity(density) {
      ortho?.setDensity(density)
    },
    orthoStats() {
      return ortho?.stats() ?? null
    },
    releaseOrthoBytes() {
      if (!ortho) satellite.setCapturing(false)
    },
    dispose() {
      tiles.removeEventListener('tile-visibility-change', onTileShown)
      stopRetrying()
      ortho?.dispose()
      detachPanRebase()
      window.removeEventListener('pointerdown', trackPointerDown, true)
      window.removeEventListener('pointerup', trackPointerUp, true)
      window.removeEventListener('pointercancel', trackPointerUp, true)
      window.removeEventListener('pointermove', trackPointerMove, true)
      window.removeEventListener('blur', trackBlur)
      window.removeEventListener('pointerleave', suppressEdgeLeave, true)
      controls.dispose()
      tiles.dispose()
      scene.remove(tiles.group)
    },
  }
}
