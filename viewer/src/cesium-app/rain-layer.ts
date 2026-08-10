import * as Cesium from 'cesium'
import { EXPERIENCE_CONFIG } from './config'
import type { EnuFrame } from './enu'

const DROP_COUNT = 260
const HALF_WIDTH_M = 44
const TOP_M = 35
const BOTTOM_M = -33
const FALL_SPAN_M = TOP_M - BOTTOM_M
const MIN_DEPTH_M = 8
const DEPTH_SPAN_M = 72

export interface RainLayer {
  setEnabled(enabled: boolean): void
  update(now: number, cameraGroundRange: number): boolean
  dispose(): void
}

export interface CreateRainLayerOptions {
  scene: Cesium.Scene
  enuFrame: EnuFrame
}

interface RainDrop {
  billboard: Cesium.Billboard
  lateralM: number
  depthM: number
  verticalM: number
  variation: number
  fallSpeedMps: number
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Cesium.Math.clamp(
    (value - edge0) / Math.max(1e-6, edge1 - edge0),
    0,
    1,
  )
  return t * t * (3 - 2 * t)
}

function createStreakTexture(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = 16
  canvas.height = 64
  const context = canvas.getContext('2d')
  if (!context) return canvas

  const image = context.createImageData(canvas.width, canvas.height)
  for (let y = 0; y < canvas.height; y++) {
    const v = (y + 0.5) / canvas.height
    const headFade = smoothstep(0, 0.16, v)
    const tailFade = 1 - smoothstep(0.72, 1, v)
    for (let x = 0; x < canvas.width; x++) {
      const u = (x + 0.5) / canvas.width
      const horizontal = 1 - smoothstep(0.06, 0.5, Math.abs(u - 0.5))
      const offset = (y * canvas.width + x) * 4
      image.data[offset] = 255
      image.data[offset + 1] = 255
      image.data[offset + 2] = 255
      image.data[offset + 3] = Math.round(
        255 * horizontal * headFade * tailFade,
      )
    }
  }
  context.putImageData(image, 0, 0)
  return canvas
}

/**
 * A camera-following field of billboard streaks. Positions live in the
 * survey's ENU frame and are rebuilt from the camera basis every frame, which
 * avoids subtracting float32 ECEF positions while matching the source layer's
 * camera-local rain volume.
 */
export function createRainLayer(
  options: CreateRainLayerOptions,
): RainLayer {
  const { scene, enuFrame } = options
  const collection = new Cesium.BillboardCollection({
    modelMatrix: enuFrame.matrix,
    scene,
    blendOption: Cesium.BlendOption.TRANSLUCENT,
    show: false,
  })
  scene.primitives.add(collection)

  const random = createRandom(0x57494c44)
  const streakTexture = createStreakTexture()
  const drops: RainDrop[] = []
  for (let index = 0; index < DROP_COUNT; index++) {
    const lateralM = (random() - 0.5) * HALF_WIDTH_M * 2
    const depthM = MIN_DEPTH_M + random() * DEPTH_SPAN_M
    const variation = random()
    const billboard = collection.add({
      position: Cesium.Cartesian3.ZERO,
      color: new Cesium.Color(0.72, 0.88, 1, 0),
      rotation: -0.1,
      sizeInMeters: true,
      width: 0.035 + variation * 0.025,
      height: 1.3 + variation * 1.3,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    })
    billboard.setImage('cesium-app-rain-streak', streakTexture)
    drops.push({
      billboard,
      lateralM,
      depthM,
      verticalM: TOP_M - variation * FALL_SPAN_M,
      variation,
      fallSpeedMps: FALL_SPAN_M * (0.82 + variation * 0.26),
    })
  }

  const cameraEnu = new Cesium.Cartesian3()
  const directionEnu = new Cesium.Cartesian3()
  const rightEnu = new Cesium.Cartesian3()
  const upEnu = new Cesium.Cartesian3()
  const positionEnu = new Cesium.Cartesian3()
  const rainColor = new Cesium.Color(0.72, 0.88, 1, 0)
  let enabled = false
  let intensity = 0
  let lastUpdate = performance.now()
  let lastOpacity = -1
  let disposed = false

  function worldDirectionToEnu(
    directionWorld: Cesium.Cartesian3,
    result: Cesium.Cartesian3,
  ): void {
    Cesium.Matrix4.multiplyByPointAsVector(
      enuFrame.inverse,
      directionWorld,
      result,
    )
    Cesium.Cartesian3.normalize(result, result)
  }

  return {
    setEnabled(nextEnabled) {
      if (!disposed) enabled = nextEnabled
    },
    update(now, cameraGroundRange) {
      if (disposed) return false
      const elapsed = Math.min(64, Math.max(0, now - lastUpdate))
      lastUpdate = now
      const targetIntensity = enabled ? 1 : 0
      const fadeTime = enabled
        ? EXPERIENCE_CONFIG.rain.fadeInMs
        : EXPERIENCE_CONFIG.rain.fadeOutMs
      intensity += (targetIntensity - intensity)
        * (1 - Math.exp(-elapsed / fadeTime))
      if (Math.abs(targetIntensity - intensity) < 0.002) {
        intensity = targetIntensity
      }

      const rangeOpacity = Cesium.Math.clamp(
        (EXPERIENCE_CONFIG.rain.maximumRangeM - cameraGroundRange)
          / EXPERIENCE_CONFIG.rain.rangeFadeM,
        0,
        1,
      )
      const opacity = rangeOpacity * intensity
      const active = opacity > 0.01
      collection.show = active
      if (!active) return false

      enuFrame.worldToEnu(scene.camera.positionWC, cameraEnu)
      worldDirectionToEnu(scene.camera.directionWC, directionEnu)
      worldDirectionToEnu(scene.camera.rightWC, rightEnu)
      worldDirectionToEnu(scene.camera.upWC, upEnu)

      if (Math.abs(opacity - lastOpacity) > 0.001) {
        lastOpacity = opacity
        rainColor.alpha = opacity * 0.82
        for (const drop of drops) drop.billboard.color = rainColor
      }

      const elapsedSeconds = elapsed * 0.001
      for (const drop of drops) {
        drop.verticalM -= drop.fallSpeedMps * elapsedSeconds
        while (drop.verticalM < BOTTOM_M) drop.verticalM += FALL_SPAN_M
        const fallPhase = (TOP_M - drop.verticalM) / FALL_SPAN_M
        const lateral = drop.lateralM
          + Math.sin(now * 0.0014 + drop.variation * 18) * 0.65
          - fallPhase * 1.8
        positionEnu.x = cameraEnu.x
          + rightEnu.x * lateral
          + upEnu.x * drop.verticalM
          + directionEnu.x * drop.depthM
        positionEnu.y = cameraEnu.y
          + rightEnu.y * lateral
          + upEnu.y * drop.verticalM
          + directionEnu.y * drop.depthM
        positionEnu.z = cameraEnu.z
          + rightEnu.z * lateral
          + upEnu.z * drop.verticalM
          + directionEnu.z * drop.depthM
        drop.billboard.position = positionEnu
      }
      return true
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
