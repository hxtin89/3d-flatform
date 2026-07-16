import * as THREE from 'three'
import { PointsNodeMaterial } from 'three/webgpu'
import {
  Fn,
  float,
  fract,
  instancedBufferAttribute,
  sin,
  smoothstep,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { EXPERIENCE_CONFIG } from './config'

const DROP_COUNT = 260

export interface RainLayer {
  setEnabled(enabled: boolean): void
  update(now: number, camera: THREE.PerspectiveCamera, cameraGroundRange: number): boolean
  dispose(): void
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

/**
 * One instanced sprite draw call. Drop motion, wrapping, size variation and
 * soft streak alpha are evaluated in the vertex/fragment shader; the CPU only
 * updates two uniforms and the camera-relative root transform.
 */
export function createRainLayer(scene: THREE.Scene): RainLayer {
  const random = createRandom(0x57494c44)
  const drops = new Float32Array(DROP_COUNT * 4)
  for (let index = 0; index < DROP_COUNT; index++) {
    const offset = index * 4
    drops[offset] = (random() - 0.5) * 88
    drops[offset + 1] = 0
    drops[offset + 2] = -(8 + random() * 72)
    drops[offset + 3] = random()
  }

  const dropAttribute = new THREE.InstancedBufferAttribute(drops, 4)
  const drop: any = instancedBufferAttribute(dropAttribute)
  const rainTime = uniform(0)
  const rainOpacity = uniform(0)

  const material = new PointsNodeMaterial()
  material.transparent = true
  material.depthTest = false
  material.depthWrite = false
  material.alphaToCoverage = true
  material.rotationNode = float(-0.1)

  const fallPhase = fract(rainTime.mul(float(0.82).add(drop.w.mul(0.26))).add(drop.w))
  const sway = sin(rainTime.mul(1.4).add(drop.w.mul(18))).mul(0.65)
  material.positionNode = vec3(
    drop.x.add(sway).sub(fallPhase.mul(1.8)),
    float(35).sub(fallPhase.mul(68)),
    drop.z,
  )
  material.scaleNode = vec2(
    float(0.035).add(drop.w.mul(0.025)),
    float(1.3).add(drop.w.mul(1.3)),
  )
  material.colorNode = Fn(() => {
    const dropUv = uv()
    const horizontal = float(1).sub(smoothstep(float(0.06), float(0.5), dropUv.x.sub(0.5).abs()))
    const headFade = smoothstep(float(0), float(0.16), dropUv.y)
    const tailFade = float(1).sub(smoothstep(float(0.72), float(1), dropUv.y))
    const alpha = horizontal.mul(headFade).mul(tailFade).mul(rainOpacity).mul(0.82)
    return vec4(vec3(0.72, 0.88, 1), alpha)
  })()

  const sprite = new THREE.Sprite(material)
  sprite.name = 'wilderness-rain-shader'
  sprite.count = DROP_COUNT
  sprite.frustumCulled = false
  sprite.renderOrder = 100

  const root = new THREE.Group()
  root.name = 'wilderness-rain-layer'
  root.visible = false
  root.add(sprite)
  scene.add(root)

  let enabled = false
  let intensity = 0
  let lastUpdate = performance.now()

  return {
    setEnabled(nextEnabled) {
      enabled = nextEnabled
    },
    update(now, camera, cameraGroundRange) {
      const elapsed = Math.min(64, Math.max(0, now - lastUpdate))
      lastUpdate = now
      const targetIntensity = enabled ? 1 : 0
      const fadeTime = enabled
        ? EXPERIENCE_CONFIG.rain.fadeInMs
        : EXPERIENCE_CONFIG.rain.fadeOutMs
      intensity += (targetIntensity - intensity) * (1 - Math.exp(-elapsed / fadeTime))
      if (Math.abs(targetIntensity - intensity) < 0.002) intensity = targetIntensity

      const rangeOpacity = THREE.MathUtils.clamp(
        (EXPERIENCE_CONFIG.rain.maximumRangeM - cameraGroundRange)
          / EXPERIENCE_CONFIG.rain.rangeFadeM,
        0,
        1,
      )
      const opacity = rangeOpacity * intensity
      const active = opacity > 0.01
      root.visible = active
      if (!active) return false

      rainTime.value = now * 0.001
      rainOpacity.value = opacity
      root.position.copy(camera.position)
      root.quaternion.copy(camera.quaternion)
      return true
    },
    dispose() {
      scene.remove(root)
      material.dispose()
    },
  }
}
