import assert from 'node:assert/strict';
import {
  applyDetailContextMode,
  BASE_CONTEXT_CACHE_BYTES,
  BASE_CONTEXT_OVERFLOW_BYTES,
  BASE_CONTEXT_SSE,
  DIM_COLOR_EXPRESSION,
  DIM_POINT_SIZE,
  trimBaseTileset,
} from '../src/detail-context';
import {
  assertBaseIdentity,
  canReuseExploreBase,
  contentMemoryBytes,
  activeDatasetFragments,
  computeLayerCounts,
  computeMemoryMetrics,
  evaluatePerformanceGate,
  evaluateZoomExitState,
  DETAIL_TRANSITION_MEMORY_BUDGET_BYTES,
  DETAIL_TRANSITION_TIMEOUT_MS,
  MICRO_ONLY_BUDGET,
  MICRO_WITH_BASE_BUDGET,
  shouldLazyLoadBase,
} from '../src/detail-micro-lifecycle';

class MockTileset {
  show = true;
  preloadWhenHidden = false;
  cullRequestsWhileMoving = false;
  maximumScreenSpaceError = 0;
  cacheBytes = 0;
  maximumCacheOverflowBytes = 0;
  style: { pointSize?: number; color?: string } | undefined;
  trimmed = false;
  destroyed = false;

  trimLoadedTiles(): void {
    this.trimmed = true;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

const offTileset = new MockTileset() as unknown as Parameters<typeof applyDetailContextMode>[0];
applyDetailContextMode(offTileset, 'off');
assert.equal(offTileset.show, false);
assert.equal(offTileset.preloadWhenHidden, false);
assert.equal(offTileset.cullRequestsWhileMoving, true);

const dimTileset = new MockTileset() as unknown as Parameters<typeof applyDetailContextMode>[0];
applyDetailContextMode(dimTileset, 'dim');
assert.equal(dimTileset.show, true);
assert.equal(dimTileset.maximumScreenSpaceError, BASE_CONTEXT_SSE);
assert.equal(dimTileset.cacheBytes, BASE_CONTEXT_CACHE_BYTES);
assert.equal(dimTileset.maximumCacheOverflowBytes, BASE_CONTEXT_OVERFLOW_BYTES);
assert.equal(dimTileset.style?.pointSize, DIM_POINT_SIZE);
assert.equal(dimTileset.style?.color, DIM_COLOR_EXPRESSION);

const dimFallbackTileset = new MockTileset() as unknown as Parameters<typeof applyDetailContextMode>[0];
const dimFallback = applyDetailContextMode(dimFallbackTileset, 'dim', { dimAlphaSupported: false });
assert.equal(dimFallback.dimAlphaSupported, false);
assert.equal(dimFallbackTileset.style?.pointSize, DIM_POINT_SIZE);
assert.equal(dimFallbackTileset.style?.color, undefined);

const runtimeFallbackTarget = new MockTileset();
let runtimeFallbackStyle: { pointSize?: number; color?: string } | undefined;
let rejectColorOnce = true;
Object.defineProperty(runtimeFallbackTarget, 'style', {
  configurable: true,
  get: () => runtimeFallbackStyle,
  set: (style: { pointSize?: number; color?: string } | undefined) => {
    if (rejectColorOnce && style?.color) {
      rejectColorOnce = false;
      throw new Error('color expression rejected');
    }
    runtimeFallbackStyle = style;
  },
});
const runtimeFallback = applyDetailContextMode(
  runtimeFallbackTarget as unknown as Parameters<typeof applyDetailContextMode>[0],
  'dim'
);
assert.equal(runtimeFallback.dimAlphaSupported, false);
assert.equal(runtimeFallbackStyle?.pointSize, DIM_POINT_SIZE);
assert.equal(runtimeFallbackStyle?.color, undefined);

const fullTileset = new MockTileset() as unknown as Parameters<typeof applyDetailContextMode>[0];
fullTileset.style = { pointSize: DIM_POINT_SIZE, color: DIM_COLOR_EXPRESSION };
applyDetailContextMode(fullTileset, 'full');
assert.equal(fullTileset.show, true);
assert.equal(fullTileset.style, undefined);

const trimTarget = new MockTileset();
trimBaseTileset(trimTarget as unknown as Parameters<typeof trimBaseTileset>[0]);
assert.equal(trimTarget.trimmed, true);

const exploreTileset = {};
const baseTileset = exploreTileset;
assertBaseIdentity(baseTileset, exploreTileset);
assert.throws(() => assertBaseIdentity({}, exploreTileset));

assert.equal(
  canReuseExploreBase({
    fromExplore: true,
    exploreDataset: 'area-p10',
    activeDataset: 'area-p10',
    exploreTileset,
    detailMicroActive: false,
  }),
  true
);
assert.equal(
  canReuseExploreBase({
    fromExplore: true,
    exploreDataset: 'area-p10',
    activeDataset: 'other',
    exploreTileset,
    detailMicroActive: false,
  }),
  false
);

assert.equal(shouldLazyLoadBase('off', null), false);
assert.equal(shouldLazyLoadBase('dim', null), true);
assert.equal(shouldLazyLoadBase('full', {}), false);
assert.equal(DETAIL_TRANSITION_MEMORY_BUDGET_BYTES, 400 * 1024 * 1024);
assert.equal(DETAIL_TRANSITION_TIMEOUT_MS, 15_000);

assert.deepEqual(evaluateZoomExitState({
  armed: false,
  cameraRange: 2_000,
  exitThreshold: 884,
}), { armed: false, shouldExit: false });
assert.deepEqual(evaluateZoomExitState({
  armed: false,
  cameraRange: 800,
  exitThreshold: 884,
}), { armed: true, shouldExit: false });
assert.deepEqual(evaluateZoomExitState({
  armed: true,
  cameraRange: 1_000,
  exitThreshold: 884,
}), { armed: true, shouldExit: true });

const offCounts = computeLayerCounts({
  baseTileset: {},
  baseShow: false,
  detailTileset: {},
  detailShow: true,
  candidateTileset: null,
});
assert.deepEqual(offCounts, {
  visibleP10LayerCount: 0,
  residentP10TilesetCount: 1,
  visibleP100LayerCount: 1,
  residentP100TilesetCount: 1,
});

const transitionCounts = computeLayerCounts({
  baseTileset: {},
  baseShow: false,
  detailTileset: {},
  detailShow: true,
  candidateTileset: {},
});
assert.equal(transitionCounts.residentP100TilesetCount, 2);
assert.equal(transitionCounts.visibleP100LayerCount, 1);

const hiddenBaseMemory = computeMemoryMetrics({
  baseShow: false,
  baseResidentMemoryBytes: 50_000_000,
  baseSelectedTileBytes: 12_000_000,
  detailResidentMemoryBytes: 200_000_000,
  detailSelectedTileBytes: 80_000_000,
});
assert.equal(hiddenBaseMemory.baseVisibleMemoryBytes, 0);
assert.equal(hiddenBaseMemory.baseResidentMemoryBytes, 50_000_000);
assert.equal(hiddenBaseMemory.combinedResidentMemoryBytes, 250_000_000);

const unsupportedVisible = computeMemoryMetrics({
  baseShow: true,
  baseResidentMemoryBytes: 10,
  baseSelectedTileBytes: null,
  detailResidentMemoryBytes: 20,
  detailSelectedTileBytes: null,
});
assert.equal(unsupportedVisible.baseVisibleMemoryBytes, 'unsupported');
assert.equal(unsupportedVisible.detailVisibleMemoryBytes, 'unsupported');

assert.equal(contentMemoryBytes({
  geometryByteLength: 10,
  texturesByteLength: 2,
  innerContents: [
    { geometryByteLength: 5, batchTableByteLength: 1 },
    { innerContents: [{ texturesByteLength: 3 }] },
  ],
}), 21);
assert.equal(contentMemoryBytes({}), null);

assert.deepEqual(activeDatasetFragments({
  resolvedDataset: 'detail/micro',
  contextDataset: null,
  baseDataset: 'explore/area',
}), ['detail/micro', 'explore/area']);
assert.deepEqual(activeDatasetFragments({
  resolvedDataset: 'detail/micro',
  contextDataset: 'context',
  baseDataset: 'detail/micro',
}), ['detail/micro', 'context']);

const degrade = evaluatePerformanceGate({
  detailContextMode: 'dim',
  combinedResidentMemoryBytes: MICRO_WITH_BASE_BUDGET.maxResidentMemoryBytes + 1,
  combinedActiveTiles: 100,
});
assert.equal(degrade.status, 'degraded');
assert.equal(degrade.suggestedContextMode, 'off');
assert.equal(degrade.shouldHideBase, false);

const critical = evaluatePerformanceGate({
  detailContextMode: 'off',
  combinedResidentMemoryBytes: MICRO_ONLY_BUDGET.maxResidentMemoryBytes + 1,
  combinedActiveTiles: MICRO_ONLY_BUDGET.maxActiveTiles + 1,
});
assert.equal(critical.status, 'critical');
assert.equal(critical.shouldHideBase, true);
assert.equal(critical.suggestedContextMode, null);

console.log('detail micro lifecycle tests passed');
