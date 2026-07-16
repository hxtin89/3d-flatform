import * as THREE from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js'
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js'
import { EXPERIENCE_CONFIG } from './config'
import type { PerformanceTier } from './environment-layer'

export interface FieldModelLayer {
  update(now: number): void
  setPerformanceTier(tier: PerformanceTier): void
  dispose(): void
}

interface FieldModelLayerOptions {
  scene: THREE.Scene
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

async function loadColorTexture(loader: THREE.TextureLoader, path: string): Promise<THREE.Texture> {
  const texture = await loader.loadAsync(assetUrl(path))
  texture.flipY = false
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 2
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

function applyTransform(
  object: THREE.Object3D,
  origin: THREE.Vector3,
  position: readonly [number, number, number],
  rotation: readonly [number, number, number],
  scale: number,
): void {
  object.position.set(origin.x + position[0], origin.y + position[1], origin.z + position[2])
  object.rotation.set(rotation[0], rotation[1], rotation[2])
  object.scale.setScalar(scale)
}

export async function createFieldModelLayer(options: FieldModelLayerOptions): Promise<FieldModelLayer> {
  const {
    scene, enuFrame, zOffset, originEnu, performanceTier, reducedMotion, onStatus,
  } = options
  const gltfLoader = new GLTFLoader()
  const textureLoader = new THREE.TextureLoader()
  onStatus?.('Loading field models…')

  const [towerGltf, towerBottom, towerTop, boatGltf, boatTexture, parrotGltf, parrotBody, parrotWings, parrotTail] = await Promise.all([
    loadGltf(gltfLoader, 'assets/models/tower/tower.gltf'),
    loadColorTexture(textureLoader, 'assets/models/tower/tower-bottom.webp'),
    loadColorTexture(textureLoader, 'assets/models/tower/tower-top.webp'),
    loadGltf(gltfLoader, 'assets/models/boat/boat.gltf'),
    loadColorTexture(textureLoader, 'assets/models/boat/MergedBake_Bake1_CyclesBake_COMBINED.webp'),
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
  const materials: THREE.Material[] = [
    towerBottomMaterial, towerTopMaterial, boatMaterial,
    parrotBodyMaterial, parrotWingsMaterial, parrotTailMaterial,
  ]
  const sourceMaterials = new Set<THREE.Material>()
  const geometries = new Set<THREE.BufferGeometry>()

  const tower = towerGltf.scene
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
  applyTransform(
    tower,
    originEnu,
    EXPERIENCE_CONFIG.tower.positionM,
    EXPERIENCE_CONFIG.tower.rotationRad,
    EXPERIENCE_CONFIG.tower.scale,
  )
  root.add(tower)

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
  applyTransform(
    boat,
    originEnu,
    EXPERIENCE_CONFIG.boat.positionM,
    EXPERIENCE_CONFIG.boat.rotationRad,
    EXPERIENCE_CONFIG.boat.scale,
  )
  root.add(boat)

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
  flock.up.set(0, 0, 1)
  root.add(flock)

  const spread = EXPERIENCE_CONFIG.parrots.spreadM
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
    const side = index % 2 === 0 ? -1 : 1
    const rank = Math.floor(index / 2) + 1
    pivot.position.set(
      -rank * spread[0] * 0.17,
      side * rank * spread[1] * 0.14,
      Math.sin(index * 2.4) * spread[2] * 0.35,
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

  const curve = new THREE.CatmullRomCurve3(
    EXPERIENCE_CONFIG.parrots.pathM.map(([x, y, z]) => new THREE.Vector3(
      originEnu.x + x,
      originEnu.y + y,
      originEnu.z + z,
    )),
    false,
    'catmullrom',
    0.42,
  )
  const curvePosition = new THREE.Vector3()
  const curveLook = new THREE.Vector3()
  const cycleStartedAt = performance.now()
  let lastNow = cycleStartedAt

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
      const elapsedSeconds = Math.min(0.05, Math.max(0, now - lastNow) / 1000)
      lastNow = now
      const flightDuration = EXPERIENCE_CONFIG.parrots.flightDurationMs
      const cycleDuration = flightDuration + EXPERIENCE_CONFIG.parrots.pauseDurationMs
      const cycleTime = (now - cycleStartedAt) % cycleDuration
      const flying = cycleTime < flightDuration
      flock.visible = flying
      if (!flying) return
      const progress = THREE.MathUtils.clamp(cycleTime / flightDuration, 0, 1)
      curve.getPointAt(progress, curvePosition)
      curve.getPointAt(Math.min(1, progress + 0.008), curveLook)
      flock.position.copy(curvePosition)
      flock.lookAt(curveLook)
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
