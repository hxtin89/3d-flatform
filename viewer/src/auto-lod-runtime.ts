// auto-lod-runtime.ts — Host-agnostic orchestrator that turns AutoLodController
// events into stage/commit/discard commands against a host layer lifecycle.
// Pure TS (no Cesium import), unit-testable with a fake host.
import {
  AutoLodController,
  type AutoLodEvent,
  type AutoLodLevel,
} from './auto-lod-controller';
import type { PresetName } from './presets';

export interface AutoLodStageHost {
  stage(request: {
    generation: number;
    level: AutoLodLevel;
    dataset: string;
    preset: PresetName;
    onVisible: (generation: number) => void;
  }): Promise<void>;
  commit(generation: number, preset: PresetName, dataset: string): boolean;
  discard(generation: number): void;
}

export interface AutoLodRuntimeHooks {
  /** Called after a successful commit (dataset/preset have been swapped). */
  onCommitted?(state: {
    generation: number;
    level: AutoLodLevel;
    areaId: string | null;
    dataset: string;
    preset: PresetName;
    transitionMs: number;
  }): void;
  /** Called when a load timed out; non-blocking status update. */
  onTimeout?(state: { generation: number; level: AutoLodLevel }): void;
  /** Called when a load failed (host error); non-blocking status update. */
  onLoadError?(state: { generation: number; level: AutoLodLevel; error: Error }): void;
  /** Called when the desired level changes (UI hint, non-blocking). */
  onDesiredLevel?(level: AutoLodLevel, areaId: string | null): void;
}

export interface AutoLodRuntimeConfig {
  controller: AutoLodController;
  host: AutoLodStageHost;
  hooks?: AutoLodRuntimeHooks;
  /** Injectable clock (ms). Defaults to performance.now. */
  now?: () => number;
}

interface ActiveStage {
  generation: number;
  level: AutoLodLevel;
  areaId: string | null;
  dataset: string;
  preset: PresetName;
  startedAt: number;
}

export class AutoLodRuntime {
  private readonly controller: AutoLodController;
  private readonly host: AutoLodStageHost;
  private readonly hooks: AutoLodRuntimeHooks;
  private readonly now: () => number;

  private active: ActiveStage | null = null;
  private disposed = false;

  constructor(config: AutoLodRuntimeConfig) {
    this.controller = config.controller;
    this.host = config.host;
    this.hooks = config.hooks ?? {};
    this.now =
      config.now ??
      (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  }

  getController(): AutoLodController {
    return this.controller;
  }

  /** Dispatch a single controller event. Safe to call repeatedly. */
  dispatchEvent(evt: AutoLodEvent | null): void {
    if (this.disposed || !evt) return;

    if (evt.type === 'load') {
      this.startStage(evt);
      return;
    }

    if (evt.type === 'timeout') {
      // Stale stage must be discarded; keep active committed layer.
      this.host.discard(evt.generation);
      if (this.active?.generation === evt.generation) this.active = null;
      this.hooks.onTimeout?.({ generation: evt.generation, level: evt.level });
      return;
    }

    // retry_scheduled is informational only.
  }

  /** Host calls this when an async stage promise rejects. */
  reportLoadError(generation: number, error: Error): void {
    const stage = this.active;
    if (!stage || stage.generation !== generation) return;
    this.host.discard(generation);
    this.active = null;
    // Mark the controller inflight as failed so it leaves the 'requesting'
    // status and arms the retry window.
    this.controller.markFailed(generation);
    this.hooks.onLoadError?.({ generation, level: stage.level, error });
  }

  /**
   * Called when the host's staged candidate emits `onVisible`. Only commits
   * the candidate whose generation is still inflight in the controller; a
   * stale completion (superseded while loading) is discarded.
   */
  reportCandidateVisible(generation: number): void {
    const stage = this.active;
    if (!stage || stage.generation !== generation) return;
    // Stale-request protection: only commit when this generation is still the
    // controller's inflight request. If the controller has already moved on
    // (superseded), discard the candidate without swapping scene.
    if (!this.controller.isInflightGeneration(generation)) {
      this.host.discard(generation);
      this.active = null;
      return;
    }
    const ok = this.host.commit(generation, stage.preset, stage.dataset);
    if (!ok) {
      // Commit refused (superseded between visible and commit): discard.
      this.host.discard(generation);
      this.active = null;
      return;
    }
    const committed = this.controller.markVisible(generation);
    if (!committed) {
      // Controller already superseded: host has just promoted a stale layer.
      // Caller is responsible for its own rollback; we only clear runtime.
      this.active = null;
      return;
    }
    const transitionMs = this.now() - stage.startedAt;
    this.hooks.onCommitted?.({
      generation,
      level: stage.level,
      areaId: stage.areaId,
      dataset: stage.dataset,
      preset: stage.preset,
      transitionMs,
    });
    this.active = null;
  }

  /** Force an immediate transition to p02 (used by Fly Home). */
  requestP02(): void {
    if (this.disposed) return;
    // Discard any active stage.
    if (this.active) {
      this.host.discard(this.active.generation);
      this.active = null;
    }
    const req = this.controller.requestImmediate('p02');
    if (!req) return;
    this.active = {
      generation: req.generation,
      level: req.level,
      areaId: req.areaId,
      dataset: req.dataset,
      preset: req.preset,
      startedAt: this.now(),
    };
    this.hooks.onDesiredLevel?.(req.level, req.areaId);
    void this.host
      .stage({
        generation: req.generation,
        level: req.level,
        dataset: req.dataset,
        preset: req.preset,
        onVisible: (g) => this.reportCandidateVisible(g),
      })
      .catch((err: Error) => this.reportLoadError(req.generation, err));
  }

  isStaging(): boolean {
    return this.active !== null;
  }

  dispose(): void {
    this.disposed = true;
    if (this.active) {
      this.host.discard(this.active.generation);
      this.active = null;
    }
  }

  private startStage(evt: Extract<AutoLodEvent, { type: 'load' }>): void {
    // Supersede any prior stage.
    if (this.active) {
      this.host.discard(this.active.generation);
      this.active = null;
    }
    this.active = {
      generation: evt.generation,
      level: evt.level,
      areaId: evt.areaId,
      dataset: evt.dataset,
      preset: evt.preset,
      startedAt: this.now(),
    };
    this.hooks.onDesiredLevel?.(evt.level, evt.areaId);
    void this.host
      .stage({
        generation: evt.generation,
        level: evt.level,
        dataset: evt.dataset,
        preset: evt.preset,
        onVisible: (g) => this.reportCandidateVisible(g),
      })
      .catch((err: Error) => this.reportLoadError(evt.generation, err));
  }

  }
