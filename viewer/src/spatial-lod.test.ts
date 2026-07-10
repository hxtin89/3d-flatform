import { describe, expect, it } from 'vitest';
import {
  SPATIAL_LOD_TILESET_FILE,
  SPATIAL_LOD_STREAMING_OPTIONS,
  classifySpatialLodTileUri,
  countSpatialLodPntsUrls,
  emptySpatialLodLevelStats,
  extractTileContentUri,
  formatSpatialLodActiveTileSamples,
  formatSpatialLodLevelStats,
  parseSpatialLodTileId,
  shouldTrimSpatialLod,
  spatialLodCachePolicy,
  spatialLodDataset,
  spatialLodEntryUrl,
  spatialLodOverviewRuntimePolicy,
  spatialLodPanScaleMetersPerPixel,
  spatialLodSse,
} from './spatial-lod';

describe('spatial-lod helpers', () => {
  it('resolves the spatial-lod dataset and entry URL', () => {
    const dataset = spatialLodDataset('peru-b2-globe');
    expect(dataset).toBe('peru-b2-globe/peru-b2-globe-spatial-lod');
    expect(spatialLodEntryUrl('http://localhost:8081/', dataset, SPATIAL_LOD_TILESET_FILE))
      .toBe('http://localhost:8081/peru-b2-globe/peru-b2-globe-spatial-lod/tileset.json');
  });

  it('uses tileset.json as the entry filename by default', () => {
    expect(spatialLodEntryUrl('http://localhost:8081', 'autzen'))
      .toBe('http://localhost:8081/autzen/tileset.json');
  });

  it('maps presets to spatial SSE 1024/256/128', () => {
    expect(spatialLodSse('low')).toBe(1024);
    expect(spatialLodSse('medium')).toBe(256);
    expect(spatialLodSse('high')).toBe(128);
  });

  it('streams desired z4 leaves progressively without loading siblings', () => {
    expect(SPATIAL_LOD_STREAMING_OPTIONS).toMatchObject({
      skipLevelOfDetail: true,
      immediatelyLoadDesiredLevelOfDetail: false,
      loadSiblings: false,
      preferLeaves: true,
      foveatedConeSize: 0.25,
      foveatedMinimumScreenSpaceErrorRelaxation: 64,
      foveatedTimeDelay: 0.2,
      cullRequestsWhileMovingMultiplier: 120,
    });
  });

  it('keeps cache headroom and trims when returning to Overview', () => {
    expect(spatialLodCachePolicy('low')).toEqual({
      cacheBytes: 256 * 1024 * 1024,
      maximumCacheOverflowBytes: 128 * 1024 * 1024,
      trimOnEnter: true,
    });
    expect(spatialLodCachePolicy('medium')).toEqual({
      cacheBytes: 512 * 1024 * 1024,
      maximumCacheOverflowBytes: 256 * 1024 * 1024,
      trimOnEnter: false,
    });
    expect(spatialLodCachePolicy('high')).toEqual({
      cacheBytes: 768 * 1024 * 1024,
      maximumCacheOverflowBytes: 512 * 1024 * 1024,
      trimOnEnter: false,
    });
  });

  it('trims only when returning from Explore or Detail to Overview', () => {
    expect(shouldTrimSpatialLod('medium', 'low')).toBe(true);
    expect(shouldTrimSpatialLod('high', 'low')).toBe(true);
    expect(shouldTrimSpatialLod('low', 'low')).toBe(false);
    expect(shouldTrimSpatialLod('low', 'medium')).toBe(false);
    expect(shouldTrimSpatialLod('medium', 'high')).toBe(false);
  });

  it('uses Detail SSE for the nearest Overview runtime band', () => {
    expect(spatialLodOverviewRuntimePolicy(1)).toMatchObject({
      level: 'z4',
      sse: 64,
      cacheBytes: 2_048 * 1024 * 1024,
      maximumCacheOverflowBytes: 1_024 * 1024 * 1024,
    });
    expect(spatialLodOverviewRuntimePolicy(178).sse).toBe(64);
    expect(spatialLodOverviewRuntimePolicy(300).sse).toBe(128);
  });

  it('maps Overview runtime policy by range after the nearest band', () => {
    expect(spatialLodOverviewRuntimePolicy(300)).toMatchObject({ level: 'z3', sse: 128 });
    expect(spatialLodOverviewRuntimePolicy(750)).toMatchObject({ level: 'z2', sse: 256 });
    expect(spatialLodOverviewRuntimePolicy(1_500)).toMatchObject({ level: 'z1', sse: 512 });
    expect(spatialLodOverviewRuntimePolicy(Number.POSITIVE_INFINITY)).toMatchObject({
      level: 'z0',
      sse: 1024,
    });
  });

  it('scales globe pan by current range instead of dataset radius floor', () => {
    expect(spatialLodPanScaleMetersPerPixel(300)).toBeCloseTo(0.36);
    expect(spatialLodPanScaleMetersPerPixel(0)).toBe(0);
    expect(spatialLodPanScaleMetersPerPixel(Number.NaN)).toBe(0);
  });

  it('rejects traversal and non-JSON entry filenames', () => {
    expect(() => spatialLodEntryUrl('http://localhost:8081', '../secret')).toThrow(/dataset path/);
    expect(() => spatialLodEntryUrl('http://localhost:8081', 'safe', '../tileset.json')).toThrow(/filename/);
  });

  it('classifies tile URIs by z-level', () => {
    expect(classifySpatialLodTileUri('http://localhost:8081/x/points/z0/z0_x000001_y000002.pnts')).toBe('z0');
    expect(classifySpatialLodTileUri('../../points/z3/z3_x000010_y000008.pnts')).toBe('z3');
    expect(classifySpatialLodTileUri('../../points/z4/z4_x000010_y000008.pnts')).toBe('z4');
    expect(classifySpatialLodTileUri('z0/z0_x000001_y000002/tileset.json')).toBeNull();
    expect(classifySpatialLodTileUri(undefined)).toBeNull();
  });

  it('starts with zeroed level stats', () => {
    expect(emptySpatialLodLevelStats()).toEqual({ z0: 0, z1: 0, z2: 0, z3: 0, z4: 0 });
  });

  it('counts requested PNTS URLs by z-level', () => {
    expect(countSpatialLodPntsUrls([
      'http://localhost:8081/x/points/z0/z0_x000001_y000002.pnts',
      'http://localhost:8081/x/points/z2/z2_x000001_y000002.pnts?cache=1',
      '../../points/z2/z2_x000002_y000002.pnts',
      '../../points/z4/z4_x000010_y000008.pnts#hash',
      '../../points/z4/not-a-pnts.bin',
      'z0/z0_x000001_y000002/tileset.json',
    ])).toEqual({ z0: 1, z1: 0, z2: 2, z3: 0, z4: 1 });
  });

  it('formats z-level stats for compact report rows', () => {
    expect(formatSpatialLodLevelStats({ z0: 1, z1: 0, z2: 2, z3: 0, z4: 1 }))
      .toBe('z0=1 z1=0 z2=2 z3=0 z4=1');
    expect(formatSpatialLodLevelStats(null)).toBe('—');
  });

  it('parses tile ids from spatial-lod PNTS URIs', () => {
    expect(parseSpatialLodTileId('/points/z0/z0_x000001_y000002.pnts')).toEqual({
      level: 'z0',
      x: 1,
      y: 2,
      tileId: 'z0_x000001_y000002',
    });
    expect(parseSpatialLodTileId('../../points/z4/z4_x-00003_y000008.pnts?cache=1')).toEqual({
      level: 'z4',
      x: -3,
      y: 8,
      tileId: 'z4_x-00003_y000008',
    });
    expect(parseSpatialLodTileId('not-a-spatial-lod.pnts')).toBeNull();
  });

  it('formats active tile samples with a stable limit', () => {
    expect(formatSpatialLodActiveTileSamples([
      {
        uri: '../../points/z1/z1_x000001_y000002.pnts',
        level: 'z1',
        tileId: 'z1_x000001_y000002',
        x: 1,
        y: 2,
        geometricError: 1000,
        childrenCount: 4,
        hasViewerRequestVolume: false,
        refine: 'REPLACE',
        contentState: 'ready',
      },
      {
        uri: '../../points/z4/z4_x000010_y000020.pnts',
        level: 'z4',
        tileId: 'z4_x000010_y000020',
        x: 10,
        y: 20,
        geometricError: 0,
        childrenCount: 0,
        hasViewerRequestVolume: true,
        refine: 'REPLACE',
        contentState: 'loading',
      },
    ], 1)).toBe('z1_x000001_y000002 err=1000 child=4 vrv=0 content=ready');
    expect(formatSpatialLodActiveTileSamples([{
      uri: '../../points/z3/z3_x000010_y000020.pnts',
      level: 'z3',
      tileId: 'z3_x000010_y000020',
      x: 10,
      y: 20,
      geometricError: 250,
      childrenCount: 25,
      hasViewerRequestVolume: false,
      refine: 'REPLACE',
      contentState: 'ready',
      cameraInsideZ4RequestVolume: false,
      distanceToZ4RequestVolumeMeters: 37,
    }])).toContain('z4vrv=out@37m');
    expect(formatSpatialLodActiveTileSamples([])).toBe('—');
  });

  it('extracts URL from _contentResource.url', () => {
    const tile = { _contentResource: { url: 'http://localhost:8081/x/points/z3/z3_x000001_y000002.pnts' } };
    expect(extractTileContentUri(tile)).toContain('/points/z3/');
  });

  it('falls back to content.uri', () => {
    const tile = { content: { uri: '../../points/z2/z2_x000001_y000002.pnts' } };
    expect(extractTileContentUri(tile)).toContain('/points/z2/');
  });

  it('uses getUrlComponent when available', () => {
    const tile = { _contentResource: { getUrlComponent: () => 'http://localhost:8081/x/points/z1/z1_x000000_y000000.pnts' } };
    expect(extractTileContentUri(tile)).toContain('/points/z1/');
  });

  it('returns null when no URL available', () => {
    expect(extractTileContentUri({})).toBeNull();
    expect(extractTileContentUri(null)).toBeNull();
    expect(extractTileContentUri(undefined)).toBeNull();
  });
});
