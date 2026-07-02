// overview-sse-controller.ts — Sticky SSE 64 controller for Overview
import * as Cesium from 'cesium';
import {
  OVERVIEW_SSE_BOOTSTRAP,
  OVERVIEW_SSE_TRAVEL,
  OVERVIEW_SSE_READY,
  OVERVIEW_SSE_BOOTSTRAP_TIMEOUT_MS,
  OVERVIEW_SSE_TRAVEL_SETTLE_MS,
  OVERVIEW_TRAVEL_DISTANCE_THRESHOLD_M,
} from './presets';

export interface BootstrapValidation {
  coarseBootstrapReady: boolean;
  coarseContentTileCount: number;
  coarseContentBytes: number;
  coarseContentMaxDepth: number;
  missingBranches: string[];
}

export type OverviewSsePhase = 'bootstrap' | 'travel' | 'refining' | 'ready';

export interface OverviewSseMetrics {
  bootstrapRequests: number;
  bootstrapBytes: number | 'unsupported';
  travelRequests: number;
  travelBytes: number | 'unsupported';
  refiningRequests: number;
  refiningBytes: number | 'unsupported';
  readyRequests: number;
  readyBytes: number | 'unsupported';
}

export type OverviewSseMetricName =
  | 'overviewSsePhase'
  | 'overviewSse'
  | 'overviewBootstrapRequests'
  | 'overviewBootstrapBytes'
  | 'overviewTravelRequests'
  | 'overviewTravelBytes'
  | 'overviewRefiningRequests'
  | 'overviewRefiningBytes'
  | 'overviewReadyRequests'
  | 'overviewReadyBytes'
  | 'overviewTravelDistance';

export type OverviewSseMetricCallback = (
  name: OverviewSseMetricName,
  value: string | number
) => void;

interface PhaseRecord {
  timestamp: number;
  phase: OverviewSsePhase;
  sse: number;
}

const OVERVIEW_READY_STABLE_MS = 1_000;

export class OverviewSseController {
  private tileset: Cesium.Cesium3DTileset | null = null;
  private validation: BootstrapValidation | null = null;
  private phase: OverviewSsePhase = 'ready';
  private sse = OVERVIEW_SSE_READY;
  private bootstrapTimeout: ReturnType<typeof setTimeout> | null = null;
  private travelSettleTimer: ReturnType<typeof setTimeout> | null = null;
  private active = false;
  private loadGeneration = 0;
  private travelDistance = 0;
  private refiningReadySince: number | null = null;

  private phaseHistory: PhaseRecord[] = [];
  private observer: PerformanceObserver | null = null;
  private metrics: OverviewSseMetrics = {
    bootstrapRequests: 0,
    bootstrapBytes: 0,
    travelRequests: 0,
    travelBytes: 0,
    refiningRequests: 0,
    refiningBytes: 0,
    readyRequests: 0,
    readyBytes: 0,
  };
  private bytesSupported = true;
  private callback: OverviewSseMetricCallback | null = null;

  setCallback(callback: OverviewSseMetricCallback | null): void {
    this.callback = callback;
  }

  async fetchValidation(tilesetUrl: string): Promise<BootstrapValidation | null> {
    try {
      const baseUrl = tilesetUrl.replace(/\/tileset\.json$/, '');
      const response = await fetch(`${baseUrl}/bootstrap-validation.json`, {
        cache: 'no-store',
      });
      if (!response.ok) return null;
      return (await response.json()) as BootstrapValidation;
    } catch {
      return null;
    }
  }

  activate(
    tileset: Cesium.Cesium3DTileset,
    validation: BootstrapValidation | null
  ): void {
    this.cleanup();
    this.loadGeneration += 1;
    const generation = this.loadGeneration;
    this.tileset = tileset;
    this.validation = validation;
    this.active = true;

    this.metrics = {
      bootstrapRequests: 0,
      bootstrapBytes: 0,
      travelRequests: 0,
      travelBytes: 0,
      refiningRequests: 0,
      refiningBytes: 0,
      readyRequests: 0,
      readyBytes: 0,
    };
    this.travelDistance = 0;
    this.bytesSupported = true;
    this.phaseHistory = [];

    this.startPerformanceObserver();

    if (validation?.coarseBootstrapReady) {
      this.recordPhase('bootstrap', OVERVIEW_SSE_BOOTSTRAP);
      this.applySse(OVERVIEW_SSE_BOOTSTRAP);
      this.scheduleBootstrapTimeout(generation);
    } else {
      this.recordPhase('refining', OVERVIEW_SSE_READY);
      this.applySse(OVERVIEW_SSE_READY);
    }
  }

  deactivate(): void {
    this.cleanup();
  }

  onFirstVisible(): void {
    if (!this.active) return;
    if (this.phase !== 'bootstrap') return;
    this.cancelBootstrapTimeout();
    this.recordPhase('refining', OVERVIEW_SSE_READY);
    this.applySse(OVERVIEW_SSE_READY);
  }

  onAllTilesLoaded(): void {
    if (!this.active) return;
    if (this.phase !== 'refining') return;
    this.refiningReadySince ??= performance.now();
  }

  onTilesetFrame(tilesLoaded: boolean): void {
    if (!this.active) return;
    if (this.phase !== 'refining') return;
    if (!tilesLoaded) {
      this.refiningReadySince = null;
      return;
    }
    const now = performance.now();
    if (this.refiningReadySince === null) {
      this.refiningReadySince = now;
      return;
    }
    if (now - this.refiningReadySince < OVERVIEW_READY_STABLE_MS) return;
    this.recordPhase('ready', OVERVIEW_SSE_READY);
  }

  beginTravel(distanceMeters: number): boolean {
    if (!this.active) return false;
    if (distanceMeters < OVERVIEW_TRAVEL_DISTANCE_THRESHOLD_M) return false;
    this.cancelBootstrapTimeout();
    this.cancelTravelSettleTimer();
    this.travelDistance = distanceMeters;
    this.recordPhase('travel', OVERVIEW_SSE_TRAVEL);
    this.applySse(OVERVIEW_SSE_TRAVEL);
    this.emit('overviewTravelDistance', distanceMeters);
    return true;
  }

  endTravel(started: boolean): void {
    if (!this.active || !started) return;
    this.scheduleTravelSettle(this.loadGeneration);
  }

  getCurrentSse(): number {
    return this.sse;
  }

  getPhase(): OverviewSsePhase {
    return this.phase;
  }

  getMetrics(): OverviewSseMetrics {
    return { ...this.metrics };
  }

  getValidation(): BootstrapValidation | null {
    return this.validation;
  }

  dispose(): void {
    this.cleanup();
  }

  private cleanup(): void {
    this.active = false;
    this.refiningReadySince = null;
    this.cancelBootstrapTimeout();
    this.cancelTravelSettleTimer();
    if (this.observer) {
      try {
        this.observer.disconnect();
      } catch {
        // ignore
      }
      this.observer = null;
    }
    this.tileset = null;
    this.validation = null;
  }

  private cancelBootstrapTimeout(): void {
    if (this.bootstrapTimeout) {
      clearTimeout(this.bootstrapTimeout);
      this.bootstrapTimeout = null;
    }
  }

  private cancelTravelSettleTimer(): void {
    if (this.travelSettleTimer) {
      clearTimeout(this.travelSettleTimer);
      this.travelSettleTimer = null;
    }
  }

  private scheduleBootstrapTimeout(generation: number): void {
    this.cancelBootstrapTimeout();
    this.bootstrapTimeout = setTimeout(() => {
      if (!this.active || this.loadGeneration !== generation) return;
      if (this.phase !== 'bootstrap') return;
      this.recordPhase('refining', OVERVIEW_SSE_READY);
      this.applySse(OVERVIEW_SSE_READY);
    }, OVERVIEW_SSE_BOOTSTRAP_TIMEOUT_MS);
  }

  private scheduleTravelSettle(generation: number): void {
    this.cancelTravelSettleTimer();
    this.travelSettleTimer = setTimeout(() => {
      if (!this.active || this.loadGeneration !== generation) return;
      if (this.phase !== 'travel') return;
      this.recordPhase('refining', OVERVIEW_SSE_READY);
      this.applySse(OVERVIEW_SSE_READY);
    }, OVERVIEW_SSE_TRAVEL_SETTLE_MS);
  }

  private applySse(sse: number): void {
    this.sse = sse;
    if (this.tileset) {
      this.tileset.maximumScreenSpaceError = sse;
    }
    this.emit('overviewSse', sse);
  }

  private recordPhase(phase: OverviewSsePhase, sse: number): void {
    this.phase = phase;
    if (phase === 'refining') {
      // Packed/external tilesets can briefly report tilesLoaded while their next
      // refinement branch is still being discovered. Require a quiet interval.
      this.refiningReadySince = null;
    }
    this.phaseHistory.push({ timestamp: performance.now(), phase, sse });
    this.emit('overviewSsePhase', phase);
  }

  private startPerformanceObserver(): void {
    if (!('PerformanceObserver' in window)) return;
    try {
      this.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.handleResourceEntry(entry as PerformanceResourceTiming);
        }
      });
      this.observer.observe({ entryTypes: ['resource'] });
    } catch {
      this.observer = null;
    }
  }

  private handleResourceEntry(entry: PerformanceResourceTiming): void {
    if (!entry.name.endsWith('.pnts')) return;
    let metricPhase = this.phaseAt(entry.startTime);
    if (!metricPhase) return;

    if (metricPhase === 'ready') {
      // A ready phase that still produces point requests was only temporarily
      // idle (common while external tileset branches are being discovered).
      // Attribute that work to refinement and reopen the settling window.
      metricPhase = 'refining';
      this.refiningReadySince = null;
      if (this.phase === 'ready') {
        this.recordPhase('refining', OVERVIEW_SSE_READY);
      }
    }

    const hasSize =
      entry.transferSize > 0 ||
      entry.encodedBodySize > 0 ||
      entry.decodedBodySize > 0;
    if (!hasSize) {
      this.bytesSupported = false;
    }
    const bytes =
      entry.transferSize || entry.encodedBodySize || entry.decodedBodySize || 0;

    switch (metricPhase) {
      case 'bootstrap':
        this.metrics.bootstrapRequests += 1;
        this.metrics.bootstrapBytes = this.accumulate(
          this.metrics.bootstrapBytes,
          bytes
        );
        break;
      case 'travel':
        this.metrics.travelRequests += 1;
        this.metrics.travelBytes = this.accumulate(
          this.metrics.travelBytes,
          bytes
        );
        break;
      case 'refining':
        this.metrics.refiningRequests += 1;
        this.metrics.refiningBytes = this.accumulate(
          this.metrics.refiningBytes,
          bytes
        );
        break;
    }
    this.emitMetrics();
  }

  private phaseAt(timestamp: number): OverviewSsePhase | null {
    if (this.phaseHistory.length === 0) return null;
    if (timestamp < this.phaseHistory[0].timestamp) return null;
    let current: OverviewSsePhase | null = null;
    for (const record of this.phaseHistory) {
      if (record.timestamp <= timestamp) {
        current = record.phase;
      } else {
        break;
      }
    }
    return current;
  }

  private accumulate(
    current: number | 'unsupported',
    bytes: number
  ): number | 'unsupported' {
    if (!this.bytesSupported || current === 'unsupported') return 'unsupported';
    return current + bytes;
  }

  private emitMetrics(): void {
    this.emit('overviewBootstrapRequests', this.metrics.bootstrapRequests);
    this.emit('overviewBootstrapBytes', this.metrics.bootstrapBytes);
    this.emit('overviewTravelRequests', this.metrics.travelRequests);
    this.emit('overviewTravelBytes', this.metrics.travelBytes);
    this.emit('overviewRefiningRequests', this.metrics.refiningRequests);
    this.emit('overviewRefiningBytes', this.metrics.refiningBytes);
    this.emit('overviewReadyRequests', this.metrics.readyRequests);
    this.emit('overviewReadyBytes', this.metrics.readyBytes);
  }

  private emit(name: OverviewSseMetricName, value: string | number): void {
    this.callback?.(name, value);
  }
}
