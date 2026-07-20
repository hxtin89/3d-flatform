export type AdaptivePointHierarchyVrv = 'none' | 'frontier-tight';
export type AdaptivePointHierarchyControllerMode = 'simple' | 'advanced';
export type AphCameraPhase = 'FAR' | 'APPROACH' | 'MOVING_DETAIL' | 'DETAIL_WARMUP' | 'DETAIL_READY';
export type AphPressureLevel = 'NONE' | 'MODERATE' | 'HIGH';
export type AdaptivePointHierarchyRenderProfile = 'balanced' | 'raw';

export interface AdaptivePointHierarchyNodeId {
  z0Id: string;
  depth: number;
  quadrantPath: string;
}

export interface AdaptivePointHierarchyDepthStats {
  p001: number;
  byDepth: Record<number, number>;
  unclassified: number;
}

export interface AdaptivePointHierarchyRenderSettings {
  profile: AdaptivePointHierarchyRenderProfile;
  attenuation: boolean;
  geometricErrorScale: number;
  maximumAttenuation: number;
  eyeDomeLighting: boolean;
  eyeDomeLightingStrength: number;
  eyeDomeLightingRadius: number;
}

export interface AphNodeDiagnostics {
  nodeId: string;
  depth: number | 'p001';
  kind: 'internal' | 'leaf' | 'leaf_max_depth' | 'p001';
  emittedPointCount: number;
  inputPointCount: number;
  representativePointCount?: number;
  residualRoutedPointCount?: number;
  extentMeters?: { width: number | null; height: number | null; zSpan: number | null };
  bboxDensityPointsPerSquareMeter?: number | null;
  bboxAreaClamped?: boolean | null;
  underfilledReason?: string | null;
}

export interface AphDiagnosticsResolution {
  diagnostics: AphNodeDiagnostics | null;
  source: 'runtime-extras' | 'metadata-map' | 'unavailable';
  reason?: 'missing-uri' | 'missing-metadata';
}

export interface AdaptivePointHierarchyTuning {
  farSse: number;
  approachRangeMeters: number;
  approachSse: number;
  detailSse: number;
}

const Z0_PATTERN = /^z0_x\d{6}_y\d{6}$/;
const ADAPTIVE_NODE_PATTERN = /(?:^|\/)adaptive\/(z0_x\d{6}_y\d{6})\/d(\d+)_q([0-3]*)\.pnts(?:[?#].*)?$/;

export const ADAPTIVE_POINT_HIERARCHY_CACHE_BYTES = 1_024 * 1024 * 1024;
export const ADAPTIVE_POINT_HIERARCHY_CACHE_OVERFLOW_BYTES = 512 * 1024 * 1024;
export const ADAPTIVE_POINT_HIERARCHY_SSE = 16;
export const ADAPTIVE_POINT_HIERARCHY_MIN_CAMERA_DISTANCE_METERS = 20;
export const ADAPTIVE_POINT_HIERARCHY_SSE_LADDER = [4, 8, 12, 16, 24, 32, 48, 64] as const;
export const ADAPTIVE_POINT_HIERARCHY_SIMPLE_SSE = 4;
export const APH_DETAIL_RANGE_METERS = 250;
export const APH_APPROACH_RANGE_METERS = 3_000;
export const APH_APPROACH_SSE = 8;
export const DEFAULT_ADAPTIVE_POINT_HIERARCHY_TUNING: AdaptivePointHierarchyTuning = {
  farSse: 16,
  approachRangeMeters: APH_APPROACH_RANGE_METERS,
  approachSse: APH_APPROACH_SSE,
  detailSse: 4,
};
export const APH_WARMUP_MS = 250;
export const APH_PRESSURE_MODERATE_MS = 500;
export const APH_PRESSURE_HIGH_FRAME_MS = 300;
export const APH_PRESSURE_RECOVERY_MS = 1_000;

// 250–1000 m → APPROACH, SSE 8, detailEligible=false
// ≤250 m     → DETAIL_WARMUP → DETAIL_READY, SSE 4
// >1000 m    → FAR, SSE 16

export const ADAPTIVE_POINT_HIERARCHY_STREAMING_OPTIONS = {
  skipLevelOfDetail: true,
  baseScreenSpaceError: 1_024,
  skipScreenSpaceErrorFactor: 16,
  skipLevels: 1,
  immediatelyLoadDesiredLevelOfDetail: false,
  loadSiblings: false,
  preferLeaves: true,
  foveatedScreenSpaceError: true,
  foveatedConeSize: 0.2,
  foveatedMinimumScreenSpaceErrorRelaxation: 4,
  foveatedTimeDelay: 0.2,
  cullRequestsWhileMoving: true,
  cullRequestsWhileMovingMultiplier: 120,
} as const;

/** Cesium's normal hierarchical traversal; no APH controller gates. */
export const ADAPTIVE_POINT_HIERARCHY_SIMPLE_TRAVERSAL = {
  skipLevelOfDetail: false,
  preferLeaves: false,
  foveatedScreenSpaceError: false,
  cullRequestsWhileMoving: false,
  immediatelyLoadDesiredLevelOfDetail: false,
} as const;

export interface AdaptivePointHierarchyBudgetMetrics {
  now: number;
  selectedPoints: number | null;
  frameTimeEmaMs: number | null;
  memoryBytes: number | null;
  cameraRangeMeters: number;
  intersectsFrontierVrv: boolean;
  cameraMoving: boolean;
  cameraIdleMs: number;
  refinementCycleId: number;
  warmupImmediateLoadSuppressed: boolean;
}

export interface AdaptivePointHierarchyDecision {
  cameraPhase: AphCameraPhase;
  pressureLevel: AphPressureLevel;
  effectiveSse: number;
  detailEligible: boolean;
  skipLevelOfDetail: boolean;
  preferLeaves: boolean;
  foveatedScreenSpaceError: boolean;
  foveatedConeSize: number;
  foveatedMinimumScreenSpaceErrorRelaxation: number;
  foveatedTimeDelay: number;
  cullRequestsWhileMoving: boolean;
  immediatelyLoadDesiredLevelOfDetail: boolean;
}

export function adaptivePointHierarchyDataset(logicalDataset: string): string {
  return `${logicalDataset}/${logicalDataset}-adaptive-point-hierarchy`;
}

export function adaptivePointHierarchyInitialSse(rangeMeters: number): number {
  if (rangeMeters <= 250) return 4;
  if (rangeMeters <= 500) return 8;
  if (rangeMeters <= 1_000) return 12;
  if (rangeMeters <= 2_000) return 16;
  return 32;
}

export function adaptivePointHierarchyDetailEligible(
  cameraRangeMeters: number,
  vrv: AdaptivePointHierarchyVrv,
  intersectsFrontierVrv: boolean
): boolean {
  return cameraRangeMeters <= APH_DETAIL_RANGE_METERS || (vrv === 'frontier-tight' && intersectsFrontierVrv);
}

export function normalizeAdaptivePointHierarchyTuning(
  tuning: Partial<AdaptivePointHierarchyTuning>
): AdaptivePointHierarchyTuning {
  const validSse = (value: number | undefined, fallback: number): number => (
    typeof value === 'number' && ADAPTIVE_POINT_HIERARCHY_SSE_LADDER.includes(
      value as typeof ADAPTIVE_POINT_HIERARCHY_SSE_LADDER[number]
    )
      ? value
      : fallback
  );
  const requestedApproachRange = tuning.approachRangeMeters;
  const approachRangeMeters = typeof requestedApproachRange === 'number' && Number.isFinite(requestedApproachRange)
    ? Math.min(Math.max(Math.round(requestedApproachRange), APH_DETAIL_RANGE_METERS), 50_000)
    : DEFAULT_ADAPTIVE_POINT_HIERARCHY_TUNING.approachRangeMeters;
  return {
    farSse: validSse(tuning.farSse, DEFAULT_ADAPTIVE_POINT_HIERARCHY_TUNING.farSse),
    approachRangeMeters,
    approachSse: validSse(tuning.approachSse, DEFAULT_ADAPTIVE_POINT_HIERARCHY_TUNING.approachSse),
    detailSse: validSse(tuning.detailSse, DEFAULT_ADAPTIVE_POINT_HIERARCHY_TUNING.detailSse),
  };
}

export function normalizeAdaptivePointHierarchySimpleSse(value: number | undefined): number {
  return typeof value === 'number' && ADAPTIVE_POINT_HIERARCHY_SSE_LADDER.includes(
    value as typeof ADAPTIVE_POINT_HIERARCHY_SSE_LADDER[number]
  )
    ? value
    : ADAPTIVE_POINT_HIERARCHY_SIMPLE_SSE;
}

export function parseAdaptivePointHierarchyRenderProfile(value: string | null): AdaptivePointHierarchyRenderProfile {
  return value === 'raw' ? 'raw' : 'balanced';
}

export function clampAdaptivePointHierarchyRenderValue(
  value: string | null,
  fallback: number,
  min: number,
  max: number
): number {
  if (value === null || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function adaptivePointHierarchyRenderSettings(
  profile: AdaptivePointHierarchyRenderProfile,
  maxAttenuation: string | null,
  edlStrength: string | null,
  edlRadius: string | null
): AdaptivePointHierarchyRenderSettings {
  if (profile === 'raw') {
    return {
      profile,
      attenuation: false,
      geometricErrorScale: 1,
      maximumAttenuation: 1,
      eyeDomeLighting: false,
      eyeDomeLightingStrength: 0,
      eyeDomeLightingRadius: 1,
    };
  }
  return {
    profile,
    attenuation: true,
    geometricErrorScale: 1,
    maximumAttenuation: clampAdaptivePointHierarchyRenderValue(maxAttenuation, 1.5, 1, 2),
    eyeDomeLighting: true,
    eyeDomeLightingStrength: clampAdaptivePointHierarchyRenderValue(edlStrength, 0.3, 0, 1),
    eyeDomeLightingRadius: clampAdaptivePointHierarchyRenderValue(edlRadius, 1, 0.5, 2),
  };
}

export class AdaptivePointHierarchyController {
  private cameraPhase: AphCameraPhase = 'FAR';
  private pressureLevel: AphPressureLevel = 'NONE';
  private warmupCycleId: number | null = null;
  private moderateSignalSince: number | null = null;
  private highSignalSince: number | null = null;
  private recoverySince: number | null = null;
  private tuning: AdaptivePointHierarchyTuning;

  constructor(
    _initialRangeMeters: number,
    private readonly vrv: AdaptivePointHierarchyVrv,
    tuning: Partial<AdaptivePointHierarchyTuning> = DEFAULT_ADAPTIVE_POINT_HIERARCHY_TUNING
  ) {
    this.tuning = normalizeAdaptivePointHierarchyTuning(tuning);
  }

  setTuning(tuning: Partial<AdaptivePointHierarchyTuning>): AdaptivePointHierarchyTuning {
    this.tuning = normalizeAdaptivePointHierarchyTuning(tuning);
    return { ...this.tuning };
  }

  getTuning(): AdaptivePointHierarchyTuning {
    return { ...this.tuning };
  }

  update(metrics: AdaptivePointHierarchyBudgetMetrics): AdaptivePointHierarchyDecision {
    const detailEligible = adaptivePointHierarchyDetailEligible(
      metrics.cameraRangeMeters,
      this.vrv,
      metrics.intersectsFrontierVrv
    );
    this.updatePressure(metrics);

    if (!detailEligible) {
      this.cameraPhase = metrics.cameraRangeMeters <= this.tuning.approachRangeMeters
        ? 'APPROACH'
        : 'FAR';
      this.warmupCycleId = null;
    } else if (metrics.cameraMoving) {
      this.cameraPhase = 'MOVING_DETAIL';
      this.warmupCycleId = null;
    } else if (this.warmupCycleId !== metrics.refinementCycleId) {
      this.cameraPhase = 'DETAIL_WARMUP';
      this.warmupCycleId = metrics.refinementCycleId;
    } else if (
      this.cameraPhase === 'DETAIL_WARMUP' &&
      metrics.cameraIdleMs >= APH_WARMUP_MS &&
      this.pressureLevel === 'NONE'
    ) {
      this.cameraPhase = 'DETAIL_READY';
    }

    const baseSse = this.cameraPhase === 'FAR'
      ? this.tuning.farSse
      : this.cameraPhase === 'DETAIL_READY'
        ? this.tuning.detailSse
        : this.tuning.approachSse;
    const pressureFloor = this.pressureLevel === 'HIGH'
      ? 12
      : this.pressureLevel === 'MODERATE'
        ? 8
        : 0;
    const detailTraversal = this.cameraPhase === 'DETAIL_WARMUP' || this.cameraPhase === 'DETAIL_READY';
    const immediate = this.cameraPhase === 'DETAIL_WARMUP'
      && this.pressureLevel === 'NONE'
      && !metrics.warmupImmediateLoadSuppressed;

    return {
      cameraPhase: this.cameraPhase,
      pressureLevel: this.pressureLevel,
      effectiveSse: Math.max(baseSse, pressureFloor),
      detailEligible,
      skipLevelOfDetail: !detailTraversal,
      preferLeaves: !detailTraversal,
      foveatedScreenSpaceError: !detailTraversal,
      foveatedConeSize: detailTraversal ? 1 : 0.2,
      foveatedMinimumScreenSpaceErrorRelaxation: detailTraversal ? 0 : 4,
      foveatedTimeDelay: detailTraversal ? 0 : 0.2,
      cullRequestsWhileMoving: !detailTraversal,
      immediatelyLoadDesiredLevelOfDetail: immediate,
    };
  }

  private updatePressure(metrics: AdaptivePointHierarchyBudgetMetrics): void {
    const moderateSignal = (
      (metrics.selectedPoints !== null && metrics.selectedPoints > 15_000_000) ||
      (metrics.memoryBytes !== null && metrics.memoryBytes > 1_024 * 1024 * 1024) ||
      (metrics.frameTimeEmaMs !== null && metrics.frameTimeEmaMs > 50)
    );
    const highSignal = (
      (metrics.selectedPoints !== null && metrics.selectedPoints > 20_000_000) ||
      (metrics.memoryBytes !== null && metrics.memoryBytes > 1.3 * 1024 * 1024 * 1024) ||
      (metrics.frameTimeEmaMs !== null && metrics.frameTimeEmaMs > 80)
    );
    this.moderateSignalSince = moderateSignal ? (this.moderateSignalSince ?? metrics.now) : null;
    this.highSignalSince = highSignal ? (this.highSignalSince ?? metrics.now) : null;

    if (this.highSignalSince !== null && metrics.now - this.highSignalSince >= APH_PRESSURE_HIGH_FRAME_MS) {
      this.pressureLevel = 'HIGH';
      this.recoverySince = null;
      return;
    }
    if (this.moderateSignalSince !== null && metrics.now - this.moderateSignalSince >= APH_PRESSURE_MODERATE_MS) {
      this.pressureLevel = 'MODERATE';
      this.recoverySince = null;
      return;
    }
    const recovered = (
      (metrics.selectedPoints === null || metrics.selectedPoints < 12_000_000) &&
      (metrics.memoryBytes === null || metrics.memoryBytes < 850 * 1024 * 1024) &&
      (metrics.frameTimeEmaMs === null || metrics.frameTimeEmaMs < 40)
    );
    this.recoverySince = recovered ? (this.recoverySince ?? metrics.now) : null;
    if (this.recoverySince !== null && metrics.now - this.recoverySince >= APH_PRESSURE_RECOVERY_MS) {
      this.pressureLevel = 'NONE';
    }
  }
}

export function parseAdaptivePointHierarchyVrv(value: string | null): AdaptivePointHierarchyVrv {
  return value === 'frontier-tight' ? 'frontier-tight' : 'none';
}

export function parseAdaptivePointHierarchyControllerMode(
  value: string | null
): AdaptivePointHierarchyControllerMode {
  return value === 'advanced' ? 'advanced' : 'simple';
}

export function parseAdaptivePointHierarchyPreviewZ0(value: string | null): string | null {
  return value && Z0_PATTERN.test(value) ? value : null;
}

export function adaptivePointHierarchyTilesetFile(
  previewZ0: string | null,
  vrv: AdaptivePointHierarchyVrv
): string {
  return previewZ0
    ? `tileset-preview-${previewZ0}-${vrv === 'none' ? 'no-vrv' : vrv}.json`
    : 'tileset.json';
}

export function adaptivePointHierarchyEntryUrl(
  baseUrl: string,
  dataset: string,
  tilesetFile: string
): string {
  return baseUrl ? `${baseUrl}/${dataset}/${tilesetFile}` : '';
}

export function parseAdaptivePointHierarchyNodeId(
  uri: string | null | undefined
): AdaptivePointHierarchyNodeId | null {
  if (!uri) return null;
  const match = uri.replace(/\\/g, '/').match(ADAPTIVE_NODE_PATTERN);
  if (!match) return null;
  return { z0Id: match[1], depth: Number(match[2]), quadrantPath: match[3] };
}

/**
 * Produces a stable PNTS identity without collapsing sibling z0 subtrees.
 * Resolved Cesium URLs are preferred by callers; unresolved relative paths
 * deliberately stay separate so they cannot alias an absolute resource.
 */
export function canonicalizeAdaptivePointHierarchyUri(uri: string, baseUrl?: string): string {
  const normalized = uri.replace(/\\/g, '/').split(/[?#]/, 1)[0] ?? '';
  if (!normalized) return 'relative:';
  try {
    const resolved = baseUrl ? new URL(normalized, baseUrl) : new URL(normalized);
    return resolved.pathname.replace(/\\/g, '/');
  } catch {
    return `relative:${normalized}`;
  }
}

export function resolveAdaptivePointHierarchyDiagnostics(
  runtimeExtras: unknown,
  canonicalUri: string | null,
  metadataByCanonicalUri: ReadonlyMap<string, AphNodeDiagnostics>
): AphDiagnosticsResolution {
  const aph = typeof runtimeExtras === 'object' && runtimeExtras !== null
    ? (runtimeExtras as { aph?: unknown }).aph
    : null;
  if (typeof aph === 'object' && aph !== null && typeof (aph as { nodeId?: unknown }).nodeId === 'string') {
    return { diagnostics: aph as AphNodeDiagnostics, source: 'runtime-extras' };
  }
  if (canonicalUri && metadataByCanonicalUri.has(canonicalUri)) {
    return { diagnostics: metadataByCanonicalUri.get(canonicalUri) ?? null, source: 'metadata-map' };
  }
  return {
    diagnostics: null,
    source: 'unavailable',
    reason: canonicalUri ? 'missing-metadata' : 'missing-uri',
  };
}

export function isAdaptivePointHierarchyP001(uri: string | null | undefined): boolean {
  return Boolean(uri && /(?:^|\/)z0\/z0_x\d{6}_y\d{6}\.pnts(?:[?#].*)?$/.test(uri));
}

export function emptyAdaptivePointHierarchyDepthStats(): AdaptivePointHierarchyDepthStats {
  return { p001: 0, byDepth: {}, unclassified: 0 };
}

export function classifyAdaptivePointHierarchyUri(
  stats: AdaptivePointHierarchyDepthStats,
  uri: string | null | undefined
): number | 'p001' | null {
  if (isAdaptivePointHierarchyP001(uri)) {
    stats.p001 += 1;
    return 'p001';
  }
  const node = parseAdaptivePointHierarchyNodeId(uri);
  if (!node) {
    stats.unclassified += 1;
    return null;
  }
  stats.byDepth[node.depth] = (stats.byDepth[node.depth] ?? 0) + 1;
  return node.depth;
}

export function formatAdaptivePointHierarchyDepthStats(
  stats: AdaptivePointHierarchyDepthStats
): string {
  const depths = Object.entries(stats.byDepth)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([depth, count]) => `d${depth}=${count}`);
  return [`p001=${stats.p001}`, ...depths, `other=${stats.unclassified}`].join(' ');
}
