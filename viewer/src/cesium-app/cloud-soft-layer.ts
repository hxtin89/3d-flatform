import * as Cesium from 'cesium'
import { EXPERIENCE_CONFIG } from './config'
import type { DaylightState } from './environment-layer'
import type { EnuFrame } from './enu'

export interface CloudSoftLayer {
  setEnabled(enabled: boolean): void
  update(now: number, daylightState: DaylightState, cameraGroundRange: number): void
  dispose(): void
}

export interface CreateCloudSoftLayerOptions {
  scene: Cesium.Scene
  enuFrame: EnuFrame
  surveyCentreEnu?: Cesium.Cartesian3
  reducedMotion?: boolean
}

interface SoftCloud {
  cloud: Cesium.CumulusCloud
  basePositionEnu: Cesium.Cartesian3
}

function clamp01(value: number): number {
  return Cesium.Math.clamp(value, 0, 1)
}

function smooth01(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / Math.max(1e-6, edge1 - edge0))
  return t * t * (3 - 2 * t)
}

export function createCloudSoftLayer(
  options: CreateCloudSoftLayerOptions,
): CloudSoftLayer {
  const {
    scene,
    enuFrame,
    surveyCentreEnu = Cesium.Cartesian3.ZERO,
    reducedMotion = false,
  } = options
  const cfg = EXPERIENCE_CONFIG.clouds
  const collection = new Cesium.CloudCollection({
    show: false,
    noiseDetail: 16,
  })
  scene.primitives.add(collection)
  const clouds: SoftCloud[] = []
  const positionEnu = new Cesium.Cartesian3()
  const positionWorld = new Cesium.Cartesian3()
  const cloudColor = new Cesium.Color()
  const motionOpacity = reducedMotion ? 0.72 : 1
  let disposed = false

  for (let fieldIndex = 0; fieldIndex < cfg.fields.length; fieldIndex++) {
    const field = cfg.fields[fieldIndex]
    for (let puff = 0; puff < cfg.softPuffsPerField; puff++) {
      const seed = fieldIndex * 97 + puff * 31
      const angle = seed * 2.399963
      const radial = Math.sqrt((puff + 0.5) / cfg.softPuffsPerField)
      const basePositionEnu = new Cesium.Cartesian3(
        surveyCentreEnu.x + field.offsetM[0]
          + Math.cos(angle) * field.sizeM[0] * 0.33 * radial,
        surveyCentreEnu.y + field.offsetM[1]
          + Math.sin(angle) * field.sizeM[1] * 0.33 * radial,
        surveyCentreEnu.z + field.offsetM[2]
          + Math.sin(seed * 1.17) * field.sizeM[2] * 0.13,
      )
      const base = 0.13 + ((seed * 17) % 19) / 180
      const width = field.sizeM[0] * base
      const depth = field.sizeM[1] * base
      const height = field.sizeM[2] * (0.18 + base * 0.25)
      enuFrame.enuToWorld(basePositionEnu, positionWorld)
      const cloud = collection.add({
        position: positionWorld,
        scale: new Cesium.Cartesian2(width * 1.35, height * 1.8),
        maximumSize: new Cesium.Cartesian3(width, depth, height),
        slice: 0.34 + ((seed * 13) % 25) / 100,
        color: new Cesium.Color(0.91, 0.95, 0.95, 0),
        brightness: 1,
      })
      clouds.push({ cloud, basePositionEnu })
    }
  }

  return {
    setEnabled(enabled) {
      if (!disposed) collection.show = enabled
    },
    update(now, daylightState, cameraGroundRange) {
      if (disposed) return
      const rangeOpacity = smooth01(
        cfg.closeFadeEndM,
        cfg.closeFadeStartM,
        cameraGroundRange,
      )
      const daylight = clamp01(
        (daylightState.intensity - EXPERIENCE_CONFIG.environment.minimumSceneLight)
        / (1 - EXPERIENCE_CONFIG.environment.minimumSceneLight),
      )
      Cesium.Color.lerp(
        daylightState.lightColor,
        daylightState.skyColor,
        0.18,
        cloudColor,
      )
      cloudColor.alpha = 0.16 * rangeOpacity * motionOpacity
      const brightness = Cesium.Math.lerp(0.28, 1, daylight)
      // Match the source layer's bounded, slow field drift. Recomputing from
      // immutable ENU bases avoids accumulating floating-point error in ECEF.
      const driftX = Math.sin(now * 0.00003) * 240
      const driftY = Math.cos(now * 0.000025) * 110
      for (const entry of clouds) {
        Cesium.Cartesian3.fromElements(
          entry.basePositionEnu.x + driftX,
          entry.basePositionEnu.y + driftY,
          entry.basePositionEnu.z,
          positionEnu,
        )
        enuFrame.enuToWorld(positionEnu, positionWorld)
        entry.cloud.position = positionWorld
        entry.cloud.color = cloudColor
        entry.cloud.brightness = brightness
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      const sceneDestroyed = (scene as any).isDestroyed?.() ?? false
      const removed = !sceneDestroyed
        && scene.primitives.contains(collection)
        && scene.primitives.remove(collection)
      if (!removed && !collection.isDestroyed()) collection.destroy()
    },
  }
}
