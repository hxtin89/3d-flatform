// presets.ts — Quality preset definitions for CesiumJS point cloud rendering
import * as Cesium from 'cesium';

export type PresetName = 'low' | 'medium' | 'high';
export type PresetVariant = 'local' | 'globe';

export interface PresetConfig {
  name: PresetName;
  label: string;
  userMode: 'Overview' | 'Explore' | 'Detail';
  dataDensity: 'p02' | 'p10' | 'full';
  renderQuality: 'low' | 'medium' | 'high-safe';
  maximumScreenSpaceError: number;
  /** In bytes — replaces deprecated maximumMemoryUsage */
  cacheBytes: number;
  maximumCacheOverflowBytes: number;
  attenuation: boolean;
  geometricErrorScale: number;
  maximumAttenuation: number;
  description: string;
}

export const PRESETS: Record<PresetName, PresetConfig> = {
  low: {
    name: 'low',
    label: 'Overview',
    userMode: 'Overview',
    dataDensity: 'p02',
    renderQuality: 'low',
    maximumScreenSpaceError: 64,
    cacheBytes: 256 * 1024 * 1024,           // 256 MB
    maximumCacheOverflowBytes: 128 * 1024 * 1024,
    attenuation: false,
    geometricErrorScale: 1.0,
    maximumAttenuation: 4,
    description: 'Whole-site overview using the lightest data and render budget.',
  },
  medium: {
    name: 'medium',
    label: 'Explore',
    userMode: 'Explore',
    dataDensity: 'p10',
    renderQuality: 'medium',
    maximumScreenSpaceError: 32,
    cacheBytes: 512 * 1024 * 1024,           // 512 MB
    maximumCacheOverflowBytes: 256 * 1024 * 1024,
    attenuation: false,
    geometricErrorScale: 1.0,
    maximumAttenuation: 8,
    description: 'Area exploration with a balanced data and render budget.',
  },
  high: {
    name: 'high',
    label: 'Detail',
    userMode: 'Detail',
    dataDensity: 'full',
    renderQuality: 'high-safe',
    maximumScreenSpaceError: 64,
    cacheBytes: 768 * 1024 * 1024,           // 768 MB
    maximumCacheOverflowBytes: 512 * 1024 * 1024,
    attenuation: false,
    geometricErrorScale: 1.0,
    maximumAttenuation: 16,
    description: 'Selected-area detail with a bounded high-quality budget.',
  },
};

export const GLOBE_PRESETS: Partial<Record<PresetName, PresetConfig>> = {
  low: {
    ...PRESETS.low,
    maximumScreenSpaceError: 128,
    description: 'Globe overview tuned for ~3–5M visible points (SSE 128).',
  },
  high: {
    ...PRESETS.high,
    maximumScreenSpaceError: 256,
    description: 'Selected-area detail using a higher SSE budget for Earth-scale framing.',
  },
};

export function applyPreset(
  tileset: Cesium.Cesium3DTileset,
  presetName: PresetName,
  overrides: { maximumScreenSpaceError?: number } = {},
  options: { variant?: PresetVariant } = {}
): void {
  const preset = options.variant === 'globe'
    ? GLOBE_PRESETS[presetName] ?? PRESETS[presetName]
    : PRESETS[presetName];
    console.log('presetName', presetName);
    console.log('preset', preset);
  const maximumScreenSpaceError = overrides.maximumScreenSpaceError ?? preset.maximumScreenSpaceError;

  tileset.maximumScreenSpaceError = maximumScreenSpaceError;
  tileset.cacheBytes = preset.cacheBytes;
  tileset.maximumCacheOverflowBytes = preset.maximumCacheOverflowBytes;

  // Apply point cloud shading
  const shading = new Cesium.PointCloudShading({
    attenuation: preset.attenuation,
    geometricErrorScale: preset.geometricErrorScale,
    maximumAttenuation: preset.maximumAttenuation,
    eyeDomeLighting: preset.attenuation,
    eyeDomeLightingStrength: 1.0,
    eyeDomeLightingRadius: 1.0,
  });

  tileset.pointCloudShading = shading;

  console.log(
    `[Mode] Applied "${preset.userMode}": variant=${options.variant ?? 'local'}, density=${preset.dataDensity}, quality=${preset.renderQuality}, SSE=${maximumScreenSpaceError}, Cache=${preset.cacheBytes / 1024 / 1024}MB`
  );
}

/** Returns human-readable MB for display */
export function cacheBytesToMB(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

export type OverviewPointSizeBand = 'near' | 'medium' | 'far';

export const OVERVIEW_CACHE_BYTES = 512 * 1024 * 1024;
export const OVERVIEW_CACHE_OVERFLOW_BYTES = 256 * 1024 * 1024;
export const OVERVIEW_POINT_SIZE_SCALE_MIN = 0.5;
export const OVERVIEW_POINT_SIZE_SCALE_MAX = 2;
export const OVERVIEW_POINT_SIZE_SCALE_STEP = 0.25;
export const OVERVIEW_POINT_SIZE_SCALE_DEFAULT = 0.5;
export const OVERVIEW_POINT_SIZE_PX_MIN = 0.5;
export const OVERVIEW_POINT_SIZE_PX_MAX = 6;

// Khuyen nghi
//OVERVIEW_SSE_BOOTSTRAP = 64; // vì coarse có content
//OVERVIEW_SSE_TRAVEL = 256;   // chỉ fly xa / cache miss lớn
//OVERVIEW_SSE_READY = 128;    // default cân bằng

export const OVERVIEW_SSE_BOOTSTRAP = 96;
export const OVERVIEW_SSE_TRAVEL = 256;
export const OVERVIEW_SSE_READY = 96;
export const OVERVIEW_SSE_BOOTSTRAP_TIMEOUT_MS = 2500;
export const OVERVIEW_SSE_TRAVEL_SETTLE_MS = 750;
export const OVERVIEW_TRAVEL_DISTANCE_THRESHOLD_M = 10_000; // 10 km

const OVERVIEW_BAND_NEAR_MEDIUM = 0.75;
const OVERVIEW_BAND_MEDIUM_FAR = 2.5;
const OVERVIEW_BAND_HYSTERESIS = 0.1;

export function overviewBandForRatio(
  ratio: number,
  currentBand: OverviewPointSizeBand | null
): OverviewPointSizeBand {
  if (currentBand === null) {
    if (ratio <= OVERVIEW_BAND_NEAR_MEDIUM) return 'near';
    if (ratio <= OVERVIEW_BAND_MEDIUM_FAR) return 'medium';
    return 'far';
  }
  const upNearMedium = OVERVIEW_BAND_NEAR_MEDIUM * (1 + OVERVIEW_BAND_HYSTERESIS);
  const downNearMedium = OVERVIEW_BAND_NEAR_MEDIUM * (1 - OVERVIEW_BAND_HYSTERESIS);
  const upMediumFar = OVERVIEW_BAND_MEDIUM_FAR * (1 + OVERVIEW_BAND_HYSTERESIS);
  const downMediumFar = OVERVIEW_BAND_MEDIUM_FAR * (1 - OVERVIEW_BAND_HYSTERESIS);
  switch (currentBand) {
    case 'near':
      if (ratio > upMediumFar) return 'far';
      if (ratio > upNearMedium) return 'medium';
      return 'near';
    case 'medium':
      if (ratio < downNearMedium) return 'near';
      if (ratio > upMediumFar) return 'far';
      return 'medium';
    case 'far':
      if (ratio < downNearMedium) return 'near';
      if (ratio < downMediumFar) return 'medium';
      return 'far';
  }
}

export function overviewBasePointSize(band: OverviewPointSizeBand): number {
  switch (band) {
    case 'near':
      return 1;
    case 'medium':
      return 2;
    case 'far':
      return 3;
  }
}

export function clampOverviewPointSizeScale(scale: number): number {
  if (!Number.isFinite(scale)) return OVERVIEW_POINT_SIZE_SCALE_DEFAULT;
  const snapped = Math.round(scale / OVERVIEW_POINT_SIZE_SCALE_STEP) * OVERVIEW_POINT_SIZE_SCALE_STEP;
  return Cesium.Math.clamp(
    Number(snapped.toFixed(2)),
    OVERVIEW_POINT_SIZE_SCALE_MIN,
    OVERVIEW_POINT_SIZE_SCALE_MAX
  );
}

export function clampOverviewPointSizePx(px: number): number {
  return Cesium.Math.clamp(px, OVERVIEW_POINT_SIZE_PX_MIN, OVERVIEW_POINT_SIZE_PX_MAX);
}

export function createOverviewPointSizeStyle(pointSizePx: number): Cesium.Cesium3DTileStyle {
  return new Cesium.Cesium3DTileStyle({ pointSize: pointSizePx });
}

export interface OverviewRuntimeTuningOptions {
  pointSizePx: number;
}

export function applyOverviewRuntimeTuning(
  tileset: Cesium.Cesium3DTileset,
  options: OverviewRuntimeTuningOptions
): void {
  tileset.cacheBytes = OVERVIEW_CACHE_BYTES;
  tileset.maximumCacheOverflowBytes = OVERVIEW_CACHE_OVERFLOW_BYTES;
  const shading = tileset.pointCloudShading;
  if (shading) {
    shading.attenuation = false;
    shading.eyeDomeLighting = false;
  }
  tileset.style = createOverviewPointSizeStyle(options.pointSizePx);
}
