import { describe, expect, it } from 'vitest';
import {
  ONE_LOD_TREE_TILESET_FILE,
  oneLodTreeBandForRatio,
  oneLodTreeCachePolicy,
  oneLodTreeDataset,
  oneLodTreePresetForPointBand,
  oneLodTreeSse,
  shouldTrimOneLodTree,
  tilesetEntryUrl,
} from './one-lod-tree';

describe('one-lod-tree helpers', () => {
  it('resolves the sidecar dataset and entry URL', () => {
    const dataset = oneLodTreeDataset('peru-b2-globe');
    expect(dataset).toBe('peru-b2-globe/peru-b2-globe-one-lod-tree');
    expect(tilesetEntryUrl('http://localhost:8081/', dataset, ONE_LOD_TREE_TILESET_FILE))
      .toBe('http://localhost:8081/peru-b2-globe/peru-b2-globe-one-lod-tree/tileset-one-lod-tree.json');
  });

  it('keeps the conventional tileset filename as the default', () => {
    expect(tilesetEntryUrl('http://localhost:8081', 'autzen'))
      .toBe('http://localhost:8081/autzen/tileset.json');
  });

  it('maps presets to progressively finer SSE without reloading', () => {
    expect(oneLodTreeSse('low')).toBe(256);
    expect(oneLodTreeSse('medium')).toBe(124);
    expect(oneLodTreeSse('high')).toBe(96);
  });

  it('maps camera point-size bands to one-lod-tree presets', () => {
    expect(oneLodTreePresetForPointBand('far')).toBe('low');
    expect(oneLodTreePresetForPointBand('medium')).toBe('medium');
    expect(oneLodTreePresetForPointBand('near')).toBe('high');
  });

  it('keeps one-lod-tree Detail SSE closer than the data request volume', () => {
    expect(oneLodTreeBandForRatio(2.6, null)).toBe('far');
    expect(oneLodTreeBandForRatio(0.47, null)).toBe('medium');
    expect(oneLodTreeBandForRatio(0.35, null)).toBe('near');
  });

  it('keeps cache headroom and trims when returning from a finer preset', () => {
    expect(oneLodTreeCachePolicy('low')).toEqual({
      cacheBytes: 256 * 1024 * 1024,
      maximumCacheOverflowBytes: 128 * 1024 * 1024,
      trimOnEnter: true,
    });
    expect(oneLodTreeCachePolicy('medium')).toEqual({
      cacheBytes: 512 * 1024 * 1024,
      maximumCacheOverflowBytes: 256 * 1024 * 1024,
      trimOnEnter: false,
    });
    expect(oneLodTreeCachePolicy('high')).toEqual({
      cacheBytes: 768 * 1024 * 1024,
      maximumCacheOverflowBytes: 512 * 1024 * 1024,
      trimOnEnter: false,
    });
  });

  it('trims only when returning from Explore or Detail to Overview', () => {
    expect(shouldTrimOneLodTree('medium', 'low')).toBe(true);
    expect(shouldTrimOneLodTree('high', 'low')).toBe(true);
    expect(shouldTrimOneLodTree('low', 'low')).toBe(false);
    expect(shouldTrimOneLodTree('low', 'medium')).toBe(false);
    expect(shouldTrimOneLodTree('medium', 'high')).toBe(false);
  });

  it('rejects traversal and non-JSON entry filenames', () => {
    expect(() => tilesetEntryUrl('http://localhost:8081', '../secret')).toThrow(/dataset path/);
    expect(() => tilesetEntryUrl('http://localhost:8081', 'safe', '../tileset.json')).toThrow(/filename/);
  });
});
