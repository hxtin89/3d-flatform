// main.ts — Entry point for the SBB CesiumJS Point Cloud Viewer
import './style.css';
import {
  DATASET,
  TILE_CONFIG,
  TILE_SOURCE,
  LOD_MODE,
  PointCloudViewer,
  type CameraSnapshot,
  type ViewerState,
} from './viewer';
import { type PresetName } from './presets';
import {
  setStatus,
  updateStats,
  setActivePreset,
  setDatasetLabel,
  setServerUrl,
  setSourceLabel,
  initPresetButtons,
  initFlyHomeButton,
  initAreaSelect,
  initUseCurrentViewButton,
  initContextLayerToggle,
  initControlsPanelToggle,
  initDetailSseSelect,
  initOverviewPointSizeSlider,
  setOverviewPointSizeScale,
  setOverviewPointSizeAvailability,
  isContextLayerEnabled,
  setAutoLodIndicator,
  setAreaOptions,
  setAreaDetectionStatus,
  setContextLayerAvailability,
  setPresetAvailability,
  setSelectedAreaOption,
  setUseCurrentViewAvailability,
} from './ui';
import {
  initDatasetReport,
  markInteraction,
  updateLoadedTilesEstimate,
  updateBrowserMetric,
  updateReportMode,
  setReportDatasetContext,
  setReportAreaDetectionContext,
  reloadDatasetReport,
  resetBrowserMetrics,
  setOverviewSseValidation,
  type BrowserMetricName,
} from './report';
import {
  fetchAreaManifest,
  findAreaForViewSamples,
  modeForPreset,
  resolveDataset,
  selectedArea,
  statusLabel,
  fetchAutoLodManifest,
  autoLodAreaForSamples,
  type AreaManifest,
  type AreaManifestEntry,
  type ResolvedDataset,
} from './manifest';
import {
  AutoLodController,
  autoLodFocusRadius,
  type AutoLodEvent,
  type AutoLodLevel,
  type AutoLodManifest,
} from './auto-lod-controller';
import { AutoLodRuntime, type AutoLodStageHost } from './auto-lod-runtime';
import type { AutoLodStageRequest } from './viewer';

setDatasetLabel(DATASET);
setSourceLabel(TILE_SOURCE);
setServerUrl(TILE_CONFIG.baseUrl || 'CloudFront not configured');
setAutoLodIndicator(LOD_MODE === 'auto');
initDatasetReport();

let areaManifest: AreaManifest | null = null;
let currentArea: AreaManifestEntry | null = null;
let currentResolved: ResolvedDataset = resolveDataset(DATASET, 'low', null, null);
let preDetailCameraSnapshot: CameraSnapshot | null = null;
let contextLayerEnabled = false;

// ── Auto-LOD (?lod=auto) runtime state ─────────────────────────────────────
// Kept fully separate from the manual flow so manual behavior is untouched.
const AUTO_LOD_MIN_ZOOM = 0.05; // allow continued zoom at p100
const AUTO_LOD_HEARTBEAT_MS = 200;
let autoLodController: AutoLodController | null = null;
let autoLodRuntime: AutoLodRuntime | null = null;
let autoLodManifest: AutoLodManifest | null = null;
let autoLodReady = false;
let autoLodCameraDirty = false;
let autoLodCameraRemoveCleanup: (() => void) | null = null;
let autoLodHeartbeat: number | null = null;
let autoLodLastProbe: { areaId: string | null; ratio: number } | null = null;
let autoLodTransitionCount = 0;
let autoLodLastTransitionDurationMs = 0;
let autoLodLastGeneration = -1;
let autoLodFlyHomePending = false;
let autoLodLastDesiredLevel: AutoLodLevel | '—' = '—';
let autoLodLastTransitionReason = '—';

type CurrentViewDetection = {
  area: AreaManifestEntry;
  detection: ReturnType<typeof findAreaForViewSamples>;
  pickedSampleCount: number;
  previousAreaId: string | null;
};

// Initialize the viewer
const viewer = new PointCloudViewer('cesium-container', {
  onStateChange: (state: ViewerState, message?: string) => {
    setStatus(state, message);
    // Update stats display after ready
    if (state === 'ready') {
      updateStats({
        sse: viewer.getSSE(),
        memory: viewer.getCacheMB(),
        tiles: 0,
      });
    }
  },
  onTileStats: (loaded: number, active?: number | string) => {
    updateStats({ tiles: loaded });
    updateLoadedTilesEstimate(loaded, active);
  },
  onPresetChange: (preset: PresetName) => {
    updateReportMode(preset);
    updateStats({
      sse: viewer.getSSE(),
      memory: viewer.getCacheMB(),
    });
    const isOverview = preset === 'low';
    setOverviewPointSizeAvailability(
      isOverview,
      isOverview ? '' : 'Available in Overview only'
    );
    if (isOverview) setOverviewPointSizeScale(viewer.getOverviewPointSizeScale());
  },
  onBrowserMetric: (metric: BrowserMetricName, value: number | string) => {
    updateBrowserMetric(metric, value);
  },
  onOverviewSseValidation: (validation: Record<string, unknown> | null) => {
    setOverviewSseValidation(validation);
  },
  onInteraction: () => {
    markInteraction();
  },
});

// Wire up UI controls
initPresetButtons((preset: PresetName) => {
  applyMode(preset, { detectCurrentViewForDetail: preset === 'high' }).catch((err) => {
    console.error('[Main] Failed to switch mode:', err);
    setStatus('error', `Mode switch failed: ${err.message}`);
  });
});

initAreaSelect((areaId: string) => {
  const area = selectedArea(areaManifest, areaId);
  selectArea(area, { reloadCurrentMode: true }).catch((err) => {
    console.error('[Main] Failed to switch area:', err);
    setStatus('error', `Area switch failed: ${err.message}`);
  });
});

initUseCurrentViewButton(() => {
  useCurrentView().catch((err) => {
    console.error('[Main] Failed to detect area from current view:', err);
    setAreaDetectionStatus(`Area detection failed: ${err.message}`);
  });
});

initContextLayerToggle((enabled: boolean) => {
  contextLayerEnabled = enabled;
  updateModeAvailability();
  const preset = viewer.getCurrentPreset();
  if (preset === 'medium' || preset === 'high') {
    applyMode(preset, { detectCurrentViewForDetail: false }).catch((err) => {
      console.error('[Main] Failed to toggle context layer:', err);
      setStatus('error', `Context toggle failed: ${err.message}`);
    });
  }
});

initDetailSseSelect((sse: number) => {
  if (autoLodReady) return; // Detail SSE disabled in auto mode.
  viewer.setDetailSseOverride(sse);
  updateStats({
    sse: viewer.getSSE(),
    memory: viewer.getCacheMB(),
  });
});

initOverviewPointSizeSlider((scale: number) => {
  viewer.setOverviewPointSizeScale(scale);
  setOverviewPointSizeScale(viewer.getOverviewPointSizeScale());
});

initFlyHomeButton(() => {
  if (autoLodReady && autoLodRuntime) {
    autoLodFlyHomePending = true;
    autoLodRuntime.requestP02();
    return;
  }
  viewer.flyHome();
});
initControlsPanelToggle();

// Set initial active preset
setActivePreset(viewer.getCurrentPreset());
updateReportMode(viewer.getCurrentPreset());

bootstrap().catch((err) => {
  console.error('[Main] Unexpected error:', err);
  setStatus('error', `Unexpected error: ${err.message}`);
});

async function bootstrap(): Promise<void> {
  if (LOD_MODE === 'auto') {
    await bootstrapAutoLod();
    return;
  }
  try {
    areaManifest = await fetchAreaManifest(DATASET);
  } catch (err) {
    console.warn('[Main] Failed to load area manifest:', err);
    areaManifest = null;
  }

  currentArea = selectedArea(areaManifest, areaManifest?.defaultAreaId ?? null);
  if (areaManifest) {
    const hasAreas = areaManifest.areas.length > 0;
    setAreaOptions(
      areaManifest.areas.map((area) => ({ areaId: area.areaId, label: area.label })),
      currentArea?.areaId ?? null
    );
    setUseCurrentViewAvailability(hasAreas, 'Area manifest is not ready yet.');
    setAreaDetectionStatus(hasAreas ? '' : 'Area manifest is not ready yet.');
  } else {
    setUseCurrentViewAvailability(false, 'Area manifest is not ready yet.');
    setAreaDetectionStatus('Area manifest is not ready yet.');
  }
  updateModeAvailability();
  await applyMode('low');
}

async function bootstrapAutoLod(): Promise<void> {
  try {
    autoLodManifest = await fetchAutoLodManifest(DATASET);
  } catch (err) {
    setStatus('error', `Invalid Auto-LOD manifest: ${(err as Error).message}`);
    return;
  }
  if (!autoLodManifest) {
    setStatus(
      'error',
      `area-manifest-auto-lod.json not found for "${DATASET}".\n-> Run: POINTCLOUD_PUBLIC_ROOT=peru-b2-globe npm run pipeline:area:auto-lod:manifest -- 2404PeruB2`
    );
    return;
  }

  autoLodController = new AutoLodController({ manifest: autoLodManifest });
  autoLodRuntime = new AutoLodRuntime({
    controller: autoLodController,
    host: makeAutoLodHost(),
    hooks: {
      onCommitted: (s) => {
        autoLodTransitionCount += 1;
        autoLodLastTransitionDurationMs = s.transitionMs;
        autoLodLastGeneration = s.generation;
        viewer.setAutoLodMinimumZoomDistance(AUTO_LOD_MIN_ZOOM);
        setActivePreset(s.preset);
        setDatasetLabel(s.dataset);
        updateReportMode(s.preset);
        // Reports only update after commit (per plan).
        resetBrowserMetrics();
        updateAutoLodTelemetry();
        reloadDatasetReport().catch(() => undefined);
        setAreaDetectionStatus(autoLodStatusMessage(s.level, s.areaId));
        // Fly Home requested p02: frame the global p02 scene once committed.
        if (s.level === 'p02' && autoLodFlyHomePending) {
          autoLodFlyHomePending = false;
          viewer.flyHome();
        }
      },
      onTimeout: (s) => {
        autoLodLastGeneration = s.generation;
        autoLodLastTransitionReason = 'timeout';
        setAreaDetectionStatus(
          `Auto-LOD: ${s.level} load timed out; keeping current dataset.`
        );
        updateAutoLodTelemetry();
      },
      onLoadError: (s) => {
        autoLodLastGeneration = s.generation;
        autoLodLastTransitionReason = `error:${s.error.message}`;
        setAreaDetectionStatus(
          `Auto-LOD: ${s.level} load failed — ${s.error.message}. Keeping current.`
        );
        updateAutoLodTelemetry();
      },
      onDesiredLevel: (level, areaId) => {
        updateBrowserMetric('lodDesiredLevel', level);
        autoLodLastDesiredLevel = level;
        autoLodLastTransitionReason = autoLodFlyHomePending ? 'fly_home' : 'camera';
        // non-blocking — no UI swap yet.
      },
    },
  });

  setDatasetLabel(autoLodManifest.dataset);

  // Disable all manual controls in auto mode (incl. Detail SSE).
  setPresetAvailability('low', false, 'Auto-LOD mode (camera-driven)');
  setPresetAvailability('medium', false, 'Auto-LOD mode (camera-driven)');
  setPresetAvailability('high', false, 'Auto-LOD mode (camera-driven)');
  setContextLayerAvailability(false, 'Auto-LOD mode');
  setUseCurrentViewAvailability(false, 'Auto-LOD mode');
  setAreaOptions([], null);
  setOverviewPointSizeAvailability(false, 'Auto-LOD mode');
  const detailSseSelect = document.getElementById('select-detail-sse') as HTMLSelectElement | null;
  if (detailSseSelect) detailSseSelect.disabled = true;
  setAreaDetectionStatus('Auto-LOD: camera-driven p02 ⇄ p10 ⇄ p100');
  updateAutoLodTelemetry();

  const p02 = autoLodManifest.levels.p02;
  if (p02.status !== 'ready' || !p02.dataset) {
    setStatus('error', `p02 overview dataset not built: ${p02.dataset || '(missing)'}`);
    return;
  }

  await viewer.loadScene({
    primary: { dataset: p02.dataset, preset: 'low' },
    cameraBehavior: 'flyTo',
  });
  viewer.adoptCurrentPrimaryAsAutoLodAnchor();
  viewer.setAutoLodMinimumZoomDistance(AUTO_LOD_MIN_ZOOM);
  autoLodReady = true;
  autoLodLastDesiredLevel = 'p02';
  setDatasetLabel(p02.dataset);
  setActivePreset('low');
  updateReportMode('low');
  resetBrowserMetrics();
  updateAutoLodTelemetry();
  reloadDatasetReport().catch(() => undefined);

  startAutoLodHeartbeat();
  setupAutoLodCameraListener();
}

function makeAutoLodHost(): AutoLodStageHost {
  return {
    stage: async (request) => {
      const stageRequest: AutoLodStageRequest = {
        generation: request.generation,
        level: request.level,
        dataset: request.dataset,
        preset: request.preset,
        onVisible: (g) => autoLodRuntime?.reportCandidateVisible(g),
      };
      await viewer.stageAutoLodCandidate(stageRequest);
    },
    commit: (generation, preset, dataset) =>
      viewer.commitAutoLodCandidate(generation, preset, dataset),
    discard: (generation) => viewer.discardAutoLodCandidate(generation),
  };
}

/** camera.changed only marks a dirty flag; the heartbeat 200 ms later does the work. */
function setupAutoLodCameraListener(): void {
  autoLodCameraRemoveCleanup = viewer.subscribeCameraChanges(() => {
    autoLodCameraDirty = true;
  });
}

function disposeAutoLod(): void {
  autoLodReady = false;
  if (autoLodHeartbeat !== null) {
    window.clearInterval(autoLodHeartbeat);
    autoLodHeartbeat = null;
  }
  autoLodCameraRemoveCleanup?.();
  autoLodCameraRemoveCleanup = null;
  autoLodRuntime?.dispose();
  autoLodRuntime = null;
}

window.addEventListener('beforeunload', disposeAutoLod);

function startAutoLodHeartbeat(): void {
  if (autoLodHeartbeat !== null) return;
  let lastSampleAt = 0;
  autoLodHeartbeat = window.setInterval(() => {
    if (!autoLodReady || !autoLodController || !autoLodManifest) return;
    if (!autoLodRuntime) return;

    const dirty = autoLodCameraDirty;

    // No movement: feed cached probe so settle/timeout/retry still progress.
    if (!dirty) {
      if (autoLodLastProbe) {
        const evt = autoLodController.update(autoLodLastProbe);
        autoLodRuntime.dispatchEvent(evt);
      }
      return;
    }

    // Throttle re-sampling to at most 5 batches per second when moving.
    const now = performance.now();
    if (now - lastSampleAt < 200) {
      // Keep dirty flag set so the next heartbeat retries real sampling.
      if (autoLodLastProbe) {
        const evt = autoLodController.update(autoLodLastProbe);
        autoLodRuntime.dispatchEvent(evt);
      }
      return;
    }
    // Camera moved past the throttle window: clear dirty and sample now.
    autoLodCameraDirty = false;
    lastSampleAt = now;

    const samples = viewer.getCurrentViewSamples();
    const detected = autoLodAreaForSamples(autoLodManifest, samples);
    const area = autoLodController.areaById(detected.areaId);
    const range = viewer.getActiveCameraRange();
    const focus = area ? autoLodFocusRadius(area) : 0;
    const ratio = focus > 0 ? range / focus : 0;

    autoLodLastProbe = { areaId: detected.areaId, ratio };
    const evt = autoLodController.update(autoLodLastProbe);
    autoLodRuntime.dispatchEvent(evt);
    updateAutoLodTelemetry();
  }, AUTO_LOD_HEARTBEAT_MS);
}

function autoLodStatusMessage(level: AutoLodLevel, areaId: string | null): string {
  const label = areaId ? autoLodController?.areaById(areaId)?.label ?? areaId : 'global';
  return `Auto-LOD → ${level} (${label})`;
}

function updateAutoLodTelemetry(): void {
  if (!autoLodController) return;
  const state = autoLodController.getState();
  setReportDatasetContext({
    logicalDataset: autoLodManifest?.dataset ?? DATASET,
    resolvedDataset: viewer.getActiveDataset(),
    selectedAreaId: state.areaId,
    modeStatus: state.status,
    sourceChunkId: autoLodController.areaById(state.areaId)?.sourceChunkId ?? null,
  });
  updateBrowserMetric('lodCurrentLevel', state.level);
  updateBrowserMetric('lodDesiredLevel', autoLodLastDesiredLevel);
  updateBrowserMetric('lodAreaId', state.areaId ?? '');
  updateBrowserMetric('lodRangeRatio', Number(state.lastRatio.toFixed(3)));
  updateBrowserMetric('lodTransitionStatus', state.status);
  updateBrowserMetric('lodTransitionReason', autoLodLastTransitionReason);
  updateBrowserMetric('lodTransitionCount', autoLodTransitionCount);
  updateBrowserMetric('lodGeneration', state.inflightGeneration ?? autoLodLastGeneration);
  // Duration is the most recent committed stage's elapsed time, not time-since.
  updateBrowserMetric('lodTransitionMs', Math.round(autoLodLastTransitionDurationMs));
}

async function applyMode(
  preset: PresetName,
  opts: { detectCurrentViewForDetail?: boolean; forceReload?: boolean } = {}
): Promise<void> {
  const previousPreset = viewer.getCurrentPreset();
  let currentViewDetection: CurrentViewDetection | null = null;
  if (preset === 'high' && opts.detectCurrentViewForDetail) {
    const detected = detectCurrentViewArea('high');
    if (detected?.area) {
      currentViewDetection = detected;
      currentArea = detected.area;
      setSelectedAreaOption(currentArea.areaId);
      updateModeAvailability();
      setAreaDetectionStatus(`Detected ${areaLabel(currentArea)} from current view ${detectionStatusSuffix(detected.detection)}.`);
      setAreaDetectionReport('selected_for_detail', currentArea.areaId, detected.previousAreaId, 'high', {
        sampleCount: detected.detection.sampleCount,
        matchedSampleCount: detected.detection.matchedSampleCount,
        pickedSampleCount: detected.pickedSampleCount,
        fallbackUsed: detected.detection.fallbackUsed,
        reason: detected.detection.reason,
      });
    }
  }

  const resolved = resolveDataset(DATASET, preset, areaManifest, currentArea);
  if (preset !== 'low' && resolved.modeStatus !== 'ready') {
    if (currentViewDetection) {
      const mode = modeForPreset(preset);
      const status = statusLabel(mode, resolved.modeStatus);
      setAreaDetectionStatus(
        `Detected ${areaLabel(currentViewDetection.area)} ${detectionStatusSuffix(currentViewDetection.detection)}, but ${mode} is ${status}. Keeping current loaded dataset.`
      );
      setAreaDetectionReport('mode_not_ready', currentViewDetection.area.areaId, currentViewDetection.previousAreaId, preset, {
        sampleCount: currentViewDetection.detection.sampleCount,
        matchedSampleCount: currentViewDetection.detection.matchedSampleCount,
        pickedSampleCount: currentViewDetection.pickedSampleCount,
        fallbackUsed: currentViewDetection.detection.fallbackUsed,
        reason: `${mode}_${resolved.modeStatus}`,
      });
    }
    return;
  }
  const wantsContext = preset !== 'low' && contextLayerEnabled;
  const canLoadContext = wantsContext && resolved.contextStatus === 'ready' && Boolean(resolved.contextDataset);
  if (wantsContext && !canLoadContext) {
    setAreaDetectionStatus(
      `Context layer is ${resolved.contextStatusLabel ?? 'not ready'}; loading ${modeForPreset(preset)} focus only. Run npm run pipeline:area:overview:p001:excluding -- ${DATASET}.`
    );
  }

  const restoreSnapshot = preset === 'low' && previousPreset !== 'low'
    ? preDetailCameraSnapshot
    : null;
  if (preset !== 'low' && previousPreset === 'low') {
    preDetailCameraSnapshot = viewer.captureCameraSnapshot();
  }

  const reportResolved = canLoadContext ? resolved : {
    ...resolved,
    contextDataset: null,
    contextStatus: null,
    contextStatusLabel: null,
    contextExcludedAreaId: null,
    contextExcludedSourceChunkId: null,
  };
  currentResolved = reportResolved;
  viewer.setPreset(preset);
  setActivePreset(preset);
  setDatasetLabel(resolved.resolvedDataset);
  updateReportMode(preset);
  setReportDatasetContext(reportResolved);
  resetBrowserMetrics();
  updateBrowserMetric('framingMode', preset === 'low'
    ? restoreSnapshot ? 'restore' : 'flyTo'
    : 'preserve');
  await reloadDatasetReport();
  if (preset !== 'low') {
    await viewer.loadScene({
      primary: { dataset: resolved.resolvedDataset, preset },
      context: canLoadContext && resolved.contextDataset
        ? { dataset: resolved.contextDataset, preset: 'low' }
        : null,
      cameraBehavior: 'preserve',
    });
  } else if (restoreSnapshot) {
    await viewer.loadScene({
      primary: { dataset: resolved.resolvedDataset, preset },
      cameraBehavior: 'restore',
      snapshot: restoreSnapshot,
    });
    preDetailCameraSnapshot = null;
  } else {
    await viewer.loadTileset(resolved.resolvedDataset);
  }
  updateStats({
    sse: viewer.getSSE(),
    memory: viewer.getCacheMB(),
    tiles: 0,
  });
}

function updateModeAvailability(): void {
  contextLayerEnabled = isContextLayerEnabled();
  const overviewStatus = resolveDataset(DATASET, 'low', areaManifest, currentArea).modeStatus;
  setPresetAvailability('low', true, statusLabel('overview', overviewStatus));
  const exploreResolved = resolveDataset(DATASET, 'medium', areaManifest, currentArea);
  const exploreStatus = exploreResolved.modeStatus;
  const detailResolved = resolveDataset(DATASET, 'high', areaManifest, currentArea);
  const detailStatus = detailResolved.modeStatus;
  setContextLayerAvailability(Boolean(areaManifest?.areas.length), 'Area manifest is not ready yet.');
  setPresetAvailability(
    'medium',
    exploreStatus === 'ready',
    exploreStatus === 'ready'
      ? !contextLayerEnabled
        ? 'ready (context off)'
        : exploreResolved.contextStatus === 'ready'
        ? 'ready + context'
        : 'ready (focus only)'
      : statusLabel(modeForPreset('medium'), exploreStatus)
  );
  setPresetAvailability(
    'high',
    detailStatus === 'ready',
    detailStatus === 'ready'
      ? !contextLayerEnabled
        ? 'ready (context off)'
        : detailResolved.contextStatus === 'ready'
        ? 'ready + context'
        : 'ready (focus only)'
      : statusLabel(modeForPreset('high'), detailStatus)
  );
  setReportDatasetContext(currentResolved);
}

function detectCurrentViewArea(preset: PresetName): {
  area: AreaManifestEntry;
  detection: ReturnType<typeof findAreaForViewSamples>;
  pickedSampleCount: number;
  previousAreaId: string | null;
} | null {
  const previousAreaId = currentArea?.areaId ?? null;
  if (!areaManifest) {
    setAreaDetectionStatus('Area manifest is not ready yet.');
    return null;
  }

  const samples = viewer.getCurrentViewSamples();
  const pickedSampleCount = samples.filter((sample) => sample.source === 'pickPosition').length;
  if (samples.length === 0) {
    setAreaDetectionStatus('No current-view samples. Existing area selection kept.');
    setAreaDetectionReport('no_samples', null, previousAreaId, preset, {
      sampleCount: 0,
      matchedSampleCount: 0,
      pickedSampleCount,
      fallbackUsed: false,
      reason: 'no_samples',
    });
    return null;
  }

  const detection = findAreaForViewSamples(areaManifest, samples);
  if (!detection.area) {
    setAreaDetectionStatus(`No area found for current view ${detectionStatusSuffix(detection)}. Existing area selection kept.`);
    setAreaDetectionReport('no_match', null, previousAreaId, preset, {
      sampleCount: detection.sampleCount,
      matchedSampleCount: detection.matchedSampleCount,
      pickedSampleCount,
      fallbackUsed: detection.fallbackUsed,
      reason: detection.reason,
    });
    return null;
  }

  return {
    area: detection.area,
    detection,
    pickedSampleCount,
    previousAreaId,
  };
}

async function useCurrentView(): Promise<void> {
  const preset = viewer.getCurrentPreset();
  const previousAreaId = currentArea?.areaId ?? null;
  if (!areaManifest) {
    setAreaDetectionStatus('Area manifest is not ready yet.');
    setAreaDetectionReport('manifest_not_ready', null, previousAreaId, preset, {
      sampleCount: 0,
      matchedSampleCount: 0,
      pickedSampleCount: 0,
      fallbackUsed: false,
      reason: 'manifest_not_ready',
    });
    return;
  }

  const detected = detectCurrentViewArea(preset);
  if (!detected?.area) return;

  const detectedArea = detected.area;
  const detection = detected.detection;
  const pickedSampleCount = detected.pickedSampleCount;
  const label = areaLabel(detectedArea);
  if (detectedArea.areaId === currentArea?.areaId) {
    if (preset === 'medium' || preset === 'high') {
      setAreaDetectionStatus(`Current view is already inside ${label}; reloading ${modeForPreset(preset)} ${detectionStatusSuffix(detection)}.`);
      setAreaDetectionReport('already_selected_reloaded', detectedArea.areaId, previousAreaId, preset, {
        sampleCount: detection.sampleCount,
        matchedSampleCount: detection.matchedSampleCount,
        pickedSampleCount,
        fallbackUsed: detection.fallbackUsed,
        reason: detection.reason,
      });
      await applyMode(preset, { detectCurrentViewForDetail: false, forceReload: true });
      return;
    }

    setAreaDetectionStatus(`Current view is already inside ${label} ${detectionStatusSuffix(detection)}.`);
    setAreaDetectionReport('already_selected', detectedArea.areaId, previousAreaId, preset, {
      sampleCount: detection.sampleCount,
      matchedSampleCount: detection.matchedSampleCount,
      pickedSampleCount,
      fallbackUsed: detection.fallbackUsed,
      reason: detection.reason,
    });
    return;
  }

  const resolved = resolveDataset(DATASET, preset, areaManifest, detectedArea);
  if (preset !== 'low' && resolved.modeStatus !== 'ready') {
    const mode = modeForPreset(preset);
    const status = statusLabel(mode, resolved.modeStatus);
    currentArea = detectedArea;
    setSelectedAreaOption(currentArea.areaId);
    updateModeAvailability();
    setAreaDetectionStatus(`Detected ${label} ${detectionStatusSuffix(detection)}, but ${mode} is ${status}. Keeping current loaded dataset.`);
    setAreaDetectionReport('mode_not_ready', detectedArea.areaId, previousAreaId, preset, {
      sampleCount: detection.sampleCount,
      matchedSampleCount: detection.matchedSampleCount,
      pickedSampleCount,
      fallbackUsed: detection.fallbackUsed,
      reason: `${mode}_${resolved.modeStatus}`,
    });
    return;
  }

  await selectArea(detectedArea, {
    reloadCurrentMode: preset !== 'low',
    statusMessage: `Detected ${label} from current view ${detectionStatusSuffix(detection)}.`,
  });
  setAreaDetectionReport('selected', detectedArea.areaId, previousAreaId, preset, {
    sampleCount: detection.sampleCount,
    matchedSampleCount: detection.matchedSampleCount,
    pickedSampleCount,
    fallbackUsed: detection.fallbackUsed,
    reason: detection.reason,
  });
}

async function selectArea(
  area: AreaManifestEntry | null,
  opts: { reloadCurrentMode: boolean; statusMessage?: string }
): Promise<void> {
  currentArea = area;
  setSelectedAreaOption(currentArea?.areaId ?? null);
  updateModeAvailability();
  if (opts.statusMessage) setAreaDetectionStatus(opts.statusMessage);

  if (!opts.reloadCurrentMode) {
    currentResolved = resolveDataset(DATASET, viewer.getCurrentPreset(), areaManifest, currentArea);
    setReportDatasetContext(currentResolved);
    return;
  }

  const preset = viewer.getCurrentPreset();
  const resolved = resolveDataset(DATASET, preset, areaManifest, currentArea);
  if (resolved.modeStatus !== 'ready') {
    await applyMode('low');
    return;
  }
  await applyMode(preset, { detectCurrentViewForDetail: false });
}

function areaLabel(area: AreaManifestEntry): string {
  return area.label || area.areaId;
}

function detectionStatusSuffix(detection: {
  matchedSampleCount: number;
  sampleCount: number;
  fallbackUsed: boolean;
}): string {
  const fallback = detection.fallbackUsed ? ', orbit fallback' : '';
  return `(${detection.matchedSampleCount}/${detection.sampleCount} samples${fallback})`;
}

function setAreaDetectionReport(
  status: string,
  detectedAreaId: string | null,
  previousAreaId: string | null,
  preset: PresetName,
  details: {
    sampleCount: number;
    matchedSampleCount: number;
    pickedSampleCount: number;
    fallbackUsed: boolean;
    reason: string;
  }
): void {
  setReportAreaDetectionContext({
    status,
    detectedAreaId,
    previousAreaId,
    currentMode: modeForPreset(preset),
    ...details,
  });
}
