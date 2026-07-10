import type { PresetName } from './presets';

export const SPATIAL_LOD_TILESET_FILE = 'tileset.json';

export const SPATIAL_LOD_SSE: Readonly<Record<PresetName, number>> = {
  low: 1024,
  medium: 256,
  high: 128,
};

const MIB = 1024 * 1024;
const SPATIAL_LOD_PAN_SCALE_FACTOR = 0.0012;

export const SPATIAL_LOD_STREAMING_OPTIONS = {
  skipLevelOfDetail: true,
  baseScreenSpaceError: 1_024,
  skipScreenSpaceErrorFactor: 16,
  skipLevels: 1,
  immediatelyLoadDesiredLevelOfDetail: false,
  loadSiblings: false,
  preferLeaves: true,
  foveatedScreenSpaceError: true,
  foveatedConeSize: 0.25,
  foveatedMinimumScreenSpaceErrorRelaxation: 64,
  foveatedTimeDelay: 0.2,
  cullRequestsWhileMoving: true,
  cullRequestsWhileMovingMultiplier: 120,
} as const;

// Cache headroom mirrors PRESETS but is inlined so this module (and its tests)
// do not pull the Cesium runtime dependency through presets.ts.
const SPATIAL_CACHE_BYTES: Readonly<Record<PresetName, number>> = {
  low: 256 * MIB,
  medium: 512 * MIB,
  high: 768 * MIB,
};
const SPATIAL_CACHE_OVERFLOW_BYTES: Readonly<Record<PresetName, number>> = {
  low: 128 * MIB,
  medium: 256 * MIB,
  high: 512 * MIB,
};

export interface SpatialLodCachePolicy {
  cacheBytes: number;
  maximumCacheOverflowBytes: number;
  trimOnEnter: boolean;
}

export interface SpatialLodOverviewRuntimePolicy {
  level: keyof SpatialLodLevelStats;
  maxRangeMeters: number;
  sse: number;
  cacheBytes: number;
  maximumCacheOverflowBytes: number;
}

const SPATIAL_LOD_OVERVIEW_RUNTIME_LADDER: readonly SpatialLodOverviewRuntimePolicy[] = [
  { level: 'z4', maxRangeMeters: 250, sse: 64, cacheBytes: 2_048 * MIB, maximumCacheOverflowBytes: 1_024 * MIB },
  { level: 'z3', maxRangeMeters: 500, sse: 128, cacheBytes: 1_536 * MIB, maximumCacheOverflowBytes: 768 * MIB },
  { level: 'z2', maxRangeMeters: 1_000, sse: 256, cacheBytes: 1_024 * MIB, maximumCacheOverflowBytes: 512 * MIB },
  { level: 'z1', maxRangeMeters: 2_000, sse: 512, cacheBytes: 512 * MIB, maximumCacheOverflowBytes: 256 * MIB },
  { level: 'z0', maxRangeMeters: Number.POSITIVE_INFINITY, sse: 1_024, cacheBytes: 256 * MIB, maximumCacheOverflowBytes: 128 * MIB },
];

export function spatialLodDataset(logicalDataset: string): string {
  return `${logicalDataset}/${logicalDataset}-spatial-lod`;
}

export function spatialLodSse(preset: PresetName): number {
  return SPATIAL_LOD_SSE[preset];
}

/**
 * Spatial LOD keeps the same cache headroom as the normal presets. Overview
 * trims finer cached tiles so returning from Explore/Detail releases the
 * finer z3/z4 tiles.
 */
export function spatialLodCachePolicy(preset: PresetName): SpatialLodCachePolicy {
  return {
    cacheBytes: SPATIAL_CACHE_BYTES[preset],
    maximumCacheOverflowBytes: SPATIAL_CACHE_OVERFLOW_BYTES[preset],
    trimOnEnter: preset === 'low',
  };
}

export function shouldTrimSpatialLod(
  previousPreset: PresetName,
  nextPreset: PresetName
): boolean {
  return previousPreset !== 'low' && spatialLodCachePolicy(nextPreset).trimOnEnter;
}

export function spatialLodOverviewRuntimePolicy(rangeMeters: number): SpatialLodOverviewRuntimePolicy {
  const range = Number.isFinite(rangeMeters)
    ? Math.max(rangeMeters, 0)
    : Number.POSITIVE_INFINITY;
  return SPATIAL_LOD_OVERVIEW_RUNTIME_LADDER.find(
    (band) => range <= band.maxRangeMeters
  ) ?? SPATIAL_LOD_OVERVIEW_RUNTIME_LADDER[SPATIAL_LOD_OVERVIEW_RUNTIME_LADDER.length - 1];
}

export function spatialLodPanScaleMetersPerPixel(rangeMeters: number): number {
  if (!Number.isFinite(rangeMeters) || rangeMeters <= 0) return 0;
  return rangeMeters * SPATIAL_LOD_PAN_SCALE_FACTOR;
}

const SAFE_TILESET_FILE = /^[a-zA-Z0-9_-]+\.json$/;

export function spatialLodEntryUrl(
  baseUrl: string,
  dataset: string,
  tilesetFile = SPATIAL_LOD_TILESET_FILE
): string {
  if (!baseUrl) return '';
  if (!SAFE_TILESET_FILE.test(tilesetFile)) {
    throw new Error(`Invalid tileset entry filename: ${tilesetFile}`);
  }
  const base = baseUrl.replace(/\/+$/, '');
  const path = dataset.replace(/^\/+|\/+$/g, '');
  if (!path || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid tileset dataset path: ${dataset}`);
  }
  return `${base}/${path}/${tilesetFile}`;
}

/**
 * Per-z0..z4 runtime report bucket. Counters are filled from the loaded
 * tileset's selected tiles by inspecting the tile URI path segment.
 */
export interface SpatialLodLevelStats {
  z0: number;
  z1: number;
  z2: number;
  z3: number;
  z4: number;
}

export interface SpatialLodTileId {
  level: keyof SpatialLodLevelStats;
  x: number;
  y: number;
  tileId: string;
}

export interface SpatialLodActiveTileSample {
  uri: string | null;
  level: keyof SpatialLodLevelStats | null;
  tileId: string | null;
  x: number | null;
  y: number | null;
  geometricError: number | null;
  childrenCount: number | null;
  hasViewerRequestVolume: boolean;
  refine: string | null;
  contentState: string;
  cameraInsideZ4RequestVolume?: boolean | null;
  distanceToZ4RequestVolumeMeters?: number | null;
}

export function emptySpatialLodLevelStats(): SpatialLodLevelStats {
  return { z0: 0, z1: 0, z2: 0, z3: 0, z4: 0 };
}

const SPATIAL_LEVEL_PATTERN = /\/points\/(z[0-4])\//;
const SPATIAL_PNTS_LEVEL_PATTERN = /\/points\/(z[0-4])\/[^?#]+\.pnts(?:[?#].*)?$/;
const SPATIAL_TILE_ID_PATTERN = /(z[0-4])_x(-?\d+)_y(-?\d+)(?:\.pnts|\.json)?(?:[?#].*)?$/;

export function classifySpatialLodTileUri(uri: string | undefined): keyof SpatialLodLevelStats | null {
  if (!uri) return null;
  const match = uri.match(SPATIAL_LEVEL_PATTERN);
  if (!match) return null;
  const level = match[1] as keyof SpatialLodLevelStats;
  return level in { z0: 1, z1: 1, z2: 1, z3: 1, z4: 1 } ? level : null;
}

export function countSpatialLodPntsUrls(urls: Iterable<string>): SpatialLodLevelStats {
  const stats = emptySpatialLodLevelStats();
  for (const url of urls) {
    const match = url.match(SPATIAL_PNTS_LEVEL_PATTERN);
    if (!match) continue;
    const level = match[1] as keyof SpatialLodLevelStats;
    stats[level] += 1;
  }
  return stats;
}

export function formatSpatialLodLevelStats(stats: SpatialLodLevelStats | null): string {
  if (!stats) return '—';
  return `z0=${stats.z0} z1=${stats.z1} z2=${stats.z2} z3=${stats.z3} z4=${stats.z4}`;
}

export function parseSpatialLodTileId(uri: string | undefined | null): SpatialLodTileId | null {
  if (!uri) return null;
  const clean = uri.split('/').pop() ?? uri;
  const match = clean.match(SPATIAL_TILE_ID_PATTERN);
  if (!match) return null;
  const level = match[1] as keyof SpatialLodLevelStats;
  return {
    level,
    x: Number.parseInt(match[2], 10),
    y: Number.parseInt(match[3], 10),
    tileId: `${level}_x${match[2]}_y${match[3]}`,
  };
}

export function formatSpatialLodActiveTileSamples(
  samples: readonly SpatialLodActiveTileSample[],
  limit = 8
): string {
  if (samples.length === 0) return '—';
  return samples.slice(0, limit).map((sample) => {
    const id = sample.tileId ?? sample.level ?? 'unknown';
    const err = sample.geometricError === null ? 'err=—' : `err=${sample.geometricError}`;
    const child = sample.childrenCount === null ? 'child=—' : `child=${sample.childrenCount}`;
    const vrv = sample.hasViewerRequestVolume ? 'vrv=1' : 'vrv=0';
    const z4Vrv = sample.level === 'z3'
      ? sample.cameraInsideZ4RequestVolume == null
        ? ' z4vrv=—'
        : ` z4vrv=${sample.cameraInsideZ4RequestVolume ? 'in' : 'out'}@${sample.distanceToZ4RequestVolumeMeters ?? '—'}m`
      : '';
    return `${id} ${err} ${child} ${vrv}${z4Vrv} content=${sample.contentState}`;
  }).join(' | ');
}

/**
 * Extract a content URI from a Cesium runtime tile. Cesium keeps the URL on
 * the private `_contentResource` (a Resource with `url`/`getUrlComponent()`).
 * Some tilesets expose it on `content.uri` instead. Returns null when no URL
 * can be read so the caller can show "—" instead of misleading zeros.
 */
export function extractTileContentUri(tile: unknown): string | null {
  if (!tile || typeof tile !== 'object') return null;
  const t = tile as {
    content?: { uri?: unknown; _url?: unknown };
    _contentResource?: { url?: unknown; getUrlComponent?: (() => string) | unknown };
  };
  const contentUri = t.content?.uri;
  if (typeof contentUri === 'string') return contentUri;
  const resUrl = t._contentResource?.url;
  if (typeof resUrl === 'string') return resUrl;
  const getter = t._contentResource?.getUrlComponent;
  if (typeof getter === 'function') {
    try {
      const v = getter.call(t._contentResource);
      return typeof v === 'string' ? v : null;
    } catch {
      return null;
    }
  }
  return null;
}
