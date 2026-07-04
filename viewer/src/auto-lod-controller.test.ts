// auto-lod-controller.test.ts — Unit tests for the pure LOD state machine.
import { describe, it, expect } from 'vitest';
import {
  AutoLodController,
  autoLodFocusRadius,
  type AutoLodManifest,
} from './auto-lod-controller';

function makeManifest(overrides: Partial<AutoLodManifest> = {}): AutoLodManifest {
  return {
    version: 1,
    dataset: 'peru-b2-globe',
    mode: 'auto-lod',
    coordinateMode: 'globe',
    defaultLevel: 'p02',
    bboxFrame: 'enu',
    rootTransform: null,
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
      area('area-001', true, true),
      area('area-002', true, false),
    ],
    ...overrides,
  };
}

function area(
  areaId: string,
  exploreReady = true,
  detailReady = true
): AutoLodManifest['areas'][number] {
  return {
    areaId,
    label: areaId,
    sourceChunkId: `chunk-${areaId}`,
    bbox: [0, 0, 0, 100, 100, 100],
    pointCount: 1000,
    levels: {
      p10: { dataset: `ds/p10/${areaId}`, status: exploreReady ? 'ready' : 'not_built' },
      p100: { dataset: `ds/p100/${areaId}`, status: detailReady ? 'ready' : 'not_built' },
    },
  };
}

describe('AutoLodController', () => {
  it('starts at p02 and requests p10 after settle when ratio crosses enter threshold', () => {
    let t = 1000;
    const c = new AutoLodController({ manifest: makeManifest(), now: () => t });

    // Camera close to area-001 (ratio 1.0 <= 2.5 enter).
    expect(c.update({ areaId: 'area-001', ratio: 1.0 })).toBeNull(); // no settle yet

    // Still within the same frame window before settle.
    t += 500;
    expect(c.update({ areaId: 'area-001', ratio: 1.0 })).toBeNull(); // < 750ms

    t += 300; // 800ms total > 750ms settle
    const evt = c.update({ areaId: 'area-001', ratio: 1.0 });
    expect(evt?.type).toBe('load');
    if (evt?.type === 'load') {
      expect(evt.level).toBe('p10');
      expect(evt.areaId).toBe('area-001');
      expect(evt.dataset).toBe('ds/p10/area-001');
      expect(evt.preset).toBe('medium');
      expect(evt.generation).toBe(1);
    }
    expect(c.getState().status).toBe('requesting');
  });

  it('commits to p10 only after markVisible and leaves p02 behind', () => {
    let t = 0;
    const c = new AutoLodController({ manifest: makeManifest(), now: () => t });
    // Arm pending first.
    c.update({ areaId: 'area-001', ratio: 1.0 });
    t += 800;
    const evt = c.update({ areaId: 'area-001', ratio: 1.0 });
    expect(evt?.type).toBe('load');
    if (evt?.type !== 'load') return;

    // Simulate first tile visible.
    c.markVisible(evt.generation);
    expect(c.getState().level).toBe('p10');
    expect(c.getState().status).toBe('visible');

    // Subsequent frames stay at p10.
    t += 100;
    expect(c.update({ areaId: 'area-001', ratio: 1.5 })).toBeNull();
    expect(c.getState().level).toBe('p10');
  });

  it('hysteresis: ratio near threshold does not cause load loop', () => {
    let t = 0;
    const c = new AutoLodController({ manifest: makeManifest(), now: () => t });

    // Arm pending + cross into p10.
    c.update({ areaId: 'area-001', ratio: 2.0 });
    t += 800;
    const enter = c.update({ areaId: 'area-001', ratio: 2.0 });
    expect(enter?.type).toBe('load');
    if (enter?.type === 'load') c.markVisible(enter.generation);
    expect(c.getState().level).toBe('p10');

    // Wobble just above enter threshold but below exit threshold (no switch).
    for (let i = 0; i < 10; i++) {
      t += 200;
      const ratio = i % 2 === 0 ? 2.6 : 2.8; // both between 2.5 and 3.0
      const e = c.update({ areaId: 'area-001', ratio });
      expect(e).toBeNull();
    }
    expect(c.getState().level).toBe('p10');
  });

  it('returns to p02 when ratio exceeds exit threshold after settle', () => {
    let t = 0;
    const c = new AutoLodController({ manifest: makeManifest(), now: () => t });
    c.update({ areaId: 'area-001', ratio: 1.0 });
    t += 800;
    const enter = c.update({ areaId: 'area-001', ratio: 1.0 });
    if (enter?.type === 'load') c.markVisible(enter.generation);
    expect(c.getState().level).toBe('p10');

    // Cross exit threshold, settle, then switch back.
    c.update({ areaId: 'area-001', ratio: 3.5 });
    t += 800;
    const exit = c.update({ areaId: 'area-001', ratio: 3.5 });
    expect(exit?.type).toBe('load');
    if (exit?.type === 'load') {
      expect(exit.level).toBe('p02');
      expect(exit.areaId).toBeNull();
      c.markVisible(exit.generation);
    }
    expect(c.getState().level).toBe('p02');
  });

  it('transitions p10 -> p100 at the close threshold', () => {
    let t = 0;
    const c = new AutoLodController({ manifest: makeManifest(), now: () => t });
    // Enter p10 first.
    c.update({ areaId: 'area-001', ratio: 1.0 });
    t += 800;
    const enter10 = c.update({ areaId: 'area-001', ratio: 1.0 });
    if (enter10?.type === 'load') c.markVisible(enter10.generation);
    expect(c.getState().level).toBe('p10');

    // Now very close -> p100.
    c.update({ areaId: 'area-001', ratio: 0.5 });
    t += 800;
    const enter100 = c.update({ areaId: 'area-001', ratio: 0.5 });
    expect(enter100?.type).toBe('load');
    if (enter100?.type === 'load') {
      expect(enter100.level).toBe('p100');
      expect(enter100.dataset).toBe('ds/p100/area-001');
    }
  });

  it('load timeout keeps current LOD and schedules a retry', () => {
    let t = 0;
    const c = new AutoLodController({
      manifest: makeManifest({
        thresholds: {
          p10EnterRatio: 2.5,
          p10ExitRatio: 3.0,
          p100EnterRatio: 0.75,
          p100ExitRatio: 0.9,
          settleMs: 0,
          visibleTimeoutMs: 1000,
          retryMs: 5000,
        },
      }),
      now: () => t,
    });

    const enter = c.update({ areaId: 'area-001', ratio: 1.0 });
    expect(enter?.type).toBe('load');
    if (enter?.type !== 'load') return;
    const gen = enter.generation;

    // No visibility -> timeout after visibleTimeoutMs.
    t += 1100;
    const evt = c.update({ areaId: 'area-001', ratio: 1.0 });
    expect(evt?.type).toBe('timeout');
    if (evt?.type === 'timeout') expect(evt.generation).toBe(gen);
    expect(c.getState().level).toBe('p02'); // unchanged
    expect(c.getState().status).toBe('failed');

    // Within retry window, no new load is issued.
    t += 1000;
    expect(c.update({ areaId: 'area-001', ratio: 1.0 })?.type).toBe('retry_scheduled');

    // After retry window, a new load is scheduled.
    t += 5000;
    const retry = c.update({ areaId: 'area-001', ratio: 1.0 });
    expect(retry?.type).toBe('load');
  });

  it('stale markVisible (older generation) is ignored — stale-request protection', () => {
    let t = 0;
    const c = new AutoLodController({
      manifest: makeManifest({ thresholds: { ...makeManifest().thresholds, settleMs: 0 } }),
      now: () => t,
    });

    const first = c.update({ areaId: 'area-001', ratio: 1.0 });
    if (first?.type !== 'load') return;
    // A second request quickly replaces the first (generation 2).
    const second = c.update({ areaId: 'area-002', ratio: 1.0 });
    if (second?.type !== 'load') return;
    expect(second.generation).toBeGreaterThan(first.generation);

    // Stale visible for the first generation must not commit.
    c.markVisible(first.generation);
    expect(c.getState().level).toBe('p02');
    expect(c.getState().status).toBe('requesting');

    // Only the latest generation commits.
    c.markVisible(second.generation);
    expect(c.getState().level).toBe('p10');
    expect(c.getState().areaId).toBe('area-002');
  });

  it('falls back to p02 when target p10 dataset is not_built', () => {
    let t = 0;
    const c = new AutoLodController({
      manifest: makeManifest({
        areas: [area('area-001', false, false)],
      }),
      now: () => t,
    });
    t = 800;
    const evt = c.update({ areaId: 'area-001', ratio: 1.0 });
    // p10 not ready, fallback chain p10->p02; load should target p02.
    if (evt?.type === 'load') {
      expect(evt.level).toBe('p02');
      expect(evt.areaId).toBeNull();
    } else {
      // If no ready dataset anywhere, controller returns null.
      expect(evt).toBeNull();
    }
  });

  it('falls back p100 -> p10 when detail dataset not ready', () => {
    let t = 0;
    const c = new AutoLodController({
      manifest: makeManifest({ areas: [area('area-001', true, false)] }),
      now: () => t,
    });
    // Enter p10 first.
    c.update({ areaId: 'area-001', ratio: 1.0 });
    t += 800;
    const enter10 = c.update({ areaId: 'area-001', ratio: 1.0 });
    if (enter10?.type === 'load') c.markVisible(enter10.generation);
    expect(c.getState().level).toBe('p10');

    // Zoom deeper but p100 not built -> stays/falls-back to p10.
    c.update({ areaId: 'area-001', ratio: 0.5 });
    t += 800;
    const evt = c.update({ areaId: 'area-001', ratio: 0.5 });
    if (evt?.type === 'load') {
      expect(evt.level).toBe('p10');
    } else {
      expect(evt).toBeNull();
    }
    expect(['p10', 'p100']).toContain(c.getState().level);
  });

  it('no area match stays at p02', () => {
    const c = new AutoLodController({ manifest: makeManifest(), now: () => 0 });
    const evt = c.update({ areaId: null, ratio: 0.1 });
    expect(evt).toBeNull();
    expect(c.getState().level).toBe('p02');
  });

  it('autoLodFocusRadius computes half-diagonal', () => {
    const a = area('x');
    expect(autoLodFocusRadius(a)).toBeCloseTo(Math.sqrt(100 ** 2 * 3) / 2);
  });

  it('requestImmediate bypasses settle/hysteresis and returns a p02 load', () => {
    let t = 0;
    const c = new AutoLodController({ manifest: makeManifest(), now: () => t });
    // Place controller mid-p10-flight then force p02 via requestImmediate.
    c.update({ areaId: 'area-001', ratio: 1.0 });
    const req = c.requestImmediate('p02');
    expect(req).not.toBeNull();
    if (!req) return;
    expect(req.level).toBe('p02');
    expect(req.areaId).toBeNull();
    expect(req.dataset).toBe('ds/p02');
    expect(req.preset).toBe('low');
    // The previous in-flight must be replaced.
    expect(c.isInflightGeneration(req.generation)).toBe(true);
  });

  it('requestImmediate to p100 returns ready dataset', () => {
    const c = new AutoLodController({ manifest: makeManifest() });
    const req = c.requestImmediate('p100', 'area-001');
    expect(req).not.toBeNull();
    if (req) {
      expect(req.level).toBe('p100');
      expect(req.dataset).toBe('ds/p100/area-001');
    }
  });

  it('requestImmediate returns null when no ready dataset in fallback chain', () => {
    const c = new AutoLodController({
      manifest: makeManifest({
        areas: [area('area-001', false, false)],
        levels: {
          p02: { scope: 'global', preset: 'low', dataset: 'ds/p02', status: 'not_built' },
          p10: { scope: 'area', preset: 'medium' },
          p100: { scope: 'area', preset: 'high' },
        },
      }),
    });
    expect(c.requestImmediate('p100', 'area-001')).toBeNull();
    expect(c.requestImmediate('p10', 'area-001')).toBeNull();
  });
});