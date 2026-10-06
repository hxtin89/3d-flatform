import * as THREE from 'three'
import { dotState, drawnPoints, isDotMesh, loadedPoints } from './dot-geometry.ts'

/**
 * What the point cloud holds in memory, for the device session that decides whether
 * "one copy of each point tile" (2.3, handover-quick-wins.md section 9) is ever needed.
 *
 * Three numbers the plan asks for, read in one go from the console as `__wild.dots.memory`:
 *
 * - **d, the drawn share of the resident tiles.** Resident is every tile with a loaded
 *   model (the CPU cache, down to its floor). Selected is what the traversal picked this
 *   frame; drawn is the selected tiles whose dot mesh is actually visible — not held back
 *   by the render gate or the arrival reveal. 2.3's CPU gain applies to the drawn share
 *   only, and until now that share was a guess.
 * - **Point bytes on the GPU, counted from three's `Info.memoryMap`**, which books every
 *   texture and attribute the backend created. The unload plugin's `estimatedGpuBytes`
 *   is the library's byte estimate of each tile's scene, taken once when the tile
 *   arrives, and it undercounts the pulled feed. Here a texture is a point texture when
 *   it carries `userData.cloudPointData`; it is `drawn` or `hidden` according to the tile
 *   that owns it, and `orphan` when no loaded dot mesh owns it (a retired 1×1 stand-in,
 *   or a texture a shared shader keeps alive).
 * - **The tab's heap**, as far as a page can read it: Chrome's `performance.memory`.
 *   Neither backend's GPU memory shows there, and `measureUserAgentSpecificMemory` wants
 *   a cross-origin-isolated page, which this one is not; the footprint that matters on a
 *   phone comes from the OS (Safari's or Chrome's task manager), which `footprintNote`
 *   says.
 *
 * CPU bytes repeat the accounting of `__wild.dots.state` as a total: every distinct
 * ArrayBuffer a loaded dot mesh keeps reachable, counted once.
 */
export interface PointMemoryReport {
  tiles: { resident: number; selected: number; drawn: number }
  points: { resident: number; selected: number; drawn: number }
  /** d: drawn over resident, by tiles and by points. */
  drawnShare: { tiles: number; points: number }
  /** Resident and drawn tiles per feed (`pulled`, `instanced`). */
  feeds: Record<string, { tiles: number; drawnTiles: number }>
  gpu: {
    pointTextures: {
      count: number
      MiB: number
      drawn: { count: number; MiB: number }
      hidden: { count: number; MiB: number }
      orphan: { count: number; MiB: number }
    }
    /** Attributes of loaded dot meshes and their carriers that the backend holds (the
     *  instanced feed's point data, the pulled feed's corners and shared index). */
    pointAttributes: { count: number; MiB: number }
    pointMiB: number
    allTexturesMiB: number
    allMiB: number
  }
  cpu: { pointMiB: number }
  heap: { usedMiB: number; totalMiB: number; limitMiB: number } | null
  footprintNote: string
}

/** The two tile-renderer parts the report reads. */
export interface PointMemoryTiles {
  forEachLoadedModel(callback: (scene: THREE.Object3D, tile: object) => void): void
  visibleTiles: { has(tile: object): boolean }
}

/** The parts of three's `renderer.info` the report reads. */
export interface PointMemoryInfo {
  memoryMap: Map<object, number | { size: number; type: string }>
  memory: { texturesSize: number; total: number }
}

/** Chrome's `performance.memory`. */
export interface HeapReading {
  usedJSHeapSize: number
  totalJSHeapSize: number
  jsHeapSizeLimit: number
}

export interface PointMemoryOptions {
  tiles: PointMemoryTiles
  info: PointMemoryInfo
  /** The material property the pulled feed keeps its point texture on (POINT_DATA_PROPERTY). */
  pointDataProperty: string
  heap?: HeapReading | null
  crossOriginIsolated?: boolean
}

const MIB = 1024 * 1024
const toMiB = (bytes: number) => Number((bytes / MIB).toFixed(1))
const share = (part: number, whole: number) => (whole > 0 ? Number((part / whole).toFixed(3)) : 0)

/** Visible through every ancestor up to and including `root`. */
function drawnWithin(object: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = object; node; node = node.parent) {
    if (!node.visible) return false
    if (node === root) return true
  }
  return false
}

export function pointMemoryReport(options: PointMemoryOptions): PointMemoryReport {
  const { tiles, info, pointDataProperty } = options
  const counts = {
    tiles: { resident: 0, selected: 0, drawn: 0 },
    points: { resident: 0, selected: 0, drawn: 0 },
  }
  const feeds: Record<string, { tiles: number; drawnTiles: number }> = {}
  /** Point textures owned by a loaded dot mesh, and whether that mesh is drawn. */
  const ownedTextures = new Map<object, boolean>()
  const attributes = new Set<object>()
  const cpuBuffers = new Set<ArrayBufferLike>()
  const holdBuffer = (buffer: ArrayBufferLike | undefined) => { if (buffer) cpuBuffers.add(buffer) }

  tiles.forEachLoadedModel((scene, tile) => {
    const selected = tiles.visibleTiles.has(tile)
    let tileDrawn = false
    let tileFeed: string | null = null
    let residentPoints = 0
    let drawn = 0
    scene.traverse((object) => {
      if (!isDotMesh(object)) return
      const mesh = object
      const dot = dotState(mesh)!
      tileFeed = dot.feed
      residentPoints += loadedPoints(mesh)
      const meshDrawn = selected && drawnWithin(mesh, scene)
      if (meshDrawn) {
        tileDrawn = true
        drawn += drawnPoints(mesh)
      }
      const texture = (mesh.material as any)?.[pointDataProperty]
      if (texture?.isTexture) {
        ownedTextures.set(texture, (ownedTextures.get(texture) ?? false) || meshDrawn)
        holdBuffer(texture.image?.data?.buffer)
      }
      const carrier = (mesh.parent as any)?.geometry as THREE.BufferGeometry | undefined
      if (carrier) {
        for (const attribute of Object.values(carrier.attributes)) {
          attributes.add(attribute)
          holdBuffer((attribute as any).array?.buffer)
        }
        if (carrier.index) attributes.add(carrier.index)
      }
      for (const attribute of Object.values(mesh.geometry.attributes)) {
        attributes.add(attribute)
        if (attribute.count > 8) holdBuffer((attribute as any).array?.buffer)
      }
      if (mesh.geometry.index) attributes.add(mesh.geometry.index)
      const metadata = (tile as any)?.engineData?.metadata
      holdBuffer(metadata?.featureTable?.buffer)
      holdBuffer(metadata?.batchTable?.buffer)
    })
    counts.tiles.resident++
    counts.points.resident += residentPoints
    if (selected) { counts.tiles.selected++; counts.points.selected += residentPoints }
    if (tileDrawn) { counts.tiles.drawn++; counts.points.drawn += drawn }
    if (tileFeed) {
      const entry = feeds[tileFeed] ??= { tiles: 0, drawnTiles: 0 }
      entry.tiles++
      if (tileDrawn) entry.drawnTiles++
    }
  })

  const textures = { count: 0, bytes: 0, drawn: { count: 0, bytes: 0 }, hidden: { count: 0, bytes: 0 }, orphan: { count: 0, bytes: 0 } }
  let attributeCount = 0
  let attributeBytes = 0
  for (const [key, value] of info.memoryMap) {
    if ((key as any).isTexture) {
      if (!(key as any).userData?.cloudPointData) continue
      const bytes = typeof value === 'number' ? value : value.size
      textures.count++
      textures.bytes += bytes
      const owner = ownedTextures.get(key)
      const bucket = owner === undefined ? textures.orphan : owner ? textures.drawn : textures.hidden
      bucket.count++
      bucket.bytes += bytes
    } else if (attributes.has(key)) {
      attributeCount++
      attributeBytes += typeof value === 'number' ? value : value.size
    }
  }

  let cpuBytes = 0
  for (const buffer of cpuBuffers) cpuBytes += buffer.byteLength

  const heap = options.heap
    ? { usedMiB: toMiB(options.heap.usedJSHeapSize), totalMiB: toMiB(options.heap.totalJSHeapSize), limitMiB: toMiB(options.heap.jsHeapSizeLimit) }
    : null

  return {
    tiles: counts.tiles,
    points: counts.points,
    drawnShare: { tiles: share(counts.tiles.drawn, counts.tiles.resident), points: share(counts.points.drawn, counts.points.resident) },
    feeds,
    gpu: {
      pointTextures: {
        count: textures.count,
        MiB: toMiB(textures.bytes),
        drawn: { count: textures.drawn.count, MiB: toMiB(textures.drawn.bytes) },
        hidden: { count: textures.hidden.count, MiB: toMiB(textures.hidden.bytes) },
        orphan: { count: textures.orphan.count, MiB: toMiB(textures.orphan.bytes) },
      },
      pointAttributes: { count: attributeCount, MiB: toMiB(attributeBytes) },
      pointMiB: toMiB(textures.bytes + attributeBytes),
      allTexturesMiB: toMiB(info.memory.texturesSize),
      allMiB: toMiB(info.memory.total),
    },
    cpu: { pointMiB: toMiB(cpuBytes) },
    heap,
    footprintNote: heap
      ? 'heap is the JS heap only (Chrome); GPU memory is not in it. Read the tab footprint from the OS task manager.'
      : options.crossOriginIsolated
        ? 'no performance.memory here; try performance.measureUserAgentSpecificMemory(), the page is cross-origin isolated.'
        : 'no performance.memory in this browser, and the page is not cross-origin isolated, so no in-page footprint. Read the tab footprint from the OS task manager.',
  }
}
