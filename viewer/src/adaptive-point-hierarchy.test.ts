import { describe, expect, it } from 'vitest';
import {
  adaptivePointHierarchyDataset,
  canonicalizeAdaptivePointHierarchyUri,
  resolveAdaptivePointHierarchyDiagnostics,
  adaptivePointHierarchyDetailEligible,
  adaptivePointHierarchyInitialSse,
  adaptivePointHierarchyRenderSettings,
  AdaptivePointHierarchyController,
  parseAdaptivePointHierarchyRenderProfile,
  adaptivePointHierarchyTilesetFile,
  classifyAdaptivePointHierarchyUri,
  emptyAdaptivePointHierarchyDepthStats,
  formatAdaptivePointHierarchyDepthStats,
  normalizeAdaptivePointHierarchyTuning,
  parseAdaptivePointHierarchyNodeId,
  parseAdaptivePointHierarchyControllerMode,
  parseAdaptivePointHierarchyPreviewZ0,
  parseAdaptivePointHierarchyVrv,
  normalizeAdaptivePointHierarchySimpleSse,
  ADAPTIVE_POINT_HIERARCHY_SIMPLE_SSE,
  ADAPTIVE_POINT_HIERARCHY_SIMPLE_TRAVERSAL,
} from './adaptive-point-hierarchy';

describe('adaptive point hierarchy helpers', () => {
  it('resolves the dataset and preview entry', () => {
    expect(adaptivePointHierarchyDataset('peru-b2-globe'))
      .toBe('peru-b2-globe/peru-b2-globe-adaptive-point-hierarchy');
    expect(adaptivePointHierarchyTilesetFile('z0_x000002_y000004', 'frontier-tight'))
      .toBe('tileset-preview-z0_x000002_y000004-frontier-tight.json');
  });

  it('validates preview and VRV query values', () => {
    expect(parseAdaptivePointHierarchyPreviewZ0('z0_x000002_y000004'))
      .toBe('z0_x000002_y000004');
    expect(parseAdaptivePointHierarchyPreviewZ0('../tileset')).toBeNull();
    expect(parseAdaptivePointHierarchyVrv('none')).toBe('none');
    expect(parseAdaptivePointHierarchyVrv('bad')).toBe('none');
    expect(parseAdaptivePointHierarchyControllerMode(null)).toBe('simple');
    expect(parseAdaptivePointHierarchyControllerMode('bad')).toBe('simple');
    expect(parseAdaptivePointHierarchyControllerMode('advanced')).toBe('advanced');
  });

  it('keeps simple traversal free of hierarchy gates', () => {
    expect(ADAPTIVE_POINT_HIERARCHY_SIMPLE_SSE).toBe(8);
    expect(normalizeAdaptivePointHierarchySimpleSse(24)).toBe(24);
    expect(normalizeAdaptivePointHierarchySimpleSse(10)).toBe(8);
    expect(ADAPTIVE_POINT_HIERARCHY_SIMPLE_TRAVERSAL).toEqual({
      skipLevelOfDetail: false,
      preferLeaves: false,
      foveatedScreenSpaceError: false,
      cullRequestsWhileMoving: false,
      immediatelyLoadDesiredLevelOfDetail: false,
    });
  });

  it('parses real Task 2 adaptive PNTS paths', () => {
    expect(parseAdaptivePointHierarchyNodeId(
      '../../points/adaptive/z0_x000002_y000004/d11_q01230123012.pnts'
    )).toEqual({
      z0Id: 'z0_x000002_y000004',
      depth: 11,
      quadrantPath: '01230123012',
    });
  });

  it('canonicalizes resolved paths without merging different z0 subtrees', () => {
    expect(canonicalizeAdaptivePointHierarchyUri(
      'https://tiles.example/peru/z0-A/points/adaptive/z0_x000002_y000004/d5_q01230.pnts?cache=1'
    )).toBe('/peru/z0-A/points/adaptive/z0_x000002_y000004/d5_q01230.pnts');
    expect(canonicalizeAdaptivePointHierarchyUri(
      '../../points/adaptive/z0_x000002_y000004/d5_q01230.pnts',
      'https://tiles.example/peru/z0-A/tiles/nested/tileset.json'
    )).toBe('/peru/z0-A/points/adaptive/z0_x000002_y000004/d5_q01230.pnts');
    expect(canonicalizeAdaptivePointHierarchyUri('z0-A/points/d5_x01.pnts'))
      .not.toBe(canonicalizeAdaptivePointHierarchyUri('z0-B/points/d5_x01.pnts'));
    expect(canonicalizeAdaptivePointHierarchyUri('../../points/d5_x01.pnts'))
      .toBe('relative:../../points/d5_x01.pnts');
  });

  it('prefers runtime extras, falls back to canonical metadata, then remains unavailable', () => {
    const uri = '/tiles/peru/points/adaptive/z0_x000002_y000004/d5_q01230.pnts';
    const fromMap = {
      nodeId: 'z0_x000002_y000004/d5_q01230', depth: 5 as const, kind: 'leaf' as const,
      emittedPointCount: 27_000, inputPointCount: 27_000,
    };
    const metadata = new Map([[uri, fromMap]]);
    expect(resolveAdaptivePointHierarchyDiagnostics(
      { aph: { ...fromMap, nodeId: 'runtime-node' } }, uri, metadata,
    )).toMatchObject({ source: 'runtime-extras', diagnostics: { nodeId: 'runtime-node' } });
    expect(resolveAdaptivePointHierarchyDiagnostics(null, uri, metadata))
      .toMatchObject({ source: 'metadata-map', diagnostics: fromMap });
    expect(resolveAdaptivePointHierarchyDiagnostics(null, uri, new Map()))
      .toMatchObject({ source: 'unavailable', reason: 'missing-metadata' });
  });

  it('accounts selected tiles by adaptive depth', () => {
    const stats = emptyAdaptivePointHierarchyDepthStats();
    classifyAdaptivePointHierarchyUri(stats, '../../points/z0/z0_x000002_y000004.pnts');
    classifyAdaptivePointHierarchyUri(stats, '../../points/adaptive/z0_x000002_y000004/d0_q.pnts');
    classifyAdaptivePointHierarchyUri(stats, '../../points/adaptive/z0_x000002_y000004/d5_q01230.pnts');
    classifyAdaptivePointHierarchyUri(stats, 'unknown.pnts');
    expect(stats).toEqual({ p001: 1, byDepth: { 0: 1, 5: 1 }, unclassified: 1 });
    expect(formatAdaptivePointHierarchyDepthStats(stats)).toBe('p001=1 d0=1 d5=1 other=1');
  });

  it('uses the APH SSE ladder and detail eligibility contract', () => {
    expect(adaptivePointHierarchyInitialSse(250)).toBe(4);
    expect(adaptivePointHierarchyInitialSse(700)).toBe(12);
    expect(adaptivePointHierarchyInitialSse(3_000)).toBe(32);
    expect(adaptivePointHierarchyDetailEligible(200, 'none', false)).toBe(true);
    expect(adaptivePointHierarchyDetailEligible(500, 'none', true)).toBe(false);
    expect(adaptivePointHierarchyDetailEligible(500, 'frontier-tight', true)).toBe(true);
  });

  it('uses the FAR phase outside the approach range', () => {
    const controller = new AdaptivePointHierarchyController(5_000, 'none');
    const base = {
      selectedPoints: 1_000_000,
      frameTimeEmaMs: 20,
      memoryBytes: 100,
      cameraRangeMeters: 5_000,
      intersectsFrontierVrv: false,
      cameraMoving: false,
      cameraIdleMs: 0,
      refinementCycleId: 1,
      warmupImmediateLoadSuppressed: false,
    };
    const decision = controller.update({ ...base, now: 0 });
    expect(decision.cameraPhase).toBe('FAR');
    expect(decision.effectiveSse).toBe(16);
    expect(decision.skipLevelOfDetail).toBe(true);
  });

  it('preloads the foveated approach region without claiming detail eligibility', () => {
    const controller = new AdaptivePointHierarchyController(3_000, 'none');
    const base = {
      selectedPoints: 1_000_000,
      frameTimeEmaMs: 20,
      memoryBytes: 100,
      intersectsFrontierVrv: false,
      cameraMoving: false,
      cameraIdleMs: 1_000,
      refinementCycleId: 1,
      warmupImmediateLoadSuppressed: false,
    };
    const approach = controller.update({ ...base, now: 0, cameraRangeMeters: 2_565 });
    expect(approach.cameraPhase).toBe('APPROACH');
    expect(approach.detailEligible).toBe(false);
    expect(approach.effectiveSse).toBe(8);
    expect(approach.skipLevelOfDetail).toBe(true);
    expect(approach.foveatedScreenSpaceError).toBe(true);
    expect(approach.cullRequestsWhileMoving).toBe(true);
    expect(approach.immediatelyLoadDesiredLevelOfDetail).toBe(false);

    const far = controller.update({ ...base, now: 1, cameraRangeMeters: 3_001 });
    expect(far.cameraPhase).toBe('FAR');
    expect(far.effectiveSse).toBe(16);
  });

  it('normalizes runtime tuning to the APH ladder and safe approach range', () => {
    expect(normalizeAdaptivePointHierarchyTuning({
      farSse: 24,
      approachRangeMeters: 2_565.4,
      approachSse: 4,
      detailSse: 8,
    })).toEqual({
      farSse: 24,
      approachRangeMeters: 2_565,
      approachSse: 4,
      detailSse: 8,
    });
    expect(normalizeAdaptivePointHierarchyTuning({
      farSse: 10,
      approachRangeMeters: 100,
      approachSse: 6,
      detailSse: 2,
    })).toEqual({
      farSse: 16,
      approachRangeMeters: 250,
      approachSse: 8,
      detailSse: 4,
    });
  });

  it('applies live phase SSE and approach range tuning', () => {
    const controller = new AdaptivePointHierarchyController(5_000, 'none', {
      farSse: 24,
      approachRangeMeters: 4_000,
      approachSse: 4,
      detailSse: 8,
    });
    const base = {
      selectedPoints: 1_000_000,
      frameTimeEmaMs: 20,
      memoryBytes: 100,
      intersectsFrontierVrv: false,
      cameraMoving: false,
      cameraIdleMs: 1_000,
      refinementCycleId: 1,
      warmupImmediateLoadSuppressed: false,
    };
    expect(controller.update({ ...base, now: 0, cameraRangeMeters: 4_500 })).toMatchObject({
      cameraPhase: 'FAR',
      effectiveSse: 24,
    });
    expect(controller.update({ ...base, now: 1, cameraRangeMeters: 2_565 })).toMatchObject({
      cameraPhase: 'APPROACH',
      effectiveSse: 4,
    });
    controller.update({ ...base, now: 2, cameraRangeMeters: 200 });
    expect(controller.update({ ...base, now: 252, cameraRangeMeters: 200 })).toMatchObject({
      cameraPhase: 'DETAIL_READY',
      effectiveSse: 8,
    });
  });

  it('starts a fresh detail warmup after approach preloading', () => {
    const controller = new AdaptivePointHierarchyController(900, 'none');
    const base = {
      selectedPoints: 1_000_000,
      frameTimeEmaMs: 20,
      memoryBytes: 100,
      intersectsFrontierVrv: false,
      cameraMoving: false,
      cameraIdleMs: 0,
      refinementCycleId: 7,
      warmupImmediateLoadSuppressed: false,
    };
    expect(controller.update({ ...base, now: 0, cameraRangeMeters: 900 }).cameraPhase)
      .toBe('APPROACH');
    const warmup = controller.update({ ...base, now: 1, cameraRangeMeters: 250 });
    expect(warmup.cameraPhase).toBe('DETAIL_WARMUP');
    expect(warmup.detailEligible).toBe(true);
    expect(warmup.immediatelyLoadDesiredLevelOfDetail).toBe(true);
  });

  it('warms detail immediately after moveEnd then reaches SSE 4 after the guard', () => {
    const controller = new AdaptivePointHierarchyController(1_500, 'none');
    const close = {
      selectedPoints: 1_000_000,
      frameTimeEmaMs: 20,
      memoryBytes: 100,
      cameraRangeMeters: 200,
      intersectsFrontierVrv: false,
      refinementCycleId: 1,
      warmupImmediateLoadSuppressed: false,
    };
    expect(controller.update({ ...close, now: 0, cameraMoving: true, cameraIdleMs: 0 }).cameraPhase)
      .toBe('MOVING_DETAIL');
    const warmup = controller.update({ ...close, now: 1, cameraMoving: false, cameraIdleMs: 0 });
    expect(warmup.cameraPhase).toBe('DETAIL_WARMUP');
    expect(warmup.effectiveSse).toBe(8);
    expect(warmup.immediatelyLoadDesiredLevelOfDetail).toBe(true);
    const decision = controller.update({ ...close, now: 251, cameraMoving: false, cameraIdleMs: 250 });
    expect(decision.effectiveSse).toBe(4);
    expect(decision.cameraPhase).toBe('DETAIL_READY');
    expect(decision.immediatelyLoadDesiredLevelOfDetail).toBe(false);
  });

  it('uses pressure as an SSE overlay and suppresses immediate warmup loading', () => {
    const controller = new AdaptivePointHierarchyController(200, 'none');
    const metrics = {
      cameraRangeMeters: 200,
      intersectsFrontierVrv: false,
      cameraMoving: false,
      cameraIdleMs: 0,
      refinementCycleId: 1,
      warmupImmediateLoadSuppressed: false,
      selectedPoints: 20_100_000,
      frameTimeEmaMs: 20,
      memoryBytes: 100,
    };
    expect(controller.update({ ...metrics, now: 0 }).pressureLevel).toBe('NONE');
    const pressured = controller.update({ ...metrics, now: 500 });
    expect(pressured.pressureLevel).toBe('HIGH');
    expect(pressured.effectiveSse).toBe(12);
    expect(pressured.immediatelyLoadDesiredLevelOfDetail).toBe(false);
  });

  it('defaults rendering profiles to raw and accepts balanced explicitly', () => {
    expect(parseAdaptivePointHierarchyRenderProfile('raw')).toBe('raw');
    expect(parseAdaptivePointHierarchyRenderProfile(null)).toBe('raw');
    expect(parseAdaptivePointHierarchyRenderProfile('bad')).toBe('raw');
    expect(parseAdaptivePointHierarchyRenderProfile('balanced')).toBe('balanced');
    expect(adaptivePointHierarchyRenderSettings('balanced', '2.2', '-1', '3')).toMatchObject({
      maximumAttenuation: 1.5,
      eyeDomeLightingStrength: 0.3,
      eyeDomeLightingRadius: 1,
    });
    expect(adaptivePointHierarchyRenderSettings('raw', '2', '1', '2')).toMatchObject({
      attenuation: false,
      eyeDomeLighting: false,
    });
  });
});
