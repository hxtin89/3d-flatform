import { TILE_CONFIG } from './viewer';
import { type PresetName } from './presets';

export const AREA_BBOX_EPSILON = 0.01;

export type ModeStatus = 'ready' | 'not_built' | 'building' | 'failed';
export type LogicalMode = 'overview' | 'explore' | 'detail';

export interface ModeDataset {
  dataset: string;
  status: ModeStatus;
}

export interface AreaManifestEntry {
  areaId: string;
  label: string;
  sourceChunkId: string;
  bbox: number[];
  sourceBbox?: number[];
  pointCount: number | null;
  datasets: {
    explore?: ModeDataset;
    detail?: ModeDataset;
    context?: ModeDataset;
  };
}

export interface AreaManifest {
  dataset: string;
  defaultMode: LogicalMode;
  defaultAreaId: string | null;
  coordinateMode?: 'local' | 'globe';
  bboxFrame?: 'source' | 'enu';
  rootTransform?: number[] | null;
  enuOriginSource?: number[] | null;
  enuOriginEcef?: number[] | null;
  enuOriginLonLat?: number[] | null;
  datasets: {
    overview: ModeDataset;
  };
  areas: AreaManifestEntry[];
}

export interface LocalPoint {
  x: number;
  y: number;
  z: number;
}

export interface AreaViewSample extends LocalPoint {
  weight: number;
  source: 'pickPosition' | 'orbitTarget';
}

export interface AreaDetectionResult {
  area: AreaManifestEntry | null;
  sampleCount: number;
  matchedSampleCount: number;
  fallbackUsed: boolean;
  reason: string;
}

export interface ResolvedDataset {
  logicalDataset: string;
  resolvedDataset: string;
  selectedAreaId: string | null;
  modeStatus: ModeStatus;
  modeStatusLabel: string;
  sourceChunkId: string | null;
  contextDataset: string | null;
  contextStatus: ModeStatus | null;
  contextStatusLabel: string | null;
  contextExcludedAreaId: string | null;
  contextExcludedSourceChunkId: string | null;
}

export function modeForPreset(preset: PresetName): LogicalMode {
  if (preset === 'medium') return 'explore';
  if (preset === 'high') return 'detail';
  return 'overview';
}

export async function fetchAreaManifest(dataset: string): Promise<AreaManifest | null> {
  if (!TILE_CONFIG.baseUrl) return null;
  const response = await fetch(`${TILE_CONFIG.baseUrl}/${dataset}/area-manifest.json`, {
    cache: 'no-store',
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Manifest HTTP ${response.status}`);
  return await response.json() as AreaManifest;
}

export function selectedArea(
  manifest: AreaManifest | null,
  areaId: string | null
): AreaManifestEntry | null {
  if (!manifest) return null;
  const selected = manifest.areas.find((area) => area.areaId === areaId);
  return selected ?? manifest.areas[0] ?? null;
}

export function findAreaForPoint(
  manifest: AreaManifest | null,
  point: LocalPoint
): AreaManifestEntry | null {
  return findAreaForViewSamples(manifest, [{
    ...point,
    weight: 1,
    source: 'orbitTarget',
  }]).area;
}

export function findAreaForViewSamples(
  manifest: AreaManifest | null,
  samples: AreaViewSample[]
): AreaDetectionResult {
  const sampleCount = samples.length;
  const fallbackUsed = samples.some((sample) => sample.source === 'orbitTarget');
  if (!manifest) {
    return {
      area: null,
      sampleCount,
      matchedSampleCount: 0,
      fallbackUsed,
      reason: 'manifest_not_ready',
    };
  }

  const comparableSamples = samples.map((sample) => toManifestFrame(manifest, sample));
  const scores = new Map<string, {
    area: AreaManifestEntry;
    score: number;
    matchedSampleCount: number;
    zMatchCount: number;
    maxWeight: number;
    footprintArea: number;
  }>();

  let matchedSampleCount = 0;

  for (const sample of comparableSamples) {
    let matchedThisSample = false;
    for (const area of manifest.areas) {
      const match = matchAreaSample(area, sample);
      if (!match) continue;
      matchedThisSample = true;
      const current = scores.get(area.areaId) ?? {
        area,
        score: 0,
        matchedSampleCount: 0,
        zMatchCount: 0,
        maxWeight: 0,
        footprintArea: match.footprintArea,
      };
      current.score += sample.weight * (match.containsZ ? 1.05 : 1);
      current.matchedSampleCount += 1;
      current.zMatchCount += match.containsZ ? 1 : 0;
      current.maxWeight = Math.max(current.maxWeight, sample.weight);
      current.footprintArea = Math.min(current.footprintArea, match.footprintArea);
      scores.set(area.areaId, current);
    }
    if (matchedThisSample) matchedSampleCount += 1;
  }

  let best: {
    area: AreaManifestEntry;
    score: number;
    matchedSampleCount: number;
    zMatchCount: number;
    maxWeight: number;
    footprintArea: number;
  } | null = null;

  for (const candidate of scores.values()) {
    if (
      !best ||
      candidate.score > best.score ||
      (candidate.score === best.score && candidate.maxWeight > best.maxWeight) ||
      (
        candidate.score === best.score &&
        candidate.maxWeight === best.maxWeight &&
        candidate.footprintArea < best.footprintArea
      )
    ) {
      best = candidate;
    }
  }

  if (!best) {
    return {
      area: null,
      sampleCount,
      matchedSampleCount,
      fallbackUsed,
      reason: sampleCount === 0 ? 'no_samples' : 'no_area_match',
    };
  }

  return {
    area: best.area,
    sampleCount,
    matchedSampleCount,
    fallbackUsed,
    reason: 'matched',
  };
}

function toManifestFrame(manifest: AreaManifest, sample: AreaViewSample): AreaViewSample {
  if (manifest.coordinateMode !== 'globe' || manifest.bboxFrame !== 'enu') return sample;
  const transform = manifest.rootTransform;
  if (!Array.isArray(transform) || transform.length !== 16) return sample;
  if (transform.some((value) => !Number.isFinite(value))) return sample;

  const dx = sample.x - transform[12];
  const dy = sample.y - transform[13];
  const dz = sample.z - transform[14];

  return {
    ...sample,
    x: dx * transform[0] + dy * transform[1] + dz * transform[2],
    y: dx * transform[4] + dy * transform[5] + dz * transform[6],
    z: dx * transform[8] + dy * transform[9] + dz * transform[10],
  };
}

function matchAreaSample(
  area: AreaManifestEntry,
  point: LocalPoint
): { containsZ: boolean; footprintArea: number } | null {
    const bounds = area.bbox;
    if (bounds.length !== 6 || bounds.some((value) => !Number.isFinite(value))) {
      return null;
    }

    const [minX, minY, minZ, maxX, maxY, maxZ] = bounds;
    const containsXY =
      point.x >= minX - AREA_BBOX_EPSILON &&
      point.x <= maxX + AREA_BBOX_EPSILON &&
      point.y >= minY - AREA_BBOX_EPSILON &&
      point.y <= maxY + AREA_BBOX_EPSILON;

    if (!containsXY) return null;

    const containsZ =
      point.z >= minZ - AREA_BBOX_EPSILON &&
      point.z <= maxZ + AREA_BBOX_EPSILON;
    const footprintArea = Math.max(maxX - minX, 0) * Math.max(maxY - minY, 0);
    return { containsZ, footprintArea };
}

export function resolveDataset(
  requestedDataset: string,
  preset: PresetName,
  manifest: AreaManifest | null,
  area: AreaManifestEntry | null
): ResolvedDataset {
  if (!manifest) {
    return {
      logicalDataset: requestedDataset,
      resolvedDataset: requestedDataset,
      selectedAreaId: null,
      modeStatus: 'ready',
      modeStatusLabel: 'ready',
      sourceChunkId: null,
      contextDataset: null,
      contextStatus: null,
      contextStatusLabel: null,
      contextExcludedAreaId: null,
      contextExcludedSourceChunkId: null,
    };
  }

  const mode = modeForPreset(preset);
  if (mode === 'overview') {
    const overview = manifest.datasets.overview;
    return {
      logicalDataset: manifest.dataset,
      resolvedDataset: overview.dataset,
      selectedAreaId: area?.areaId ?? null,
      modeStatus: overview.status,
      modeStatusLabel: overview.status,
      sourceChunkId: null,
      contextDataset: null,
      contextStatus: null,
      contextStatusLabel: null,
      contextExcludedAreaId: null,
      contextExcludedSourceChunkId: null,
    };
  }

  const item = mode === 'explore'
    ? area?.datasets.explore
    : area?.datasets.detail;
  const context = area?.datasets.context;
  const fallbackDataset = `${manifest.dataset}-${area?.areaId ?? 'area-001'}-${mode === 'explore' ? 'p10' : 'full'}`;
  const status = item?.status ?? 'not_built';
  const contextStatus = context?.status ?? null;
  return {
    logicalDataset: manifest.dataset,
    resolvedDataset: item?.dataset ?? fallbackDataset,
    selectedAreaId: area?.areaId ?? null,
    modeStatus: status,
    modeStatusLabel: statusLabel(mode, status),
    sourceChunkId: area?.sourceChunkId ?? null,
    contextDataset: context?.dataset ?? null,
    contextStatus,
    contextStatusLabel: contextStatus ? statusLabel('overview', contextStatus) : null,
    contextExcludedAreaId: context ? area?.areaId ?? null : null,
    contextExcludedSourceChunkId: context ? area?.sourceChunkId ?? null : null,
  };
}

export function statusLabel(mode: LogicalMode, status: ModeStatus): string {
  if (status === 'ready') return 'ready';
  if (status === 'building') return 'Building';
  if (status === 'failed') return 'Failed';
  if (mode === 'detail') return 'Build required';
  if (mode === 'explore') return 'Not built yet';
  return status;
}

// ── Auto-LOD manifest (?lod=auto) ──────────────────────────────────────────
// Self-contained contract produced by pipeline/area_auto_lod_manifest.py.
// Kept separate from the manual-mode `AreaManifest` so manual behavior is
// untouched. The type contract lives in `./auto-lod-controller` so the
// controller stays zero-dependency and unit-testable without Cesium.
export type {
  AutoLodArea,
  AutoLodLevel,
  AutoLodManifest,
  AutoLodPreset,
  LodStatus,
} from './auto-lod-controller';

import type { AutoLodArea, AutoLodLevel, AutoLodManifest } from './auto-lod-controller';

export async function fetchAutoLodManifest(dataset: string): Promise<AutoLodManifest | null> {
  if (!TILE_CONFIG.baseUrl) return null;
  const response = await fetch(`${TILE_CONFIG.baseUrl}/${dataset}/area-manifest-auto-lod.json`, {
    cache: 'no-store',
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Auto-LOD manifest HTTP ${response.status}`);
  const raw = await response.json();
  return parseAutoLodManifest(raw, dataset);
}

/** Strict runtime validator. Throws Error("Invalid Auto-LOD manifest: ...") on any violation. */
export function parseAutoLodManifest(raw: unknown, expectedDataset: string): AutoLodManifest {
  const label = 'Invalid Auto-LOD manifest';
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${label}: root must be an object.`);
  }
  const r = raw as Record<string, unknown>;

  if (r.get !== undefined) throw new Error(`${label}: unexpected Map instance.`);
  if (r.version !== 1) throw new Error(`${label}: version must equal 1, got ${JSON.stringify(r.version)}.`);
  if (r.mode !== 'auto-lod') throw new Error(`${label}: mode must equal "auto-lod", got ${JSON.stringify(r.mode)}.`);
  if (typeof r.dataset !== 'string' || !r.dataset) {
    throw new Error(`${label}: dataset must be a non-empty string.`);
  }
  if (r.dataset !== expectedDataset) {
    throw new Error(`${label}: dataset "${r.dataset}" does not match URL dataset "${expectedDataset}".`);
  }
  if (r.defaultLevel !== 'p02' && r.defaultLevel !== 'p10' && r.defaultLevel !== 'p100') {
    throw new Error(`${label}: defaultLevel must be one of p02|p10|p100.`);
  }

  const coord = r.coordinateMode;
  if (coord !== undefined && coord !== 'local' && coord !== 'globe') {
    throw new Error(`${label}: coordinateMode must be "local" or "globe".`);
  }
  const isGlobe = coord === 'globe';

  const levels = r.levels;
  if (typeof levels !== 'object' || levels === null || Array.isArray(levels)) {
    throw new Error(`${label}: levels must be an object.`);
  }
  const lv = levels as Record<string, any>;
  if (lv.p02?.scope !== 'global' || lv.p02?.preset !== 'low') {
    throw new Error(`${label}: levels.p02 must have scope="global", preset="low".`);
  }
  if (typeof lv.p02?.dataset !== 'string' || !lv.p02.dataset.trim()) {
    throw new Error(`${label}: levels.p02.dataset must be a non-empty string.`);
  }
  if (lv.p02?.status !== 'ready' && lv.p02?.status !== 'not_built') {
    throw new Error(`${label}: levels.p02.status must be "ready" or "not_built".`);
  }
  if (lv.p10?.scope !== 'area' || lv.p10?.preset !== 'medium') {
    throw new Error(`${label}: levels.p10 must have scope="area", preset="medium".`);
  }
  if (lv.p100?.scope !== 'area' || lv.p100?.preset !== 'high') {
    throw new Error(`${label}: levels.p100 must have scope="area", preset="high".`);
  }

  const t = r.thresholds;
  if (typeof t !== 'object' || t === null || Array.isArray(t)) {
    throw new Error(`${label}: thresholds must be an object.`);
  }
  const th = t as Record<string, unknown>;
  const required = [
    'p10EnterRatio', 'p10ExitRatio',
    'p100EnterRatio', 'p100ExitRatio',
    'settleMs', 'visibleTimeoutMs', 'retryMs',
  ] as const;
  for (const key of required) {
    if (typeof th[key] !== 'number' || !Number.isFinite(th[key])) {
      throw new Error(`${label}: threshold ${key} must be a finite number.`);
    }
  }
  const T = th as Record<typeof required[number], number>;
  if (!(0 < T.p100EnterRatio && T.p100EnterRatio < T.p100ExitRatio)) {
    throw new Error(`${label}: threshold ordering violated: 0 < p100EnterRatio < p100ExitRatio.`);
  }
  if (!(T.p100ExitRatio < T.p10EnterRatio && T.p10EnterRatio < T.p10ExitRatio)) {
    throw new Error(`${label}: threshold ordering violated: p100ExitRatio < p10EnterRatio < p10ExitRatio.`);
  }
  if (T.settleMs < 0 || T.visibleTimeoutMs <= 0 || T.retryMs <= 0) {
    throw new Error(`${label}: settleMs>=0, visibleTimeoutMs>0, retryMs>0.`);
  }

  const rootTransform = r.rootTransform;
  if (isGlobe) {
    if (!Array.isArray(rootTransform) || rootTransform.length !== 16) {
      throw new Error(`${label}: globe manifest requires rootTransform with 16 finite numbers.`);
    }
    if (!rootTransform.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      throw new Error(`${label}: rootTransform entries must be finite numbers.`);
    }
  }

  const areas = r.areas;
  if (!Array.isArray(areas) || areas.length === 0) {
    throw new Error(`${label}: areas must be a non-empty array.`);
  }
  const seenArea = new Set<string>();
  const seenChunk = new Set<string>();
  areas.forEach((a, i) => {
    if (typeof a !== 'object' || a === null || Array.isArray(a)) {
      throw new Error(`${label}: areas[${i}] must be an object.`);
    }
    const area = a as Record<string, unknown>;
    if (typeof area.areaId !== 'string' || !area.areaId) {
      throw new Error(`${label}: areas[${i}].areaId must be a non-empty string.`);
    }
    if (seenArea.has(area.areaId)) {
      throw new Error(`${label}: duplicate areaId "${area.areaId}".`);
    }
    seenArea.add(area.areaId);
    if (typeof area.sourceChunkId !== 'string' || !area.sourceChunkId) {
      throw new Error(`${label}: areas[${i}].sourceChunkId must be a non-empty string.`);
    }
    if (seenChunk.has(area.sourceChunkId)) {
      throw new Error(`${label}: duplicate sourceChunkId "${area.sourceChunkId}" (area ${area.areaId}).`);
    }
    seenChunk.add(area.sourceChunkId);
    const bbox = area.bbox;
    if (!Array.isArray(bbox) || bbox.length !== 6 || !bbox.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      throw new Error(`${label}: areas[${i}].bbox must be six finite numbers.`);
    }
    const [minx, miny, minz, maxx, maxy, maxz] = bbox;
    if (!(maxx >= minx && maxy >= miny && maxz >= minz)) {
      throw new Error(`${label}: areas[${i}].bbox must satisfy min <= max on every axis.`);
    }
    const levelsBlock = area.levels;
    if (typeof levelsBlock !== 'object' || levelsBlock === null) {
      throw new Error(`${label}: areas[${i}].levels must be an object.`);
    }
    const lb = levelsBlock as Record<string, any>;
    for (const lvl of ['p10', 'p100'] as const) {
      const slot = lb[lvl];
      if (typeof slot !== 'object' || slot === null) {
        throw new Error(`${label}: areas[${i}].levels.${lvl} must be an object.`);
      }
      if (typeof slot.dataset !== 'string') {
        throw new Error(`${label}: areas[${i}].levels.${lvl}.dataset must be a string.`);
      }
      // Empty dataset is allowed when status is `not_built`; a `ready` dataset
      // path must be non-empty (so we never try to fetch an empty URL).
      if (slot.status === 'ready' && !slot.dataset.trim()) {
        throw new Error(
          `${label}: areas[${i}].levels.${lvl}.dataset must be non-empty when status="ready".`
        );
      }
      if (slot.status !== 'ready' && slot.status !== 'not_built') {
        throw new Error(`${label}: areas[${i}].levels.${lvl}.status must be ready|not_built.`);
      }
    }
  });

  return raw as unknown as AutoLodManifest;
}

/**
 * Detect which auto-LOD area the camera currently points at.
 * Reuses the existing `findAreaForViewSamples` matcher; the auto-LOD manifest
 * carries the same bbox frame as the manual manifest so we project samples into
 * the manifest frame by adapting the matcher to treat AutoLodArea like AreaManifestEntry.
 */
export function autoLodAreaForSamples(
  manifest: AutoLodManifest | null,
  samples: AreaViewSample[]
): { areaId: string | null; reason: string } {
  if (!manifest) return { areaId: null, reason: 'manifest_not_ready' };
  if (samples.length === 0) return { areaId: null, reason: 'no_samples' };
  const proxy: AreaManifest = {
    dataset: manifest.dataset,
    defaultMode: 'overview',
    defaultAreaId: manifest.areas[0]?.areaId ?? null,
    coordinateMode: manifest.coordinateMode,
    bboxFrame: manifest.bboxFrame,
    rootTransform: manifest.rootTransform,
    enuOriginSource: manifest.enuOriginSource,
    enuOriginEcef: manifest.enuOriginEcef,
    enuOriginLonLat: manifest.enuOriginLonLat,
    datasets: { overview: { dataset: '', status: 'not_built' } },
    areas: manifest.areas.map((area) => ({
      areaId: area.areaId,
      label: area.label,
      sourceChunkId: area.sourceChunkId,
      bbox: area.bbox,
      sourceBbox: area.sourceBbox ?? undefined,
      pointCount: area.pointCount,
      datasets: {},
    })),
  };
  const result = findAreaForViewSamples(proxy, samples);
  return { areaId: result.area?.areaId ?? null, reason: result.reason };
}
