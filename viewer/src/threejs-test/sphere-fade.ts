import * as THREE from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'

import { EXPERIENCE_CONFIG } from './config'
import { getOrigin } from './origin'

/**
 * Two concentric spheres standing on the basemap under the focus of the view — the dome
 * the viewer looks into.
 *
 * The dome is defined on the screen, not in fixed metres, so it holds the same place in
 * the frame at every height:
 *
 *  - Its centre is where a ray through a *focus spot* on the screen meets the WGS84
 *    ellipsoid the imagery is draped on. Looking straight down the spot is the middle of
 *    the screen; as the camera tilts it slides down towards the lower third, so the
 *    foreground — nearest, largest on screen — is the part drawn whole. It only goes as
 *    far down as keeps the ground under the middle of the screen, what the view is aimed
 *    at, inside the whole part of the dome; from higher and flatter it stays nearer the
 *    middle.
 *  - Its inner radius is `growth` times the camera's distance to that centre, so it
 *    covers a near-constant share of the screen — a vignette — between `innerRadiusM`
 *    (the close-up floor, where nothing changes from the fixed dome) and `maxRadiusM`,
 *    above which it stops growing and shrinks on screen as the camera climbs on.
 *  - The outer radius and the ramp width scale with it, in their configured proportion
 *    to `innerRadiusM`, so the melt looks the same at every height and the load gate
 *    keeps the same lead on the draw gate.
 *
 * Centre and radius ease towards those targets with a time constant rather than
 * snapping, so a sweep of the camera glides the dome instead of dragging it. The gates
 * and the shader all read the eased values, which is what keeps a tile from switching
 * off anywhere its points have not already faded out.
 */
export interface SphereFadeSettings {
  /** Master switch. Off, nothing is placed or drawn. */
  enabled: boolean
  /** Outer sphere at the minimum inner radius, metres. A tile loads only if its box
   *  intersects it. Scales with the inner radius as the dome grows. */
  outerRadiusM: number
  /** Inner sphere's minimum radius, metres — the size close to the canopy, where the
   *  dome does not grow. A tile is drawn only if its box intersects the inner sphere,
   *  and every point fades to nothing at its rim. Clamped to the outer radius, so the
   *  inner sphere can never poke out of the outer one. */
  innerRadiusM: number
  /**
   * How far inside the inner radius the falloff begins, in metres at the minimum radius
   * — the width of the ramp; it scales with the radius as the dome grows. Everything
   * nearer the centre than `innerRadius - ramp` is drawn whole; a ramp at or above the
   * radius ramps from the very centre.
   */
  rampInsetM: number
  /**
   * The ramp's shape, one exponent per end — see sphereFadeFactor in point-cloud.ts.
   * `fadeIn` is how it leaves the plateau: above 1 holds full size a while longer before
   * dropping, below 1 drops at once. `fadeOut` is how it lands on zero at the rim: above
   * 1 lingers small before vanishing, below 1 vanishes abruptly. 1 and 1 is a straight
   * line. The plateau inside is not affected by either.
   */
  fadeIn: number
  fadeOut: number
  /** Opacity of the two debug shells, 0..1. */
  debugOpacity: number
  /** Whether the shells are drawn at all. */
  showDebug: boolean
  /**
   * A focus hit further away than this many times the camera's height above it counts
   * as a miss. The ray meets the ellipsoid tens of kilometres out for the last few
   * degrees of pitch, where one degree of tilt moves the hit by kilometres — the same
   * runaway `lod.maxTiltRangeFactor` clamps for the refinement range, and the default is
   * that constant so the two agree on where "looking across" begins.
   */
  maxRangeFactor: number
  /** Inner radius per metre of camera-to-centre distance. 0 keeps the dome at
   *  `innerRadiusM` at every height — the fixed dome. */
  growth: number
  /** Largest inner radius the growth may reach, metres. */
  maxRadiusM: number
  /** How far down the screen the focus spot sits at full side view, in half screen
   *  heights (0 the middle, 1 the bottom edge). 0 keeps it in the middle at every tilt. */
  focusDrop: number
  /** Time constant the centre and radius ease with, seconds. 0 snaps. */
  easeSeconds: number
}

export interface SphereFadeStats {
  /** A centre exists — the ray has hit the ground at least once since boot. */
  placed: boolean
  /** The ray missed or grazed this frame, so the centre is riding the camera. */
  frozen: boolean
  /** Held at a point given from outside — the entrance flight's landing — rather than
   *  following the view. */
  pinned: boolean
  /** Camera to the focus hit, metres. NaN while frozen or pinned. */
  hitRangeM: number
  /** Camera to the sphere centre, metres. */
  cameraDistanceM: number
  /** Where the focus spot sat this frame, in half screen heights below the middle. */
  focusDrop: number
  /** The centre in the cloud's lifted ENU frame — the frame `worldToEnu` in main.ts
   *  reports in, not the shader's raw ENU. */
  centreEnu: { x: number; y: number; z: number }
  outerRadiusM: number
  innerRadiusM: number
  rampM: number
}

export interface SphereFade {
  readonly settings: SphereFadeSettings
  /** Render-space centre this frame. Only meaningful while `placed()` is true. */
  readonly centreWorld: THREE.Vector3
  placed(): boolean
  outerRadius(): number
  /** The inner radius as applied — never above the outer. */
  innerRadius(): number
  /** The ramp width as applied, metres. */
  rampWidth(): number
  /**
   * Hold the centre where the ray from `eyeWorld` through `lookWorld` meets the map,
   * instead of under the live focus — the landed pose of a flight still in the air, so
   * the dome is already waiting there, at the size it will have from that eye, as the
   * camera arrives. Stays in force, through rebases and after the flight has landed,
   * until `unpin()`.
   */
  pinAlong(eyeWorld: THREE.Vector3, lookWorld: THREE.Vector3): void
  /** Back to following the view. A no-op when not pinned. */
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
  /** How far into side view the camera is, 0 top-down to 1 side-on — main.ts's one
   *  pitch curve, which the foveation and the old vignette anchor follow too. */
  sideViewFactor: () => number
  /** Shared with the panel, which is bound before this exists — same arrangement as
   *  foveation's settings. */
  settings?: SphereFadeSettings
}): SphereFade {
  const { camera, ellipsoid, scene, worldToEnu, enuToWorld, sideViewFactor } = opts
  const settings: SphereFadeSettings = opts.settings ?? { ...EXPERIENCE_CONFIG.lod.sphereFade }

  const raycaster = new THREE.Raycaster()
  const focusNdc = new THREE.Vector2(0, 0)
  const origin = new THREE.Vector3()
  const hitEcef = new THREE.Vector3()
  const hitEnu = new THREE.Vector3()
  const cameraEnu = new THREE.Vector3()
  const centreWorld = new THREE.Vector3()
  /** The eased centre, lifted ENU. `centreWorld` is re-expressed from it every frame. */
  const centreEnu = new THREE.Vector3()
  /** Where the centre is heading this frame, lifted ENU. */
  const targetEnu = new THREE.Vector3()
  const targetWorld = new THREE.Vector3()
  /** The ground under the middle of the screen this frame, lifted ENU. */
  const middleEnu = new THREE.Vector3()
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
  let appliedDrop = 0
  /** The eased inner radius, metres; 0 until the first placement snaps it. */
  let radius = 0
  let lastUpdateMs = NaN
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

  /** The configured radii at the close-up size; everything else is these times `scale()`. */
  const baseOuter = () => Math.max(1, settings.outerRadiusM)
  const baseInner = () => Math.min(Math.max(1, settings.innerRadiusM), baseOuter())
  /** How far the dome has grown over its close-up size, 1 when it has not. */
  const scale = () => (radius > 0 ? radius / baseInner() : 1)
  const innerRadius = () => (radius > 0 ? radius : baseInner())
  const outerRadius = () => baseOuter() * scale()
  const rampWidth = () => Math.max(0, settings.rampInsetM) * scale()

  /** The inner radius the dome grows to at `distance` metres from the camera. */
  const radiusFor = (distance: number): number => {
    const floor = baseInner()
    const growth = Math.max(0, settings.growth)
    return THREE.MathUtils.clamp(growth * distance, floor, Math.max(floor, settings.maxRadiusM))
  }

  const hideShells = () => {
    outerShell.visible = false
    innerShell.visible = false
  }

  /**
   * Cast the ray through the focus spot `drop` half screen heights below the middle.
   * Fills hitEcef (render space) and hitEnu, and returns the range, or NaN on a miss or
   * a grazing hit.
   */
  const castFocus = (drop: number): number => {
    focusNdc.set(0, -drop)
    raycaster.setFromCamera(focusNdc, camera)
    // The ellipsoid lives in ECEF; the ray is render space. Direction is unaffected.
    getOrigin(origin)
    raycaster.ray.origin.add(origin)
    if (!ellipsoid.intersectRay(raycaster.ray, hitEcef)) return NaN
    hitEcef.sub(origin)
    worldToEnu(hitEcef, hitEnu)
    const range = camera.position.distanceTo(hitEcef)
    const height = Math.max(1, cameraEnu.z - hitEnu.z)
    // A grazing hit runs off toward the horizon; treat it as a miss and hold on.
    return range <= settings.maxRangeFactor * height ? range : NaN
  }

  /** Whether the ground under the middle of the screen (`middleEnu`) lies in the whole,
   *  un-faded part of a dome centred on `hitEnu` and sized for `range`. */
  const keepsMiddle = (range: number): boolean => {
    const r = radiusFor(range)
    const plateau = r - Math.max(0, settings.rampInsetM) * (r / baseInner())
    return hitEnu.distanceTo(middleEnu) <= plateau
  }

  /** Aim `targetEnu` at this frame's focus hit, or at the camera plus the last offset. */
  const aimTarget = (): boolean => {
    worldToEnu(camera.position, cameraEnu)
    const side = THREE.MathUtils.clamp(sideViewFactor(), 0, 1)
    const fullDrop = Math.max(0, settings.focusDrop) * side
    let drop = 0
    let range = castFocus(0)
    // The spot goes down only as far as it can while what the view is aimed at, the
    // ground under the middle, stays drawn whole. Close to the canopy the dome's floor
    // radius holds both and the spot takes the full drop; from higher and flatter the
    // middle lies further out than the dome reaches, and the spot stays up — measured
    // before this rule: at 1 km and 21° the fixed drop left the booked parcel in the
    // middle of the frame out on the basemap, and at 5 km and 21° the dome was empty.
    if (fullDrop > 0 && Number.isFinite(range)) {
      middleEnu.copy(hitEnu)
      const middleRange = range
      const steps = 8
      for (let i = steps; i > 0; i--) {
        const candidate = (fullDrop * i) / steps
        const r = castFocus(candidate)
        if (Number.isFinite(r) && keepsMiddle(r)) { drop = candidate; range = r; break }
      }
      // No lowered spot kept the middle: cast the middle again, since hitEnu now holds
      // the last candidate's hit.
      if (drop === 0) range = castFocus(0)
      if (!Number.isFinite(range)) range = middleRange
    } else if (fullDrop > 0) {
      // The middle grazes or misses — looking across. Take the full drop; the lowered
      // spot is then the only ground the view has.
      range = castFocus(fullDrop)
      drop = fullDrop
    }
    if (Number.isFinite(range)) {
      hitRange = range
      appliedDrop = drop
      groundZ = hitEnu.z
      frozenOffsetEnu.set(hitEnu.x - cameraEnu.x, hitEnu.y - cameraEnu.y)
      targetEnu.copy(hitEnu)
      frozen = false
      return true
    }
    hitRange = NaN
    frozen = true
    if (!placed) return false
    targetEnu.set(cameraEnu.x + frozenOffsetEnu.x, cameraEnu.y + frozenOffsetEnu.y, groundZ)
    return true
  }

  const placeCentre = (nowMs: number): void => {
    if (!aimTarget()) return
    enuToWorld(targetEnu, targetWorld)
    const targetRadius = radiusFor(camera.position.distanceTo(targetWorld))
    const dt = Number.isFinite(lastUpdateMs) ? Math.min(0.25, (nowMs - lastUpdateMs) / 1000) : 0
    const tau = Math.max(0, settings.easeSeconds)
    // Snap on the first placement and on a jump the easing would only smear — a pose
    // restored from the bench, a rebase-sized teleport — where gliding across kilometres
    // would draw the wrong ground for the whole time constant.
    const jump = !placed || radius <= 0 || centreEnu.distanceTo(targetEnu) > 3 * Math.max(radius, targetRadius)
    const k = jump || tau === 0 ? 1 : 1 - Math.exp(-dt / tau)
    centreEnu.lerp(targetEnu, k)
    radius = jump ? targetRadius : radius + (targetRadius - radius) * k
    enuToWorld(centreEnu, centreWorld)
    placed = true
  }

  return {
    settings,
    centreWorld,
    placed: () => placed,
    outerRadius,
    innerRadius,
    rampWidth,
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
      // The size it will have from that eye, not from wherever the flight is now — the
      // flight starts 160 km out, where the dome would sit at its maximum.
      radius = radiusFor(eyeWorld.distanceTo(centreWorld))
      groundZ = centreEnu.z
      placed = true
      pinned = true
      frozen = false
      hitRange = NaN
      appliedDrop = 0
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
      const nowMs = performance.now()
      if (!settings.enabled) { hideShells(); lastUpdateMs = nowMs; return }
      if (pinned) enuToWorld(centreEnu, centreWorld)
      else placeCentre(nowMs)
      lastUpdateMs = nowMs
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
        hitRangeM: pinned ? NaN : hitRange,
        cameraDistanceM: placed ? camera.position.distanceTo(centreWorld) : NaN,
        focusDrop: pinned ? 0 : appliedDrop,
        centreEnu: { x: centreEnu.x, y: centreEnu.y, z: centreEnu.z },
        outerRadiusM: outerRadius(),
        innerRadiusM: innerRadius(),
        rampM: rampWidth(),
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
