import * as THREE from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'

import { EXPERIENCE_CONFIG } from './config'
import { getOrigin } from './origin'

/**
 * Two concentric spheres standing on the basemap under the view centre — the dome the
 * viewer looks into.
 *
 * The centre is the point where the ray through the middle of the screen meets the
 * WGS84 ellipsoid the imagery is draped on, so it is always on the map and always in the
 * middle of the frame: pan and it slides across the ground, zoom out and it stays the
 * same size in metres while shrinking on screen. Both radii are settings in metres.
 *
 * Phase A: placement and the two translucent debug shells. The load gate (outer sphere),
 * the render gate (inner sphere) and the per-point size/height falloff of phase B all read
 * `centreWorld` and the two radii from here.
 */
export interface SphereFadeSettings {
  /** Master switch. Off, nothing is placed or drawn. */
  enabled: boolean
  /** Outer sphere, metres. Phase B: a tile loads only if its box intersects it. */
  outerRadiusM: number
  /** Inner sphere, metres. Phase B: a tile is drawn only if its box intersects it, and
   *  every point inside fades to nothing at this distance from the centre. Clamped to
   *  the outer radius, so the inner sphere can never poke out of the outer one. */
  innerRadiusM: number
  /**
   * How far inside the inner radius the falloff begins, in metres — the width of the
   * ramp. Everything nearer the centre than `innerRadius - rampInsetM` is drawn whole;
   * an inset at or above the radius ramps from the very centre.
   */
  rampInsetM: number
  /** Exponent on the ramp over those last metres: 1 linear, above 1 fades early, below
   *  1 holds and drops late. The plateau inside is not affected. */
  exponent: number
  /** Opacity of the two debug shells, 0..1. */
  debugOpacity: number
  /** Whether the shells are drawn at all. */
  showDebug: boolean
  /**
   * A view-centre hit further away than this many times the camera's height above it
   * counts as a miss. The ray meets the ellipsoid tens of kilometres out for the last
   * few degrees of pitch, where one degree of tilt moves the hit by kilometres — the
   * same runaway `lod.maxTiltRangeFactor` clamps for the refinement range, and the
   * default is that constant so the two agree on where "looking across" begins.
   */
  maxRangeFactor: number
}

export interface SphereFadeStats {
  /** A centre exists — the ray has hit the ground at least once since boot. */
  placed: boolean
  /** The ray missed or grazed this frame, so the centre is riding the camera. */
  frozen: boolean
  /** Held at a point given from outside — the entrance flight's landing — rather than
   *  following the view centre. */
  pinned: boolean
  /** Camera to the view-centre hit, metres. NaN while frozen. */
  hitRangeM: number
  /** Camera to the sphere centre, metres. */
  cameraDistanceM: number
  /** The centre in the cloud's lifted ENU frame — the frame `worldToEnu` in main.ts
   *  reports in, not the shader's raw ENU. */
  centreEnu: { x: number; y: number; z: number }
  outerRadiusM: number
  innerRadiusM: number
}

export interface SphereFade {
  readonly settings: SphereFadeSettings
  /** Render-space centre this frame. Only meaningful while `placed()` is true. */
  readonly centreWorld: THREE.Vector3
  placed(): boolean
  outerRadius(): number
  /** The inner radius as applied — never above the outer. */
  innerRadius(): number
  /**
   * Hold the centre where the ray from `eyeWorld` through `lookWorld` meets the map,
   * instead of under the live view centre — the landed pose of a flight still in the
   * air, so the dome is already waiting there as the camera arrives. Stays in force,
   * through rebases and after the flight has landed, until `unpin()`.
   */
  pinAlong(eyeWorld: THREE.Vector3, lookWorld: THREE.Vector3): void
  /** Back to following the view centre. A no-op when not pinned. */
  unpin(): void
  /** Re-place the centre and move the shells. Call once per frame, after the controls
   *  have moved the camera and before the point-cloud traversal. */
  update(): void
  stats(): SphereFadeStats
  dispose(): void
}

export function createSphereFade(opts: {
  camera: THREE.PerspectiveCamera
  /** The WGS84 ellipsoid the basemap is draped on — `globe.ellipsoid`. It works in
   *  ECEF, so the render-space ray is shifted by the floating origin before the test. */
  ellipsoid: { intersectRay(ray: THREE.Ray, target: THREE.Vector3): THREE.Vector3 | null }
  /** Render-space parent for the debug shells: the scene root, not `ecefRoot`. The
   *  centre is rebuilt from the camera every frame, so a rebase needs no listener. */
  scene: THREE.Object3D
  /** main.ts's pair — one lifted ENU frame both ways, so a round trip is exact. */
  worldToEnu: (world: THREE.Vector3, target: THREE.Vector3) => THREE.Vector3
  enuToWorld: (enu: THREE.Vector3, target: THREE.Vector3) => THREE.Vector3
  /** Shared with the panel, which is bound before this exists — same arrangement as
   *  foveation's settings. */
  settings?: SphereFadeSettings
}): SphereFade {
  const { camera, ellipsoid, scene, worldToEnu, enuToWorld } = opts
  const settings: SphereFadeSettings = opts.settings ?? { ...EXPERIENCE_CONFIG.lod.sphereFade }

  const raycaster = new THREE.Raycaster()
  const screenCentre = new THREE.Vector2(0, 0)
  const origin = new THREE.Vector3()
  const hitEcef = new THREE.Vector3()
  const hitEnu = new THREE.Vector3()
  const cameraEnu = new THREE.Vector3()
  const centreWorld = new THREE.Vector3()
  const centreEnu = new THREE.Vector3()
  /**
   * Where the centre sat relative to the camera, in ENU metres on the ground plane, the
   * last time the ray hit. While the ray misses, the centre is the camera plus this — so
   * a camera that pitches up to the horizon keeps its dome, and one that then flies on
   * takes the dome with it instead of leaving it behind. Translation only: turning in
   * place does not swing it round.
   */
  const frozenOffsetEnu = new THREE.Vector2()
  let groundZ = 0
  let placed = false
  let frozen = false
  let hitRange = NaN
  /**
   * Pinned: the centre is kept in ENU (`centreEnu`) and re-expressed in render space
   * every frame, because the entrance flight it exists for crosses 130 km and rebases
   * the origin many times on the way — a render-space copy would be left behind.
   */
  let pinned = false
  const pinRay = new THREE.Ray()

  // One unit sphere, scaled per shell per frame. Double-sided because the camera stands
  // inside the outer sphere most of the time — at 80 m over the canopy the ground under
  // the view centre is nearer than either radius — and a front-faced shell seen from
  // inside is simply not there. depthWrite off so the two shells and the points behind
  // them blend instead of fighting; depth test on, so the lower half sits under the map.
  const shellGeometry = new THREE.SphereGeometry(1, 48, 32)
  const makeShell = (color: number, renderOrder: number): THREE.Mesh => {
    const material = new MeshBasicNodeMaterial()
    material.color.set(color)
    material.transparent = true
    material.opacity = settings.debugOpacity
    material.depthWrite = false
    material.side = THREE.DoubleSide
    material.toneMapped = false
    const mesh = new THREE.Mesh(shellGeometry, material)
    mesh.frustumCulled = false
    mesh.renderOrder = renderOrder
    mesh.visible = false
    scene.add(mesh)
    return mesh
  }
  const outerShell = makeShell(0x38bdf8, 20)
  const innerShell = makeShell(0xf59e0b, 21)

  const outerRadius = () => Math.max(1, settings.outerRadiusM)
  const innerRadius = () => Math.min(Math.max(1, settings.innerRadiusM), outerRadius())

  const hideShells = () => {
    outerShell.visible = false
    innerShell.visible = false
  }

  const placeCentre = (): void => {
    worldToEnu(camera.position, cameraEnu)
    raycaster.setFromCamera(screenCentre, camera)
    // The ellipsoid lives in ECEF; the ray is render space. Direction is unaffected.
    getOrigin(origin)
    raycaster.ray.origin.add(origin)
    const hit = ellipsoid.intersectRay(raycaster.ray, hitEcef)
    let fresh = false
    if (hit) {
      hitEcef.sub(origin)
      worldToEnu(hitEcef, hitEnu)
      const range = camera.position.distanceTo(hitEcef)
      const height = Math.max(1, cameraEnu.z - hitEnu.z)
      // A grazing hit runs off toward the horizon; treat it as a miss and hold on.
      if (range <= settings.maxRangeFactor * height) {
        fresh = true
        hitRange = range
        groundZ = hitEnu.z
        frozenOffsetEnu.set(hitEnu.x - cameraEnu.x, hitEnu.y - cameraEnu.y)
        centreEnu.copy(hitEnu)
        centreWorld.copy(hitEcef)
        placed = true
      }
    }
    if (!fresh) {
      hitRange = NaN
      if (!placed) return
      centreEnu.set(cameraEnu.x + frozenOffsetEnu.x, cameraEnu.y + frozenOffsetEnu.y, groundZ)
      enuToWorld(centreEnu, centreWorld)
    }
    frozen = !fresh
  }

  return {
    settings,
    centreWorld,
    placed: () => placed,
    outerRadius,
    innerRadius,
    pinAlong(eyeWorld, lookWorld) {
      pinRay.origin.copy(eyeWorld)
      pinRay.direction.copy(lookWorld).sub(eyeWorld).normalize()
      getOrigin(origin)
      pinRay.origin.add(origin)
      const hit = ellipsoid.intersectRay(pinRay, hitEcef)
      // A look point on the survey always hits the map behind it. Should it not, the
      // look point itself is the best stand-in — it is on the parcel, a few metres up.
      if (hit) centreWorld.copy(hitEcef.sub(origin))
      else centreWorld.copy(lookWorld)
      worldToEnu(centreWorld, centreEnu)
      groundZ = centreEnu.z
      placed = true
      pinned = true
      frozen = false
      hitRange = NaN
    },
    unpin() {
      if (!pinned) return
      pinned = false
      // The pinned centre becomes the last hit, so a miss on the very next frame holds
      // it in place rather than reaching back to an offset from before the pin.
      worldToEnu(camera.position, cameraEnu)
      frozenOffsetEnu.set(centreEnu.x - cameraEnu.x, centreEnu.y - cameraEnu.y)
    },
    update() {
      if (!settings.enabled) { hideShells(); return }
      if (pinned) enuToWorld(centreEnu, centreWorld)
      else placeCentre()
      if (!placed || !settings.showDebug) { hideShells(); return }
      const outer = outerRadius()
      const inner = innerRadius()
      outerShell.visible = true
      innerShell.visible = true
      outerShell.position.copy(centreWorld)
      innerShell.position.copy(centreWorld)
      outerShell.scale.setScalar(outer)
      innerShell.scale.setScalar(inner)
      ;(outerShell.material as MeshBasicNodeMaterial).opacity = settings.debugOpacity
      ;(innerShell.material as MeshBasicNodeMaterial).opacity = settings.debugOpacity
    },
    stats() {
      return {
        placed,
        frozen,
        pinned,
        hitRangeM: hitRange,
        cameraDistanceM: placed ? camera.position.distanceTo(centreWorld) : NaN,
        centreEnu: { x: centreEnu.x, y: centreEnu.y, z: centreEnu.z },
        outerRadiusM: outerRadius(),
        innerRadiusM: innerRadius(),
      }
    },
    dispose() {
      outerShell.removeFromParent()
      innerShell.removeFromParent()
      ;(outerShell.material as THREE.Material).dispose()
      ;(innerShell.material as THREE.Material).dispose()
      shellGeometry.dispose()
    },
  }
}
