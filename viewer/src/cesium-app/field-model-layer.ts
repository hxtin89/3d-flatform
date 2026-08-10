import * as Cesium from 'cesium'
import { EXPERIENCE_CONFIG } from './config'
import type { EnuFrame } from './enu'
import type { DaylightPhase, PerformanceTier } from './environment-layer'

export interface FieldModelLayer {
  update(now: number): void
  setVisible(visible: boolean): void
  setPerformanceTier(tier: PerformanceTier): void
  setDaylightPhase(phase: DaylightPhase): void
  dispose(): void
}

export interface FieldModelLayerOptions {
  scene: Cesium.Scene
  enuFrame: EnuFrame
  originEnu: Cesium.Cartesian3
  performanceTier: PerformanceTier
  reducedMotion: boolean
  onStatus?(message: string): void
}

interface BirdRecord {
  model: Cesium.Model
  offset: Cesium.Cartesian3
  scale: number
}

const FLIGHT_ANIMATION_INDEX = 0
const GLTF_LINEAR_FILTER = 9729
const GLTF_LINEAR_MIPMAP_LINEAR_FILTER = 9987
const GLTF_REPEAT_WRAP = 10497

function assetUrl(path: string): string {
  const base = import.meta.env.BASE_URL.endsWith('/')
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`
  return `${base}${path.replace(/^\/+/, '')}`
}

function bakedMaterial(
  name: string,
  textureIndex: number,
  emissiveAmount: number,
  texCoord = 0,
  transparent = false,
): Record<string, unknown> {
  return {
    name,
    pbrMetallicRoughness: {
      baseColorTexture: { index: textureIndex, texCoord },
      metallicFactor: 0,
      roughnessFactor: 0.88,
    },
    emissiveTexture: { index: textureIndex, texCoord },
    emissiveFactor: [emissiveAmount, emissiveAmount, emissiveAmount],
    doubleSided: transparent,
    ...(transparent ? { alphaMode: 'MASK', alphaCutoff: 0.08 } : {}),
  }
}

function installTowerMaterials(gltf: any): void {
  gltf.samplers = [{
    magFilter: GLTF_LINEAR_FILTER,
    minFilter: GLTF_LINEAR_MIPMAP_LINEAR_FILTER,
    wrapS: GLTF_REPEAT_WRAP,
    wrapT: GLTF_REPEAT_WRAP,
  }]
  gltf.images = [
    { uri: assetUrl('assets/models/tower/tower-bottom.webp') },
    { uri: assetUrl('assets/models/tower/tower-top.webp') },
  ]
  gltf.textures = [
    { sampler: 0, source: 0 },
    { sampler: 0, source: 1 },
  ]
  gltf.materials = [
    bakedMaterial('tower-bottom-baked', 0, 0.38),
    bakedMaterial('tower-top-baked', 1, 0.42, 0, true),
  ]

  const topMeshIndices = new Set<number>()
  for (const node of gltf.nodes ?? []) {
    if (typeof node.mesh === 'number' && /004$/.test(String(node.name ?? '').replace('.', ''))) {
      topMeshIndices.add(node.mesh)
    }
  }
  for (let meshIndex = 0; meshIndex < (gltf.meshes?.length ?? 0); meshIndex++) {
    const materialIndex = topMeshIndices.has(meshIndex) ? 1 : 0
    for (const primitive of gltf.meshes[meshIndex].primitives ?? []) {
      primitive.material = materialIndex
    }
  }
}

function installBoatMaterial(gltf: any): void {
  gltf.samplers = [{
    magFilter: GLTF_LINEAR_FILTER,
    minFilter: GLTF_LINEAR_MIPMAP_LINEAR_FILTER,
    wrapS: GLTF_REPEAT_WRAP,
    wrapT: GLTF_REPEAT_WRAP,
  }]
  gltf.images = [{
    uri: assetUrl('assets/models/boat/MergedBake_Bake1_CyclesBake_COMBINED.webp'),
  }]
  gltf.textures = [{ sampler: 0, source: 0 }]
  // The merged Cycles bake was authored against TEXCOORD_1.
  gltf.materials = [bakedMaterial('boat-baked', 0, 0.48, 1)]
  for (const mesh of gltf.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) primitive.material = 0
  }
}

function installParrotMaterials(gltf: any): void {
  gltf.samplers = [{
    magFilter: GLTF_LINEAR_FILTER,
    minFilter: GLTF_LINEAR_MIPMAP_LINEAR_FILTER,
    wrapS: GLTF_REPEAT_WRAP,
    wrapT: GLTF_REPEAT_WRAP,
  }]
  gltf.images = [
    { uri: assetUrl('assets/models/parrot/Scarlet_Macaw_difuse.webp') },
    {
      uri: assetUrl(
        'assets/models/parrot/Scarlet_macaw_wings_difuse-Scarlet_macaw_wings_alpha.webp',
      ),
    },
    {
      uri: assetUrl(
        'assets/models/parrot/Scarlet_Macaw_tail-Scarlet_Macaw_tail_alpha.webp',
      ),
    },
  ]
  gltf.textures = [
    { sampler: 0, source: 0 },
    { sampler: 0, source: 1 },
    { sampler: 0, source: 2 },
  ]
  gltf.materials = [
    bakedMaterial('Scarlet_macaw_body', 0, 0.62, 0, true),
    bakedMaterial('Scarlet_macaw_wings', 1, 0.62, 0, true),
    bakedMaterial('Scarlet_macaw_tail', 2, 0.62, 0, true),
  ]
}

function rotationZxy(
  rotation: readonly [number, number, number],
): Cesium.Matrix3 {
  const rotationZ = Cesium.Matrix3.fromRotationZ(rotation[2])
  const rotationX = Cesium.Matrix3.fromRotationX(rotation[0])
  const rotationY = Cesium.Matrix3.fromRotationY(rotation[1])
  const result = Cesium.Matrix3.multiply(rotationZ, rotationX, new Cesium.Matrix3())
  return Cesium.Matrix3.multiply(result, rotationY, result)
}

function composeModelMatrix(
  enuFrame: EnuFrame,
  positionEnu: Cesium.Cartesian3,
  rotation: Cesium.Matrix3,
  scale: number,
  result = new Cesium.Matrix4(),
): Cesium.Matrix4 {
  // Matrix4.fromRotationTranslation is T · R. Scaling its basis columns then
  // gives the requested ENU · T · Rz · Rx · Ry · S composition.
  const local = Cesium.Matrix4.fromRotationTranslation(rotation, positionEnu, result)
  Cesium.Matrix4.multiplyByUniformScale(local, scale, local)
  return Cesium.Matrix4.multiply(enuFrame.matrix, local, result)
}

function offsetPosition(
  origin: Cesium.Cartesian3,
  offset: readonly [number, number, number],
): Cesium.Cartesian3 {
  return new Cesium.Cartesian3(
    origin.x + offset[0],
    origin.y + offset[1],
    origin.z + offset[2],
  )
}

function countForTier(tier: PerformanceTier): number {
  if (tier === 'strong') return EXPERIENCE_CONFIG.parrots.strongCount
  if (tier === 'balanced') return EXPERIENCE_CONFIG.parrots.balancedCount
  return EXPERIENCE_CONFIG.parrots.constrainedCount
}

function randomBetween(minimum: number, maximum: number): number {
  return minimum + Math.random() * (maximum - minimum)
}

export async function createFieldModelLayer(
  options: FieldModelLayerOptions,
): Promise<FieldModelLayer> {
  const {
    scene,
    enuFrame,
    performanceTier,
    reducedMotion,
    onStatus,
  } = options
  const originEnu = Cesium.Cartesian3.clone(options.originEnu)
  const towerMatrix = composeModelMatrix(
    enuFrame,
    offsetPosition(originEnu, EXPERIENCE_CONFIG.tower.positionM),
    rotationZxy(EXPERIENCE_CONFIG.tower.rotationRad),
    EXPERIENCE_CONFIG.tower.scale,
  )
  const boatMatrix = composeModelMatrix(
    enuFrame,
    offsetPosition(originEnu, EXPERIENCE_CONFIG.boat.positionM),
    rotationZxy(EXPERIENCE_CONFIG.boat.rotationRad),
    EXPERIENCE_CONFIG.boat.scale,
  )

  onStatus?.('Loading field models…')
  const loadModel = async (
    url: string,
    modelMatrix: Cesium.Matrix4,
    gltfCallback: (gltf: any) => void,
    cull = true,
  ): Promise<Cesium.Model> => {
    const model = await Cesium.Model.fromGltfAsync({
      url,
      modelMatrix,
      show: false,
      allowPicking: false,
      shadows: Cesium.ShadowMode.DISABLED,
      enableVerticalExaggeration: false,
      cull,
      gltfCallback,
      // Cesium normally converts glTF Y-up/Z-forward into Z-up/X-forward.
      // Three exposes the asset's raw +Y/+Z axes and the source layer already
      // encodes that conversion in config.rotationRad (parent Z, then model
      // X/Y). Suppressing Cesium's implicit correction preserves the source
      // visual transform. Final orientation is verified in the live scene.
      upAxis: Cesium.Axis.Z,
      forwardAxis: Cesium.Axis.X,
    })
    return model
  }

  const parrotUrl = assetUrl('assets/models/parrot/Scarlet_macaw-limit-animations.gltf')
  const parrotRotation = rotationZxy(EXPERIENCE_CONFIG.parrots.modelRotationRad)
  const birdCapacity = EXPERIENCE_CONFIG.parrots.strongCount
  const initialBirdMatrix = composeModelMatrix(
    enuFrame,
    originEnu,
    parrotRotation,
    EXPERIENCE_CONFIG.parrots.modelScale,
  )
  const loadTasks: Promise<Cesium.Model>[] = [
    loadModel(
      assetUrl('assets/models/tower/tower.gltf'),
      towerMatrix,
      installTowerMaterials,
    ),
    loadModel(
      assetUrl('assets/models/boat/boat.gltf'),
      boatMatrix,
      installBoatMaterial,
    ),
    ...Array.from({ length: birdCapacity }, () => loadModel(
      parrotUrl,
      Cesium.Matrix4.clone(initialBirdMatrix),
      installParrotMaterials,
      false,
    )),
  ]

  const settled = await Promise.allSettled(loadTasks)
  const failed = settled.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  )
  const loadedModels = settled.flatMap((result) => (
    result.status === 'fulfilled' ? [result.value] : []
  ))
  if (failed) {
    for (const model of loadedModels) {
      if (!model.isDestroyed()) model.destroy()
    }
    throw failed.reason
  }

  const tower = loadedModels[0]
  const boat = loadedModels[1]
  const birds: BirdRecord[] = loadedModels.slice(2).map((model, index) => ({
    model,
    offset: new Cesium.Cartesian3(),
    scale: EXPERIENCE_CONFIG.parrots.modelScale * (0.88 + (index % 4) * 0.07),
  }))
  const primitives = new Cesium.PrimitiveCollection()
  for (const model of loadedModels) primitives.add(model)
  try {
    scene.primitives.add(primitives)
  } catch (error) {
    if (!primitives.isDestroyed()) primitives.destroy()
    throw error
  }

  const animationEpochMs = performance.now()
  const animationEventRemovers: Array<() => void> = []
  for (let index = 0; index < birds.length; index++) {
    const bird = birds[index]
    let animationStarted = false
    const startAnimation = () => {
      if (animationStarted || bird.model.isDestroyed()) return
      animationStarted = true
      // The product clock is paused and advanced from the Peru time control.
      // Keep skeletal animation on monotonic real time without changing that
      // one-time-source contract.
      bird.model.activeAnimations.animateWhilePaused = true
      bird.model.activeAnimations.add({
        index: FLIGHT_ANIMATION_INDEX,
        loop: Cesium.ModelAnimationLoop.REPEAT,
        multiplier: EXPERIENCE_CONFIG.parrots.animationSpeed,
        animationTime: (duration) => {
          const elapsedSeconds = (performance.now() - animationEpochMs) / 1000
          const phaseSeconds = index * 0.37 / EXPERIENCE_CONFIG.parrots.animationSpeed
          return (elapsedSeconds + phaseSeconds) / Math.max(duration, 1e-6)
        },
      })
    }
    if (bird.model.ready) startAnimation()
    else animationEventRemovers.push(bird.model.readyEvent.addEventListener(startAnimation))
  }

  const passStart = new Cesium.Cartesian3()
  const passEnd = new Cesium.Cartesian3()
  const passForward = new Cesium.Cartesian3()
  const passRight = new Cesium.Cartesian3()
  const passUp = new Cesium.Cartesian3()
  const passOrientation = new Cesium.Matrix3()
  const birdRotation = new Cesium.Matrix3()
  const birdOffsetEnu = new Cesium.Cartesian3()
  const birdPositionEnu = new Cesium.Cartesian3()
  const flockPosition = new Cesium.Cartesian3()
  const cameraPositionEnu = new Cesium.Cartesian3()
  const cameraForward = new Cesium.Cartesian3()
  const cameraRight = new Cesium.Cartesian3()
  const cameraScreenUp = new Cesium.Cartesian3()
  const cameraUp = new Cesium.Cartesian3()
  const passCentre = new Cesium.Cartesian3()
  const fieldWorldPosition = enuFrame.enuToWorld(originEnu)
  const localUp = Cesium.Cartesian3.UNIT_Z
  const birdMatrix = new Cesium.Matrix4()
  let activeTier = performanceTier
  let activeBirdCount = countForTier(activeTier)
  let layerVisible = true
  let daylightPhase: DaylightPhase = 'day'
  let flockOpacity = 1
  let lastAppliedOpacity = -1
  let lastNow = performance.now()
  let passStartedAt = lastNow
  let nextPassAt = lastNow
  let flying = false
  let disposed = false

  function enuDirection(world: Cesium.Cartesian3, result: Cesium.Cartesian3): Cesium.Cartesian3 {
    Cesium.Matrix4.multiplyByPointAsVector(enuFrame.inverse, world, result)
    return Cesium.Cartesian3.normalize(result, result)
  }

  function layoutBirds(count: number): void {
    const spread = EXPERIENCE_CONFIG.parrots.spreadM
    const clusterPattern = [2, 3, 1, 2, 1, 3]
    const clusterOf: number[] = []
    const memberOf: number[] = []
    const clusterSizes: number[] = []
    for (let assigned = 0; assigned < count;) {
      const size = Math.min(
        clusterPattern[clusterSizes.length % clusterPattern.length],
        count - assigned,
      )
      for (let member = 0; member < size; member++) {
        clusterOf.push(clusterSizes.length)
        memberOf.push(member)
      }
      clusterSizes.push(size)
      assigned += size
    }
    const clusterCount = clusterSizes.length
    for (let index = 0; index < count; index++) {
      const cluster = clusterOf[index]
      const size = clusterSizes[cluster]
      const lateral = (memberOf[index] - (size - 1) * 0.5) * spread[1] * 1.6
        + Math.sin(index * 2.9) * spread[1] * 0.25
      const along = (cluster - (clusterCount - 1) * 0.5) * spread[0] * 1.5
        + Math.sin(index * 3.7) * spread[0] * 0.18
      Cesium.Cartesian3.fromElements(
        lateral,
        Math.sin(index * 2.4) * spread[2],
        along,
        birds[index].offset,
      )
    }
  }

  function syncVisibility(): void {
    tower.show = layerVisible
    boat.show = layerVisible
    for (let index = 0; index < birds.length; index++) {
      birds[index].model.show = layerVisible
        && !reducedMotion
        && flying
        && index < activeBirdCount
    }
  }

  function applyFlockOpacity(): void {
    if (Math.abs(flockOpacity - lastAppliedOpacity) < 1e-4) return
    lastAppliedOpacity = flockOpacity
    for (const bird of birds) {
      // Keep Cesium's default HIGHLIGHT blend mode; its alpha multiplies the
      // glTF material alpha and gives the same whole-flock night fade.
      bird.model.color = Cesium.Color.WHITE.withAlpha(flockOpacity)
    }
  }

  function scheduleNextPass(startedAt: number): void {
    const jitter = randomBetween(
      -EXPERIENCE_CONFIG.parrots.passIntervalJitterMs,
      EXPERIENCE_CONFIG.parrots.passIntervalJitterMs,
    )
    nextPassAt = startedAt + EXPERIENCE_CONFIG.parrots.passIntervalMs + jitter
  }

  function buildCameraPass(): void {
    const camera = scene.camera
    enuFrame.worldToEnu(camera.positionWC, cameraPositionEnu)
    enuDirection(camera.directionWC, cameraForward)
    enuDirection(camera.upWC, cameraUp)
    Cesium.Cartesian3.cross(cameraForward, cameraUp, cameraRight)
    Cesium.Cartesian3.normalize(cameraRight, cameraRight)
    Cesium.Cartesian3.cross(cameraRight, cameraForward, cameraScreenUp)
    Cesium.Cartesian3.normalize(cameraScreenUp, cameraScreenUp)

    const [minimumDepth, maximumDepth] = EXPERIENCE_CONFIG.parrots.cameraDepthM
    const distanceToField = Cesium.Cartesian3.distance(camera.positionWC, fieldWorldPosition)
    const depth = Cesium.Math.clamp(
      distanceToField * randomBetween(0.34, 0.58),
      minimumDepth,
      maximumDepth,
    )
    const frustum = camera.frustum
    const fovy = frustum instanceof Cesium.PerspectiveFrustum
      ? frustum.fovy ?? Cesium.Math.toRadians(60)
      : Cesium.Math.toRadians(60)
    const aspect = frustum instanceof Cesium.PerspectiveFrustum
      ? frustum.aspectRatio ?? scene.canvas.clientWidth / Math.max(1, scene.canvas.clientHeight)
      : scene.canvas.clientWidth / Math.max(1, scene.canvas.clientHeight)
    const halfHeight = Math.tan(fovy * 0.5) * depth
    const halfWidth = halfHeight * aspect
    const side = Math.random() < 0.5 ? -1 : 1
    const vertical = randomBetween(...EXPERIENCE_CONFIG.parrots.screenHeightRange)
    const edge = halfWidth * EXPERIENCE_CONFIG.parrots.edgeOverscan

    Cesium.Cartesian3.multiplyByScalar(cameraForward, depth, passCentre)
    Cesium.Cartesian3.add(cameraPositionEnu, passCentre, passCentre)
    Cesium.Cartesian3.multiplyByScalar(cameraRight, side * edge, passStart)
    Cesium.Cartesian3.add(passCentre, passStart, passStart)
    Cesium.Cartesian3.multiplyByScalar(cameraScreenUp, vertical * halfHeight, passUp)
    Cesium.Cartesian3.add(passStart, passUp, passStart)
    Cesium.Cartesian3.multiplyByScalar(cameraRight, -side * edge, passEnd)
    Cesium.Cartesian3.add(passCentre, passEnd, passEnd)
    Cesium.Cartesian3.add(passEnd, passUp, passEnd)

    Cesium.Cartesian3.subtract(passEnd, passStart, passForward)
    Cesium.Cartesian3.normalize(passForward, passForward)
    Cesium.Cartesian3.cross(localUp, passForward, passRight)
    Cesium.Cartesian3.normalize(passRight, passRight)
    Cesium.Cartesian3.cross(passForward, passRight, passUp)
    Cesium.Cartesian3.normalize(passUp, passUp)
    Cesium.Matrix3.setColumn(passOrientation, 0, passRight, passOrientation)
    Cesium.Matrix3.setColumn(passOrientation, 1, passUp, passOrientation)
    Cesium.Matrix3.setColumn(passOrientation, 2, passForward, passOrientation)
  }

  function beginPass(now: number): void {
    buildCameraPass()
    passStartedAt = now
    flying = true
    scheduleNextPass(now)
    syncVisibility()
  }

  function updateBirdMatrices(progress: number): void {
    Cesium.Cartesian3.lerp(passStart, passEnd, progress, flockPosition)
    Cesium.Matrix3.multiply(passOrientation, parrotRotation, birdRotation)
    for (let index = 0; index < activeBirdCount; index++) {
      const bird = birds[index]
      Cesium.Matrix3.multiplyByVector(passOrientation, bird.offset, birdOffsetEnu)
      Cesium.Cartesian3.add(flockPosition, birdOffsetEnu, birdPositionEnu)
      composeModelMatrix(
        enuFrame,
        birdPositionEnu,
        birdRotation,
        bird.scale,
        birdMatrix,
      )
      Cesium.Matrix4.clone(birdMatrix, bird.model.modelMatrix)
    }
  }

  layoutBirds(activeBirdCount)
  applyFlockOpacity()
  syncVisibility()
  onStatus?.('Field models ready')

  return {
    setVisible(visible) {
      if (disposed || layerVisible === visible) return
      layerVisible = visible
      syncVisibility()
    },
    update(now) {
      if (disposed) return
      if (!layerVisible || reducedMotion) {
        flying = false
        lastNow = now
        syncVisibility()
        return
      }

      const elapsedMs = Math.min(50, Math.max(0, now - lastNow))
      lastNow = now
      const targetOpacity = daylightPhase === 'night' ? 0 : 1
      const opacityStep = elapsedMs / EXPERIENCE_CONFIG.parrots.nightFadeMs
      flockOpacity += Math.sign(targetOpacity - flockOpacity)
        * Math.min(Math.abs(targetOpacity - flockOpacity), opacityStep)
      flockOpacity = Cesium.Math.clamp(flockOpacity, 0, 1)
      applyFlockOpacity()

      if (daylightPhase !== 'night' && !flying && now >= nextPassAt) beginPass(now)
      if (!flying) return
      if (daylightPhase === 'night' && flockOpacity <= 0.001) {
        flying = false
        syncVisibility()
        return
      }
      const progress = Cesium.Math.clamp(
        (now - passStartedAt) / EXPERIENCE_CONFIG.parrots.flightDurationMs,
        0,
        1,
      )
      if (progress >= 1) {
        flying = false
        syncVisibility()
        return
      }
      updateBirdMatrices(progress)
    },
    setPerformanceTier(tier) {
      if (disposed || tier === activeTier) return
      activeTier = tier
      activeBirdCount = Math.min(birds.length, countForTier(activeTier))
      layoutBirds(activeBirdCount)
      syncVisibility()
    },
    setDaylightPhase(phase) {
      if (!disposed) daylightPhase = phase
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const removeEventListener of animationEventRemovers.splice(0)) {
        removeEventListener()
      }
      for (const bird of birds) {
        if (!bird.model.isDestroyed()) bird.model.activeAnimations.removeAll()
      }
      const sceneDestroyed = (scene as any).isDestroyed?.() ?? false
      const wasRemoved = !sceneDestroyed
        && scene.primitives.contains(primitives)
        && scene.primitives.remove(primitives)
      if (!wasRemoved && !primitives.isDestroyed()) primitives.destroy()
    },
  }
}
