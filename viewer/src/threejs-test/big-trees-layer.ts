import * as THREE from 'three'
import { Line2NodeMaterial } from 'three/webgpu'
import { Line2 } from 'three/addons/lines/webgpu/Line2.js'
import { LineGeometry } from 'three/addons/lines/LineGeometry.js'
import { DOME_HIDDEN_FADE, domeFadeAt, type PickDome } from './cloud-pick'
import { applyHighPrecisionAlways } from './point-cloud'

/**
 * Marks the big trees around the canopy tower: a ring on each crown, a thin line down to
 * the forest floor and a chip with the tree's height.
 *
 * The trees come from public/big-trees/<dataset>.json, a curated list: candidates from
 * scripts/find-big-trees.mjs (scripts/big-trees-candidates), each checked at full point
 * density, with heights and crowns read off that check. Rerunning the finder does not
 * change it. Positions there are raw ENU metres before the lift, the
 * frame of every placement in config.ts; the root carries zOffset like the other layers.
 *
 * Like the tower, the marks fade with the dome: outside it the cloud is not drawn, and a
 * ring floating over the bare map marks nothing.
 */
export interface BigTree {
  id: string
  x: number
  y: number
  groundZ: number
  topZ: number
  heightM: number
  crownRadiusM: number
}

export interface BigTreesLayer {
  setVisible(visible: boolean): void
  /** Follow a new cloud lift: the root carries zOffset like the stream group does. */
  setZOffset(zOffset: number): void
  /** `dome` is the dome as the shader has it this frame, or null when it is off. */
  update(camera: THREE.PerspectiveCamera, cameraGroundRange: number, dome: PickDome | null, zOffset: number): void
  count(): number
  dispose(): void
}

interface BigTreesLayerOptions {
  /** ECEF-anchored parent — the floating-origin root, not the raw scene. */
  scene: THREE.Object3D
  overlay: HTMLElement
  enuFrame: THREE.Matrix4
  zOffset: number
  trees: readonly BigTree[]
}

interface TreeRecord {
  tree: BigTree
  group: THREE.Group
  label: HTMLElement
  materials: Array<{ material: Line2NodeMaterial; baseOpacity: number }>
  fade: number
  labelWidth: number
  labelHeight: number
}

/** Beyond this camera-to-ground range the chips go and only the rings stay. */
const LABEL_MAX_RANGE_M = 2_400
const LABEL_GAP_PX = 6
const RING_WIDTH_PX = 3
const LINE_WIDTH_PX = 2

function createMaterial(color: number, opacity: number, widthPx: number): Line2NodeMaterial {
  const material = new Line2NodeMaterial({ linewidth: widthPx, worldUnits: false })
  // Same reason as the markers: on the ECEF root the marks jitter unless the
  // model-view matrix is composed on the CPU.
  applyHighPrecisionAlways(material)
  material.color.setHex(color)
  material.transparent = true
  material.opacity = opacity
  material.depthWrite = false
  return material
}

export function parseBigTrees(raw: unknown): BigTree[] {
  const list = (raw as { trees?: unknown })?.trees
  if (!Array.isArray(list)) return []
  const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
  return list.filter((tree): tree is BigTree =>
    typeof tree?.id === 'string'
    && finite(tree.x) && finite(tree.y) && finite(tree.groundZ) && finite(tree.topZ)
    && finite(tree.heightM) && finite(tree.crownRadiusM) && tree.topZ > tree.groundZ)
}

export function createBigTreesLayer(options: BigTreesLayerOptions): BigTreesLayer {
  const { scene, overlay, enuFrame, trees } = options

  const root = new THREE.Group()
  root.name = 'wilderness-big-trees'
  root.matrixAutoUpdate = false
  const setRootMatrix = (zOffset: number) => {
    root.matrix.copy(enuFrame).multiply(new THREE.Matrix4().makeTranslation(0, 0, zOffset))
    root.matrixWorldNeedsUpdate = true
  }
  setRootMatrix(options.zOffset)
  scene.add(root)

  // One unit ring and one unit line, scaled per tree; materials are cloned per tree so
  // each can fade on its own while all share one shader program. Screen-space wide lines,
  // not meshes: the renderer has no antialiasing, and a ring band or stem a few
  // decimetres wide is under a pixel from a few hundred metres out, where it breaks into
  // crawling dashes. These keep RING_WIDTH_PX / LINE_WIDTH_PX at any distance. Plain
  // THREE.Line would be stuck at one pixel, and the WebGPU renderer does not draw
  // THREE.LineLoop at all, so the ring is a polyline closed by repeating its first point.
  const ringPositions: number[] = []
  for (let k = 0; k <= 64; k++) {
    const angle = (k / 64) * Math.PI * 2
    ringPositions.push(Math.cos(angle), Math.sin(angle), 0)
  }
  const ringGeometry = new LineGeometry().setPositions(ringPositions)
  const lineGeometry = new LineGeometry().setPositions([0, 0, 0, 0, 0, 1])
  const ringBase = createMaterial(0xf2d48a, 0.9, RING_WIDTH_PX)
  const lineBase = createMaterial(0xf2d48a, 0.6, LINE_WIDTH_PX)
  const materials: Line2NodeMaterial[] = [ringBase, lineBase]

  const records: TreeRecord[] = trees.map((tree) => {
    const group = new THREE.Group()
    group.position.set(tree.x, tree.y, tree.groundZ)
    const ringMaterial = ringBase.clone()
    const lineMaterial = lineBase.clone()
    materials.push(ringMaterial, lineMaterial)
    const ring = new Line2(ringGeometry, ringMaterial)
    // Just above the crown top, so the ring reads as a halo rather than cutting the crown.
    ring.position.z = tree.topZ - tree.groundZ + 0.6
    ring.scale.setScalar(Math.max(3, tree.crownRadiusM))
    ring.renderOrder = 3
    const line = new Line2(lineGeometry, lineMaterial)
    line.scale.set(1, 1, tree.topZ - tree.groundZ)
    line.renderOrder = 3
    group.add(line, ring)
    root.add(group)

    const label = document.createElement('div')
    label.className = 'map-marker-label big-tree-label'
    label.innerHTML = `<b>${Math.round(tree.heightM)} m</b><small>Big tree</small>`
    label.hidden = true
    overlay.append(label)
    return {
      tree, group, label, fade: 1, labelWidth: 0, labelHeight: 0,
      materials: [
        { material: ringMaterial, baseOpacity: ringBase.opacity },
        { material: lineMaterial, baseOpacity: lineBase.opacity },
      ],
    }
  })
  root.updateMatrixWorld(true)

  // Tallest first: when chips collide, the bigger tree keeps its label.
  const byHeight = [...records].sort((a, b) => b.tree.heightM - a.tree.heightM)
  const topEnu = new THREE.Vector3()
  const world = new THREE.Vector3()
  const view = new THREE.Vector3()
  const projected = new THREE.Vector3()
  let visible = true
  let measured = false

  function measureLabels(): void {
    for (const record of records) {
      record.label.hidden = false
      record.labelWidth = record.label.offsetWidth
      record.labelHeight = record.label.offsetHeight
      record.label.hidden = true
    }
    measured = true
  }

  return {
    setVisible(next) {
      visible = next
      root.visible = next
      overlay.hidden = !next
    },
    setZOffset(zOffset) {
      setRootMatrix(zOffset)
    },
    update(camera, cameraGroundRange, dome, zOffset) {
      if (!visible) return
      if (!measured) measureLabels()
      for (const record of records) {
        let fade = 1
        if (dome) {
          // The shader's frame carries the lift; the tree data does not.
          topEnu.set(record.tree.x, record.tree.y, record.tree.topZ + zOffset)
          fade = domeFadeAt(dome, topEnu)
        }
        if (fade !== record.fade) {
          record.fade = fade
          record.group.visible = fade > DOME_HIDDEN_FADE
          for (const entry of record.materials) entry.material.opacity = entry.baseOpacity * fade
        }
      }

      root.updateMatrixWorld()
      const showLabels = cameraGroundRange < LABEL_MAX_RANGE_M
      const accepted: Array<{ left: number; right: number; top: number; bottom: number }> = []
      for (const record of byHeight) {
        const label = record.label
        if (!showLabels || !record.group.visible) { label.hidden = true; continue }
        world.set(0, 0, record.tree.topZ - record.tree.groundZ + 3)
        record.group.localToWorld(world)
        view.copy(world).applyMatrix4(camera.matrixWorldInverse)
        projected.copy(world).project(camera)
        if (view.z >= 0 || Math.abs(projected.x) > 1.05 || Math.abs(projected.y) > 1.05 || projected.z >= 1) {
          label.hidden = true
          continue
        }
        const x = (projected.x * 0.5 + 0.5) * window.innerWidth
        const y = (-projected.y * 0.5 + 0.5) * window.innerHeight
        const box = {
          left: x - record.labelWidth / 2, right: x + record.labelWidth / 2,
          top: y - record.labelHeight, bottom: y,
        }
        const collides = accepted.some((other) => box.left < other.right + LABEL_GAP_PX
          && box.right > other.left - LABEL_GAP_PX
          && box.top < other.bottom + LABEL_GAP_PX
          && box.bottom > other.top - LABEL_GAP_PX)
        if (collides) { label.hidden = true; continue }
        accepted.push(box)
        label.hidden = false
        label.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`
        label.style.opacity = record.fade.toFixed(3)
      }
    },
    count: () => records.length,
    dispose() {
      for (const record of records) record.label.remove()
      scene.remove(root)
      ringGeometry.dispose()
      lineGeometry.dispose()
      for (const material of materials) material.dispose()
    },
  }
}
