import { PRESETS, type OverviewPointSizeBand, type PresetName } from './presets';

export const ONE_LOD_TREE_TILESET_FILE = 'tileset-one-lod-tree.json';

export const ONE_LOD_TREE_SSE: Readonly<Record<PresetName, number>> = {
  low: 512,
  medium: 128,
  high: 64,
};

const SAFE_TILESET_FILE = /^[a-zA-Z0-9_-]+\.json$/;
const ONE_LOD_TREE_BAND_NEAR_MEDIUM = 0.20;
const ONE_LOD_TREE_BAND_MEDIUM_FAR = 1.0;
const ONE_LOD_TREE_BAND_HYSTERESIS = 0.1;

export function oneLodTreeDataset(logicalDataset: string): string {
  return `${logicalDataset}/${logicalDataset}-one-lod-tree`;
}

export function oneLodTreeSse(preset: PresetName): number {
  return ONE_LOD_TREE_SSE[preset];
}

export function oneLodTreeBandForRatio(
  ratio: number,
  currentBand: OverviewPointSizeBand | null
): OverviewPointSizeBand {
  if (currentBand === null) {
    if (ratio <= ONE_LOD_TREE_BAND_NEAR_MEDIUM) return 'near';
    if (ratio <= ONE_LOD_TREE_BAND_MEDIUM_FAR) return 'medium';
    return 'far';
  }
  const upNearMedium = ONE_LOD_TREE_BAND_NEAR_MEDIUM * (1 + ONE_LOD_TREE_BAND_HYSTERESIS);
  const downNearMedium = ONE_LOD_TREE_BAND_NEAR_MEDIUM * (1 - ONE_LOD_TREE_BAND_HYSTERESIS);
  const upMediumFar = ONE_LOD_TREE_BAND_MEDIUM_FAR * (1 + ONE_LOD_TREE_BAND_HYSTERESIS);
  const downMediumFar = ONE_LOD_TREE_BAND_MEDIUM_FAR * (1 - ONE_LOD_TREE_BAND_HYSTERESIS);
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

export function oneLodTreePresetForPointBand(
  band: OverviewPointSizeBand
): PresetName {
  switch (band) {
    case 'near':
      return 'high';
    case 'medium':
      return 'medium';
    case 'far':
      return 'low';
  }
}

export interface OneLodTreeCachePolicy {
  cacheBytes: number;
  maximumCacheOverflowBytes: number;
  trimOnEnter: boolean;
}

/**
 * Explore and Detail keep their normal cache headroom for smooth navigation.
 * Overview keeps overflow headroom so Cesium does not oscillate its
 * memory-adjusted SSE when the base cache is full.
 */
export function oneLodTreeCachePolicy(preset: PresetName): OneLodTreeCachePolicy {
  const config = PRESETS[preset];
  return {
    cacheBytes: config.cacheBytes,
    maximumCacheOverflowBytes: config.maximumCacheOverflowBytes,
    trimOnEnter: preset === 'low',
  };
}

/** Trim finer cached tiles only when actually returning to Overview. */
export function shouldTrimOneLodTree(
  previousPreset: PresetName,
  nextPreset: PresetName
): boolean {
  return previousPreset !== 'low' && oneLodTreeCachePolicy(nextPreset).trimOnEnter;
}

export function tilesetEntryUrl(
  baseUrl: string,
  dataset: string,
  tilesetFile = 'tileset.json'
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
