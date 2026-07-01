// presets.ts — Quality preset definitions for CesiumJS point cloud rendering
import * as Cesium from 'cesium';

export type PresetName = 'low' | 'medium' | 'high';
export type PresetVariant = 'local' | 'globe';
export type DetailScope = 'none' | 'legacy-area' | 'micro';

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
    description: 'Globe overview using a higher SSE budget for Earth-scale framing.',
  },
  high: {
    ...PRESETS.high,
    maximumScreenSpaceError: 128,
    description: 'Selected-area detail using a higher SSE budget for Earth-scale framing.',
  },
};

export const MICRO_DETAIL_PRESET: PresetConfig = {
  ...PRESETS.high,
  maximumScreenSpaceError: 128,
  cacheBytes: 256 * 1024 * 1024,
  maximumCacheOverflowBytes: 64 * 1024 * 1024,
  description: 'Exact p100 micro-area detail with bounded cache and SSE 128.',
};

export function presetFor(
  presetName: PresetName,
  options: { variant?: PresetVariant; detailScope?: DetailScope } = {}
): PresetConfig {
  if (presetName === 'high' && options.detailScope === 'micro') return MICRO_DETAIL_PRESET;
  return options.variant === 'globe'
    ? GLOBE_PRESETS[presetName] ?? PRESETS[presetName]
    : PRESETS[presetName];
}

export function applyPreset(
  tileset: Cesium.Cesium3DTileset,
  presetName: PresetName,
  overrides: { maximumScreenSpaceError?: number } = {},
  options: { variant?: PresetVariant; detailScope?: DetailScope } = {}
): void {
  const preset = presetFor(presetName, options);
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
    `[Mode] Applied "${preset.userMode}": variant=${options.variant ?? 'local'}, scope=${options.detailScope ?? 'none'}, density=${preset.dataDensity}, quality=${preset.renderQuality}, SSE=${maximumScreenSpaceError}, Cache=${preset.cacheBytes / 1024 / 1024}MB`
  );
}

/** Returns human-readable MB for display */
export function cacheBytesToMB(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}
