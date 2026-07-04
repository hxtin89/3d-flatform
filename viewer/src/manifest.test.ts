// manifest.test.ts — Runtime validator tests for parseAutoLodManifest().
import { describe, it, expect } from 'vitest';
import { parseAutoLodManifest } from './manifest';
import type { AutoLodManifest } from './auto-lod-controller';

function validManifest(): AutoLodManifest {
  return {
    version: 1,
    dataset: 'peru-b2-globe',
    mode: 'auto-lod',
    coordinateMode: 'globe',
    defaultLevel: 'p02',
    bboxFrame: 'enu',
    rootTransform: Array.from({ length: 16 }, (_, i) => i + 1),
    levels: {
      p02: { scope: 'global', preset: 'low', dataset: 'ds/p02', status: 'ready' },
      p10: { scope: 'area', preset: 'medium' },
      p100: { scope: 'area', preset: 'high' },
    },
    thresholds: {
      p10EnterRatio: 2.5,
      p10ExitRatio: 3.0,
      p100EnterRatio: 0.75,
      p100ExitRatio: 0.9,
      settleMs: 750,
      visibleTimeoutMs: 10000,
      retryMs: 30000,
    },
    areas: [
      {
        areaId: 'area-001',
        label: 'A1',
        sourceChunkId: 'chunk-1',
        bbox: [0, 0, 0, 10, 10, 10],
        pointCount: 100,
        levels: {
          p10: { dataset: 'ds/p10/a1', status: 'ready' },
          p100: { dataset: 'ds/p100/a1', status: 'not_built' },
        },
      },
    ],
  };
}

describe('parseAutoLodManifest', () => {
  it('accepts a well-formed manifest', () => {
    expect(() => parseAutoLodManifest(validManifest(), 'peru-b2-globe')).not.toThrow();
  });

  it('rejects wrong version', () => {
    const m = validManifest() as any;
    m.version = 2;
    expect(() => parseAutoLodManifest(m, 'peru-b2-globe')).toThrow(/version must equal 1/);
  });

  it('rejects wrong mode', () => {
    const m = validManifest() as any;
    m.mode = 'manual';
    expect(() => parseAutoLodManifest(m, 'peru-b2-globe')).toThrow(/mode must equal/);
  });

  it('rejects mismatched dataset', () => {
    expect(() => parseAutoLodManifest(validManifest(), 'other-dataset')).toThrow(
      /does not match URL dataset/
    );
  });

  it('rejects duplicate areaId', () => {
    const m = validManifest();
    m.areas.push({ ...m.areas[0] });
    expect(() => parseAutoLodManifest(m, 'peru-b2-globe')).toThrow(/duplicate areaId/);
  });

  it('rejects duplicate sourceChunkId', () => {
    const m = validManifest();
    m.areas.push({
      ...m.areas[0],
      areaId: 'area-002',
      sourceChunkId: m.areas[0].sourceChunkId,
    });
    expect(() => parseAutoLodManifest(m, 'peru-b2-globe')).toThrow(/duplicate sourceChunkId/);
  });

  it('rejects bad bbox (max < min)', () => {
    const m = validManifest();
    m.areas[0].bbox = [10, 0, 0, 5, 10, 10];
    expect(() => parseAutoLodManifest(m, 'peru-b2-globe')).toThrow(/bbox must satisfy/);
  });

  it('rejects non-finite threshold', () => {
    const m = validManifest();
    (m.thresholds as any).p10EnterRatio = Infinity;
    expect(() => parseAutoLodManifest(m, 'peru-b2-globe')).toThrow(/finite number/);
  });

  it('rejects bad threshold ordering', () => {
    const m = validManifest();
    m.thresholds.p100ExitRatio = 0.5; // < p100EnterRatio (0.75)
    expect(() => parseAutoLodManifest(m, 'peru-b2-globe')).toThrow(/ordering/);
  });

  it('rejects empty p02 dataset', () => {
    const m = validManifest();
    (m.levels.p02 as any).dataset = '';
    expect(() => parseAutoLodManifest(m, 'peru-b2-globe')).toThrow(/p02.dataset/);
  });

  it('rejects empty p10 area dataset when status is ready', () => {
    const m = validManifest();
    m.areas[0].levels.p10.dataset = '';
    m.areas[0].levels.p10.status = 'ready';
    expect(() => parseAutoLodManifest(m, 'peru-b2-globe')).toThrow(/non-empty when status/);
  });

  it('allows empty p10 area dataset when status is not_built', () => {
    const m = validManifest();
    m.areas[0].levels.p10.dataset = '';
    m.areas[0].levels.p10.status = 'not_built';
    expect(() => parseAutoLodManifest(m, 'peru-b2-globe')).not.toThrow();
  });

  it('rejects invalid status', () => {
    const m = validManifest();
    (m.areas[0].levels.p10 as any).status = 'pending';
    expect(() => parseAutoLodManifest(m, 'peru-b2-globe')).toThrow(/status must be/);
  });

  it('rejects globe manifest with bad rootTransform length', () => {
    const m = validManifest();
    (m.rootTransform as any) = [1, 2, 3];
    expect(() => parseAutoLodManifest(m, 'peru-b2-globe')).toThrow(/rootTransform/);
  });

  it('rejects non-array areas', () => {
    const m = validManifest() as any;
    m.areas = {};
    expect(() => parseAutoLodManifest(m, 'peru-b2-globe')).toThrow(/areas must be a non-empty array/);
  });

  it('rejects non-object root', () => {
    expect(() => parseAutoLodManifest(null, 'x')).toThrow(/root must be an object/);
    expect(() => parseAutoLodManifest([], 'x')).toThrow(/root must be an object/);
    expect(() => parseAutoLodManifest('hello', 'x')).toThrow(/root must be an object/);
  });
});