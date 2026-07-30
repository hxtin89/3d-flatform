import * as Cesium from 'cesium'
import { createCloudNoiseAtlas } from './cloud-noise'
import { EXPERIENCE_CONFIG } from './config'
import type { DaylightState } from './environment-layer'
import type { EnuFrame } from './enu'

export interface CloudVolumeLayer {
  setEnabled(enabled: boolean): void
  update(now: number, daylightState: DaylightState, cameraGroundRange: number): void
  /** Rebuilds the single stage because the march bound is compile-time GLSL. */
  setQuality(steps: number): void
  dispose(): void
}

export interface CreateCloudVolumeLayerOptions {
  scene: Cesium.Scene
  enuFrame: EnuFrame
  surveyCentreEnu: Cesium.Cartesian3
  surveyRadiusM: number
  areaMinZ: number
  reducedMotion?: boolean
}

interface NearCloudBox {
  boxIndex: number
  centre: Cesium.Cartesian3
  size: Cesium.Cartesian3
  driftDirection: Cesium.Cartesian2
  cycleStart: number
  visibleFor: number
  gapFor: number
}

function clamp01(value: number): number {
  return Cesium.Math.clamp(value, 0, 1)
}

function smooth01(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / Math.max(1e-6, edge1 - edge0))
  return t * t * (3 - 2 * t)
}

function atlasCanvas(
  atlas: Uint8Array,
  width: number,
  height: number,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('2D canvas is unavailable for the cloud noise atlas')
  const image = context.createImageData(width, height)
  for (let source = 0, target = 0; source < atlas.length; source++, target += 4) {
    const density = atlas[source]
    image.data[target] = density
    image.data[target + 1] = density
    image.data[target + 2] = density
    image.data[target + 3] = 255
  }
  context.putImageData(image, 0, 0)
  return canvas
}

function fragmentShader(
  raymarchSteps: number,
  fieldCount: number,
  nearCount: number,
): string {
  const boxCount = fieldCount + nearCount
  const nearSteps = EXPERIENCE_CONFIG.clouds.near.raymarchSteps
  const marchLoopSteps = Math.max(raymarchSteps, nearSteps)
  const cfg = EXPERIENCE_CONFIG.clouds
  return `
    precision highp float;

    uniform sampler2D colorTexture;
    uniform sampler2D depthTexture;
    uniform sampler2D u_noiseAtlas;
    uniform mat4 u_eyeToEnu;
    uniform vec3 u_boxMin[${boxCount}];
    uniform vec3 u_boxMax[${boxCount}];
    uniform float u_boxOpacity[${boxCount}];
    uniform vec3 u_sunDirectionEnu;
    uniform vec3 u_sunColor;
    uniform vec3 u_ambientColor;
    uniform vec3 u_windOffset;
    uniform vec4 u_noiseLayout;
    uniform vec2 u_noiseAtlasSize;
    uniform float u_globalOpacity;
    uniform float u_motionOpacity;
    in vec2 v_textureCoordinates;

    float wrapIndex(float value, float size) {
      return mod(mod(value, size) + size, size);
    }

    float atlasVoxel(vec3 voxel) {
      float x = wrapIndex(voxel.x, u_noiseLayout.x);
      float y = wrapIndex(voxel.y, u_noiseLayout.x);
      float z = wrapIndex(voxel.z, u_noiseLayout.y);
      vec2 tile = vec2(mod(z, u_noiseLayout.z), floor(z / u_noiseLayout.z));
      vec2 pixel = tile * u_noiseLayout.x + vec2(x, y);
      return texture(u_noiseAtlas, (pixel + 0.5) / u_noiseAtlasSize).r;
    }

    // All three axes are interpolated manually. Sampling exact texel centres
    // prevents the atlas filter from bleeding across adjacent z-slice tiles.
    float cloudNoise(vec3 coordinate) {
      vec3 dimensions = vec3(u_noiseLayout.x, u_noiseLayout.x, u_noiseLayout.y);
      vec3 grid = fract(coordinate) * dimensions - 0.5;
      vec3 base = floor(grid);
      vec3 amount = fract(grid);
      float c000 = atlasVoxel(base);
      float c100 = atlasVoxel(base + vec3(1.0, 0.0, 0.0));
      float c010 = atlasVoxel(base + vec3(0.0, 1.0, 0.0));
      float c110 = atlasVoxel(base + vec3(1.0, 1.0, 0.0));
      float c001 = atlasVoxel(base + vec3(0.0, 0.0, 1.0));
      float c101 = atlasVoxel(base + vec3(1.0, 0.0, 1.0));
      float c011 = atlasVoxel(base + vec3(0.0, 1.0, 1.0));
      float c111 = atlasVoxel(base + vec3(1.0, 1.0, 1.0));
      return mix(
        mix(mix(c000, c100, amount.x), mix(c010, c110, amount.x), amount.y),
        mix(mix(c001, c101, amount.x), mix(c011, c111, amount.x), amount.y),
        amount.z
      );
    }

    vec2 intersectBox(vec3 origin, vec3 direction, vec3 boxMin, vec3 boxMax) {
      vec3 safeDirection = direction;
      if (abs(safeDirection.x) < 0.000001) {
        safeDirection.x = safeDirection.x < 0.0 ? -0.000001 : 0.000001;
      }
      if (abs(safeDirection.y) < 0.000001) {
        safeDirection.y = safeDirection.y < 0.0 ? -0.000001 : 0.000001;
      }
      if (abs(safeDirection.z) < 0.000001) {
        safeDirection.z = safeDirection.z < 0.0 ? -0.000001 : 0.000001;
      }
      vec3 t0 = (boxMin - origin) / safeDirection;
      vec3 t1 = (boxMax - origin) / safeDirection;
      vec3 near3 = min(t0, t1);
      vec3 far3 = max(t0, t1);
      return vec2(
        max(near3.x, max(near3.y, near3.z)),
        min(far3.x, min(far3.y, far3.z))
      );
    }

    float hash12(vec2 point) {
      vec3 p3 = fract(vec3(point.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      vec4 sceneColor = texture(colorTexture, v_textureCoordinates);
      float rawDepth = texture(depthTexture, v_textureCoordinates).r;

      // The two-argument overload reverses Cesium's logarithmic depth itself.
      // Calling czm_readDepth before this would decode it twice.
      vec4 positionEC = czm_windowToEyeCoordinates(gl_FragCoord.xy, rawDepth);
      positionEC /= max(abs(positionEC.w), 0.0000001);
      vec3 cameraEnu = (u_eyeToEnu * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
      vec3 surfaceEnu = (u_eyeToEnu * vec4(positionEC.xyz, 1.0)).xyz;
      vec3 toSurface = surfaceEnu - cameraEnu;
      float surfaceDistance = length(toSurface);
      if (surfaceDistance < 0.0001) {
        out_FragColor = sceneColor;
        return;
      }
      vec3 rayDirection = toSurface / surfaceDistance;
      float depthLimit = rawDepth >= 0.999999 ? 1.0e20 : surfaceDistance;

      vec3 cloudRgb = vec3(0.0);
      float cloudAlpha = 0.0;
      vec3 sunDirection = normalize(u_sunDirectionEnu);
      float g = ${cfg.hgG.toFixed(8)};
      float cosTheta = dot(rayDirection, sunDirection);
      float phase = (1.0 - g * g)
        / (pow(max(0.0001, 1.0 + g * g - 2.0 * g * cosTheta), 1.5)
          * ${String(4 * Math.PI)})
        + 0.3;
      float jitter = hash12(gl_FragCoord.xy);

      for (int boxIndex = 0; boxIndex < ${boxCount}; ++boxIndex) {
        if (u_boxOpacity[boxIndex] <= 0.0001) {
          continue;
        }
        vec2 hit = intersectBox(
          cameraEnu,
          rayDirection,
          u_boxMin[boxIndex],
          u_boxMax[boxIndex]
        );
        float entry = max(hit.x, 0.0);
        float exit = min(hit.y, depthLimit);
        if (entry >= exit) {
          continue;
        }

        bool isNearCloud = boxIndex >= ${fieldCount};
        float stepCount = isNearCloud
          ? ${nearSteps.toFixed(1)}
          : ${raymarchSteps.toFixed(1)};
        float stepLength = (exit - entry) / stepCount;
        vec3 boxSize = max(u_boxMax[boxIndex] - u_boxMin[boxIndex], vec3(0.001));
        vec3 lightDirectionLocal = normalize(sunDirection / boxSize);
        vec3 samplePosition = cameraEnu
          + rayDirection * (entry + jitter * stepLength);
        float boxFade = isNearCloud ? u_motionOpacity : u_globalOpacity;

        for (int stepIndex = 0; stepIndex < ${marchLoopSteps}; ++stepIndex) {
          if ((!isNearCloud && stepIndex >= ${raymarchSteps})
            || (isNearCloud && stepIndex >= ${nearSteps})) {
            break;
          }
          vec3 localPosition = (samplePosition - u_boxMin[boxIndex]) / boxSize
            + u_windOffset;
          float density = smoothstep(
            ${cfg.coverage[0].toFixed(8)},
            ${cfg.coverage[1].toFixed(8)},
            cloudNoise(localPosition)
          );
          if (density > 0.002) {
            float lightDensity = 0.0;
            vec3 lightPosition = localPosition;
            for (int lightIndex = 0; lightIndex < ${cfg.lightSteps}; ++lightIndex) {
              lightPosition += lightDirectionLocal * ${cfg.lightStepBoxFraction.toFixed(8)};
              lightDensity += smoothstep(
                ${cfg.coverage[0].toFixed(8)},
                ${cfg.coverage[1].toFixed(8)},
                cloudNoise(lightPosition)
              );
            }
            float tapExtinction = ${(cfg.extinction * cfg.lightStepBoxFraction).toFixed(8)};
            float transmittance = exp(-lightDensity * tapExtinction);
            float powder = 1.0 - exp(-lightDensity * tapExtinction * 2.0);
            vec3 lit = u_sunColor
              * transmittance
              * (powder * 0.7 + 0.3)
              * phase
              * ${cfg.sunBoost.toFixed(8)}
              + u_ambientColor * ${cfg.ambientAmount.toFixed(8)};
            float alpha = density
              * ${cfg.stepAlpha.toFixed(8)}
              * u_boxOpacity[boxIndex]
              * boxFade;
            cloudRgb += (1.0 - cloudAlpha) * alpha * lit;
            cloudAlpha += (1.0 - cloudAlpha) * alpha;
          }
          if (cloudAlpha >= 0.95) {
            break;
          }
          samplePosition += rayDirection * stepLength;
        }
        if (cloudAlpha >= 0.95) {
          break;
        }
      }

      out_FragColor = vec4(
        sceneColor.rgb * (1.0 - cloudAlpha) + cloudRgb,
        sceneColor.a
      );
    }
  `
}

export function createCloudVolumeLayer(
  options: CreateCloudVolumeLayerOptions,
): CloudVolumeLayer {
  const {
    scene,
    enuFrame,
    surveyCentreEnu,
    surveyRadiusM,
    areaMinZ,
    reducedMotion = false,
  } = options
  const cfg = EXPERIENCE_CONFIG.clouds
  const fieldCount = cfg.fields.length
  const nearCount = cfg.near.count
  const boxCount = fieldCount + nearCount
  const noiseSize = cfg.textureSizeStrong
  const noise = createCloudNoiseAtlas(noiseSize, noiseSize)
  const noiseCanvas = atlasCanvas(noise.atlas, noise.atlasWidth, noise.atlasHeight)
  const noiseLayout = new Cesium.Cartesian4(
    noise.sliceSize,
    noise.slices,
    noise.columns,
    noise.rows,
  )
  const noiseAtlasSize = new Cesium.Cartesian2(noise.atlasWidth, noise.atlasHeight)
  const eyeToEnu = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY)
  const sunDirection = new Cesium.Cartesian3(0.3, -0.4, 0.85)
  const sunColor = new Cesium.Cartesian3(1, 1, 1)
  const ambientColor = new Cesium.Cartesian3(0.7, 0.8, 0.9)
  const windOffset = new Cesium.Cartesian3()
  const boxMin = Array.from({ length: boxCount }, () => new Cesium.Cartesian3())
  const boxMax = Array.from({ length: boxCount }, () => new Cesium.Cartesian3())
  const boxOpacity = Array.from({ length: boxCount }, () => 0)
  const centreZ = Number.isFinite(surveyCentreEnu.z)
    ? Math.max(areaMinZ, surveyCentreEnu.z)
    : areaMinZ + 40
  const surveyCentre = new Cesium.Cartesian3(
    surveyCentreEnu.x,
    surveyCentreEnu.y,
    centreZ,
  )
  const cameraEnu = new Cesium.Cartesian3()
  const ambientScratch = new Cesium.Color()
  const nearClouds: NearCloudBox[] = []
  let enabled = false
  let disposed = false
  let currentSteps = Math.round(cfg.raymarchStepsStrong)
  let stage: Cesium.PostProcessStage
  let globalOpacity = 1
  const motionOpacity = reducedMotion ? 0.72 : 1
  let lastNearUpdate = performance.now()

  function setBounds(
    boxIndex: number,
    centre: Cesium.Cartesian3,
    size: Cesium.Cartesian3,
  ): void {
    Cesium.Cartesian3.fromElements(
      centre.x - size.x * 0.5,
      centre.y - size.y * 0.5,
      centre.z - size.z * 0.5,
      boxMin[boxIndex],
    )
    Cesium.Cartesian3.fromElements(
      centre.x + size.x * 0.5,
      centre.y + size.y * 0.5,
      centre.z + size.z * 0.5,
      boxMax[boxIndex],
    )
  }

  cfg.fields.forEach((field, index) => {
    const centre = new Cesium.Cartesian3(
      surveyCentre.x + field.offsetM[0],
      surveyCentre.y + field.offsetM[1],
      surveyCentre.z + field.offsetM[2],
    )
    const size = new Cesium.Cartesian3(field.sizeM[0], field.sizeM[1], field.sizeM[2])
    setBounds(index, centre, size)
    boxOpacity[index] = 1
  })

  // Deterministic lifecycle, matching the Three.js placement across reloads.
  let nearSeed = 0x9e3779b9
  function nearRandom(): number {
    nearSeed += 0x6d2b79f5
    let value = nearSeed
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }

  function nearBetween(range: readonly [number, number]): number {
    return range[0] + nearRandom() * (range[1] - range[0])
  }

  function respawnNearCloud(cloud: NearCloudBox, now: number, initial = false): void {
    const nearCfg = cfg.near
    const angle = nearRandom() * Math.PI * 2
    const radius = Math.sqrt(nearRandom())
      * Math.max(1, surveyRadiusM)
      * nearCfg.radiusFraction
    const altitude = nearBetween(nearCfg.altitudeM)
    const sizeX = nearBetween(nearCfg.sizeXyM)
    const sizeY = nearBetween(nearCfg.sizeXyM)
    const sizeZ = nearBetween(nearCfg.sizeZM)
    Cesium.Cartesian3.fromElements(
      surveyCentre.x + Math.cos(angle) * radius,
      surveyCentre.y + Math.sin(angle) * radius,
      surveyCentre.z + altitude + sizeZ * 0.5,
      cloud.centre,
    )
    Cesium.Cartesian3.fromElements(sizeX, sizeY, sizeZ, cloud.size)
    const perturbation = (nearRandom() - 0.5) * 0.9
    const windAngle = Math.atan2(cfg.windMps[1], cfg.windMps[0]) + perturbation
    Cesium.Cartesian2.fromElements(
      Math.cos(windAngle),
      Math.sin(windAngle),
      cloud.driftDirection,
    )
    cloud.visibleFor = nearBetween(nearCfg.visibleSeconds)
    cloud.gapFor = nearBetween(nearCfg.gapSeconds)
    const fullCycle = nearCfg.fadeSeconds * 2 + cloud.visibleFor + cloud.gapFor
    cloud.cycleStart = initial ? now - nearRandom() * fullCycle * 1000 : now
    setBounds(cloud.boxIndex, cloud.centre, cloud.size)
  }

  const initialNow = performance.now()
  for (let index = 0; index < nearCount; index++) {
    const cloud: NearCloudBox = {
      boxIndex: fieldCount + index,
      centre: new Cesium.Cartesian3(),
      size: new Cesium.Cartesian3(1, 1, 1),
      driftDirection: new Cesium.Cartesian2(1, 0),
      cycleStart: initialNow,
      visibleFor: 120,
      gapFor: 60,
    }
    respawnNearCloud(cloud, initialNow, true)
    nearClouds.push(cloud)
  }

  function buildStage(steps: number): Cesium.PostProcessStage {
    const nextStage = new Cesium.PostProcessStage({
      name: 'wilderness-volume-clouds',
      textureScale: 0.5,
      sampleMode: Cesium.PostProcessStageSampleMode.LINEAR,
      fragmentShader: fragmentShader(steps, fieldCount, nearCount),
      uniforms: {
        u_noiseAtlas: noiseCanvas,
        u_eyeToEnu: () => eyeToEnu,
        u_boxMin: () => boxMin,
        u_boxMax: () => boxMax,
        u_boxOpacity: () => boxOpacity,
        u_sunDirectionEnu: () => sunDirection,
        u_sunColor: () => sunColor,
        u_ambientColor: () => ambientColor,
        u_windOffset: () => windOffset,
        u_noiseLayout: () => noiseLayout,
        u_noiseAtlasSize: () => noiseAtlasSize,
        u_globalOpacity: () => globalOpacity,
        u_motionOpacity: motionOpacity,
      },
    })
    nextStage.enabled = enabled
    scene.postProcessStages.add(nextStage)
    return nextStage
  }

  stage = buildStage(currentSteps)

  function updateNearClouds(now: number): void {
    const elapsedSeconds = Math.min(0.1, Math.max(0, now - lastNearUpdate) * 0.001)
    lastNearUpdate = now
    enuFrame.worldToEnu(scene.camera.positionWC, cameraEnu)
    const nearCfg = cfg.near
    for (const cloud of nearClouds) {
      const age = (now - cloud.cycleStart) * 0.001
      const fade = nearCfg.fadeSeconds
      const fullCycle = fade * 2 + cloud.visibleFor + cloud.gapFor
      if (age >= fullCycle) {
        respawnNearCloud(cloud, now)
        boxOpacity[cloud.boxIndex] = 0
        continue
      }
      let envelope = 0
      if (age < fade) envelope = smooth01(0, 1, age / fade)
      else if (age < fade + cloud.visibleFor) envelope = 1
      else if (age < fade * 2 + cloud.visibleFor) {
        envelope = smooth01(0, 1, 1 - (age - fade - cloud.visibleFor) / fade)
      }
      if (envelope > 0) {
        cloud.centre.x += cloud.driftDirection.x * nearCfg.driftMps * elapsedSeconds
        cloud.centre.y += cloud.driftDirection.y * nearCfg.driftMps * elapsedSeconds
        const halfDiagonal = Cesium.Cartesian3.magnitude(cloud.size) * 0.5
        const distance = Cesium.Cartesian3.distance(cameraEnu, cloud.centre)
        envelope *= smooth01(halfDiagonal * 0.8, halfDiagonal * 1.6, distance)
        setBounds(cloud.boxIndex, cloud.centre, cloud.size)
      }
      boxOpacity[cloud.boxIndex] = envelope * nearCfg.maxOpacity
    }
  }

  return {
    setEnabled(nextEnabled) {
      if (disposed) return
      enabled = nextEnabled
      stage.enabled = nextEnabled
    },
    update(now, daylightState, cameraGroundRange) {
      if (disposed) return
      Cesium.Matrix4.multiply(enuFrame.inverse, scene.camera.inverseViewMatrix, eyeToEnu)
      Cesium.Cartesian3.clone(daylightState.sunDirectionEnu, sunDirection)
      Cesium.Cartesian3.normalize(sunDirection, sunDirection)
      const daylight = clamp01(
        (daylightState.intensity - EXPERIENCE_CONFIG.environment.minimumSceneLight)
        / (1 - EXPERIENCE_CONFIG.environment.minimumSceneLight),
      )
      const sunScale = Cesium.Math.lerp(0.35, 1.6, daylight)
      Cesium.Cartesian3.fromElements(
        daylightState.lightColor.red * sunScale,
        daylightState.lightColor.green * sunScale,
        daylightState.lightColor.blue * sunScale,
        sunColor,
      )
      Cesium.Color.lerp(
        daylightState.skyColor,
        Cesium.Color.WHITE,
        0.55 * daylight + 0.1,
        ambientScratch,
      )
      Cesium.Cartesian3.fromElements(
        ambientScratch.red * daylightState.ambientIntensity,
        ambientScratch.green * daylightState.ambientIntensity,
        ambientScratch.blue * daylightState.ambientIntensity,
        ambientColor,
      )
      const windSeconds = now * 0.001
      Cesium.Cartesian3.fromElements(
        (windSeconds * cfg.windMps[0] / 20_000) % 1,
        (windSeconds * cfg.windMps[1] / 8_000) % 1,
        0,
        windOffset,
      )
      globalOpacity = smooth01(
        cfg.closeFadeEndM,
        cfg.closeFadeStartM,
        cameraGroundRange,
      ) * motionOpacity
      updateNearClouds(now)
    },
    setQuality(steps) {
      if (disposed) return
      const nextSteps = Math.round(Cesium.Math.clamp(steps, 8, 96))
      if (nextSteps === currentSteps) return
      currentSteps = nextSteps
      const previousStage = stage
      if (!scene.postProcessStages.remove(previousStage) && !previousStage.isDestroyed()) {
        previousStage.destroy()
      }
      stage = buildStage(currentSteps)
    },
    dispose() {
      if (disposed) return
      disposed = true
      const sceneDestroyed = (scene as any).isDestroyed?.() ?? false
      const removed = !sceneDestroyed && scene.postProcessStages.remove(stage)
      if (!removed && !stage.isDestroyed()) stage.destroy()
    },
  }
}
