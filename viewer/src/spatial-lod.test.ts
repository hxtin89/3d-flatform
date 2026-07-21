import { describe, expect, it } from 'vitest';
import {
  SPATIAL_LOD_TILESET_FILE,
  SPATIAL_LOD_STREAMING_OPTIONS,
  SPATIAL_LOD_HARD_MEMORY_BYTES,
  SpatialLodBudgetController,
  classifySpatialLodTileUri,
  countSpatialLodPntsUrls,
  emptySpatialLodLevelStats,
  extractTileContentUri,
  formatSpatialLodActiveTileSamples,
  formatSpatialLodLevelStats,
  parseSpatialLodTileId,
  spatialLodDataset,
  spatialLodEntryUrl,
  spatialLodInitialSse,
  spatialLodPanScaleMetersPerPixel,
  spatialLodTargetPoints,
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

  it('streams desired z4 leaves progressively without loading siblings', () => {
    expect(SPATIAL_LOD_STREAMING_OPTIONS).toMatchObject({
      skipLevelOfDetail: true,
      immediatelyLoadDesiredLevelOfDetail: false,
      loadSiblings: false,
      preferLeaves: true,
      foveatedConeSize: 0.2,
      foveatedMinimumScreenSpaceErrorRelaxation: 64,
      foveatedTimeDelay: 0.2,
      cullRequestsWhileMovingMultiplier: 120,
    });
  });

  it('uses distance only for an initial SSE seed', () => {
    expect(spatialLodInitialSse(250)).toBe(64);
    expect(spatialLodInitialSse(500)).toBe(128);
    expect(spatialLodInitialSse(1_000)).toBe(256);
    expect(spatialLodInitialSse(2_000)).toBe(512);
    expect(spatialLodInitialSse(Number.POSITIVE_INFINITY)).toBe(1_024);
  });

  it('derives the point target from drawing-buffer pixels within fixed bounds', () => {
    expect(spatialLodTargetPoints(100, 100)).toBe(5_000_000);
    expect(spatialLodTargetPoints(2_000, 1_000)).toBe(12_000_000);
    expect(spatialLodTargetPoints(8_000, 8_000)).toBe(12_000_000);
  });

  it('uses point budget hysteresis, then switches settled pressure to standard traversal', () => {
    const controller = new SpatialLodBudgetController(1_000);
    controller.onCameraMoveEnd();
    const metrics = {
      drawingBufferWidth: 1_000,
      drawingBufferHeight: 1_000,
      selectedPoints: 4_000_000,
      frameTimeEmaMs: 25,
      memoryBytes: 512 * 1024 * 1024,
      queuesSettled: true,
      z4Eligible: true,
    };
    expect(controller.update({ ...metrics, now: 0 })).toMatchObject({
      state: 'STREAMING', effectiveSse: 256, skipLevelOfDetail: true, eyeDomeLighting: false,
    });
    expect(controller.update({ ...metrics, now: 2_500 })).toMatchObject({
      state: 'SETTLED', effectiveSse: 196, skipLevelOfDetail: false,
      preferLeaves: false, traversalPolicy: 'standard', eyeDomeLighting: false,
    });
    const pressureController = new SpatialLodBudgetController(1_000);
    pressureController.onCameraMoveEnd();
    const pressure = pressureController.update({
      ...metrics,
      now: 5_000,
      selectedPoints: 16_000_000,
      frameTimeEmaMs: 65,
      memoryBytes: SPATIAL_LOD_HARD_MEMORY_BYTES + 1,
    });
    expect(pressure).toMatchObject({
      state: 'PRESSURE', effectiveSse: 384, skipLevelOfDetail: true,
      preferLeaves: true, traversalPolicy: 'streaming', eyeDomeLighting: false, trimCache: true,
    });

    for (const now of [6_000, 7_000, 8_000, 9_000, 10_000]) {
      pressureController.update({
        ...metrics,
        now,
        selectedPoints: 16_000_000,
        frameTimeEmaMs: 65,
        memoryBytes: SPATIAL_LOD_HARD_MEMORY_BYTES + 1,
      });
    }
    expect(pressureController.update({
      ...metrics,
      now: 12_500,
      selectedPoints: 16_000_000,
      frameTimeEmaMs: 65,
      memoryBytes: SPATIAL_LOD_HARD_MEMORY_BYTES + 1,
    })).toMatchObject({
      state: 'PRESSURE', effectiveSse: 2_048, skipLevelOfDetail: false,
      preferLeaves: false, traversalPolicy: 'standard', eyeDomeLighting: false,
    });

    pressureController.onCameraMoveStart(12_600);
    expect(pressureController.update({ ...metrics, now: 12_600 })).toMatchObject({
      state: 'MOVING', skipLevelOfDetail: true,
      preferLeaves: true, traversalPolicy: 'streaming', eyeDomeLighting: false,
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
