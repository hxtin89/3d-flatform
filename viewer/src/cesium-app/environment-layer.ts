import * as Cesium from 'cesium'
import { createShadowSlice } from './cloud-noise'
import {
  createCloudSoftLayer,
  type CloudSoftLayer,
} from './cloud-soft-layer'
import {
  createCloudVolumeLayer,
  type CloudVolumeLayer,
} from './cloud-volume-layer'
import { EXPERIENCE_CONFIG } from './config'
import type { EnuFrame } from './enu'
import type { PointTileset } from './point-tileset'

export type CloudMode = 'off' | 'soft' | 'volume'
export type PerformanceTier = 'constrained' | 'balanced' | 'strong'
export type DaylightPhase = 'night' | 'sunrise' | 'day' | 'sunset'

export interface DaylightState {
  peruMinutes: number
  timeLabel: string
  live: boolean
  phase: DaylightPhase
  sunElevationRad: number
  sunDirectionEnu: Cesium.Cartesian3
  skyColor: Cesium.Color
  fogColor: Cesium.Color
  lightColor: Cesium.Color
  daylightColor: Cesium.Color
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
  update(
    now: number,
    cameraGroundRange: number,
    fps: number,
    qualityGuardEnabled: boolean,
  ): DaylightState
  getDaylightState(): DaylightState
  getCloudState(): CloudState
  /** persist=false leaves the stored user preference untouched (compare mode). */
  setCloudIntent(enabled: boolean, persist?: boolean): void
  /** Override the heuristic tier with a measured one (loader benchmark). */
  applyMeasuredTier(tier: PerformanceTier): void
  setPeruMinutes(minutes: number | null): void
  /** Off keeps the Peru clock running but makes every visual target neutral. */
  setGradingEnabled(enabled: boolean): void
  dispose(): void
}

export interface EnvironmentLayerOptions {
  scene: Cesium.Scene
  imageryLayer: Cesium.ImageryLayer | null
  pointTileset: PointTileset
  enuFrame: EnuFrame
  surveyCentreEnu: Cesium.Cartesian3
  surveyRadiusM: number
  areaMinZ: number
  originLonLat: readonly [number, number, number]
  reducedMotion: boolean
  isStrongContext: boolean
  onCloudStateChange?(state: CloudState): void
}

const CLOUD_PREFERENCE_KEY = 'living-dashboard:clouds'
const TWO_PI = Math.PI * 2

function clamp01(value: number): number {
  return Cesium.Math.clamp(value, 0, 1)
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
  target: Cesium.Cartesian3,
): { direction: Cesium.Cartesian3; elevation: number; hourAngle: number } {
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
  const hourAngle = Cesium.Math.toRadians(trueSolarMinutes / 4 - 180)
  const latitude = Cesium.Math.toRadians(latitudeDeg)
  const sinElevation = Math.sin(latitude) * Math.sin(declination)
    + Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle)
  const elevation = Math.asin(Cesium.Math.clamp(sinElevation, -1, 1))
  const azimuth = Math.atan2(
    Math.sin(hourAngle),
    Math.cos(hourAngle) * Math.sin(latitude) - Math.tan(declination) * Math.cos(latitude),
  ) + Math.PI

  Cesium.Cartesian3.fromElements(
    Math.sin(azimuth) * Math.cos(elevation),
    Math.cos(azimuth) * Math.cos(elevation),
    Math.sin(elevation),
    target,
  )
  Cesium.Cartesian3.normalize(target, target)
  return { direction: target, elevation, hourAngle }
}

export function classifyTier(isStrongContext: boolean): PerformanceTier {
  const connection = (navigator as any).connection
  const saveData = Boolean(connection?.saveData)
  const cores = navigator.hardwareConcurrency || 2
  const memory = Number((navigator as any).deviceMemory)
  const coarseMobile = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 1_100
  if (!isStrongContext || saveData || coarseMobile || cores < 6 || (Number.isFinite(memory) && memory < 4)) {
    return 'constrained'
  }
  if (cores >= EXPERIENCE_CONFIG.clouds.strongMinimumCores
    && (!Number.isFinite(memory) || memory >= EXPERIENCE_CONFIG.clouds.strongMinimumMemoryGb)) {
    return 'strong'
  }
  return 'balanced'
}

function colorFromHex(rgb: number): Cesium.Color {
  return Cesium.Color.fromBytes(
    (rgb >> 16) & 0xff,
    (rgb >> 8) & 0xff,
    rgb & 0xff,
    0xff,
  )
}

function lerpColor(
  target: Cesium.Color,
  start: Cesium.Color,
  end: Cesium.Color,
  amount: number,
): Cesium.Color {
  return Cesium.Color.lerp(start, end, amount, target)
}

export function createEnvironmentLayer(options: EnvironmentLayerOptions): EnvironmentLayer {
  const {
    scene, imageryLayer, pointTileset, enuFrame, originLonLat, reducedMotion,
    surveyCentreEnu, surveyRadiusM, areaMinZ, isStrongContext, onCloudStateChange,
  } = options
  const tier = classifyTier(isStrongContext)
  let activeTier = tier
  let storedPreference: string | null = null
  try { storedPreference = localStorage.getItem(CLOUD_PREFERENCE_KEY) } catch { /* private mode */ }
  let cloudIntent = storedPreference === null ? tier !== 'constrained' : storedPreference === 'on'
  let cloudMode: CloudMode = 'off'
  let cloudReason = cloudIntent ? 'Adaptive cloud quality' : 'Clouds are off'
  let lowFpsSince = 0
  // Guard-demotion bookkeeping: only demotions by the fps guard earn a
  // recovery attempt — a measured 'medium' bench verdict stays authoritative.
  let guardDemotedFromVolume = false
  let highFpsSince = 0
  let promotionsLeft = EXPERIENCE_CONFIG.clouds.maxPromotions
  let manualMinutes: number | null = EXPERIENCE_CONFIG.environment.startPeruMinutes
  let lastDaylightUpdate = -Infinity
  let lastLiveRefresh = -Infinity
  let gradingEnabled = true
  let disposed = false
  let volumeLayer: CloudVolumeLayer | null = null
  let softLayer: CloudSoftLayer | null = null

  // Upload once, before the benchmark may promote a heuristic balanced tier.
  // Using the volume resolution keeps that later promotion on the same sampled
  // density field instead of leaving its canopy slice at the smaller tier.
  const shadowTextureSize = EXPERIENCE_CONFIG.clouds.textureSizeStrong
  pointTileset.setCloudShadowTexture(
    createShadowSlice(shadowTextureSize),
    shadowTextureSize,
    shadowTextureSize,
  )

  const previousLight = scene.light
  const previousBackground = Cesium.Color.clone(scene.backgroundColor)
  const previousGlobeLighting = scene.globe.enableLighting
  const previousAtmosphere = {
    brightnessShift: scene.atmosphere.brightnessShift,
    hueShift: scene.atmosphere.hueShift,
    saturationShift: scene.atmosphere.saturationShift,
  }
  const previousSky = scene.skyAtmosphere
    ? {
        show: scene.skyAtmosphere.show,
        brightnessShift: scene.skyAtmosphere.brightnessShift,
        hueShift: scene.skyAtmosphere.hueShift,
        saturationShift: scene.skyAtmosphere.saturationShift,
      }
    : null
  const previousImagery = imageryLayer
    ? {
        brightness: imageryLayer.brightness,
        contrast: imageryLayer.contrast,
        hue: imageryLayer.hue,
        saturation: imageryLayer.saturation,
        gamma: imageryLayer.gamma,
      }
    : null

  const state: DaylightState = {
    peruMinutes: EXPERIENCE_CONFIG.environment.startPeruMinutes,
    timeLabel: '14:00',
    live: false,
    phase: 'day',
    sunElevationRad: Math.PI / 3,
    sunDirectionEnu: Cesium.Cartesian3.normalize(
      new Cesium.Cartesian3(0.3, -0.4, 0.85),
      new Cesium.Cartesian3(),
    ),
    skyColor: colorFromHex(EXPERIENCE_CONFIG.environment.daySky),
    fogColor: colorFromHex(EXPERIENCE_CONFIG.environment.dayFog),
    lightColor: Cesium.Color.clone(Cesium.Color.WHITE),
    daylightColor: Cesium.Color.clone(Cesium.Color.WHITE),
    intensity: 1,
    ambientIntensity: 1,
  }
  const nightSky = colorFromHex(EXPERIENCE_CONFIG.environment.nightSky)
  const dawnSky = colorFromHex(EXPERIENCE_CONFIG.environment.dawnSky)
  const daySky = colorFromHex(EXPERIENCE_CONFIG.environment.daySky)
  const nightFog = colorFromHex(EXPERIENCE_CONFIG.environment.nightFog)
  const dayFog = colorFromHex(EXPERIENCE_CONFIG.environment.dayFog)
  const nightGrade = colorFromHex(EXPERIENCE_CONFIG.pointLighting.nightGrade)
  const dayGrade = Cesium.Color.clone(Cesium.Color.WHITE)
  const warmLight = colorFromHex(0xffc58f)
  const moonLight = colorFromHex(0x9fc5e8)
  const worldSunDirection = new Cesium.Cartesian3()
  const emittedSunDirection = new Cesium.Cartesian3()
  enuFrame.enuDirectionToWorld(state.sunDirectionEnu, worldSunDirection)
  Cesium.Cartesian3.normalize(worldSunDirection, worldSunDirection)
  Cesium.Cartesian3.negate(worldSunDirection, emittedSunDirection)
  const sunlight = new Cesium.DirectionalLight({
    // NOAA returns the surface-to-sun vector; Cesium wants the direction in
    // which photons travel, so the explicit scene light uses its negative.
    direction: emittedSunDirection,
    color: Cesium.Color.WHITE,
    intensity: 1.75,
  })
  scene.light = sunlight
  // Points and imagery receive the common grading explicitly. Enabling globe
  // lighting as well would apply a second, Cesium-clock-dependent multiplier.
  scene.globe.enableLighting = false

  function notifyCloudState(): void {
    onCloudStateChange?.({
      mode: cloudMode,
      tier: activeTier,
      intent: cloudIntent,
      reason: cloudReason,
    })
  }

  function preferredMode(): Exclude<CloudMode, 'off'> {
    return activeTier === 'strong' ? 'volume' : 'soft'
  }

  function ensureVolumeLayer(): CloudVolumeLayer {
    if (!volumeLayer) {
      volumeLayer = createCloudVolumeLayer({
        scene,
        enuFrame,
        surveyCentreEnu,
        surveyRadiusM,
        areaMinZ,
        reducedMotion,
      })
    }
    return volumeLayer
  }

  function ensureSoftLayer(): CloudSoftLayer {
    if (!softLayer) {
      softLayer = createCloudSoftLayer({
        scene,
        enuFrame,
        surveyCentreEnu,
        reducedMotion,
      })
    }
    return softLayer
  }

  function setMode(nextMode: CloudMode, reason: string): void {
    cloudMode = nextMode
    cloudReason = reason
    if (nextMode === 'volume') {
      softLayer?.setEnabled(false)
      const layer = ensureVolumeLayer()
      layer.setQuality(activeTier === 'strong'
        ? EXPERIENCE_CONFIG.clouds.raymarchStepsStrong
        : EXPERIENCE_CONFIG.clouds.raymarchSteps)
      layer.setEnabled(true)
    } else if (nextMode === 'soft') {
      volumeLayer?.setEnabled(false)
      ensureSoftLayer().setEnabled(true)
    } else {
      volumeLayer?.setEnabled(false)
      softLayer?.setEnabled(false)
    }
    notifyCloudState()
  }

  function applyNeutralGrading(): void {
    pointTileset.setDaylight([1, 1, 1], 1, 0)
    pointTileset.setCloudShadow(0, [0, 0])
    Cesium.Color.clone(daySky, scene.backgroundColor)
    scene.globe.enableLighting = false
    if (scene.skyAtmosphere) {
      scene.skyAtmosphere.show = true
      scene.skyAtmosphere.brightnessShift = 0
      scene.skyAtmosphere.hueShift = 0
      scene.skyAtmosphere.saturationShift = 0
    }
    scene.atmosphere.brightnessShift = 0
    scene.atmosphere.hueShift = 0
    scene.atmosphere.saturationShift = 0
    if (imageryLayer) {
      imageryLayer.brightness = 1
      imageryLayer.contrast = 1
      imageryLayer.hue = 0
      imageryLayer.saturation = 1
      imageryLayer.gamma = 1
    }
    sunlight.color = Cesium.Color.clone(Cesium.Color.WHITE, sunlight.color)
    sunlight.intensity = 1.75
  }

  function updateDaylight(now: number): void {
    if (now - lastDaylightUpdate < EXPERIENCE_CONFIG.environment.updateIntervalMs
      && !(manualMinutes === null && now - lastLiveRefresh >= EXPERIENCE_CONFIG.environment.liveRefreshMs)) return
    lastDaylightUpdate = now
    if (manualMinutes === null) lastLiveRefresh = now
    const clock = getPeruClock(Date.now())
    const minutes = manualMinutes ?? clock.minutes
    const solar = calculateSunDirection(clock.date, minutes, originLonLat[0], originLonLat[1], state.sunDirectionEnu)
    const daylight = smooth01(Cesium.Math.toRadians(-8), Cesium.Math.toRadians(18), solar.elevation)
    const twilight = smooth01(Cesium.Math.toRadians(-12), Cesium.Math.toRadians(5), solar.elevation)
    const golden = Math.exp(-Math.pow((Cesium.Math.toDegrees(solar.elevation) - 7) / 11, 2))
    state.peruMinutes = minutes
    state.timeLabel = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
    state.live = manualMinutes === null
    state.phase = solar.elevation < Cesium.Math.toRadians(-6)
      ? 'night'
      : solar.elevation < Cesium.Math.toRadians(6)
        ? solar.hourAngle < 0 ? 'sunrise' : 'sunset'
        : 'day'
    state.sunElevationRad = solar.elevation
    lerpColor(state.skyColor, nightSky, dawnSky, twilight)
    lerpColor(state.skyColor, state.skyColor, daySky, daylight * 0.82)
    lerpColor(state.fogColor, nightFog, dayFog, daylight)
    lerpColor(state.lightColor, moonLight, dayGrade, daylight)
    lerpColor(state.lightColor, state.lightColor, warmLight, golden * 0.32)
    lerpColor(state.daylightColor, nightGrade, dayGrade, daylight)
    lerpColor(
      state.daylightColor,
      state.daylightColor,
      warmLight,
      golden * EXPERIENCE_CONFIG.pointLighting.goldenGradeBoost,
    )
    state.intensity = Cesium.Math.lerp(EXPERIENCE_CONFIG.environment.minimumSceneLight, 1, daylight)
    state.ambientIntensity = Cesium.Math.lerp(0.44, 1.1, daylight)
    // State (clock, phase, sun position) keeps updating above; everything below
    // writes colours/lights and is suppressed while grading is off.
    if (!gradingEnabled) return

    const goldenFactor = golden * EXPERIENCE_CONFIG.pointLighting.goldenRimStrength
      * Math.max(daylight, twilight * 0.5)
    pointTileset.setDaylight(
      [state.daylightColor.red, state.daylightColor.green, state.daylightColor.blue],
      state.intensity,
      goldenFactor,
    )
    Cesium.Color.clone(state.skyColor, scene.backgroundColor)
    scene.globe.enableLighting = false
    const atmosphereBrightness = Cesium.Math.lerp(-0.62, 0, daylight)
    const atmosphereSaturation = Cesium.Math.lerp(-0.18, 0.04, daylight)
    const atmosphereHue = Cesium.Math.lerp(-0.025, 0, daylight) + golden * 0.012
    if (scene.skyAtmosphere) {
      scene.skyAtmosphere.show = true
      scene.skyAtmosphere.brightnessShift = atmosphereBrightness
      scene.skyAtmosphere.saturationShift = atmosphereSaturation
      scene.skyAtmosphere.hueShift = atmosphereHue
    }
    // Cesium Fog has no writable color. Its blend color comes from the common
    // Atmosphere object, so mirror the sky shifts there while retaining the
    // pure fogColor state for downstream WP6/WP7 consumers.
    scene.atmosphere.brightnessShift = atmosphereBrightness
    scene.atmosphere.saturationShift = atmosphereSaturation
    scene.atmosphere.hueShift = atmosphereHue
    if (imageryLayer) {
      // Conservative multiplicative grading: retain satellite-map legibility at
      // night, allow only a slight daytime saturation lift, and avoid changing
      // gamma so Cesium's imagery decode remains predictable.
      imageryLayer.brightness = Cesium.Math.lerp(0.35, 1, daylight)
      imageryLayer.contrast = 1
      imageryLayer.hue = Cesium.Math.lerp(-0.035, 0, daylight) + golden * 0.01
      imageryLayer.saturation = Cesium.Math.lerp(0.78, 1.04, daylight)
      imageryLayer.gamma = 1
    }
    sunlight.color = Cesium.Color.clone(state.lightColor, sunlight.color)
    sunlight.intensity = Cesium.Math.lerp(0.28, 1.75, daylight)
    enuFrame.enuDirectionToWorld(state.sunDirectionEnu, worldSunDirection)
    Cesium.Cartesian3.normalize(worldSunDirection, worldSunDirection)
    Cesium.Cartesian3.negate(worldSunDirection, sunlight.direction)
  }

  if (cloudIntent) {
    setMode(
      preferredMode(),
      tier === 'strong' ? 'Volumetric WebGL clouds' : 'Lightweight cloud volumes',
    )
  } else notifyCloudState()
  updateDaylight(performance.now())

  return {
    getDaylightState: () => state,
    getCloudState: () => ({
      mode: cloudMode,
      tier: activeTier,
      intent: cloudIntent,
      reason: cloudReason,
    }),
    setCloudIntent(enabled, persist = true) {
      cloudIntent = enabled
      lowFpsSince = 0
      if (persist) {
        try { localStorage.setItem(CLOUD_PREFERENCE_KEY, enabled ? 'on' : 'off') } catch { /* private mode */ }
      }
      setMode(
        enabled ? preferredMode() : 'off',
        enabled ? 'Clouds enabled by user' : 'Clouds disabled by user',
      )
    },
    setGradingEnabled(enabled) {
      if (gradingEnabled === enabled) return
      gradingEnabled = enabled
      if (enabled) {
        // Force the next update to repaint everything the neutral pass overwrote.
        lastDaylightUpdate = -Infinity
        updateDaylight(performance.now())
      } else {
        applyNeutralGrading()
      }
    },
    applyMeasuredTier(measuredTier) {
      activeTier = measuredTier
      lowFpsSince = 0
      if (!cloudIntent) { notifyCloudState(); return }
      if (measuredTier === 'constrained') {
        cloudIntent = false
        setMode('off', 'Clouds disabled by device probe')
      } else {
        setMode(preferredMode(), measuredTier === 'strong'
          ? 'Volumetric WebGL clouds (probe)'
          : 'Lightweight cloud volumes (probe)')
      }
    },
    setPeruMinutes(minutes) {
      manualMinutes = minutes === null
        ? null
        : Math.round(Cesium.Math.clamp(minutes, 0, 1_439))
      lastDaylightUpdate = -Infinity
      updateDaylight(performance.now())
    },
    update(now, cameraGroundRange, fps, qualityGuardEnabled) {
      updateDaylight(now)
      const windSeconds = now * 0.001
      const wind = EXPERIENCE_CONFIG.clouds.windMps
      const windU = (windSeconds * wind[0] / 20_000) % 1
      const windV = (windSeconds * wind[1] / 8_000) % 1
      const daylight = clamp01(
        (state.intensity - EXPERIENCE_CONFIG.environment.minimumSceneLight)
        / (1 - EXPERIENCE_CONFIG.environment.minimumSceneLight),
      )
      pointTileset.setCloudShadow(
        gradingEnabled
          ? EXPERIENCE_CONFIG.pointLighting.cloudShadowStrength
            * daylight
            * (cloudMode !== 'off' ? 1 : 0.5)
          : 0,
        [windU, windV],
      )
      if (cloudMode === 'volume') {
        volumeLayer?.update(now, state, cameraGroundRange)
      } else if (cloudMode === 'soft') {
        softLayer?.update(now, state, cameraGroundRange)
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
              guardDemotedFromVolume = true
              console.info('[clouds] volumetric → soft: fps held below '
                + `${threshold} for ${EXPERIENCE_CONFIG.clouds.lowFpsDurationMs} ms`)
              setMode('soft', 'Cloud detail reduced to protect frame rate')
            } else {
              activeTier = 'constrained'
              cloudIntent = false
              setMode('off', 'Clouds paused to protect frame rate')
            }
            lowFpsSince = 0
          }
        } else lowFpsSince = 0

        // Recovery is bounded so borderline devices settle on soft rather than
        // ping-ponging indefinitely after upload or compositor hitches.
        if (guardDemotedFromVolume && cloudMode === 'soft' && promotionsLeft > 0
          && fps >= EXPERIENCE_CONFIG.clouds.promoteFps) {
          if (!highFpsSince) highFpsSince = now
          if (now - highFpsSince >= EXPERIENCE_CONFIG.clouds.promoteDurationMs) {
            promotionsLeft--
            guardDemotedFromVolume = false
            highFpsSince = 0
            activeTier = 'strong'
            console.info(`[clouds] soft → volumetric: fps recovered (${promotionsLeft} retries left)`)
            setMode('volume', 'Volumetric clouds restored — frame rate recovered')
          }
        } else highFpsSince = 0
      } else { lowFpsSince = 0; highFpsSince = 0 }
      return state
    },
    dispose() {
      if (disposed) return
      disposed = true
      volumeLayer?.dispose()
      volumeLayer = null
      softLayer?.dispose()
      softLayer = null
      pointTileset.setDaylight([1, 1, 1], 1, 0)
      pointTileset.setCloudShadow(0, [0, 0])
      scene.light = previousLight
      Cesium.Color.clone(previousBackground, scene.backgroundColor)
      scene.globe.enableLighting = previousGlobeLighting
      scene.atmosphere.brightnessShift = previousAtmosphere.brightnessShift
      scene.atmosphere.hueShift = previousAtmosphere.hueShift
      scene.atmosphere.saturationShift = previousAtmosphere.saturationShift
      if (scene.skyAtmosphere && previousSky) {
        scene.skyAtmosphere.show = previousSky.show
        scene.skyAtmosphere.brightnessShift = previousSky.brightnessShift
        scene.skyAtmosphere.hueShift = previousSky.hueShift
        scene.skyAtmosphere.saturationShift = previousSky.saturationShift
      }
      if (imageryLayer && previousImagery) {
        imageryLayer.brightness = previousImagery.brightness
        imageryLayer.contrast = previousImagery.contrast
        imageryLayer.hue = previousImagery.hue
        imageryLayer.saturation = previousImagery.saturation
        imageryLayer.gamma = previousImagery.gamma
      }
    },
  }
}
