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

  const scores = new Map<string, {
    area: AreaManifestEntry;
    score: number;
    matchedSampleCount: number;
    zMatchCount: number;
    maxWeight: number;
    footprintArea: number;
  }>();

  let matchedSampleCount = 0;

  for (const sample of samples) {
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
