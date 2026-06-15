// presets.ts — Quality preset definitions for CesiumJS point cloud rendering
import * as Cesium from 'cesium';

export type PresetName = 'low' | 'medium' | 'high';

export interface PresetConfig {
  name: PresetName;
  label: string;
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
    label: 'Low',
    maximumScreenSpaceError: 16,
    cacheBytes: 256 * 1024 * 1024,           // 256 MB
    maximumCacheOverflowBytes: 128 * 1024 * 1024,
    attenuation: false,
    geometricErrorScale: 1.0,
    maximumAttenuation: 4,
    description: 'Lower memory & quality. Best for weaker GPUs.',
  },
  medium: {
    name: 'medium',
    label: 'Medium',
    maximumScreenSpaceError: 8,
    cacheBytes: 512 * 1024 * 1024,           // 512 MB
    maximumCacheOverflowBytes: 256 * 1024 * 1024,
    attenuation: false,
    geometricErrorScale: 1.0,
    maximumAttenuation: 8,
    description: 'Balanced quality and performance. Default.',
  },
  high: {
    name: 'high',
    label: 'High',
    maximumScreenSpaceError: 2,
    cacheBytes: 1024 * 1024 * 1024,          // 1 GB
    maximumCacheOverflowBytes: 512 * 1024 * 1024,
    attenuation: false,
    geometricErrorScale: 1.0,
    maximumAttenuation: 16,
    description: 'Maximum visual quality. Requires more GPU memory.',
  },
};

export function applyPreset(
  tileset: Cesium.Cesium3DTileset,
  presetName: PresetName
): void {
  const preset = PRESETS[presetName];

  tileset.maximumScreenSpaceError = preset.maximumScreenSpaceError;
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
    `[Preset] Applied "${preset.name}": SSE=${preset.maximumScreenSpaceError}, Cache=${preset.cacheBytes / 1024 / 1024}MB, Attenuation=${preset.attenuation}`
  );
}

/** Returns human-readable MB for display */
export function cacheBytesToMB(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}
