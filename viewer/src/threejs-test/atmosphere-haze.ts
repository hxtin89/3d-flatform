// Distance haze and a graded sky — aerial perspective, the cue that reads as "filmed".
//
// Haze is one TSL fog node on the scene, so every node material picks it up after its
// colour node: points, basemap, soft clouds, props. The ray-marched volume clouds are the
// exception while the haze is on: their fragment sits on the far face of their box, so
// they turn material.fog off and apply the same curve themselves through `cloudHaze`, at
// a transmittance-weighted distance (environment-layer.ts buildVolumeMaterial); with the
// haze off they take the fog path like everything else. It works on the true distance from the
// camera (the floating origin keeps positionWorld precise), stays near zero over the
// canopy close by, builds with distance and saturates just before the far plane — the
// globe is clipped at camera.far, and the haze is what hides that edge.
//
// The sky replaces the flat background colour with a gradient from a hazy horizon to the
// zenith, starting at the geometric horizon (below the tangent by the dip angle) so the
// fully hazed ground meets it without a seam: both use the same horizon colour. Its
// colours follow the environment layer's daylight ramp every frame, which also means the
// sky finally darkens at dusk — the flat background never received that ramp.
//
// Both halves are switches that remove themselves entirely when off: the fog node and the
// background node are taken off the scene, and the frame is what it was without this file.
// With the gradient off and the haze on, the haze takes the flat sky colour instead, so the
// hazed map edge still meets the sky it is drawn against.
//
// Additive overlays (the donation parcel's glow) are faded out with distance rather than
// mixed toward the haze colour, which on an additive blend would add a pale veil; helpers
// flagged `userData.noHaze` (pivot marker, debug shells) are left untouched. Both are
// decided per material inside the one fog node, so with the haze off they do not exist.
//
// Physical mode (sky-atmosphere.ts, `setPhysicalSky`). The same two switches, other nodes:
// the background is the physically based sky with its sun disc and the clouds in front, and
// the haze is aerial perspective — the air's own transmittance over the distance and the
// light it scatters in, which is the sky's colour in that very direction, so the hazed ground
// meets the horizon without a seam at any altitude. The far-plane wall stays: it fades the
// clipped globe into what the background draws along the same ray.
import * as THREE from 'three'
import {
  Fn, If, cameraPosition, dot, exp, float, fog, length, max, mix, normalWorldGeometry, normalize,
  output, positionWorld, pow, renderGroup, smoothstep, uniform, vec3, vec4,
} from 'three/tsl'
import { EXPERIENCE_CONFIG } from './config'
import type { DaylightState } from './environment-layer'
import type { SkyAtmosphere } from './sky-atmosphere'

export interface HazeLayer {
  /** Follow the camera and the daylight ramp. Call once per frame after the far plane is set. */
  update(camera: THREE.PerspectiveCamera, daylight: DaylightState | null, altitudeM: number): void
  /** Returns true when the fog node changed, so the caller can rebuild the tile shaders. */
  setHaze(enabled: boolean): boolean
  isHaze(): boolean
  setSky(enabled: boolean): void
  isSky(): boolean
  setStartM(metres: number): void
  setDistanceM(metres: number): void
  setStrength(amount: number): void
  setHorizonBlend(amount: number): void
  /** Neutral light (Daylight grading off): day sky and white sunlight, whatever the clock. */
  setNeutral(neutral: boolean): void
  /** The haze as parts, for a material that has to evaluate it itself — the ray-marched
   *  clouds, whose fragment sits on the far side of their box. A different object in
   *  physical mode, so a caller holding the old one sees the change. */
  readonly cloudHaze: CloudHaze
  /** The physically based sky and aerial perspective, or null for the graded sky and the
   *  haze curve. Returns true when the fog node changed, so the caller rebuilds the tile
   *  shaders (and hands the fog its new `cloudHaze`). */
  setPhysicalSky(sky: SkyAtmosphere | null): boolean
  isPhysicalSky(): boolean
  /** Rebuild the physical nodes after the sky's own shape changed (clouds switched).
   *  Returns true when the fog node changed. */
  refreshPhysicalSky(): boolean
  dispose(): void
}

/** The haze curve, split so a caller can feed its own distances into it. */
export interface CloudHaze {
  /** Coverage 0..1 at `distance` metres from the camera, before the far-plane wall. */
  amount(distance: any): any
  /** The far-plane wall 0..1 at `distance`: 1 just before camera.far clips. */
  wall(distance: any): any
  /** The horizon colour the haze mixes toward. */
  color: any
  /** Physical mode: the full composite for premultiplied light seen through `transmittance`
   *  at `distance` metres along the render-space direction `dirWorld` — the light dimmed by
   *  the air in front of it plus the air's own in-scatter over what it hides. */
  aerial?(light: any, transmittance: any, distance: any, dirWorld: any): any
}

const EARTH_RADIUS_M = 6_371_000

export function createHazeLayer(opts: { scene: THREE.Scene; up: THREE.Vector3 }): HazeLayer {
  const { scene } = opts
  const CONFIG = EXPERIENCE_CONFIG.atmosphere.haze
  const sceneNodes = scene as unknown as { fogNode: any; backgroundNode: any }

  // Render-group uniforms: one value per frame shared by every tile, rather than one
  // copy per material the fog node lands in.
  const horizonColor = uniform(new THREE.Color(EXPERIENCE_CONFIG.environment.daySky)).setGroup(renderGroup)
  const zenithColor = uniform(new THREE.Color(EXPERIENCE_CONFIG.environment.daySky)).setGroup(renderGroup)
  const startM = uniform(CONFIG.startM).setGroup(renderGroup)
  const distanceM = uniform(CONFIG.distanceM).setGroup(renderGroup)
  const strength = uniform(CONFIG.strength).setGroup(renderGroup)
  const farM = uniform(24_000).setGroup(renderGroup)
  // The caller's vector itself, not a copy: main.ts fills it in once the survey frame is known.
  const up = uniform(opts.up).setGroup(renderGroup)
  const dip = uniform(0.003).setGroup(renderGroup)
  let horizonBlend: number = CONFIG.horizonBlend

  // 1 − e^(−(d − start)/distance), scaled by strength, then forced to 1 over the last
  // stretch before the far plane. Clipping is by view depth and the radial distance is
  // never shorter, so the wall is always reached before anything is cut.
  const hazeAmount = (d: any) => float(1).sub(exp(max(d.sub(startM), 0).div(distanceM).negate())).mul(strength)
  const hazeWall = (d: any) => smoothstep(farM.mul(0.8), farM.mul(0.97), d)
  const distance = length(positionWorld.sub(cameraPosition))
  const factor = max(hazeAmount(distance), hazeWall(distance))
  const hazeNode = Fn((_inputs: unknown, builder: any) => {
    const material = builder.material
    if (material?.userData?.noHaze) return output
    if (material?.blending === THREE.AdditiveBlending) return vec4(output.rgb.mul(float(1).sub(factor)), output.a)
    return fog(horizonColor, factor)
  })()

  // Elevation of the view direction above the local horizontal; the gradient starts at the
  // geometric horizon and eases into the zenith colour by `zenithElevation`.
  const elevation = dot(normalize(normalWorldGeometry), up)
  const toZenith = smoothstep(dip.negate(), float(CONFIG.zenithElevation), elevation)
  const skyNode = mix(horizonColor, zenithColor, pow(toZenith, 0.6))

  let haze: boolean = CONFIG.enabled
  let sky: boolean = CONFIG.skyGradient
  let physical: SkyAtmosphere | null = null
  let physicalHaze: any = null
  let physicalSky: any = null
  let physicalVersion = -1
  const gradedCloudHaze: CloudHaze = { amount: hazeAmount, wall: hazeWall, color: horizonColor }
  let physicalCloudHaze: CloudHaze | null = null
  const buildPhysical = (atmosphere: SkyAtmosphere) => {
    const nodes = atmosphere.nodes
    physicalVersion = atmosphere.version
    physicalHaze = Fn((_inputs: unknown, builder: any) => {
      const material = builder.material
      if (material?.userData?.noHaze) return output
      const toPoint = positionWorld.sub(cameraPosition)
      const d = length(toPoint)
      const dirEnu = nodes.toEnu(toPoint.div(max(d, 1e-3)))
      const wall = hazeWall(d)
      const ap = nodes.aerial(d, dirEnu)
      if (material?.blending === THREE.AdditiveBlending) {
        return vec4(output.rgb.mul(ap.transmittance).mul(float(1).sub(wall)), output.a)
      }
      const hazed = output.rgb.mul(ap.transmittance).add(ap.inscatter).toVar()
      // Only near the far plane, so the background's own lookups run for few fragments.
      If(wall.greaterThan(0), () => {
        hazed.assign(mix(hazed, nodes.background(dirEnu, false), wall))
      })
      return vec4(hazed, output.a)
    })()
    physicalSky = nodes.background(nodes.toEnu(normalize(normalWorldGeometry)), true)
    physicalCloudHaze = {
      amount: hazeAmount,
      wall: hazeWall,
      color: horizonColor,
      aerial: (light: any, transmittance: any, distance: any, dirWorld: any) => {
        const ap = nodes.aerial(distance, nodes.toEnu(dirWorld))
        return vec3(light).mul(ap.transmittance).add(ap.inscatter.mul(float(1).sub(transmittance)))
      },
    }
  }
  const apply = () => {
    if (physical) {
      sceneNodes.fogNode = haze ? physicalHaze : null
      sceneNodes.backgroundNode = sky ? physicalSky : null
    } else {
      sceneNodes.fogNode = haze ? hazeNode : null
      sceneNodes.backgroundNode = sky ? skyNode : null
    }
  }
  apply()

  const scratch = new THREE.Color()
  const daySky = new THREE.Color(EXPERIENCE_CONFIG.environment.daySky)
  const white = new THREE.Color(0xffffff)
  const minimumLight = EXPERIENCE_CONFIG.environment.minimumSceneLight
  let neutral = false
  return {
    update(camera, daylight, altitudeM) {
      if (!haze && !sky) return
      farM.value = camera.far
      dip.value = Math.sqrt(2 * Math.max(altitudeM, 1) / EARTH_RADIUS_M)
      if (!sky) {
        // The flat background is what the hazed edge is seen against: match it.
        const background = scene.background as THREE.Color | null
        if (background?.isColor) horizonColor.value.copy(background)
      } else if (neutral) {
        zenithColor.value.copy(daySky)
        horizonColor.value.copy(scratch.copy(daySky).lerp(white, horizonBlend))
      } else if (daylight) {
        // Zenith is the ramp's own sky colour; the horizon is that sky pulled toward the
        // sunlight by as much as there is daylight — pale at noon, warm at golden hour, and
        // at night simply the night sky (moonlight must not light the horizon up).
        const daylightAmount = THREE.MathUtils.clamp((daylight.intensity - minimumLight) / (1 - minimumLight), 0, 1)
        zenithColor.value.copy(daylight.skyColor)
        horizonColor.value.copy(scratch.copy(daylight.skyColor).lerp(daylight.lightColor, horizonBlend * daylightAmount))
      }
    },
    setNeutral(next) { neutral = next },
    get cloudHaze() { return physical && physicalCloudHaze ? physicalCloudHaze : gradedCloudHaze },
    setPhysicalSky(next) {
      if (next === physical) return false
      physical = next
      if (physical) buildPhysical(physical)
      apply()
      return haze
    },
    isPhysicalSky() { return physical !== null },
    refreshPhysicalSky() {
      if (!physical || physical.version === physicalVersion) return false
      buildPhysical(physical)
      apply()
      return haze
    },
    setHaze(next) {
      if (next === haze) return false
      haze = next
      apply()
      return true
    },
    isHaze() { return haze },
    setSky(next) {
      if (next === sky) return
      sky = next
      apply()
    },
    isSky() { return sky },
    setStartM(metres) { startM.value = Math.max(metres, 0) },
    setDistanceM(metres) { distanceM.value = Math.max(metres, 1) },
    setStrength(value) { strength.value = THREE.MathUtils.clamp(value, 0, 1) },
    setHorizonBlend(value) { horizonBlend = THREE.MathUtils.clamp(value, 0, 1) },
    dispose() {
      sceneNodes.fogNode = null
      sceneNodes.backgroundNode = null
    },
  }
}
