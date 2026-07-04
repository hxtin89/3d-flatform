// auto-lod-controller.ts — Pure state machine that drives the ?lod=auto viewer
// mode. It is intentionally framework-agnostic and isolated from CesiumJS so
// it can be unit tested without a viewer. See plans/plan-auto-lod.md.
//
// The Auto-LOD type contract is declared here (not in manifest.ts) so this
// file has zero runtime imports — tests can load it without Cesium/Vite.

export type AutoLodLevel = 'p02' | 'p10' | 'p100';
export type AutoLodPreset = 'low' | 'medium' | 'high';
export type LodStatus = 'ready' | 'not_built';

export interface AutoLodArea {
  areaId: string;
  label: string;
  sourceChunkId: string;
  bbox: number[];
  sourceBbox?: number[] | null;
  pointCount: number | null;
  levels: {
    p10: { dataset: string; status: LodStatus };
    p100: { dataset: string; status: LodStatus };
  };
}

export interface AutoLodManifest {
  version: number;
  dataset: string;
  mode: 'auto-lod';
  coordinateMode?: 'local' | 'globe';
  defaultLevel: AutoLodLevel;
  bboxFrame?: 'source' | 'enu';
  rootTransform?: number[] | null;
  enuOriginSource?: number[] | null;
  enuOriginEcef?: number[] | null;
  enuOriginLonLat?: number[] | null;
  levels: {
    p02: { scope: 'global'; preset: 'low'; dataset: string; status: LodStatus };
    p10: { scope: 'area'; preset: 'medium' };
    p100: { scope: 'area'; preset: 'high' };
  };
  thresholds: {
    p10EnterRatio: number;
    p10ExitRatio: number;
    p100EnterRatio: number;
    p100ExitRatio: number;
    settleMs: number;
    visibleTimeoutMs: number;
    retryMs: number;
  };
  areas: AutoLodArea[];
}

export interface AutoLodProbe {
  /** Id of the area the camera currently points at, or null when none. */
  areaId: string | null;
  /**
   * Camera range ratio = distance-to-orbit-target / area focus radius.
   * Smaller ratio == closer to the area. 0 when no area is matched.
   */
  ratio: number;
}

export type AutoLodEvent =
  | {
      type: 'load';
      generation: number;
      level: AutoLodLevel;
      areaId: string | null;
      dataset: string;
      preset: AutoLodPreset;
    }
  | { type: 'timeout'; generation: number; level: AutoLodLevel }
  | { type: 'retry_scheduled'; at: number; level: AutoLodLevel };

export interface AutoLodControllerConfig {
  manifest: AutoLodManifest;
  /** Injectable clock (ms). Defaults to performance.now when omitted. */
  now?: () => number;
}

export interface AutoLodStateSnapshot {
  level: AutoLodLevel;
  areaId: string | null;
  status: 'idle' | 'requesting' | 'visible' | 'failed';
  lastChangeMs: number;
  lastRatio: number;
  inflightGeneration: number | null;
}

function presetsForLevel(level: AutoLodLevel): AutoLodPreset {
  return level === 'p02' ? 'low' : level === 'p10' ? 'medium' : 'high';
}

function datasetFor(
  manifest: AutoLodManifest,
  level: AutoLodLevel,
  area: AutoLodArea | null
): string | null {
  if (level === 'p02') return manifest.levels.p02.dataset;
  const slot = area?.levels[level];
  if (!slot || !slot.dataset) return null;
  return slot.dataset;
}

function statusFor(
  manifest: AutoLodManifest,
  level: AutoLodLevel,
  area: AutoLodArea | null
): LodStatus {
  if (level === 'p02') return manifest.levels.p02.status;
  const slot = area?.levels[level];
  if (!slot) return 'not_built';
  return slot.status;
}

export class AutoLodController {
  private readonly manifest: AutoLodManifest;
  private readonly now: () => number;

  private level: AutoLodLevel;
  private areaId: string | null = null;
  private status: 'idle' | 'requesting' | 'visible' | 'failed' = 'idle';
  private lastChangeMs: number;
  private lastRatio = 0;

  private pending: { level: AutoLodLevel; areaId: string | null; since: number } | null = null;
  private inflight: {
    generation: number;
    level: AutoLodLevel;
    areaId: string | null;
    deadline: number;
  } | null = null;
  private retryDeadline = 0;
  private generation = 0;

  constructor(config: AutoLodControllerConfig) {
    this.manifest = config.manifest;
    this.now = config.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.level = this.manifest.defaultLevel ?? 'p02';
    this.lastChangeMs = this.now();
  }

  getState(): AutoLodStateSnapshot {
    return {
      level: this.level,
      areaId: this.areaId,
      status: this.status,
      lastChangeMs: this.lastChangeMs,
      lastRatio: this.lastRatio,
      inflightGeneration: this.inflight?.generation ?? null,
    };
  }

  getManifest(): AutoLodManifest {
    return this.manifest;
  }

  areaById(areaId: string | null): AutoLodArea | null {
    if (!areaId) return null;
    return this.manifest.areas.find((area) => area.areaId === areaId) ?? null;
  }

  /** Reset to the default level (e.g. after fly-home). Cancels in-flight request. */
  reset(level: AutoLodLevel | null = null): void {
    this.level = level ?? this.manifest.defaultLevel ?? 'p02';
    this.areaId = null;
    this.status = 'idle';
    this.pending = null;
    this.inflight = null;
    this.retryDeadline = 0;
    this.lastChangeMs = this.now();
  }

  /**
   * Feed a camera probe and return any event the host should act on.
   * The host is responsible for: starting the load (when receiving `load`),
   * calling `markVisible`/`markFailed` when the request succeeds/fails.
   */
  update(probe: AutoLodProbe): AutoLodEvent | null {
    const now = this.now();
    this.lastRatio = probe.ratio;

    const area = this.areaById(probe.areaId);
    const target = this.desiredLevel(probe, area);

    // Settle / hysteresis: only arm a pending switch once the target is stable.
    if (
      !this.pending ||
      this.pending.level !== target.level ||
      this.pending.areaId !== target.areaId
    ) {
      this.pending = { level: target.level, areaId: target.areaId, since: now };
    }

    // Resolve any in-flight request first.
    if (this.inflight) {
      const timedOut = now >= this.inflight.deadline;
      if (timedOut) {
        const stale = this.inflight;
        this.inflight = null;
        this.retryDeadline = now + this.manifest.thresholds.retryMs;
        this.status = 'failed';
        return { type: 'timeout', generation: stale.generation, level: stale.level };
      }

      const stillDesired =
        this.inflight.level === target.level && this.inflight.areaId === target.areaId;
      if (stillDesired) {
        // Waiting for the host to call markVisible / markFailed.
        return null;
      }

      // Target changed while a request is in flight: supersede it. The host's
      // outstanding loadScene promise for the old generation will be ignored
      // via the generation token (stale-request protection).
      this.inflight = null;
      this.status = 'idle';
      // Re-arm pending for the new target and continue to issue a fresh load
      // below (subject to settle + retry window).
      this.pending = { level: target.level, areaId: target.areaId, since: now };
    }

    const sameAsCommitted =
      this.level === target.level && this.areaId === target.areaId;
    if (sameAsCommitted) {
      return null;
    }

    if (now < this.retryDeadline) {
      return { type: 'retry_scheduled', at: this.retryDeadline, level: target.level };
    }

    const elapsed = now - this.pending.since;
    if (elapsed < this.manifest.thresholds.settleMs) {
      return null;
    }

    // Resolve dataset: if target not ready, fall back to the closest ready level.
    const resolved = this.resolveLoadTarget(target, area);
    if (!resolved) return null;

    this.generation += 1;
    this.inflight = {
      generation: this.generation,
      level: resolved.level,
      areaId: resolved.areaId,
      deadline: now + this.manifest.thresholds.visibleTimeoutMs,
    };
    this.status = 'requesting';
    return {
      type: 'load',
      generation: this.generation,
      level: resolved.level,
      areaId: resolved.areaId,
      dataset: resolved.dataset,
      preset: presetsForLevel(resolved.level),
    };
  }

  /** Host signals that the first tile for `generation` became visible. */
  markVisible(generation: number): boolean {
    if (!this.inflight || this.inflight.generation !== generation) {
      // Stale request: ignore. This is the stale-request protection.
      return false;
    }
    this.level = this.inflight.level;
    this.areaId = this.inflight.areaId;
    this.status = 'visible';
    this.lastChangeMs = this.now();
    this.inflight = null;
    this.pending = null;
    this.retryDeadline = 0;
    return true;
  }

  /** Host signals that loading for `generation` failed. */
  markFailed(generation: number): boolean {
    if (!this.inflight || this.inflight.generation !== generation) return false;
    const now = this.now();
    this.inflight = null;
    this.retryDeadline = now + this.manifest.thresholds.retryMs;
    this.status = 'failed';
    return true;
  }

  /** Returns true when `generation` is the currently in-flight request. */
  isInflightGeneration(generation: number): boolean {
    return this.inflight?.generation === generation;
  }

  /**
   * Force an immediate staged load for `level` bypassing settle/hysteresis.
   * Used by Fly Home. Cancels any in-flight request. Returns the new
   * generation and resolved dataset/preset for the host to stage. Returns
   * null when no ready dataset exists for the requested fallback chain.
   */
  requestImmediate(
    level: AutoLodLevel,
    areaId: string | null = null
  ): {
    generation: number;
    level: AutoLodLevel;
    areaId: string | null;
    dataset: string;
    preset: AutoLodPreset;
  } | null {
    const area = this.areaById(areaId);
    const target = { level, areaId: level === 'p02' ? null : areaId };
    const resolved = this.resolveLoadTarget(target, area);
    if (!resolved) return null;

    // Cancel any in-flight; reset retry window so the immediate load proceeds.
    this.inflight = null;
    this.retryDeadline = 0;
    this.pending = { level: resolved.level, areaId: resolved.areaId, since: this.now() };

    this.generation += 1;
    this.inflight = {
      generation: this.generation,
      level: resolved.level,
      areaId: resolved.areaId,
      deadline: this.now() + this.manifest.thresholds.visibleTimeoutMs,
    };
    this.status = 'requesting';
    return {
      generation: this.generation,
      level: resolved.level,
      areaId: resolved.areaId,
      dataset: resolved.dataset,
      preset: presetsForLevel(resolved.level),
    };
  }

  private desiredLevel(
    probe: AutoLodProbe,
    area: AutoLodArea | null
  ): { level: AutoLodLevel; areaId: string | null } {
    const t = this.manifest.thresholds;
    if (!area) {
      return { level: 'p02', areaId: null };
    }

    let level: AutoLodLevel = this.level;
    if (this.level === 'p02') {
      if (probe.ratio > 0 && probe.ratio <= t.p10EnterRatio) {
        level = 'p10';
      }
    } else if (this.level === 'p10') {
      if (probe.ratio >= t.p10ExitRatio) {
        level = 'p02';
      } else if (probe.ratio > 0 && probe.ratio <= t.p100EnterRatio) {
        level = 'p100';
      }
    } else if (this.level === 'p100') {
      if (probe.ratio >= t.p100ExitRatio) {
        level = 'p10';
      }
    }

    // Fallbacks when target dataset is not ready (still swap area selection).
    if (level === 'p10' && statusFor(this.manifest, 'p10', area) !== 'ready') {
      level = 'p02';
    } else if (level === 'p100' && statusFor(this.manifest, 'p100', area) !== 'ready') {
      level = 'p10';
    }

    return { level, areaId: level === 'p02' ? null : probe.areaId };
  }

  private resolveLoadTarget(
    target: { level: AutoLodLevel; areaId: string | null },
    area: AutoLodArea | null
  ): { level: AutoLodLevel; areaId: string | null; dataset: string } | null {
    let level = target.level;
    let areaForLoad = area;
    if (level === 'p02') areaForLoad = null;

    let dataset = datasetFor(this.manifest, level, areaForLoad);
    if (dataset && statusFor(this.manifest, level, areaForLoad) === 'ready') {
      return { level, areaId: target.areaId, dataset };
    }

    // Fallback chain: p100 -> p10 -> p02.
    const fallbacks: AutoLodLevel[] = level === 'p100' ? ['p10', 'p02'] : level === 'p10' ? ['p02'] : [];
    for (const fl of fallbacks) {
      const flArea = fl === 'p02' ? null : area;
      const ds = datasetFor(this.manifest, fl, flArea);
      if (ds && statusFor(this.manifest, fl, flArea) === 'ready') {
        return { level: fl, areaId: fl === 'p02' ? null : target.areaId, dataset: ds };
      }
    }
    return null;
  }
}

/** Area focus radius = half the bbox diagonal (in manifest frame). */
export function autoLodFocusRadius(area: AutoLodArea): number {
  const b = area.bbox;
  if (!Array.isArray(b) || b.length !== 6) return 1;
  const dx = b[3] - b[0];
  const dy = b[4] - b[1];
  const dz = b[5] - b[2];
  const diag = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return diag > 0 ? diag / 2 : 1;
}