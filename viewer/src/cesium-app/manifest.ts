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
  /** Adaptive Point Hierarchy: one ~11-deep quadtree of ~75k-point nodes over the
   * same ENU origin. Unlike the One LOD Tree it carries real density at close
   * range — the published One LOD chain stops at the p02 overview band. */
  adaptiveHierarchyDataset: string
  adaptiveHierarchyTilesetFile: 'tileset.json'
  /** ENU-frame bbox used for the initial camera target. */
  areaBbox: number[] | null
  /** Combined ENU bbox used for the real survey centre. */
  surveyBbox: number[] | null
  /** Vertical source-data span, used to keep navigation above the cloud. */
  areaVerticalSpan: number | null
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

  const areas: any[] = Array.isArray(m.areas) ? m.areas : []
  const defaultArea = areas.find((area: any) => area.areaId === m.defaultAreaId)
    ?? areas[0]
    ?? null
  let surveyBbox: number[] | null = null
  for (const area of areas) {
    const bbox = area?.bbox
    if (!Array.isArray(bbox) || bbox.length !== 6 || bbox.some((value: unknown) => !Number.isFinite(Number(value)))) continue
    if (!surveyBbox) surveyBbox = bbox.map(Number)
    else {
      surveyBbox[0] = Math.min(surveyBbox[0], Number(bbox[0]))
      surveyBbox[1] = Math.min(surveyBbox[1], Number(bbox[1]))
      surveyBbox[2] = Math.min(surveyBbox[2], Number(bbox[2]))
      surveyBbox[3] = Math.max(surveyBbox[3], Number(bbox[3]))
      surveyBbox[4] = Math.max(surveyBbox[4], Number(bbox[4]))
      surveyBbox[5] = Math.max(surveyBbox[5], Number(bbox[5]))
    }
  }
  const sourceBbox = defaultArea?.sourceBbox
  const areaVerticalSpan = Array.isArray(sourceBbox) && sourceBbox.length === 6
    ? Math.max(0, Number(sourceBbox[5]) - Number(sourceBbox[2]))
    : null
  return {
    rootTransform,
    enuOriginLonLat: m.enuOriginLonLat,
    oneLodTreeDataset: `${cleanDataset}/${cleanDataset}-one-lod-tree`,
    oneLodTreeTilesetFile: 'tileset-one-lod-tree.json',
    adaptiveHierarchyDataset: `${cleanDataset}/${cleanDataset}-adaptive-point-hierarchy`,
    adaptiveHierarchyTilesetFile: 'tileset.json',
    areaBbox: Array.isArray(defaultArea?.bbox) && defaultArea.bbox.length === 6 ? defaultArea.bbox : null,
    surveyBbox,
    areaVerticalSpan: Number.isFinite(areaVerticalSpan) ? areaVerticalSpan : null,
  }
}
