import * as THREE from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js'
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js'
import { EXPERIENCE_CONFIG } from './config'
import type { DaylightPhase, PerformanceTier } from './environment-layer'

export interface FieldModelLayer {
  update(now: number): void
  setPerformanceTier(tier: PerformanceTier): void
  setDaylightPhase(phase: DaylightPhase): void
  getEditTargets(): FieldModelEditTargets
  dispose(): void
}

export interface EditableFieldModel {
  positionNode: THREE.Group
  transformNode: THREE.Group
  modelRotationRad: readonly [number, number, number]
}

export interface FieldModelEditTargets {
  originEnu: THREE.Vector3
  tower: EditableFieldModel
  boat: EditableFieldModel
  towerHeightUnits: number
}

interface FieldModelLayerOptions {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  enuFrame: THREE.Matrix4
  zOffset: number
  originEnu: THREE.Vector3
  performanceTier: PerformanceTier
  reducedMotion: boolean
  onStatus?(message: string): void
}

interface BirdRecord {
  pivot: THREE.Group
  mixer: THREE.AnimationMixer
  root: THREE.Object3D
  flight: THREE.AnimationAction
  glide: THREE.AnimationAction | null
}

function assetUrl(path: string): string {
  const base = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`
  return `${base}${path.replace(/^\/+/, '')}`
}

function loadGltf(loader: GLTFLoader, path: string): Promise<GLTF> {
  return loader.loadAsync(assetUrl(path))
}

async function loadColorTexture(loader: THREE.TextureLoader, path: string, uvChannel = 0): Promise<THREE.Texture> {
  const texture = await loader.loadAsync(assetUrl(path))
  texture.flipY = false
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 2
  texture.channel = uvChannel
  texture.needsUpdate = true
  return texture
}

function createBakedMaterial(
  map: THREE.Texture,
  transparent = false,
  emissiveIntensity = 0.32,
): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial()
  material.map = map
  material.emissive.set(0xffffff)
  material.emissiveMap = map
  material.emissiveIntensity = emissiveIntensity
  material.transparent = transparent
  material.alphaTest = transparent ? 0.08 : 0
  material.depthWrite = true
  material.roughness = 0.88
  material.metalness = 0
  return material
}

function countForTier(tier: PerformanceTier): number {
  if (tier === 'strong') return EXPERIENCE_CONFIG.parrots.strongCount
  if (tier === 'balanced') return EXPERIENCE_CONFIG.parrots.balancedCount
  return EXPERIENCE_CONFIG.parrots.constrainedCount
}

function createEditableTransform(
  parent: THREE.Group,
  object: THREE.Object3D,
  origin: THREE.Vector3,
  position: readonly [number, number, number],
  rotation: readonly [number, number, number],
  scale: number,
): EditableFieldModel {
  const positionNode = new THREE.Group()
  const transformNode = new THREE.Group()
  positionNode.position.set(origin.x + position[0], origin.y + position[1], origin.z + position[2])
  transformNode.rotation.z = rotation[2]
  transformNode.scale.setScalar(scale)
  object.rotation.set(rotation[0], rotation[1], 0)
  transformNode.add(object)
  positionNode.add(transformNode)
  parent.add(positionNode)
  return { positionNode, transformNode, modelRotationRad: rotation }
}

export async function createFieldModelLayer(options: FieldModelLayerOptions): Promise<FieldModelLayer> {
  const {
    scene, camera, enuFrame, zOffset, originEnu, performanceTier, reducedMotion, onStatus,
  } = options
  const gltfLoader = new GLTFLoader()
  const textureLoader = new THREE.TextureLoader()
  onStatus?.('Loading field models…')

  const [towerGltf, towerBottom, towerTop, boatGltf, boatTexture, parrotGltf, parrotBody, parrotWings, parrotTail] = await Promise.all([
    loadGltf(gltfLoader, 'assets/models/tower/tower.gltf'),
    loadColorTexture(textureLoader, 'assets/models/tower/tower-bottom.webp'),
    loadColorTexture(textureLoader, 'assets/models/tower/tower-top.webp'),
    loadGltf(gltfLoader, 'assets/models/boat/boat.gltf'),
    // The Cycles merged bake was authored against the boat's second UV set (TEXCOORD_1).
    loadColorTexture(textureLoader, 'assets/models/boat/MergedBake_Bake1_CyclesBake_COMBINED.webp', 1),
    loadGltf(gltfLoader, 'assets/models/parrot/Scarlet_macaw-limit-animations.gltf'),
    loadColorTexture(textureLoader, 'assets/models/parrot/Scarlet_Macaw_difuse.webp'),
    loadColorTexture(textureLoader, 'assets/models/parrot/Scarlet_macaw_wings_difuse-Scarlet_macaw_wings_alpha.webp'),
    loadColorTexture(textureLoader, 'assets/models/parrot/Scarlet_Macaw_tail-Scarlet_Macaw_tail_alpha.webp'),
  ])

  const root = new THREE.Group()
  root.name = 'wilderness-field-models'
  root.matrixAutoUpdate = false
  root.matrix.copy(enuFrame).multiply(new THREE.Matrix4().makeTranslation(0, 0, zOffset))
  root.matrixWorldNeedsUpdate = true
  scene.add(root)

  const textures = [towerBottom, towerTop, boatTexture, parrotBody, parrotWings, parrotTail]
  const towerBottomMaterial = createBakedMaterial(towerBottom, false, 0.38)
  const towerTopMaterial = createBakedMaterial(towerTop, true, 0.42)
  const boatMaterial = createBakedMaterial(boatTexture, false, 0.48)
  const parrotBodyMaterial = createBakedMaterial(parrotBody, true, 0.62)
  const parrotWingsMaterial = createBakedMaterial(parrotWings, true, 0.62)
  const parrotTailMaterial = createBakedMaterial(parrotTail, true, 0.62)
  const parrotMaterials = [parrotBodyMaterial, parrotWingsMaterial, parrotTailMaterial]
  const materials: THREE.Material[] = [
    towerBottomMaterial, towerTopMaterial, boatMaterial,
    parrotBodyMaterial, parrotWingsMaterial, parrotTailMaterial,
  ]
  const sourceMaterials = new Set<THREE.Material>()
  const geometries = new Set<THREE.BufferGeometry>()

  const tower = towerGltf.scene
  const towerHeightUnits = new THREE.Box3().setFromObject(tower).getSize(new THREE.Vector3()).y
  tower.name = 'river-observation-tower'
  tower.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    if (Array.isArray(mesh.material)) mesh.material.forEach((material) => sourceMaterials.add(material))
    else if (mesh.material) sourceMaterials.add(mesh.material)
    geometries.add(mesh.geometry)
    mesh.material = /004$/.test(mesh.name.replace('.', '')) ? towerTopMaterial : towerBottomMaterial
    mesh.castShadow = false
    mesh.receiveShadow = false
  })
  const towerEditTarget = createEditableTransform(
    root,
    tower,
    originEnu,
    EXPERIENCE_CONFIG.tower.positionM,
    EXPERIENCE_CONFIG.tower.rotationRad,
    EXPERIENCE_CONFIG.tower.scale,
  )

  const boat = boatGltf.scene
  boat.name = 'static-river-boat'
  boat.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    if (Array.isArray(mesh.material)) mesh.material.forEach((material) => sourceMaterials.add(material))
    else if (mesh.material) sourceMaterials.add(mesh.material)
    geometries.add(mesh.geometry)
    mesh.material = boatMaterial
    mesh.castShadow = false
    mesh.receiveShadow = false
  })
  const boatEditTarget = createEditableTransform(
    root,
    boat,
    originEnu,
    EXPERIENCE_CONFIG.boat.positionM,
    EXPERIENCE_CONFIG.boat.rotationRad,
    EXPERIENCE_CONFIG.boat.scale,
  )

  parrotGltf.scene.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    if (Array.isArray(mesh.material)) mesh.material.forEach((material) => sourceMaterials.add(material))
    else if (mesh.material) sourceMaterials.add(mesh.material)
    geometries.add(mesh.geometry)
  })
  const flightClip = THREE.AnimationClip.findByName(parrotGltf.animations, 'Flight')
  const glideClip = THREE.AnimationClip.findByName(parrotGltf.animations, 'Glide')
  if (!flightClip) throw new Error('Parrot model has no Flight animation')

  let activeTier = performanceTier
  const birdLimit = countForTier(performanceTier)
  const birds: BirdRecord[] = []
  const flock = new THREE.Group()
  flock.name = 'scarlet-macaw-flock'
  root.add(flock)

  const spread = EXPERIENCE_CONFIG.parrots.spreadM
  // Loose natural flock: birds travel in small clusters of one to three flying
  // abreast, staggered along the travel direction — not one strung-out line.
  const clusterPattern = [2, 3, 1, 2, 1, 3]
  const clusterOf: number[] = []
  const memberOf: number[] = []
  const clusterSizes: number[] = []
  for (let assigned = 0; assigned < birdLimit;) {
    const size = Math.min(clusterPattern[clusterSizes.length % clusterPattern.length], birdLimit - assigned)
    for (let member = 0; member < size; member++) {
      clusterOf.push(clusterSizes.length)
      memberOf.push(member)
    }
    clusterSizes.push(size)
    assigned += size
  }
  const clusterCount = clusterSizes.length
  for (let index = 0; index < birdLimit; index++) {
    const clone = cloneSkeleton(parrotGltf.scene)
    clone.name = `scarlet-macaw-${index + 1}`
    clone.rotation.set(...EXPERIENCE_CONFIG.parrots.modelRotationRad)
    clone.scale.setScalar(EXPERIENCE_CONFIG.parrots.modelScale * (0.88 + (index % 4) * 0.07))
    clone.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      if (mesh.name === 'Circle010') mesh.material = parrotBodyMaterial
      else if (mesh.name === 'Circle010_1') mesh.material = parrotWingsMaterial
      else if (mesh.name === 'Circle010_2') mesh.material = parrotTailMaterial
      else mesh.material = parrotBodyMaterial
      // Animated skinned bounds are not reliable enough for these fast passes.
      mesh.frustumCulled = false
      mesh.castShadow = false
      mesh.receiveShadow = false
    })
    const pivot = new THREE.Group()
    const cluster = clusterOf[index]
    const size = clusterSizes[cluster]
    // Wing-to-wing offset inside the cluster, cluster gaps along the track,
    // plus deterministic jitter so no two groups look mirrored.
    const lateral = (memberOf[index] - (size - 1) * 0.5) * spread[1] * 1.6
      + Math.sin(index * 2.9) * spread[1] * 0.25
    const along = (cluster - (clusterCount - 1) * 0.5) * spread[0] * 1.5
      + Math.sin(index * 3.7) * spread[0] * 0.18
    pivot.position.set(
      lateral,
      Math.sin(index * 2.4) * spread[2],
      along,
    )
    pivot.add(clone)
    flock.add(pivot)
    const mixer = new THREE.AnimationMixer(clone)
    const flight = mixer.clipAction(flightClip)
    flight.enabled = true
    flight.setLoop(THREE.LoopRepeat, Infinity)
    flight.setEffectiveTimeScale(EXPERIENCE_CONFIG.parrots.animationSpeed * (0.92 + (index % 5) * 0.035))
    flight.setEffectiveWeight(0.78)
    flight.play()
    flight.time = (index * 0.37) % Math.max(0.1, flightClip.duration)
    const glide = glideClip ? mixer.clipAction(glideClip) : null
    if (glide) {
      glide.enabled = true
      glide.setLoop(THREE.LoopRepeat, Infinity)
      glide.setEffectiveTimeScale(0.62)
      glide.setEffectiveWeight(0.22)
      glide.play()
      glide.time = (index * 0.53) % Math.max(0.1, glideClip?.duration ?? 1)
    }
    birds.push({ pivot, mixer, root: clone, flight, glide })
  }

  const passStart = new THREE.Vector3()
  const passEnd = new THREE.Vector3()
  const passForward = new THREE.Vector3()
  const passRight = new THREE.Vector3()
  const passUp = new THREE.Vector3()
  const passOrientation = new THREE.Matrix4()
  const fieldWorldPosition = new THREE.Vector3()
  const localUp = new THREE.Vector3(0, 0, 1)
  const cameraForward = new THREE.Vector3()
  const cameraRight = new THREE.Vector3()
  const cameraScreenUp = new THREE.Vector3()
  const localFromWorld = new THREE.Matrix4()
  let lastNow = performance.now()
  let passStartedAt = lastNow
  let nextPassAt = lastNow
  let flying = false
  let daylightPhase: DaylightPhase = 'day'
  let flockOpacity = 1

  function randomBetween(minimum: number, maximum: number): number {
    return minimum + Math.random() * (maximum - minimum)
  }

  function scheduleNextPass(startedAt: number): void {
    const jitter = randomBetween(
      -EXPERIENCE_CONFIG.parrots.passIntervalJitterMs,
      EXPERIENCE_CONFIG.parrots.passIntervalJitterMs,
    )
    nextPassAt = startedAt + EXPERIENCE_CONFIG.parrots.passIntervalMs + jitter
  }

  function buildCameraPass(): void {
    camera.getWorldDirection(cameraForward).normalize()
    cameraRight.crossVectors(cameraForward, camera.up).normalize()
    cameraScreenUp.crossVectors(cameraRight, cameraForward).normalize()
    const [minimumDepth, maximumDepth] = EXPERIENCE_CONFIG.parrots.cameraDepthM
    const distanceToField = camera.position.distanceTo(root.getWorldPosition(fieldWorldPosition))
    const depth = THREE.MathUtils.clamp(distanceToField * randomBetween(0.34, 0.58), minimumDepth, maximumDepth)
    const halfHeight = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) * depth
    const halfWidth = halfHeight * camera.aspect
    const side = Math.random() < 0.5 ? -1 : 1
    const vertical = randomBetween(...EXPERIENCE_CONFIG.parrots.screenHeightRange)
    const edge = halfWidth * EXPERIENCE_CONFIG.parrots.edgeOverscan
    const centre = camera.position.clone().addScaledVector(cameraForward, depth)
    passStart.copy(centre)
      .addScaledVector(cameraRight, side * edge)
      .addScaledVector(cameraScreenUp, vertical * halfHeight)
    passEnd.copy(centre)
      .addScaledVector(cameraRight, -side * edge)
      .addScaledVector(cameraScreenUp, vertical * halfHeight)
    root.updateMatrixWorld(true)
    localFromWorld.copy(root.matrixWorld).invert()
    passStart.applyMatrix4(localFromWorld)
    passEnd.applyMatrix4(localFromWorld)

    // Set one stable orientation for the complete straight pass.
    passForward.subVectors(passEnd, passStart).normalize()
    passRight.crossVectors(localUp, passForward).normalize()
    passUp.crossVectors(passForward, passRight).normalize()
    passOrientation.makeBasis(passRight, passUp, passForward)
    flock.quaternion.setFromRotationMatrix(passOrientation)
  }

  function beginPass(now: number): void {
    buildCameraPass()
    passStartedAt = now
    flying = true
    flock.visible = true
    scheduleNextPass(now)
  }

  function syncBirdCount(): void {
    const count = Math.min(birds.length, countForTier(activeTier))
    for (let index = 0; index < birds.length; index++) birds[index].pivot.visible = index < count
  }
  syncBirdCount()
  onStatus?.('Field models ready')

  return {
    update(now) {
      if (reducedMotion) {
        flock.visible = false
        lastNow = now
        return
      }
      const elapsedMs = Math.min(50, Math.max(0, now - lastNow))
      const elapsedSeconds = elapsedMs / 1000
      lastNow = now
      const targetOpacity = daylightPhase === 'night' ? 0 : 1
      flockOpacity = THREE.MathUtils.clamp(
        flockOpacity + Math.sign(targetOpacity - flockOpacity)
          * Math.min(Math.abs(targetOpacity - flockOpacity), elapsedMs / EXPERIENCE_CONFIG.parrots.nightFadeMs),
        0,
        1,
      )
      for (const material of parrotMaterials) material.opacity = flockOpacity

      if (daylightPhase !== 'night' && !flying && now >= nextPassAt) beginPass(now)
      if (!flying) return
      if (daylightPhase === 'night' && flockOpacity <= 0.001) {
        flying = false
        flock.visible = false
        return
      }
      const progress = THREE.MathUtils.clamp(
        (now - passStartedAt) / EXPERIENCE_CONFIG.parrots.flightDurationMs,
        0,
        1,
      )
      if (progress >= 1) {
        flying = false
        flock.visible = false
        return
      }
      flock.position.lerpVectors(passStart, passEnd, progress)
      const glideWeight = 0.12 + smoothstep(0.2, 0.72, Math.sin(progress * Math.PI) ** 2) * 0.34
      for (const bird of birds) {
        if (!bird.pivot.visible) continue
        bird.flight.setEffectiveWeight(1 - glideWeight)
        bird.glide?.setEffectiveWeight(glideWeight)
        bird.mixer.update(elapsedSeconds)
      }
    },
    setPerformanceTier(nextTier) {
      activeTier = nextTier
      syncBirdCount()
    },
    setDaylightPhase(nextPhase) {
      daylightPhase = nextPhase
    },
    getEditTargets() {
      return {
        originEnu: originEnu.clone(),
        tower: towerEditTarget,
        boat: boatEditTarget,
        towerHeightUnits,
      }
    },
    dispose() {
      for (const bird of birds) {
        bird.mixer.stopAllAction()
        bird.mixer.uncacheRoot(bird.root)
      }
      scene.remove(root)
      for (const material of sourceMaterials) material.dispose()
      for (const material of materials) material.dispose()
      for (const geometry of geometries) geometry.dispose()
      for (const texture of textures) texture.dispose()
    },
  }
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = THREE.MathUtils.clamp((value - edge0) / Math.max(1e-6, edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}
