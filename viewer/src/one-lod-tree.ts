import { PRESETS, type PresetName } from './presets';

export const ONE_LOD_TREE_TILESET_FILE = 'tileset-one-lod-tree.json';

export const ONE_LOD_TREE_SSE: Readonly<Record<PresetName, number>> = {
  low: 512,
  medium: 256,
  high: 128,
};

const SAFE_TILESET_FILE = /^[a-zA-Z0-9_-]+\.json$/;

export function oneLodTreeDataset(logicalDataset: string): string {
  return `${logicalDataset}/${logicalDataset}-one-lod-tree`;
}

export function oneLodTreeSse(preset: PresetName): number {
  return ONE_LOD_TREE_SSE[preset];
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
