import assert from 'node:assert/strict';
import {
  findMicroAreaForViewSamples,
  resolveDataset,
  type AreaManifest,
  type MicroAreaEntry,
  type MicroAreaManifest,
} from '../src/manifest';

const cellA: MicroAreaEntry = {
  microAreaId: 'micro-d2-x0-y0',
  bbox: [0, 0, 0, 10, 10, 10],
  sourceBbox: [0, 0, 0, 10, 10, 10],
  pointCount: 100,
  tileCount: 2,
  averageTileBytes: 300_000,
  dataset: 'detail/a',
  status: 'ready',
};
const cellB: MicroAreaEntry = {
  ...cellA,
  microAreaId: 'micro-d2-x1-y0',
  bbox: [10, 0, 0, 20, 10, 10],
  sourceBbox: [10, 0, 0, 20, 10, 10],
  dataset: 'detail/b',
};
const manifest: AreaManifest = {
  dataset: 'demo',
  defaultMode: 'overview',
  defaultAreaId: 'area-001',
  coordinateMode: 'local',
  bboxFrame: 'source',
  datasets: { overview: { dataset: 'overview', status: 'ready' } },
  areas: [{
    areaId: 'area-001',
    label: 'Area 001',
    sourceChunkId: 'chunk-0_0',
    bbox: [0, 0, 0, 20, 10, 10],
    pointCount: 200,
    datasets: {
      explore: { dataset: 'explore', status: 'ready' },
      detail: { dataset: 'legacy', status: 'ready' },
      detailMicro: { manifest: 'micro.json', status: 'ready' },
    },
  }],
};
const microManifest: MicroAreaManifest = {
  version: 1,
  areaId: 'area-001',
  sourceChunkId: 'chunk-0_0',
  coordinateMode: 'local',
  bboxFrame: 'source',
  partition: {
    strategy: 'adaptive-quadtree',
    baseDepth: 2,
    maxDepth: 4,
    maxPoints: 8_000_000,
    boundaryPolicy: 'half-open-xy-outer-inclusive-v1',
  },
  packing: {
    mode: 'level-group',
    candidateGroupLevels: [3, 4, 5],
    targetTileBytes: 524_288,
    minAverageTileBytes: 256_000,
    hardMaxTileBytes: 5_242_880,
    maxTileCount: 250,
  },
  cells: [cellA, cellB],
};

const match = findMicroAreaForViewSamples(manifest, microManifest, [
  { x: 15, y: 5, z: 1, weight: 1, source: 'pickPosition' },
]);
assert.equal(match.cell?.microAreaId, cellB.microAreaId);
assert.equal(match.reason, 'matched');

const sticky = findMicroAreaForViewSamples(manifest, microManifest, [
  { x: 11, y: 5, z: 1, weight: 1, source: 'pickPosition' },
], cellA.microAreaId, 2);
assert.equal(sticky.cell?.microAreaId, cellA.microAreaId);
assert.equal(sticky.reason, 'sticky_current');

const insufficient = findMicroAreaForViewSamples(manifest, microManifest, [
  { x: 5, y: 5, z: 1, weight: 0.5, source: 'pickPosition' },
  { x: 15, y: 5, z: 1, weight: 0.5, source: 'pickPosition' },
]);
assert.equal(insufficient.cell, null);
assert.equal(insufficient.reason, 'insufficient_weight');

const resolvedMicro = resolveDataset('demo', 'high', manifest, manifest.areas[0], cellB);
assert.equal(resolvedMicro.resolvedDataset, 'detail/b');
assert.equal(resolvedMicro.detailScope, 'micro');
assert.equal(resolvedMicro.selectedMicroAreaId, cellB.microAreaId);

const missingMicro = resolveDataset('demo', 'high', manifest, manifest.areas[0], null);
assert.equal(missingMicro.modeStatus, 'not_built');
assert.equal(missingMicro.detailScope, 'micro');

const legacyManifest: AreaManifest = JSON.parse(JSON.stringify(manifest));
delete legacyManifest.areas[0].datasets.detailMicro;
const legacy = resolveDataset('demo', 'high', legacyManifest, legacyManifest.areas[0]);
assert.equal(legacy.resolvedDataset, 'legacy');
assert.equal(legacy.detailScope, 'legacy-area');

console.log('viewer micro manifest tests passed');
