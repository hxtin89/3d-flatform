import type { DetailContextMode } from './detail-context';

export type PerformanceGateStatus = 'ok' | 'degraded' | 'critical';

export interface LayerCounts {
  visibleP10LayerCount: number;
  residentP10TilesetCount: number;
  visibleP100LayerCount: number;
  residentP100TilesetCount: number;
}

export interface MemoryMetricsInput {
  baseShow: boolean;
  baseResidentMemoryBytes: number;
  baseSelectedTileBytes: number | null;
  detailResidentMemoryBytes: number;
  detailSelectedTileBytes: number | null;
}

export interface MemoryMetrics {
  baseResidentMemoryBytes: number;
  baseVisibleMemoryBytes: number | string;
  detailResidentMemoryBytes: number;
  detailVisibleMemoryBytes: number | string;
  combinedResidentMemoryBytes: number;
}

export interface RuntimeContentMemory {
  geometryByteLength?: number;
  texturesByteLength?: number;
  batchTableByteLength?: number;
  innerContents?: RuntimeContentMemory[];
}

export interface PerformanceBudget {
  maxResidentMemoryBytes: number;
  maxActiveTiles: number;
}

export const MICRO_ONLY_BUDGET: PerformanceBudget = {
  maxResidentMemoryBytes: 300 * 1024 * 1024,
  maxActiveTiles: 250,
};

export const MICRO_WITH_BASE_BUDGET: PerformanceBudget = {
  maxResidentMemoryBytes: 400 * 1024 * 1024,
  maxActiveTiles: 500,
};

export const DETAIL_TRANSITION_MEMORY_BUDGET_BYTES = 400 * 1024 * 1024;
export const DETAIL_TRANSITION_TIMEOUT_MS = 15_000;

export function computeLayerCounts(input: {
  baseTileset: unknown | null;
  baseShow: boolean;
  detailTileset: unknown | null;
  detailShow: boolean;
  candidateTileset: unknown | null;
}): LayerCounts {
  const residentP10 = input.baseTileset ? 1 : 0;
  const residentP100 =
    (input.detailTileset ? 1 : 0) + (input.candidateTileset ? 1 : 0);

  return {
    visibleP10LayerCount: input.baseTileset && input.baseShow ? 1 : 0,
    residentP10TilesetCount: residentP10,
    visibleP100LayerCount: input.detailTileset && input.detailShow ? 1 : 0,
    residentP100TilesetCount: residentP100,
  };
}

export function computeMemoryMetrics(input: MemoryMetricsInput): MemoryMetrics {
  const baseVisibleMemoryBytes = !input.baseShow
    ? 0
    : input.baseSelectedTileBytes ?? 'unsupported';
  const detailVisibleMemoryBytes = input.detailSelectedTileBytes ?? 'unsupported';

  return {
    baseResidentMemoryBytes: input.baseResidentMemoryBytes,
    baseVisibleMemoryBytes,
    detailResidentMemoryBytes: input.detailResidentMemoryBytes,
    detailVisibleMemoryBytes,
    combinedResidentMemoryBytes:
      input.baseResidentMemoryBytes + input.detailResidentMemoryBytes,
  };
}

export function contentMemoryBytes(content: RuntimeContentMemory | undefined): number | null {
  if (!content) return null;
  const ownValues = [
    content.geometryByteLength,
    content.texturesByteLength,
    content.batchTableByteLength,
  ];
  const hasOwnMetric = ownValues.some((value) => typeof value === 'number');
  let total = ownValues.reduce<number>(
    (sum, value) => sum + (typeof value === 'number' ? value : 0),
    0
  );
  let hasMetric = hasOwnMetric;

  for (const inner of content.innerContents ?? []) {
    const innerBytes = contentMemoryBytes(inner);
    if (innerBytes !== null) {
      total += innerBytes;
      hasMetric = true;
    }
  }
  return hasMetric ? total : null;
}

export function activeDatasetFragments(input: {
  resolvedDataset: string;
  contextDataset: string | null;
  baseDataset: string | null;
}): string[] {
  return [...new Set([
    input.resolvedDataset,
    input.contextDataset,
    input.baseDataset,
  ].filter((value): value is string => Boolean(value && value !== '—')))];
}

export function budgetForDetailContext(mode: DetailContextMode): PerformanceBudget {
  return mode === 'off' ? MICRO_ONLY_BUDGET : MICRO_WITH_BASE_BUDGET;
}

export function evaluatePerformanceGate(input: {
  detailContextMode: DetailContextMode;
  combinedResidentMemoryBytes: number;
  combinedActiveTiles: number | string;
}): {
  status: PerformanceGateStatus;
  failures: string[];
  suggestedContextMode: DetailContextMode | null;
  shouldHideBase: boolean;
} {
  const budget = budgetForDetailContext(input.detailContextMode);
  const failures: string[] = [];

  if (input.combinedResidentMemoryBytes > budget.maxResidentMemoryBytes) {
    failures.push(
      `resident_memory:${input.combinedResidentMemoryBytes}>${budget.maxResidentMemoryBytes}`
    );
  }
  if (
    typeof input.combinedActiveTiles === 'number' &&
    input.combinedActiveTiles > budget.maxActiveTiles
  ) {
    failures.push(
      `active_tiles:${input.combinedActiveTiles}>${budget.maxActiveTiles}`
    );
  }

  if (failures.length === 0) {
    return {
      status: 'ok',
      failures,
      suggestedContextMode: null,
      shouldHideBase: false,
    };
  }

  if (input.detailContextMode !== 'off') {
    return {
      status: 'degraded',
      failures,
      suggestedContextMode: 'off',
      shouldHideBase: false,
    };
  }

  return {
    status: 'critical',
    failures,
    suggestedContextMode: null,
    shouldHideBase: true,
  };
}

export function canReuseExploreBase(input: {
  fromExplore: boolean;
  exploreDataset: string;
  activeDataset: string;
  exploreTileset: unknown | null;
  detailMicroActive: boolean;
}): boolean {
  return (
    input.fromExplore &&
    Boolean(input.exploreTileset) &&
    input.activeDataset === input.exploreDataset &&
    !input.detailMicroActive
  );
}

export function shouldLazyLoadBase(mode: DetailContextMode, baseTileset: unknown | null): boolean {
  return (mode === 'dim' || mode === 'full') && !baseTileset;
}

export function assertBaseIdentity(
  baseTileset: unknown | null,
  exploreTileset: unknown | null
): void {
  if (baseTileset !== exploreTileset) {
    throw new Error('detailBaseTileset === exploreTileset invariant violated');
  }
}

export function evaluateZoomExitState(input: {
  armed: boolean;
  cameraRange: number;
  exitThreshold: number;
}): { armed: boolean; shouldExit: boolean } {
  if (input.cameraRange <= input.exitThreshold) {
    return { armed: true, shouldExit: false };
  }
  return { armed: input.armed, shouldExit: input.armed };
}
