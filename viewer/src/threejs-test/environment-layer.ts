import * as THREE from 'three'
import { MeshBasicNodeMaterial, NodeMaterial } from 'three/webgpu'
import {
  Break, Fn, If, float, smoothstep, texture3D, uniform, vec3, vec4,
} from 'three/tsl'
import { RaymarchingBox } from 'three/addons/tsl/utils/Raymarching.js'
import { EXPERIENCE_CONFIG } from './config'
import type { CloudUniforms } from './point-cloud'

export type CloudMode = 'off' | 'soft' | 'volume'
export type PerformanceTier = 'constrained' | 'balanced' | 'strong'

export interface DaylightState {
  peruMinutes: number
  timeLabel: string
  live: boolean
  sunElevationRad: number
  sunDirectionEnu: THREE.Vector3
  skyColor: THREE.Color
  fogColor: THREE.Color
  lightColor: THREE.Color
  daylightColor: THREE.Color
  intensity: number
  ambientIntensity: number
}

export interface CloudState {
  mode: CloudMode
  tier: PerformanceTier
  intent: boolean
  reason: string
}

export interface EnvironmentLayer {
  getDaylightState(): DaylightState
  getCloudState(): CloudState
  setCloudIntent(enabled: boolean): void
  setPeruMinutes(minutes: number | null): void
  update(
    now: number,
    camera: THREE.PerspectiveCamera,
    cameraGroundRange: number,
    fps: number,
    qualityGuardEnabled: boolean,
  ): DaylightState
  dispose(): void
}

interface EnvironmentLayerOptions {
  scene: THREE.Scene
  renderer: { setClearColor(color: THREE.ColorRepresentation, alpha?: number): void }
  fog: THREE.Fog
  uniforms: CloudUniforms
  enuFrame: THREE.Matrix4
  zOffset: number
  surveyCentreEnu: THREE.Vector3
  originLonLat: readonly [number, number, number]
  isWebGPU: boolean
  reducedMotion: boolean
  onCloudStateChange?(state: CloudState): void
}

const CLOUD_PREFERENCE_KEY = 'living-dashboard:clouds'
const TWO_PI = Math.PI * 2

function clamp01(value: number): number {
  return THREE.MathUtils.clamp(value, 0, 1)
}

function smooth01(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / Math.max(1e-6, edge1 - edge0))
  return t * t * (3 - 2 * t)
}

function getPeruClock(nowMs: number): { date: Date; minutes: number } {
  const offsetMs = EXPERIENCE_CONFIG.environment.utcOffsetHours * 60 * 60 * 1000
  const date = new Date(nowMs + offsetMs)
  return { date, minutes: date.getUTCHours() * 60 + date.getUTCMinutes() }
}

function dayOfYear(date: Date): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0)
  const current = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  return Math.floor((current - start) / 86_400_000)
}

function calculateSunDirection(
  date: Date,
  minutes: number,
  longitudeDeg: number,
  latitudeDeg: number,
  target: THREE.Vector3,
): { direction: THREE.Vector3; elevation: number } {
  const hour = minutes / 60
  const gamma = TWO_PI / 365 * (dayOfYear(date) - 1 + (hour - 12) / 24)
  const equationOfTime = 229.18 * (
    0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma)
  )
  const declination = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma)
  const timeOffset = equationOfTime + 4 * longitudeDeg
    - 60 * EXPERIENCE_CONFIG.environment.utcOffsetHours
  const trueSolarMinutes = (minutes + timeOffset + 1_440) % 1_440
  const hourAngle = THREE.MathUtils.degToRad(trueSolarMinutes / 4 - 180)
  const latitude = THREE.MathUtils.degToRad(latitudeDeg)
  const sinElevation = Math.sin(latitude) * Math.sin(declination)
    + Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle)
  const elevation = Math.asin(THREE.MathUtils.clamp(sinElevation, -1, 1))
  const azimuth = Math.atan2(
    Math.sin(hourAngle),
    Math.cos(hourAngle) * Math.sin(latitude) - Math.tan(declination) * Math.cos(latitude),
  ) + Math.PI

  target.set(
    Math.sin(azimuth) * Math.cos(elevation),
    Math.cos(azimuth) * Math.cos(elevation),
    Math.sin(elevation),
  ).normalize()
  return { direction: target, elevation }
}

function classifyTier(isWebGPU: boolean): PerformanceTier {
  const connection = (navigator as any).connection
  const saveData = Boolean(connection?.saveData)
  const cores = navigator.hardwareConcurrency || 2
  const memory = Number((navigator as any).deviceMemory)
  const coarseMobile = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 1_100
  if (!isWebGPU || saveData || coarseMobile || cores < 6 || (Number.isFinite(memory) && memory < 4)) {
    return 'constrained'
  }
  if (cores >= EXPERIENCE_CONFIG.clouds.strongMinimumCores
    && (!Number.isFinite(memory) || memory >= EXPERIENCE_CONFIG.clouds.strongMinimumMemoryGb)) {
    return 'strong'
  }
  return 'balanced'
}

function createNoiseTexture(size: number): THREE.Data3DTexture {
  const data = new Uint8Array(size * size * size)
  const centre = (size - 1) * 0.5
  let index = 0
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const nx = (x - centre) / centre
        const ny = (y - centre) / centre
        const nz = (z - centre) / centre
        const envelope = clamp01(1 - (nx * nx * 0.62 + ny * ny * 1.45 + nz * nz * 0.62))
        const coarse = Math.sin(x * 0.21 + Math.sin(z * 0.13) * 1.8)
          + Math.sin(y * 0.29 + x * 0.08)
          + Math.sin(z * 0.17 - y * 0.11)
        const detail = Math.sin((x + y + z) * 0.47) * 0.34
        data[index++] = Math.round(clamp01((coarse / 6 + 0.52 + detail * 0.12) * envelope) * 255)
      }
    }
  }
  const texture = new THREE.Data3DTexture(data, size, size, size)
  texture.format = THREE.RedFormat
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.wrapR = THREE.RepeatWrapping
  texture.unpackAlignment = 1
  texture.needsUpdate = true
  texture.name = 'wilderness-cloud-density'
  return texture
}

export function createEnvironmentLayer(options: EnvironmentLayerOptions): EnvironmentLayer {
  const {
    scene, renderer, fog, uniforms, enuFrame, zOffset, surveyCentreEnu,
    originLonLat, isWebGPU, reducedMotion, onCloudStateChange,
  } = options
  const tier = classifyTier(isWebGPU)
  let activeTier = tier
  let storedPreference: string | null = null
  try { storedPreference = localStorage.getItem(CLOUD_PREFERENCE_KEY) } catch { /* private mode */ }
  let cloudIntent = storedPreference === null ? tier !== 'constrained' : storedPreference === 'on'
  let cloudMode: CloudMode = 'off'
  let cloudReason = cloudIntent ? 'Adaptive cloud quality' : 'Clouds are off'
  let lowFpsSince = 0
  let manualMinutes: number | null = null
  let lastDaylightUpdate = -Infinity
  let lastLiveRefresh = -Infinity
  let resources: {
    mode: Exclude<CloudMode, 'off'>
    group: THREE.Group
    geometry: THREE.BufferGeometry
    material: THREE.Material
    texture?: THREE.Data3DTexture
    opacityUniform?: any
    windUniform?: any
  } | null = null

  const root = new THREE.Group()
  root.name = 'wilderness-environment-layer'
  root.matrixAutoUpdate = false
  root.matrix.copy(enuFrame).multiply(new THREE.Matrix4().makeTranslation(0, 0, zOffset))
  root.matrixWorldNeedsUpdate = true
  scene.add(root)

  const hemisphere = new THREE.HemisphereLight(0xc9e9ff, 0x163a2d, 1)
  const sunlight = new THREE.DirectionalLight(0xffffff, 1.4)
  const sunTarget = new THREE.Object3D()
  scene.add(hemisphere, sunlight, sunTarget)
  sunlight.target = sunTarget

  const state: DaylightState = {
    peruMinutes: 720,
    timeLabel: '12:00',
    live: true,
    sunElevationRad: Math.PI / 3,
    sunDirectionEnu: new THREE.Vector3(0.3, -0.4, 0.85).normalize(),
    skyColor: new THREE.Color(EXPERIENCE_CONFIG.environment.daySky),
    fogColor: new THREE.Color(EXPERIENCE_CONFIG.environment.dayFog),
    lightColor: new THREE.Color(0xffffff),
    daylightColor: new THREE.Color(0xffffff),
    intensity: 1,
    ambientIntensity: 1,
  }
  const nightSky = new THREE.Color(EXPERIENCE_CONFIG.environment.nightSky)
  const dawnSky = new THREE.Color(EXPERIENCE_CONFIG.environment.dawnSky)
  const daySky = new THREE.Color(EXPERIENCE_CONFIG.environment.daySky)
  const nightFog = new THREE.Color(EXPERIENCE_CONFIG.environment.nightFog)
  const dayFog = new THREE.Color(EXPERIENCE_CONFIG.environment.dayFog)
  const nightGrade = new THREE.Color(0x92abc4)
  const dayGrade = new THREE.Color(0xffffff)
  const warmLight = new THREE.Color(0xffc58f)
  const moonLight = new THREE.Color(0x9fc5e8)
  const worldCentre = surveyCentreEnu.clone().applyMatrix4(root.matrix)
  const worldSunDirection = new THREE.Vector3()
  const enuRotation = new THREE.Matrix3().setFromMatrix4(enuFrame)

  function notifyCloudState(): void {
    onCloudStateChange?.({ mode: cloudMode, tier: activeTier, intent: cloudIntent, reason: cloudReason })
  }

  function disposeCloudResources(): void {
    if (!resources) return
    root.remove(resources.group)
    resources.geometry.dispose()
    resources.material.dispose()
    resources.texture?.dispose()
    resources = null
  }

  function createSoftClouds(): void {
    const group = new THREE.Group()
    group.name = 'wilderness-soft-clouds'
    const geometry = new THREE.SphereGeometry(1, 10, 7)
    const material = new MeshBasicNodeMaterial()
    material.color.set(0xe9f2f2)
    material.transparent = true
    material.opacity = 0.16
    material.depthWrite = false
    material.side = THREE.FrontSide
    const count = EXPERIENCE_CONFIG.clouds.fields.length * EXPERIENCE_CONFIG.clouds.softPuffsPerField
    const mesh = new THREE.InstancedMesh(geometry, material, count)
    mesh.name = 'wilderness-soft-cloud-puffs'
    mesh.renderOrder = 2
    mesh.frustumCulled = true
    const matrix = new THREE.Matrix4()
    const position = new THREE.Vector3()
    const scale = new THREE.Vector3()
    const quaternion = new THREE.Quaternion()
    let index = 0
    for (let fieldIndex = 0; fieldIndex < EXPERIENCE_CONFIG.clouds.fields.length; fieldIndex++) {
      const field = EXPERIENCE_CONFIG.clouds.fields[fieldIndex]
      for (let puff = 0; puff < EXPERIENCE_CONFIG.clouds.softPuffsPerField; puff++) {
        const seed = fieldIndex * 97 + puff * 31
        const angle = seed * 2.399963
        const radial = Math.sqrt((puff + 0.5) / EXPERIENCE_CONFIG.clouds.softPuffsPerField)
        position.set(
          surveyCentreEnu.x + field.offsetM[0] + Math.cos(angle) * field.sizeM[0] * 0.33 * radial,
          surveyCentreEnu.y + field.offsetM[1] + Math.sin(angle) * field.sizeM[1] * 0.33 * radial,
          surveyCentreEnu.z + field.offsetM[2] + Math.sin(seed * 1.17) * field.sizeM[2] * 0.13,
        )
        const base = 0.13 + ((seed * 17) % 19) / 180
        scale.set(field.sizeM[0] * base, field.sizeM[2] * (0.18 + base * 0.25), field.sizeM[1] * base)
        matrix.compose(position, quaternion, scale)
        mesh.setMatrixAt(index++, matrix)
      }
    }
    mesh.instanceMatrix.needsUpdate = true
    group.add(mesh)
    root.add(group)
    resources = { mode: 'soft', group, geometry, material }
  }

  function createVolumeClouds(): void {
    const texture = createNoiseTexture(EXPERIENCE_CONFIG.clouds.textureSize)
    const cloudOpacity = uniform(1)
    const windOffset = uniform(new THREE.Vector3())
    const cloudColor = uniform(new THREE.Color(0xe8f0ef))
    const steps = float(EXPERIENCE_CONFIG.clouds.raymarchSteps)
    const cloudTexture = texture3D(texture, null, 0)
    const volumeNode = Fn(() => {
      const finalColor = vec4(0).toVar()
      RaymarchingBox(steps, ({ positionRay }) => {
        const samplePosition = positionRay.add(0.5).add(windOffset)
        const density = float(cloudTexture.sample(samplePosition).r).toVar()
        density.assign(smoothstep(0.18, 0.48, density).mul(0.18))
        const shade = cloudTexture.sample(samplePosition.add(vec3(-0.018))).r
          .sub(cloudTexture.sample(samplePosition.add(vec3(0.018))).r)
          .mul(1.8)
          .add(0.72)
        finalColor.rgb.addAssign(finalColor.a.oneMinus().mul(density).mul(cloudColor).mul(shade))
        finalColor.a.addAssign(finalColor.a.oneMinus().mul(density))
        If(finalColor.a.greaterThanEqual(0.93), () => Break())
      })
      return vec4(finalColor.rgb, finalColor.a.mul(cloudOpacity))
    })()
    const material = new NodeMaterial()
    material.colorNode = volumeNode
    material.side = THREE.BackSide
    material.transparent = true
    material.depthWrite = false
    const geometry = new THREE.BoxGeometry(1, 1, 1)
    const group = new THREE.Group()
    group.name = 'wilderness-volume-clouds'
    for (const field of EXPERIENCE_CONFIG.clouds.fields) {
      const mesh = new THREE.Mesh(geometry, material)
      mesh.position.set(
        surveyCentreEnu.x + field.offsetM[0],
        surveyCentreEnu.y + field.offsetM[1],
        surveyCentreEnu.z + field.offsetM[2],
      )
      mesh.scale.set(field.sizeM[0], field.sizeM[1], field.sizeM[2])
      mesh.renderOrder = 2
      group.add(mesh)
    }
    root.add(group)
    resources = {
      mode: 'volume', group, geometry, material, texture,
      opacityUniform: cloudOpacity, windUniform: windOffset,
    }
  }

  function setMode(nextMode: CloudMode, reason: string): void {
    if (cloudMode === nextMode && resources?.mode === nextMode) {
      cloudReason = reason
      notifyCloudState()
      return
    }
    disposeCloudResources()
    cloudMode = nextMode
    cloudReason = reason
    if (nextMode === 'soft') createSoftClouds()
    if (nextMode === 'volume') createVolumeClouds()
    notifyCloudState()
  }

  function preferredMode(): Exclude<CloudMode, 'off'> {
    return activeTier === 'strong' ? 'volume' : 'soft'
  }

  function updateDaylight(now: number): void {
    if (now - lastDaylightUpdate < EXPERIENCE_CONFIG.environment.updateIntervalMs
      && !(manualMinutes === null && now - lastLiveRefresh >= EXPERIENCE_CONFIG.environment.liveRefreshMs)) return
    lastDaylightUpdate = now
    if (manualMinutes === null) lastLiveRefresh = now
    const clock = getPeruClock(Date.now())
    const minutes = manualMinutes ?? clock.minutes
    const solar = calculateSunDirection(clock.date, minutes, originLonLat[0], originLonLat[1], state.sunDirectionEnu)
    const daylight = smooth01(THREE.MathUtils.degToRad(-8), THREE.MathUtils.degToRad(18), solar.elevation)
    const twilight = smooth01(THREE.MathUtils.degToRad(-12), THREE.MathUtils.degToRad(5), solar.elevation)
    const golden = Math.exp(-Math.pow((THREE.MathUtils.radToDeg(solar.elevation) - 7) / 11, 2))
    state.peruMinutes = minutes
    state.timeLabel = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
    state.live = manualMinutes === null
    state.sunElevationRad = solar.elevation
    state.skyColor.copy(nightSky).lerp(dawnSky, twilight).lerp(daySky, daylight * 0.82)
    state.fogColor.copy(nightFog).lerp(dayFog, daylight)
    state.lightColor.copy(moonLight).lerp(dayGrade, daylight).lerp(warmLight, golden * 0.32)
    state.daylightColor.copy(nightGrade).lerp(dayGrade, daylight).lerp(warmLight, golden * 0.12)
    state.intensity = THREE.MathUtils.lerp(EXPERIENCE_CONFIG.environment.minimumSceneLight, 1, daylight)
    state.ambientIntensity = THREE.MathUtils.lerp(0.44, 1.1, daylight)
    uniforms.daylightColor.value.copy(state.daylightColor)
    uniforms.daylightIntensity.value = state.intensity
    renderer.setClearColor(state.skyColor, 1)
    fog.color.copy(state.fogColor)
    hemisphere.color.copy(state.skyColor).lerp(state.lightColor, 0.4)
    hemisphere.groundColor.set(0x163a2d).multiplyScalar(0.5 + daylight * 0.5)
    hemisphere.intensity = state.ambientIntensity
    sunlight.color.copy(state.lightColor)
    sunlight.intensity = THREE.MathUtils.lerp(0.28, 1.75, daylight)
    worldSunDirection.copy(state.sunDirectionEnu).applyMatrix3(enuRotation).normalize()
    sunlight.position.copy(worldCentre).addScaledVector(worldSunDirection, 80_000)
    sunTarget.position.copy(worldCentre)
    sunlight.updateMatrixWorld()
    sunTarget.updateMatrixWorld()
    if (resources?.material) {
      const material = resources.material as THREE.Material & { color?: THREE.Color }
      material.color?.copy(state.lightColor).lerp(state.skyColor, 0.18)
    }
  }

  if (cloudIntent) setMode(preferredMode(), tier === 'strong' ? 'Volumetric WebGPU clouds' : 'Lightweight cloud volumes')
  else notifyCloudState()
  updateDaylight(performance.now())

  return {
    getDaylightState: () => state,
    getCloudState: () => ({ mode: cloudMode, tier: activeTier, intent: cloudIntent, reason: cloudReason }),
    setCloudIntent(enabled) {
      cloudIntent = enabled
      lowFpsSince = 0
      try { localStorage.setItem(CLOUD_PREFERENCE_KEY, enabled ? 'on' : 'off') } catch { /* private mode */ }
      setMode(enabled ? preferredMode() : 'off', enabled ? 'Clouds enabled by user' : 'Clouds disabled by user')
    },
    setPeruMinutes(minutes) {
      manualMinutes = minutes === null ? null : Math.round(THREE.MathUtils.clamp(minutes, 0, 1_439))
      lastDaylightUpdate = -Infinity
      updateDaylight(performance.now())
    },
    update(now, _camera, cameraGroundRange, fps, qualityGuardEnabled) {
      updateDaylight(now)
      const rangeOpacity = smooth01(
        EXPERIENCE_CONFIG.clouds.closeFadeEndM,
        EXPERIENCE_CONFIG.clouds.closeFadeStartM,
        cameraGroundRange,
      )
      const motionOpacity = reducedMotion ? 0.72 : 1
      if (resources?.mode === 'soft') {
        const material = resources.material as MeshBasicNodeMaterial
        material.opacity = 0.16 * rangeOpacity * motionOpacity
        resources.group.position.set(
          Math.sin(now * 0.00003) * 240,
          Math.cos(now * 0.000025) * 110,
          0,
        )
      } else if (resources?.mode === 'volume') {
        resources.opacityUniform.value = rangeOpacity * motionOpacity
        const wind = EXPERIENCE_CONFIG.clouds.windMps
        resources.windUniform.value.set(
          (now * 0.001 * wind[0] / 20_000) % 1,
          (now * 0.001 * wind[1] / 8_000) % 1,
          0,
        )
      }

      if (qualityGuardEnabled && cloudMode !== 'off' && fps > 0) {
        const threshold = cloudMode === 'volume'
          ? EXPERIENCE_CONFIG.clouds.volumeFallbackFps
          : EXPERIENCE_CONFIG.clouds.disableFps
        if (fps < threshold) {
          if (!lowFpsSince) lowFpsSince = now
          if (now - lowFpsSince >= EXPERIENCE_CONFIG.clouds.lowFpsDurationMs) {
            if (cloudMode === 'volume') {
              activeTier = 'balanced'
              setMode('soft', 'Cloud detail reduced to protect frame rate')
            } else {
              activeTier = 'constrained'
              cloudIntent = false
              setMode('off', 'Clouds paused to protect frame rate')
            }
            lowFpsSince = 0
          }
        } else lowFpsSince = 0
      } else lowFpsSince = 0
      return state
    },
    dispose() {
      disposeCloudResources()
      scene.remove(root, hemisphere, sunlight, sunTarget)
    },
  }
}
