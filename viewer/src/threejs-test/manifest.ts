// Minimal area-manifest reader — just the three things the map view needs:
//   rootTransform    ENU→ECEF matrix (column-major 16) that places local-ENU point
//                    coordinates onto the WGS84 globe (same one Cesium uses)
//   overview dataset streamed in "Streaming" mode (full-area LOD octree)
//   explore dataset  loaded flat in the F16/F32 single-buffer modes
// Full manifest schema lives in the Cesium viewer's src/manifest.ts.

export interface GlobeManifest {
  /** ENU→ECEF, column-major, apply as THREE.Matrix4.fromArray() */
  rootTransform: number[]
  /** [lon, lat, heightM] of the ENU origin */
  enuOriginLonLat: [number, number, number]
  /** dataset path for streaming LOD (overview, whole survey) */
  overviewDataset: string
  /** dataset path for the flat single-buffer modes (densest bounded area) */
  exploreDataset: string
  /** full-density dataset of the first area (streaming detail tier), if built */
  detailDataset: string | null
  /** ENU-frame bbox of the explore area: [minX,minY,minZ,maxX,maxY,maxZ] */
  areaBbox: number[] | null
}

export async function fetchGlobeManifest(baseUrl: string, dataset: string): Promise<GlobeManifest> {
  const res = await fetch(`${baseUrl}/${dataset}/area-manifest.json`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`area-manifest HTTP ${res.status}`)
  const m = await res.json()

  const rootTransform: number[] | null = m.rootTransform
  if (!Array.isArray(rootTransform) || rootTransform.length !== 16) {
    throw new Error('manifest has no usable rootTransform (globe dataset required)')
  }

  const area = m.areas?.[0] ?? null
  const explore = area?.datasets?.explore
  const detail = area?.datasets?.detail
  return {
    rootTransform,
    enuOriginLonLat: m.enuOriginLonLat,
    overviewDataset: m.datasets.overview.dataset,
    exploreDataset: explore?.dataset ?? m.datasets.overview.dataset, // fall back to overview
    detailDataset: detail?.status === 'ready' ? detail.dataset : null,
    areaBbox: Array.isArray(area?.bbox) && area.bbox.length === 6 ? area.bbox : null,
  }
}
