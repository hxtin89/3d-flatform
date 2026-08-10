import * as Cesium from 'cesium'
import { EXPERIENCE_CONFIG } from './config'
import type { EnuFrame } from './enu'

export interface GroundSample {
  /** Low percentile of the sampled surface — the forest floor, in ENU metres
   * of the manifest rootTransform frame (see sampleGroundZ for why that needs
   * no correction here, unlike the three.js twin). */
  groundZ: number
  /** High percentile — the canopy top. */
  canopyZ: number
  samples: number
  /** Occupied cells of the 5×5 support grid; low values mean a thin sample. */
  support: number
}

/** Probe grid over the footprint. Each cell costs one scene.sampleHeight(),
 * i.e. one offscreen pick render, so the layer above throttles and settles. */
const PROBE_GRID = 7
const SUPPORT_GRID = 5

export interface PointTileset {
  tileset: Cesium.Cesium3DTileset
  /**
   * Statistical ground/canopy height over a square footprint of side
   * 2 × radiusM centred on `centreEnu`, in the same ENU frame as the manifest
   * bboxes. Null while the tileset is still streaming or depth picking is
   * unsupported.
   *
   * Mirrors `StreamingCloud.sampleGroundZ()` on the three.js side, but by a
   * different route: Cesium exposes no stable API for decoded PNTS positions,
   * so this samples the depth buffer instead of the point buffers.
   */
  sampleGroundZ(centreEnu: Cesium.Cartesian2, radiusM: number): GroundSample | null
  setErrorTarget(sse: number): void
  setPointSizeCss(px: number): void
  setDaylight(colorRgb: [number, number, number], intensity: number, goldenFactor: number): void
  setMask(centerEnuXY: [number, number] | null, radiusM: number, dimFloor: number): void
  setCloudShadowTexture(typedArray: Uint8Array, width: number, height: number): void
  setCloudShadow(strength: number, offsetUV: [number, number]): void
  updateFrame(camera: Cesium.Camera): void
  stats(): { points: number; visibleTiles: number; cacheBytes: number; memoryAdjustedSse: number }
  setMemoryBudget(cacheBytes: number, overflowBytes: number): void
  dispose(): void
}

export interface CreatePointTilesetOptions {
  url: string
  enuFrame: EnuFrame
  scene: Cesium.Scene
}

function colorFromHex(rgb: number): Cesium.Cartesian3 {
  return new Cesium.Cartesian3(
    ((rgb >> 16) & 0xff) / 255,
    ((rgb >> 8) & 0xff) / 255,
    (rgb & 0xff) / 255,
  )
}

function finiteOrZero(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

export async function createPointTileset(
  opts: CreatePointTilesetOptions,
): Promise<PointTileset> {
  const whiteShadowPlaceholder = new Cesium.TextureUniform({
    typedArray: new Uint8Array([255, 255, 255, 255]),
    width: 1,
    height: 1,
    repeat: true,
    pixelFormat: Cesium.PixelFormat.RGBA,
    pixelDatatype: Cesium.PixelDatatype.UNSIGNED_BYTE,
  })
  const warmRimColor = colorFromHex(EXPERIENCE_CONFIG.pointLighting.warmRim)
  const eyeToEnu = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY)

  const customShader = new Cesium.CustomShader({
    mode: Cesium.CustomShaderMode.REPLACE_MATERIAL,
    lightingModel: Cesium.LightingModel.UNLIT,
    uniforms: {
      u_pointSizeCss: {
        type: Cesium.UniformType.FLOAT,
        value: EXPERIENCE_CONFIG.lod.fixedPointSizePx,
      },
      u_eyeToEnu: {
        type: Cesium.UniformType.MAT4,
        value: eyeToEnu,
      },
      u_daylightColor: {
        type: Cesium.UniformType.VEC3,
        value: new Cesium.Cartesian3(1, 1, 1),
      },
      u_daylightIntensity: {
        type: Cesium.UniformType.FLOAT,
        value: 1,
      },
      u_goldenFactor: {
        type: Cesium.UniformType.FLOAT,
        value: 0,
      },
      u_warmRimColor: {
        type: Cesium.UniformType.VEC3,
        value: warmRimColor,
      },
      u_canopyTopZ: {
        type: Cesium.UniformType.FLOAT,
        value: EXPERIENCE_CONFIG.navigation.fallbackCloudHeightM,
      },
      u_maskEnabled: {
        type: Cesium.UniformType.BOOL,
        value: false,
      },
      u_maskCenter: {
        type: Cesium.UniformType.VEC2,
        value: new Cesium.Cartesian2(),
      },
      u_maskRadius: {
        type: Cesium.UniformType.FLOAT,
        value: 1,
      },
      u_maskDimFloor: {
        type: Cesium.UniformType.FLOAT,
        value: 0.30,
      },
      u_cloudShadow: {
        type: Cesium.UniformType.SAMPLER_2D,
        value: whiteShadowPlaceholder,
      },
      u_shadowStrength: {
        type: Cesium.UniformType.FLOAT,
        value: 0,
      },
      u_shadowUvScale: {
        type: Cesium.UniformType.FLOAT,
        value: 1 / EXPERIENCE_CONFIG.pointLighting.cloudShadowScaleM,
      },
      u_shadowOffset: {
        type: Cesium.UniformType.VEC2,
        value: new Cesium.Cartesian2(),
      },
    },
    vertexShaderText: `
      void vertexMain(VertexInput vsInput, inout czm_modelVertexOutput vsOutput) {
        vsOutput.pointSize = u_pointSizeCss * czm_pixelRatio;
      }
    `,
    fragmentShaderText: `
      void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
        vec3 enu = (u_eyeToEnu * vec4(fsInput.attributes.positionEC, 1.0)).xyz;

        float maskDim = 1.0;
        if (u_maskEnabled) {
          float maskDistance = length(enu.xy - u_maskCenter);
          if (maskDistance > u_maskRadius) {
            discard;
          }
          float edgeFade = 1.0 - smoothstep(
            u_maskRadius * 0.5,
            u_maskRadius,
            maskDistance
          );
          maskDim = mix(u_maskDimFloor, 1.0, edgeFade);
        }

        float shadowDensity = smoothstep(
          0.32,
          0.62,
          texture(u_cloudShadow, enu.xy * u_shadowUvScale + u_shadowOffset).r
        );
        float cloudShadow = 1.0 - shadowDensity * u_shadowStrength;

        float height01 = smoothstep(0.0, u_canopyTopZ, enu.z);
        vec3 goldenRim = mix(
          vec3(1.0),
          u_warmRimColor,
          height01 * u_goldenFactor
        );

        // PNTS RGB is assumed to be sRGB encoded; CustomShader attributes are
        // raw normalized values, so decode them before the linear multipliers.
        vec3 baseColor = pow(
          max(fsInput.attributes.color_0.rgb, vec3(0.0)),
          vec3(2.2)
        );
        material.diffuse = baseColor
          * u_daylightColor
          * u_daylightIntensity
          * goldenRim
          * cloudShadow
          * maskDim;
        material.alpha = 1.0;
      }
    `,
  })

  const tileset = await Cesium.Cesium3DTileset.fromUrl(opts.url, {
    dynamicScreenSpaceError: false,
    foveatedScreenSpaceError: false,
    cullRequestsWhileMoving: false,
    preloadFlightDestinations: false,
    progressiveResolutionHeightFraction: 0,
    skipLevelOfDetail: false,
    pointCloudShading: {
      attenuation: false,
      eyeDomeLighting: false,
    },
  })

  // Keep the fair-comparison pins explicit on the live object as well as in
  // fromUrl options, so later Cesium default changes cannot alter the subject.
  tileset.dynamicScreenSpaceError = false
  tileset.foveatedScreenSpaceError = false
  tileset.cullRequestsWhileMoving = false
  tileset.preloadFlightDestinations = false
  tileset.progressiveResolutionHeightFraction = 0
  tileset.skipLevelOfDetail = false
  tileset.pointCloudShading.attenuation = false
  tileset.pointCloudShading.eyeDomeLighting = false
  tileset.customShader = customShader

  const daylightColor = new Cesium.Cartesian3()
  const maskCenter = new Cesium.Cartesian2()
  const shadowOffset = new Cesium.Cartesian2()
  // Reused by the ground probe so one sample allocates nothing.
  const probeEnu = new Cesium.Cartesian3()
  const probeWorld = new Cesium.Cartesian3()
  const probeCarto = new Cesium.Cartographic()
  let disposed = false

  return {
    tileset,
    sampleGroundZ(centreEnu, radiusM) {
      const scene = opts.scene
      // tilesLoaded alone is not enough: it is true for an empty traversal too,
      // and each probe costs PROBE_GRID² offscreen pick renders. Without the
      // point check the probe would hammer a viewer that has not loaded
      // anything yet — exactly when it is slowest.
      if (disposed || !scene.sampleHeightSupported || !tileset.tilesLoaded) return null
      if (!((tileset as any).statistics?.numberOfPointsLoaded > 0)) return null
      const config = EXPERIENCE_CONFIG.donationShape

      const heights: number[] = []
      // 5×5 support grid: a candidate height backed by one corner of the
      // footprint is noise, not ground.
      const support = new Uint8Array(SUPPORT_GRID * SUPPORT_GRID)

      // Hide the globe for the duration of the probe. sampleHeight reports the
      // topmost RENDERED surface, and the draped imagery sits on the bare
      // ellipsoid ~230 m below the survey — a single globe hit would drag the
      // low percentile down with it. With the globe out, a cell either returns
      // the point cloud or nothing, which is exactly the three.js semantics
      // (that probe reads tile position buffers and never sees terrain).
      // sampleHeight is synchronous, so the flag is restored before any frame
      // the user can see.
      const globe = scene.globe
      const globeWasShown = globe ? globe.show : true
      if (globe) globe.show = false
      try {
        for (let row = 0; row < PROBE_GRID; row++) {
          for (let column = 0; column < PROBE_GRID; column++) {
            const dx = (((column + 0.5) / PROBE_GRID) * 2 - 1) * radiusM
            const dy = (((row + 0.5) / PROBE_GRID) * 2 - 1) * radiusM
            Cesium.Cartesian3.fromElements(centreEnu.x + dx, centreEnu.y + dy, 0, probeEnu)
            opts.enuFrame.enuToWorld(probeEnu, probeWorld)
            const carto = Cesium.Cartographic.fromCartesian(probeWorld, undefined, probeCarto)
            if (!carto) continue

            // Still the height of the TOPMOST thing under the column, so in
            // dense forest most cells return canopy, not ground. That is
            // exactly why groundZ is a low percentile: the gaps between crowns
            // carry the floor. A residual error of a few metres is expected —
            // EXPERIENCE_CONFIG.donationShape.groundZOverrideM is the escape
            // hatch when a site's canopy defeats the probe outright.
            let height: number | undefined
            try {
              height = scene.sampleHeight(carto, undefined, 2)
            } catch {
              // Depth picking can be unavailable for a frame while tiles swap.
              height = undefined
            }
            if (height === undefined || !Number.isFinite(height)) continue

            // Vertical frame: the hit goes back through the SAME enuFrame the
            // tileset is placed by, so the result is already in the manifest
            // ENU frame that areaBbox / fallbackGroundZ live in. Verified
            // against the published tileset: the APH root transform is
            // byte-identical to manifest.rootTransform, and the deepest tile
            // over the parcel has box z 191.6 … 223.2 in that frame — matching
            // the three.js measurement of ground 194.8 / canopy 223.8. The
            // three.js app needs a −zOffset correction only because it renders
            // the cloud ground-snapped onto the draped imagery; this app adds
            // the tileset with no modelMatrix override, so there is no lift to
            // remove.
            Cesium.Cartesian3.fromRadians(
              carto.longitude,
              carto.latitude,
              height,
              undefined,
              probeWorld,
            )
            opts.enuFrame.worldToEnu(probeWorld, probeEnu)
            heights.push(probeEnu.z)

            const cell = Math.min(4, Math.max(0, Math.floor((dx / radiusM + 1) * 2.5)))
            const band = Math.min(4, Math.max(0, Math.floor((dy / radiusM + 1) * 2.5)))
            support[band * SUPPORT_GRID + cell] = 1
          }
        }
      } finally {
        if (globe) globe.show = globeWasShown
      }

      // probeMinSamples counts point-cloud vertices on the three.js side; this
      // depth grid can never return more than PROBE_GRID² hits, so the gate is
      // the smaller of the configured floor and a quarter of the grid.
      const minimumSamples = Math.min(
        config.probeMinSamples,
        Math.ceil(PROBE_GRID * PROBE_GRID * 0.25),
      )
      if (heights.length < minimumSamples) return null
      heights.sort((a, b) => a - b)
      const at = (fraction: number): number =>
        heights[Math.min(heights.length - 1, Math.max(0, Math.floor(heights.length * fraction)))]
      let occupied = 0
      for (const cell of support) occupied += cell
      return {
        groundZ: at(config.probeGroundPercentile),
        canopyZ: at(config.probeCanopyPercentile),
        samples: heights.length,
        support: occupied,
      }
    },
    setErrorTarget(sse) {
      if (Number.isFinite(sse) && sse > 0) tileset.maximumScreenSpaceError = sse
    },
    setPointSizeCss(px) {
      if (!Number.isFinite(px)) return
      customShader.setUniform('u_pointSizeCss', Math.max(0.01, px))
    },
    setDaylight(colorRgb, intensity, goldenFactor) {
      Cesium.Cartesian3.fromElements(colorRgb[0], colorRgb[1], colorRgb[2], daylightColor)
      customShader.setUniform('u_daylightColor', daylightColor)
      customShader.setUniform('u_daylightIntensity', Math.max(0, intensity))
      customShader.setUniform('u_goldenFactor', Cesium.Math.clamp(goldenFactor, 0, 1))
    },
    setMask(centerEnuXY, radiusM, dimFloor) {
      customShader.setUniform('u_maskEnabled', centerEnuXY !== null)
      if (centerEnuXY) {
        Cesium.Cartesian2.fromElements(centerEnuXY[0], centerEnuXY[1], maskCenter)
        customShader.setUniform('u_maskCenter', maskCenter)
      }
      customShader.setUniform('u_maskRadius', Math.max(0.01, radiusM))
      customShader.setUniform('u_maskDimFloor', Cesium.Math.clamp(dimFloor, 0, 1))
    },
    setCloudShadowTexture(typedArray, width, height) {
      if (disposed || !Number.isInteger(width) || width < 1
        || !Number.isInteger(height) || height < 1
        || typedArray.length !== width * height) return
      // TextureUniform supports RGBA reliably across Cesium's WebGL paths.
      // Expand the single density channel once; the fragment shader samples R.
      const rgba = new Uint8Array(width * height * 4)
      for (let source = 0, target = 0; source < typedArray.length; source++, target += 4) {
        const density = typedArray[source]
        rgba[target] = density
        rgba[target + 1] = density
        rgba[target + 2] = density
        rgba[target + 3] = 255
      }
      customShader.setUniform('u_cloudShadow', new Cesium.TextureUniform({
        typedArray: rgba,
        width,
        height,
        repeat: true,
        pixelFormat: Cesium.PixelFormat.RGBA,
        pixelDatatype: Cesium.PixelDatatype.UNSIGNED_BYTE,
        minificationFilter: Cesium.TextureMinificationFilter.LINEAR,
        magnificationFilter: Cesium.TextureMagnificationFilter.LINEAR,
      }))
    },
    setCloudShadow(strength, offsetUV) {
      Cesium.Cartesian2.fromElements(offsetUV[0], offsetUV[1], shadowOffset)
      customShader.setUniform('u_shadowStrength', Cesium.Math.clamp(strength, 0, 1))
      customShader.setUniform('u_shadowOffset', shadowOffset)
    },
    updateFrame(camera) {
      // positionEC is camera-relative. Recompose eye -> ECEF -> ENU in float64
      // on the CPU, avoiding both RTC_CENTER tile-local positions and GLSL ECEF
      // subtraction at ~5.8e6-m magnitudes.
      Cesium.Matrix4.multiply(opts.enuFrame.inverse, camera.inverseViewMatrix, eyeToEnu)
      customShader.setUniform('u_eyeToEnu', eyeToEnu)
    },
    stats() {
      const liveTileset = tileset as any
      const statistics = liveTileset.statistics ?? liveTileset._statistics ?? {}
      const selectedTiles = statistics.selectedTiles ?? liveTileset._selectedTiles
      const visibleTiles = Array.isArray(selectedTiles)
        ? selectedTiles.length
        : finiteOrZero(statistics.selected)
      return {
        points: finiteOrZero(statistics.numberOfPointsSelected),
        visibleTiles,
        cacheBytes: finiteOrZero(statistics.geometryByteLength)
          + finiteOrZero(statistics.texturesByteLength),
        memoryAdjustedSse: finiteOrZero(
          liveTileset.memoryAdjustedScreenSpaceError ?? tileset.maximumScreenSpaceError,
        ),
      }
    },
    setMemoryBudget(cacheBytes, overflowBytes) {
      tileset.cacheBytes = Math.max(0, cacheBytes)
      tileset.maximumCacheOverflowBytes = Math.max(0, overflowBytes)
    },
    dispose() {
      if (disposed) return
      disposed = true
      const sceneDestroyed = (opts.scene as any).isDestroyed?.() ?? false
      const wasRemoved = !sceneDestroyed
        && opts.scene.primitives.contains(tileset)
        && opts.scene.primitives.remove(tileset)
      if (!wasRemoved && !(tileset as any).isDestroyed?.()) tileset.destroy()
      if (!customShader.isDestroyed()) customShader.destroy()
    },
  }
}
