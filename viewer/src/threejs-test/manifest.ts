// Minimal area-manifest reader — just the placement and One LOD entry the map needs:
//   rootTransform    ENU→ECEF matrix (column-major 16) that places local-ENU point
//                    coordinates onto the WGS84 globe (same one Cesium uses)
// Full manifest schema lives in the Cesium viewer's src/manifest.ts.

export interface GlobeManifest {
  /** ENU→ECEF, column-major, apply as THREE.Matrix4.fromArray() */
  rootTransform: number[]
  /** [lon, lat, heightM] of the ENU origin */
  enuOriginLonLat: [number, number, number]
  /** One external Overview -> Explore -> Detail tree covering all manifest areas. */
  oneLodTreeDataset: string
  oneLodTreeTilesetFile: 'tileset-one-lod-tree.json'
  /** ENU-frame bbox used for the initial camera target. */
  areaBbox: number[] | null
}

export async function fetchGlobeManifest(baseUrl: string, dataset: string): Promise<GlobeManifest> {
  const cleanDataset = dataset.replace(/^\/+|\/+$/g, '')
  if (!cleanDataset || cleanDataset.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`invalid logical dataset: ${dataset}`)
  }
  const res = await fetch(`${baseUrl}/${cleanDataset}/area-manifest.json`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`area-manifest HTTP ${res.status}`)
  const m = await res.json()

  const rootTransform: number[] | null = m.rootTransform
  if (!Array.isArray(rootTransform) || rootTransform.length !== 16) {
    throw new Error('manifest has no usable rootTransform (globe dataset required)')
  }

  const defaultArea = m.areas?.find((area: any) => area.areaId === m.defaultAreaId)
    ?? m.areas?.[0]
    ?? null
  return {
    rootTransform,
    enuOriginLonLat: m.enuOriginLonLat,
    oneLodTreeDataset: `${cleanDataset}/${cleanDataset}-one-lod-tree`,
    oneLodTreeTilesetFile: 'tileset-one-lod-tree.json',
    areaBbox: Array.isArray(defaultArea?.bbox) && defaultArea.bbox.length === 6 ? defaultArea.bbox : null,
  }
}
