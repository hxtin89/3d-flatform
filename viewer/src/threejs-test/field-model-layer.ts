import * as THREE from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js'
import { DOME_HIDDEN_FADE } from './cloud-pick'
import { EXPERIENCE_CONFIG } from './config'

export type FieldModelKey = 'tower' | 'boat'

export interface FieldModelLayer {
  /** Hide/show all props at once (compare mode). */
  setVisible(visible: boolean): void
  /** Follow a new cloud lift: the root carries zOffset like the stream group does. */
  setZOffset(zOffset: number): void
  /** Where a model stands — its origin on the floor it was placed on, in the root's
   *  frame (raw ENU before the lift). Follows the model editor. */
  footEnu(key: FieldModelKey, target: THREE.Vector3): THREE.Vector3
  /** 0..1 — how much of a model is drawn. 1 is the model as authored; 0 skips it. */
  setFade(key: FieldModelKey, fade: number): void
  getEditTargets(): FieldModelEditTargets
  dispose(): void
}

export interface EditableFieldModel {
  positionNode: THREE.Group
  transformNode: THREE.Group
  modelRotationRad: readonly [number, number, number]
  /** What positionM is relative to: the hotspot centre in x/y, the model's measured
   *  floor (config groundZM) in z. */
  originEnu: THREE.Vector3
}

export interface FieldModelEditTargets {
  tower: EditableFieldModel
  boat: EditableFieldModel
  towerHeightUnits: number
}

interface FieldModelLayerOptions {
  /** ECEF-anchored parent — the floating-origin root, not the raw scene. */
  scene: THREE.Object3D
  enuFrame: THREE.Matrix4
  zOffset: number
  /** The shifted hotspot centre. Its z is only the fallback floor for a model without
   *  a measured groundZM. */
  originEnu: THREE.Vector3
  onStatus?(message: string): void
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

function createEditableTransform(
  parent: THREE.Group,
  object: THREE.Object3D,
  origin: THREE.Vector3,
  position: readonly [number, number, number],
  rotation: readonly [number, number, number],
  scale: number,
  heightScale = scale,
): EditableFieldModel {
  const positionNode = new THREE.Group()
  const transformNode = new THREE.Group()
  positionNode.position.set(origin.x + position[0], origin.y + position[1], origin.z + position[2])
  transformNode.rotation.z = rotation[2]
  // Across and up apart: x and y are the horizontal plane here, z is up.
  transformNode.scale.set(scale, scale, heightScale)
  object.rotation.set(rotation[0], rotation[1], 0)
  transformNode.add(object)
  positionNode.add(transformNode)
  parent.add(positionNode)
  return { positionNode, transformNode, modelRotationRad: rotation, originEnu: origin.clone() }
}

/** The hotspot centre in x/y, the model's measured floor in z — or the centre's own z
 *  (areaMinZ) for a model that has no measurement. */
function modelOrigin(centre: THREE.Vector3, groundZM: number | undefined): THREE.Vector3 {
  return new THREE.Vector3(centre.x, centre.y, groundZM ?? centre.z)
}

/**
 * A model is faded by its materials' opacity alone. They are transparent from the
 * start (see where they are made) because flipping `transparent` at runtime is part of
 * three's material cache key: r185 disposes the render object and builds the node graph
 * and pipeline again on every flip, and a fade crosses 1 each time the dome edge passes.
 */
interface FadeState {
  node: THREE.Object3D
  materials: THREE.Material[]
  fade: number
}

function applyFade(state: FadeState, fade: number): void {
  const value = THREE.MathUtils.clamp(fade, 0, 1)
  if (value === state.fade) return
  state.fade = value
  state.node.visible = value > DOME_HIDDEN_FADE
  for (const material of state.materials) material.opacity = value
}

export async function createFieldModelLayer(options: FieldModelLayerOptions): Promise<FieldModelLayer> {
  const { scene, enuFrame, zOffset, originEnu, onStatus } = options
  const gltfLoader = new GLTFLoader()
  const textureLoader = new THREE.TextureLoader()
  onStatus?.('Loading field models…')

  const [towerGltf, towerBottom, towerTop, boatGltf, boatTexture] = await Promise.all([
    loadGltf(gltfLoader, 'assets/models/tower/tower.gltf'),
    loadColorTexture(textureLoader, 'assets/models/tower/tower-bottom.webp'),
    loadColorTexture(textureLoader, 'assets/models/tower/tower-top.webp'),
    loadGltf(gltfLoader, 'assets/models/boat/boat.gltf'),
    // The Cycles merged bake was authored against the boat's second UV set (TEXCOORD_1).
    loadColorTexture(textureLoader, 'assets/models/boat/MergedBake_Bake1_CyclesBake_COMBINED.webp', 1),
  ])

  const root = new THREE.Group()
  root.name = 'wilderness-field-models'
  root.matrixAutoUpdate = false
  root.matrix.copy(enuFrame).multiply(new THREE.Matrix4().makeTranslation(0, 0, zOffset))
  root.matrixWorldNeedsUpdate = true
  scene.add(root)

  const textures = [towerBottom, towerTop, boatTexture]
  const towerBottomMaterial = createBakedMaterial(towerBottom, false, 0.38)
  const towerTopMaterial = createBakedMaterial(towerTop, true, 0.42)
  const boatMaterial = createBakedMaterial(boatTexture, false, 0.48)
  // Transparent from the start so the dome fade only has to write opacity (see
  // applyFade). At opacity 1 this draws exactly as opaque: the bakes are WebP without
  // alpha, so every fragment is alpha 1, depthWrite stays on, and at renderOrder 0 the
  // two draw ahead of every other transparent in the scene. No alphaTest, which would
  // cut the last few percent of a fade off hard.
  towerBottomMaterial.transparent = true
  boatMaterial.transparent = true
  const materials: THREE.Material[] = [towerBottomMaterial, towerTopMaterial, boatMaterial]
  const sourceMaterials = new Set<THREE.Material>()
  const geometries = new Set<THREE.BufferGeometry>()

  const tower = towerGltf.scene
  tower.name = 'river-observation-tower'
  // The tower is stretched upward (config heightScale) to the scanned height, but the
  // railing section above the deck keeps the across scale vertically too, so its rails
  // stay at a person's height: squeezed by scale / heightScale around the deck.
  const railingSquash = EXPERIENCE_CONFIG.tower.scale / EXPERIENCE_CONFIG.tower.heightScale
  tower.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    if (Array.isArray(mesh.material)) mesh.material.forEach((material) => sourceMaterials.add(material))
    else if (mesh.material) sourceMaterials.add(mesh.material)
    geometries.add(mesh.geometry)
    const isTopSection = /004$/.test(mesh.name.replace('.', ''))
    mesh.material = isTopSection ? towerTopMaterial : towerBottomMaterial
    if (isTopSection) {
      mesh.scale.y = railingSquash
      mesh.position.y = EXPERIENCE_CONFIG.tower.deckUnits * (1 - railingSquash)
    }
    mesh.castShadow = false
    mesh.receiveShadow = false
  })
  // After the railing squash, in model units: times heightScale it is the height in metres.
  const towerHeightUnits = new THREE.Box3().setFromObject(tower).getSize(new THREE.Vector3()).y
  const towerEditTarget = createEditableTransform(
    root,
    tower,
    modelOrigin(originEnu, EXPERIENCE_CONFIG.tower.groundZM),
    EXPERIENCE_CONFIG.tower.positionM,
    EXPERIENCE_CONFIG.tower.rotationRad,
    EXPERIENCE_CONFIG.tower.scale,
    EXPERIENCE_CONFIG.tower.heightScale,
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
    modelOrigin(originEnu, EXPERIENCE_CONFIG.boat.groundZM),
    EXPERIENCE_CONFIG.boat.positionM,
    EXPERIENCE_CONFIG.boat.rotationRad,
    EXPERIENCE_CONFIG.boat.scale,
  )
  const fades: Record<FieldModelKey, FadeState> = {
    tower: { node: towerEditTarget.positionNode, materials: [towerBottomMaterial, towerTopMaterial], fade: 1 },
    boat: { node: boatEditTarget.positionNode, materials: [boatMaterial], fade: 1 },
  }
  const editTargets: Record<FieldModelKey, EditableFieldModel> = { tower: towerEditTarget, boat: boatEditTarget }

  onStatus?.('Field models ready')

  return {
    setVisible(visible) {
      root.visible = visible
    },
    setZOffset(nextZOffset) {
      root.matrix.copy(enuFrame).multiply(new THREE.Matrix4().makeTranslation(0, 0, nextZOffset))
      root.matrixWorldNeedsUpdate = true
    },
    footEnu(key, target) {
      return target.copy(editTargets[key].positionNode.position)
    },
    setFade(key, fade) {
      applyFade(fades[key], fade)
    },
    getEditTargets() {
      return {
        tower: towerEditTarget,
        boat: boatEditTarget,
        towerHeightUnits,
      }
    },
    dispose() {
      scene.remove(root)
      for (const material of sourceMaterials) material.dispose()
      for (const material of materials) material.dispose()
      for (const geometry of geometries) geometry.dispose()
      for (const texture of textures) texture.dispose()
    },
  }
}
