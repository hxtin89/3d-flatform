export const SPATIAL_LOD_TILESET_FILE = 'tileset.json';

const MIB = 1024 * 1024;
const SPATIAL_LOD_PAN_SCALE_FACTOR = 0.0012;

export const SPATIAL_LOD_CACHE_BYTES = 1_024 * MIB;
export const SPATIAL_LOD_CACHE_OVERFLOW_BYTES = 512 * MIB;
export const SPATIAL_LOD_SOFT_MEMORY_BYTES = SPATIAL_LOD_CACHE_BYTES;
export const SPATIAL_LOD_HARD_MEMORY_BYTES =
  SPATIAL_LOD_CACHE_BYTES + SPATIAL_LOD_CACHE_OVERFLOW_BYTES;
export const SPATIAL_LOD_HARD_POINT_LIMIT = 15_000_000;
export const SPATIAL_LOD_SSE_LADDER = [
  64, 96, 128, 196, 256, 384, 512, 768, 1_024, 1_536, 2_048,
] as const;

export type SpatialLodRuntimeState =
  | 'BOOTSTRAP'
  | 'MOVING'
  | 'STREAMING'
  | 'SETTLED'
  | 'PRESSURE';

export interface SpatialLodBudgetMetrics {
  now: number;
  drawingBufferWidth: number;
  drawingBufferHeight: number;
  selectedPoints: number | null;
  frameTimeEmaMs: number | null;
  memoryBytes: number | null;
  queuesSettled: boolean;
  z4Eligible: boolean;
}

export interface SpatialLodBudgetDecision {
  state: SpatialLodRuntimeState;
  traversalPolicy: 'streaming' | 'standard';
  seedSse: number;
  effectiveSse: number;
  targetPoints: number;
  skipLevelOfDetail: boolean;
  preferLeaves: boolean;
  foveatedScreenSpaceError: boolean;
  skipLodLatchRemainingMs: number;
  foveatedMinimumScreenSpaceErrorRelaxation: number;
  eyeDomeLighting: boolean;
  trimCache: boolean;
}

export const SPATIAL_LOD_STREAMING_OPTIONS = {
  skipLevelOfDetail: true,
  baseScreenSpaceError: 1_024,
  skipScreenSpaceErrorFactor: 16,
  skipLevels: 1,
  immediatelyLoadDesiredLevelOfDetail: false,
  loadSiblings: false,
  preferLeaves: true,
  foveatedScreenSpaceError: true,
  foveatedConeSize: 0.2,
  foveatedMinimumScreenSpaceErrorRelaxation: 64,
  foveatedTimeDelay: 0.2,
  cullRequestsWhileMoving: true,
  cullRequestsWhileMovingMultiplier: 120,
} as const;

export function spatialLodDataset(logicalDataset: string): string {
  return `${logicalDataset}/${logicalDataset}-spatial-lod`;
}

/** Distance supplies only the initial SSE seed; it never drives frames directly. */
export function spatialLodInitialSse(rangeMeters: number): number {
  const range = Number.isFinite(rangeMeters)
    ? Math.max(rangeMeters, 0)
    : Number.POSITIVE_INFINITY;
  if (range <= 250) return 64;
  if (range <= 500) return 128;
  if (range <= 1_000) return 256;
  if (range <= 2_000) return 512;
  return 1_024;
}

export function spatialLodTargetPoints(
  drawingBufferWidth: number,
  drawingBufferHeight: number
): number {
  const pixels = Math.max(0, drawingBufferWidth) * Math.max(0, drawingBufferHeight);
  return Math.round(Math.min(12_000_000, Math.max(5_000_000, pixels * 6)));
}

/**
 * The controller deliberately has no Cesium dependency so its hysteresis and
 * budget policy are deterministic in tests. Cesium traversal remains the
 * source of selected tiles; this only supplies its runtime settings.
 */
export class SpatialLodBudgetController {
  private readonly seedSse: number;
  private effectiveSse: number;
  private state: SpatialLodRuntimeState = 'BOOTSTRAP';
  private stableSince: number | null = null;
  private standardTraversalSince: number | null = null;
  private standardTraversalLatched = false;
  private lastSseAdjustmentAt = Number.NEGATIVE_INFINITY;
  private skipLodLatchUntil = 0;
  private lastTrimAt = Number.NEGATIVE_INFINITY;

  constructor(initialRangeMeters: number) {
    this.seedSse = spatialLodInitialSse(initialRangeMeters);
    this.effectiveSse = this.seedSse;
  }

  onCameraMoveStart(now: number): void {
    this.state = 'MOVING';
    this.stableSince = null;
    this.standardTraversalSince = null;
    this.standardTraversalLatched = false;
    this.skipLodLatchUntil = now;
  }

  onCameraMoveEnd(): void {
    this.state = 'STREAMING';
    this.stableSince = null;
    this.standardTraversalSince = null;
    this.standardTraversalLatched = false;
  }

  update(metrics: SpatialLodBudgetMetrics): SpatialLodBudgetDecision {
    const targetPoints = spatialLodTargetPoints(
      metrics.drawingBufferWidth,
      metrics.drawingBufferHeight
    );
    const points = metrics.selectedPoints;
    const frameTime = metrics.frameTimeEmaMs;
    const memory = metrics.memoryBytes;
    const hardPressure = (
      (points !== null && points > SPATIAL_LOD_HARD_POINT_LIMIT) ||
      (frameTime !== null && frameTime > 60) ||
      (memory !== null && memory > SPATIAL_LOD_HARD_MEMORY_BYTES)
    );
    const softPressure = (
      (frameTime !== null && frameTime > 50) ||
      (memory !== null && memory > SPATIAL_LOD_SOFT_MEMORY_BYTES)
    );

    const trimCache = memory !== null &&
      memory > SPATIAL_LOD_HARD_MEMORY_BYTES &&
      metrics.now - this.lastTrimAt >= 10_000;
    if (trimCache) this.lastTrimAt = metrics.now;

    if (this.state === 'MOVING') {
      return this.decision(metrics.now, targetPoints, false, trimCache, false);
    }

    if (hardPressure || softPressure) {
      this.state = 'PRESSURE';
      this.coarsen(metrics.now);
    }

    const stable = !hardPressure && !softPressure &&
      metrics.queuesSettled &&
      metrics.z4Eligible &&
      points !== null && points <= targetPoints &&
      frameTime !== null && frameTime <= 40 &&
      memory !== null && memory <= SPATIAL_LOD_SOFT_MEMORY_BYTES;

    const pressureTraversalEligible = (hardPressure || softPressure) &&
      metrics.queuesSettled &&
      metrics.z4Eligible &&
      this.effectiveSse === SPATIAL_LOD_SSE_LADDER.at(-1);
    const standardTraversalEligible = stable || pressureTraversalEligible;

    if (!this.standardTraversalLatched) {
      if (!standardTraversalEligible) {
        this.standardTraversalSince = null;
        this.stableSince = null;
        if (!hardPressure && !softPressure) this.state = 'STREAMING';
        return this.decision(metrics.now, targetPoints, false, trimCache, false);
      }

      this.standardTraversalSince ??= metrics.now;
      if (metrics.now - this.standardTraversalSince < 2_500) {
        this.state = hardPressure || softPressure ? 'PRESSURE' : 'STREAMING';
        return this.decision(metrics.now, targetPoints, false, trimCache, false);
      }

      this.standardTraversalLatched = true;
      this.skipLodLatchUntil = Math.max(this.skipLodLatchUntil, metrics.now + 3_000);
    }

    this.state = hardPressure || softPressure ? 'PRESSURE' : 'SETTLED';
    if (stable && points !== null && frameTime !== null && points < targetPoints * 0.7 && frameTime < 32) {
      this.refine(metrics.now);
    }
    return this.decision(metrics.now, targetPoints, false, trimCache, true);
  }

  private coarsen(now: number): void {
    if (now - this.lastSseAdjustmentAt < 1_000) return;
    const index = SPATIAL_LOD_SSE_LADDER.indexOf(
      this.effectiveSse as typeof SPATIAL_LOD_SSE_LADDER[number]
    );
    this.effectiveSse = SPATIAL_LOD_SSE_LADDER[Math.min(index + 1, SPATIAL_LOD_SSE_LADDER.length - 1)];
    this.lastSseAdjustmentAt = now;
  }

  private refine(now: number): void {
    if (now - this.lastSseAdjustmentAt < 1_000) return;
    const index = SPATIAL_LOD_SSE_LADDER.indexOf(
      this.effectiveSse as typeof SPATIAL_LOD_SSE_LADDER[number]
    );
    this.effectiveSse = SPATIAL_LOD_SSE_LADDER[Math.max(index - 1, 0)];
    this.lastSseAdjustmentAt = now;
  }

  private decision(
    now: number,
    targetPoints: number,
    eyeDomeLighting: boolean,
    trimCache: boolean,
    standardTraversal: boolean
  ): SpatialLodBudgetDecision {
    return {
      state: this.state,
      traversalPolicy: standardTraversal ? 'standard' : 'streaming',
      seedSse: this.seedSse,
      effectiveSse: this.effectiveSse,
      targetPoints,
      skipLevelOfDetail: !standardTraversal,
      preferLeaves: !standardTraversal,
      foveatedScreenSpaceError: !standardTraversal,
      skipLodLatchRemainingMs: Math.max(0, Math.round(this.skipLodLatchUntil - now)),
      foveatedMinimumScreenSpaceErrorRelaxation: Math.min(64, this.effectiveSse),
      eyeDomeLighting,
      trimCache,
    };
  }
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
