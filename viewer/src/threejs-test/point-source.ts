// Which point tileset should be streaming right now. Two jobs:
//   1. discover every published density pack from the area manifest, so packs
//      added by the pipeline later show up in the panel without a code change,
//   2. resolve (zoom band + camera position) -> one concrete tileset URL.
// No three.js state lives here; main.ts owns the renderer and the swap itself.
import { EXPERIENCE_CONFIG } from './config'
import { APH_BAND_SSE, ONE_LOD_BAND_SSE } from './adaptive-quality'
import type { GlobeManifest, ManifestArea } from './manifest'
import type { StreamingLimits } from './streaming'

/** 0 = detail, 1 = explore, 2 = overview — same indices as AdaptiveQualityState. */
export type ZoomBand = 0 | 1 | 2

/** Assignment value meaning "whatever the session's base tree is". */
export const AUTO = 'auto'

/** Key used for global packs inside `PointPack.datasets`. */
const GLOBAL_AREA = '*'

const MIB = 1024 * 1024

export interface PointPack {
  /** Namespaced so a top-level manifest key can never collide with an area key:
   *  `tree:aph` | `tree:one-lod` | `global:overview` | `area:explore` | … */
  id: string
  label: string
  scope: 'global' | 'area'
  /** Manifest status, or `ready` for the two synthetic tree packs. */
  status: string
  /** False when no area publishes this pack yet — the option stays visible but disabled. */
  available: boolean
  requestVolumes: boolean
  limits?: Partial<StreamingLimits>
  ladder: readonly number[]
  /** areaId -> dataset path. Global packs use the single key `*`. */
  datasets: Map<string, string>
  tilesetFile: string
}

export interface ResolvedSource {
  /** Swap identity: same key means the streamed tileset would not change. */
  key: string
  packId: string
  areaId: string | null
  url: string
  datasetPath: string
  label: string
  requestVolumes: boolean
  limits?: Partial<StreamingLimits>
  ladder: readonly number[]
}

export interface PointSourceController {
  packs(): readonly PointPack[]
  assignment(band: ZoomBand): string
  setAssignment(band: ZoomBand, packId: string): void
  /** Area whose ENU footprint contains the camera, else the nearest one. */
  areaFor(enuX: number, enuY: number): string | null
  /** Never null: an unavailable or unknown choice falls back to base(). */
  resolve(band: ZoomBand, areaId: string | null): ResolvedSource
  /** The session's default tree — what the app streamed before this panel existed. */
  base(): ResolvedSource
  /** After a failed root tileset: drop this area (or the whole pack) from the list. */
  markFailed(packId: string, areaId: string | null): void
}

const detailMax = EXPERIENCE_CONFIG.lod.detailMaxHeightM
const exploreMax = EXPERIENCE_CONFIG.lod.exploreMaxHeightM

/** Panel rows, coarse to fine — the labels are derived from the band edges so the
 * text can never drift away from the controller. */
export const ZOOM_BAND_ROWS: readonly { band: ZoomBand; label: string; note: string }[] = [
  {
    band: 2,
    label: `Overview · > ${exploreMax.toLocaleString('en-US')} m`,
    note: 'Density pack streamed while the camera is farther out than the explore edge',
  },
  {
    band: 1,
    label: `Explore · ${detailMax}–${exploreMax.toLocaleString('en-US')} m`,
    note: 'Per-area packs cover roughly one square kilometre — out here that reads as an island of points',
  },
  {
    band: 0,
    label: `Detail · < ${detailMax} m`,
    note: 'Closest band. Auto keeps the session tree; pick a pack to compare its density',
  },
]

/** Cache and GPU residency by published density, inferred from the dataset path.
 * A p100 pack evicts close-range tiles as fast as they arrive on the library
 * defaults, a p02 pack never needs the headroom. */
function limitsForDataset(path: string): Partial<StreamingLimits> | undefined {
  if (/p100|detail/i.test(path)) {
    return { cacheMinBytes: 192 * MIB, cacheMaxBytes: 512 * MIB, cacheMaxTiles: 900, gpuBytesTarget: 256 * MIB }
  }
  if (/p10\b|explore/i.test(path)) {
    return { cacheMinBytes: 128 * MIB, cacheMaxBytes: 320 * MIB, cacheMaxTiles: 600, gpuBytesTarget: 192 * MIB }
  }
  return undefined
}

const titleCase = (value: string) => value.charAt(0).toUpperCase() + value.slice(1)

/** `peru-b2-globe/2404PeruB2-detail-p100/areas/area-001` -> `2404PeruB2-detail-p100`. */
function packSegment(path: string): string {
  const parts = path.split('/').filter(Boolean)
  const areasAt = parts.indexOf('areas')
  const segment = areasAt > 0 ? parts[areasAt - 1] : parts[parts.length - 1]
  return segment ?? path
}

export function createPointSource(opts: {
  baseUrl: string
  manifest: GlobeManifest
  /** The session's default tree — today driven by `?tree=`. */
  basePack: 'aph' | 'one-lod'
  /** Called when the controller changes state on its own (failed pack, revert). */
  onChange?: () => void
}): PointSourceController {
  const { baseUrl, manifest, basePack, onChange } = opts

  const packs: PointPack[] = [
    {
      id: 'tree:aph',
      label: 'Adaptive hierarchy (APH)',
      scope: 'global',
      status: 'ready',
      available: true,
      requestVolumes: false,
      // The APH quadtree only pays off with residency to match: the Cesium
      // reference runs a 1 GiB cache, the One-LOD defaults would evict
      // close-range nodes as fast as they arrive.
      limits: { cacheMinBytes: 256 * MIB, cacheMaxBytes: 768 * MIB, cacheMaxTiles: 1200, gpuBytesTarget: 384 * MIB },
      ladder: APH_BAND_SSE,
      datasets: new Map([[GLOBAL_AREA, manifest.adaptiveHierarchyDataset]]),
      tilesetFile: manifest.adaptiveHierarchyTilesetFile,
    },
    {
      id: 'tree:one-lod',
      label: 'One LOD tree (p02→p10→p100)',
      scope: 'global',
      status: 'ready',
      available: true,
      requestVolumes: true,
      ladder: ONE_LOD_BAND_SSE,
      datasets: new Map([[GLOBAL_AREA, manifest.oneLodTreeDataset]]),
      tilesetFile: manifest.oneLodTreeTilesetFile,
    },
  ]

  // Manifest packs. Single-density trees carry no viewer request volumes, so the
  // VRV plugin would only add traversal cost, and their nodes are the p02/p10/p100
  // ones — the One-LOD ladder, never the APH one.
  for (const [key, entry] of Object.entries(manifest.globalDatasets)) {
    packs.push({
      id: `global:${key}`,
      label: `${titleCase(key)} · ${packSegment(entry.dataset)}`,
      scope: 'global',
      status: entry.status,
      available: entry.status === 'ready',
      requestVolumes: false,
      limits: limitsForDataset(entry.dataset),
      ladder: ONE_LOD_BAND_SSE,
      datasets: entry.status === 'ready' ? new Map([[GLOBAL_AREA, entry.dataset]]) : new Map(),
      tilesetFile: 'tileset.json',
    })
  }

  // Per-area packs: one option per distinct key across all areas, in first-seen
  // order, so a mode the pipeline adds later needs no change here.
  const areaPacks = new Map<string, PointPack>()
  for (const area of manifest.areas) {
    for (const [key, entry] of Object.entries(area.datasets)) {
      let pack = areaPacks.get(key)
      if (!pack) {
        pack = {
          id: `area:${key}`,
          label: `${titleCase(key)} · ${packSegment(entry.dataset)} (per area)`,
          scope: 'area',
          status: entry.status,
          available: false,
          requestVolumes: false,
          limits: limitsForDataset(entry.dataset),
          ladder: ONE_LOD_BAND_SSE,
          datasets: new Map(),
          tilesetFile: 'tileset.json',
        }
        areaPacks.set(key, pack)
        packs.push(pack)
      }
      if (entry.status !== 'ready') continue
      pack.datasets.set(area.areaId, entry.dataset)
      pack.available = true
      pack.status = 'ready'
    }
  }

  // Area centres for the fallback pick, computed once.
  const areaCentres = manifest.areas
    .filter((area): area is ManifestArea & { bbox: number[] } => Array.isArray(area.bbox))
    .map((area) => ({
      areaId: area.areaId,
      bbox: area.bbox,
      cx: (area.bbox[0] + area.bbox[3]) / 2,
      cy: (area.bbox[1] + area.bbox[4]) / 2,
      footprint: Math.abs(area.bbox[3] - area.bbox[0]) * Math.abs(area.bbox[4] - area.bbox[1]),
    }))

  const assignments: Record<ZoomBand, string> = { 0: AUTO, 1: AUTO, 2: AUTO }
  const baseId = basePack === 'aph' ? 'tree:aph' : 'tree:one-lod'

  const buildSource = (pack: PointPack, areaId: string | null): ResolvedSource | null => {
    const dataset = pack.datasets.get(areaId ?? GLOBAL_AREA)
    if (!dataset) return null
    return {
      key: `${pack.id}|${areaId ?? GLOBAL_AREA}`,
      packId: pack.id,
      areaId,
      url: `${baseUrl}/${dataset}/${pack.tilesetFile}`,
      datasetPath: dataset,
      label: pack.label,
      requestVolumes: pack.requestVolumes,
      limits: pack.limits,
      ladder: pack.ladder,
    }
  }

  const base = (): ResolvedSource => {
    const pack = packs.find((entry) => entry.id === baseId)!
    return buildSource(pack, null)!
  }

  return {
    packs: () => packs,
    assignment: (band) => assignments[band],
    setAssignment(band, packId) {
      assignments[band] = packId
    },
    areaFor(enuX, enuY) {
      // Containment first, smallest footprint wins where areas overlap; the
      // nearest centre keeps a camera outside every footprint on a real pack.
      let contained: { areaId: string; footprint: number } | null = null
      let nearest: { areaId: string; distanceSq: number } | null = null
      for (const area of areaCentres) {
        const [minX, minY, , maxX, maxY] = area.bbox
        if (enuX >= minX - 0.01 && enuX <= maxX + 0.01 && enuY >= minY - 0.01 && enuY <= maxY + 0.01) {
          if (!contained || area.footprint < contained.footprint) {
            contained = { areaId: area.areaId, footprint: area.footprint }
          }
        }
        const distanceSq = (enuX - area.cx) ** 2 + (enuY - area.cy) ** 2
        if (!nearest || distanceSq < nearest.distanceSq) nearest = { areaId: area.areaId, distanceSq }
      }
      return contained?.areaId ?? nearest?.areaId ?? null
    },
    resolve(band, areaId) {
      const packId = assignments[band]
      if (packId === AUTO) return base()
      const pack = packs.find((entry) => entry.id === packId)
      if (!pack || !pack.available) return base()
      return buildSource(pack, pack.scope === 'area' ? areaId : null) ?? base()
    },
    base,
    markFailed(packId, areaId) {
      const pack = packs.find((entry) => entry.id === packId)
      if (!pack) return
      pack.datasets.delete(areaId ?? GLOBAL_AREA)
      if (pack.datasets.size === 0) {
        pack.available = false
        pack.status = 'unavailable'
      }
      onChange?.()
    },
  }
}
