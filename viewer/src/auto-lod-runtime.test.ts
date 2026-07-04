// auto-lod-runtime.test.ts — Runtime tests using a fake host.
import { describe, it, expect, vi } from 'vitest';
import {
  AutoLodController,
  type AutoLodManifest,
} from './auto-lod-controller';
import { AutoLodRuntime, type AutoLodStageHost } from './auto-lod-runtime';

type FakeStage = {
  generation: number;
  level: 'p02' | 'p10' | 'p100';
  dataset: string;
  preset: 'low' | 'medium' | 'high';
  onVisible: (g: number) => void;
};

class FakeHost implements AutoLodStageHost {
  staged: FakeStage[] = [];
  committed: number[] = [];
  discarded: number[] = [];
  stageReject: ((s: FakeStage) => Error | null) | null = null;

  async stage(request: FakeStage): Promise<void> {
    this.staged.push(request);
    const err = this.stageReject?.(request);
    if (err) throw err;
  }
  commit(generation: number, preset: 'low' | 'medium' | 'high', dataset: string): boolean {
    void preset; void dataset;
    const staged = this.staged.find((s) => s.generation === generation);
    if (!staged) return false;
    this.committed.push(generation);
    return true;
  }
  discard(generation: number): void {
    this.discarded.push(generation);
  }
  fireVisible(generation: number): void {
    const staged = this.staged.find((s) => s.generation === generation);
    if (!staged) throw new Error(`No staged request for gen ${generation}`);
    staged.onVisible(generation);
  }
  reset(): void {
    this.staged = [];
    this.committed = [];
    this.discarded = [];
    this.stageReject = null;
  }
}

function manifest(overrides: Partial<AutoLodManifest> = {}): AutoLodManifest {
  return {
    version: 1,
    dataset: 'ds',
    mode: 'auto-lod',
    coordinateMode: 'globe',
    defaultLevel: 'p02',
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
      settleMs: 0,
      visibleTimeoutMs: 10000,
      retryMs: 30000,
    },
    areas: [
      {
        areaId: 'area-001',
        label: 'A1',
        sourceChunkId: 'c1',
        bbox: [0, 0, 0, 100, 100, 100],
        pointCount: 1000,
        levels: {
          p10: { dataset: 'ds/p10/a1', status: 'ready' },
          p100: { dataset: 'ds/p100/a1', status: 'ready' },
        },
      },
    ],
    ...overrides,
  };
}

describe('AutoLodRuntime', () => {
  function makeController(t = 0) {
    return new AutoLodController({ manifest: manifest(), now: () => t });
  }

  it('candidate not visible yet is not committed', () => {
    const host = new FakeHost();
    let t = 0;
    const controller = new AutoLodController({ manifest: manifest(), now: () => t });
    const rt = new AutoLodRuntime({ controller, host });
    // Trigger a load by changing probe.
    t = 0;
    const evt = controller.update({ areaId: 'area-001', ratio: 1.0 });
    expect(evt?.type).toBe('load');
    rt.dispatchEvent(evt);
    expect(host.staged).toHaveLength(1);
    expect(host.committed).toHaveLength(0);
  });

  it('candidate visible for the right generation commits', () => {
    const host = new FakeHost();
    let t = 0;
    const controller = new AutoLodController({ manifest: manifest(), now: () => t });
    const commitSpy = vi.fn();
    const rt = new AutoLodRuntime({
      controller,
      host,
      hooks: { onCommitted: commitSpy },
    });
    const evt = controller.update({ areaId: 'area-001', ratio: 1.0 });
    if (evt?.type !== 'load') throw new Error('expected load');
    rt.dispatchEvent(evt);
    host.fireVisible(evt.generation);
    expect(host.committed).toEqual([evt.generation]);
    expect(commitSpy).toHaveBeenCalledTimes(1);
    expect(commitSpy.mock.calls[0][0].level).toBe('p10');
  });

  it('stale visible (superseded) is discarded, not committed', () => {
    const host = new FakeHost();
    let t = 0;
    const controller = new AutoLodController({ manifest: manifest(), now: () => t });
    const rt = new AutoLodRuntime({ controller, host });
    // Stage A (p10).
    const evt1 = controller.update({ areaId: 'area-001', ratio: 1.0 });
    if (evt1?.type !== 'load') throw new Error('expected load 1');
    rt.dispatchEvent(evt1);
    expect(host.staged.map((s) => s.generation)).toEqual([evt1.generation]);

    // Supersede via Fly Home (requestImmediate p02) before A becomes visible.
    rt.requestP02();
    expect(host.discarded).toContain(evt1.generation);

    // Late fire of A: must NOT commit; controller no longer considers A inflight.
    expect(() => host.fireVisible(evt1.generation)).not.toThrow();
    expect(host.committed).toEqual([]);
  });

  it('request B supersedes request A; A complete after B does not change active layer', () => {
    const host = new FakeHost();
    let t = 0;
    const controller = new AutoLodController({ manifest: manifest(), now: () => t });
    const commits: number[] = [];
    const rt = new AutoLodRuntime({
      controller,
      host,
      hooks: { onCommitted: (s) => commits.push(s.generation) },
    });
    // A: stage p10 (gen 1). Committed level stays p02.
    const evtA = controller.update({ areaId: 'area-001', ratio: 1.0 });
    if (evtA?.type !== 'load') throw new Error('expected load A');
    rt.dispatchEvent(evtA);
    expect(commits).not.toContain(evtA.generation);

    // B: Fly Home (p02) supersedes A. Different level vs committed (still p02)?
    // committed.level=p02 and target.level=p02 → same → controller would normally
    // return null on update, but requestImmediate bypasses that and forces a
    // staged load with a fresh generation.
    rt.requestP02();
    const evtBGen = host.staged[host.staged.length - 1].generation;
    expect(host.discarded).toContain(evtA.generation);

    // Commit B first.
    host.fireVisible(evtBGen);
    expect(commits).toContain(evtBGen);

    // Stale A visible late must not commit nor change layer.
    expect(() => host.fireVisible(evtA.generation)).not.toThrow();
    expect(commits).not.toContain(evtA.generation);
  });

  it('load error discards candidate and keeps active dataset', () => {
    const host = new FakeHost();
    let t = 0;
    const controller = new AutoLodController({ manifest: manifest(), now: () => t });
    const errSpy = vi.fn();
    const rt = new AutoLodRuntime({ controller, host, hooks: { onLoadError: errSpy } });
    host.stageReject = () => new Error('boom');
    const evt = controller.update({ areaId: 'area-001', ratio: 1.0 });
    if (evt?.type !== 'load') throw new Error('expected load');
    rt.dispatchEvent(evt);
    // Allow rejected promise to resolve.
    return Promise.resolve().then(() => {
      expect(host.discarded).toContain(evt.generation);
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(host.committed).toEqual([]);
      expect(controller.getState().status).toBe('failed');
      expect(controller.getState().inflightGeneration).toBeNull();
    });
  });

  it('timeout event discards stage and keeps committed layer', () => {
    const host = new FakeHost();
    let t = 0;
    const controller = new AutoLodController({
      manifest: manifest({
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
    const toSpy = vi.fn();
    const rt = new AutoLodRuntime({ controller, host, hooks: { onTimeout: toSpy } });
    const evt = controller.update({ areaId: 'area-001', ratio: 1.0 });
    if (evt?.type !== 'load') throw new Error('expected load');
    rt.dispatchEvent(evt);
    // Advance past visibleTimeout; next update emits a timeout.
    t += 1100;
    const toEvt = controller.update({ areaId: 'area-001', ratio: 1.0 });
    expect(toEvt?.type).toBe('timeout');
    rt.dispatchEvent(toEvt);
    expect(toSpy).toHaveBeenCalledTimes(1);
    expect(host.discarded).toContain((evt as any).generation);
    expect(host.committed).toEqual([]);
  });

  it('fly-home (requestP02) stages p02 anchor reuse', () => {
    const host = new FakeHost();
    let t = 0;
    const controller = new AutoLodController({ manifest: manifest(), now: () => t });
    const commitSpy = vi.fn();
    const rt = new AutoLodRuntime({
      controller,
      host,
      hooks: { onCommitted: commitSpy },
    });
    // First move to p10 so we have something to leave.
    const evt10 = controller.update({ areaId: 'area-001', ratio: 1.0 });
    if (evt10?.type !== 'load') throw new Error('expected load p10');
    rt.dispatchEvent(evt10);
    host.fireVisible(evt10.generation);
    expect(commitSpy).toHaveBeenCalledTimes(1);

    // Fly-home forces p02.
    rt.requestP02();
    expect(host.staged.length).toBeGreaterThanOrEqual(2);
    const last = host.staged[host.staged.length - 1];
    expect(last.level).toBe('p02');
    expect(last.dataset).toBe('ds/p02');
    host.fireVisible(last.generation);
    expect(commitSpy).toHaveBeenCalledTimes(2);
    expect(commitSpy.mock.calls[1][0].level).toBe('p02');
  });

  it('returning to p02 uses navigation anchor (level p02)', () => {
    const host = new FakeHost();
    let t = 0;
    const controller = new AutoLodController({ manifest: manifest(), now: () => t });
    const rt = new AutoLodRuntime({ controller, host });
    // Move to p10 first.
    const evt10 = controller.update({ areaId: 'area-001', ratio: 1.0 });
    if (evt10?.type !== 'load') throw new Error('expected load');
    rt.dispatchEvent(evt10);
    host.fireVisible(evt10.generation);

    // Now zoom out to p02.
    const evtP02 = controller.update({ areaId: 'area-001', ratio: 4.0 });
    if (evtP02?.type !== 'load') throw new Error('expected p02 load');
    expect(evtP02.level).toBe('p02');
    rt.dispatchEvent(evtP02);
    host.fireVisible(evtP02.generation);
    expect(host.committed).toContain(evtP02.generation);
  });

  it('area detection mismatch stays at p02', () => {
    const host = new FakeHost();
    const controller = new AutoLodController({ manifest: manifest(), now: () => 0 });
    const rt = new AutoLodRuntime({ controller, host });
    const evt = controller.update({ areaId: null, ratio: 0.1 });
    expect(evt).toBeNull();
    rt.dispatchEvent(evt);
    expect(host.staged).toHaveLength(0);
  });
});
