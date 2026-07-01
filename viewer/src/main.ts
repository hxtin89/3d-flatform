// main.ts — Entry point for the SBB CesiumJS Point Cloud Viewer
import './style.css';
import {
  DATASET,
  TILE_CONFIG,
  TILE_SOURCE,
  PointCloudViewer,
  type CameraSnapshot,
  type DetailContextMode,
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
  initDetailContextSelect,
  isContextLayerEnabled,
  setDetailContextAvailability,
  setDetailContextModeValue,
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
  setReportMicroTransitionContext,
  setReportDetailContextMode,
  reloadDatasetReport,
  resetBrowserMetrics,
  type BrowserMetricName,
} from './report';
import {
  fetchAreaManifest,
  fetchMicroAreaManifest,
  findAreaForViewSamples,
  findMicroAreaForViewSamples,
  modeForPreset,
  resolveDataset,
  selectedArea,
  statusLabel,
  type AreaManifest,
  type AreaManifestEntry,
  type MicroAreaEntry,
  type MicroAreaManifest,
  type ResolvedDataset,
} from './manifest';
import { evaluateZoomExitState } from './detail-micro-lifecycle';

setDatasetLabel(DATASET);
setSourceLabel(TILE_SOURCE);
setServerUrl(TILE_CONFIG.baseUrl || 'CloudFront not configured');
initDatasetReport();

let areaManifest: AreaManifest | null = null;
let currentArea: AreaManifestEntry | null = null;
let currentResolved: ResolvedDataset = resolveDataset(DATASET, 'low', null, null);
let preDetailCameraSnapshot: CameraSnapshot | null = null;
let contextLayerEnabled = false;
let currentMicroArea: MicroAreaEntry | null = null;
const microManifestCache = new Map<string, MicroAreaManifest>();
let microMoveTimer: number | null = null;
let microConfirmationTimer: number | null = null;
let microSwitchGeneration = 0;
let microSwitchCount = 0;
let microZoomExitArmed = false;

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
  },
  onBrowserMetric: (metric: BrowserMetricName, value: number | string | boolean) => {
    updateBrowserMetric(metric, value);
  },
  onInteraction: () => {
    markInteraction();
  },
  onViewSettled: () => {
    scheduleMicroViewEvaluation();
  },
  onDetailContextModeChange: (mode: DetailContextMode, reason: string | null) => {
    setDetailContextModeValue(mode);
    setReportDetailContextMode(mode);
    if (reason) setAreaDetectionStatus(`Detail Context disabled: ${reason}`);
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
  viewer.setDetailSseOverride(sse);
  updateStats({
    sse: viewer.getSSE(),
    memory: viewer.getCacheMB(),
  });
});

initDetailContextSelect((mode: DetailContextMode) => {
  setReportDetailContextMode(mode);
  viewer.setDetailContextMode(mode).catch((err) => {
    console.error('[Main] Failed to set Detail context mode:', err);
  });
});

initFlyHomeButton(() => {
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

async function loadMicroManifest(area: AreaManifestEntry): Promise<MicroAreaManifest | null> {
  const ref = area.datasets.detailMicro;
  if (!ref || ref.status !== 'ready') return null;
  const cached = microManifestCache.get(ref.manifest);
  if (cached) return cached;
  const manifest = await fetchMicroAreaManifest(ref.manifest);
  if (manifest) microManifestCache.set(ref.manifest, manifest);
  return manifest;
}

function microZoomExitThreshold(cell: MicroAreaEntry): number {
  const width = Math.max(cell.bbox[3] - cell.bbox[0], 0);
  const height = Math.max(cell.bbox[4] - cell.bbox[1], 0);
  return Math.hypot(width, height) * 2.5;
}

function clearMicroTimers(): void {
  if (microMoveTimer !== null) window.clearTimeout(microMoveTimer);
  if (microConfirmationTimer !== null) window.clearTimeout(microConfirmationTimer);
  microMoveTimer = null;
  microConfirmationTimer = null;
}

function scheduleMicroViewEvaluation(): void {
  if (viewer.getCurrentPreset() !== 'high' || currentResolved.detailScope !== 'micro') return;
  clearMicroTimers();
  microSwitchGeneration += 1;
  viewer.cancelMicroTransition();
  const generation = microSwitchGeneration;
  microMoveTimer = window.setTimeout(() => {
    evaluateMicroView(generation).catch((error) => {
      console.error('[Micro] View evaluation failed:', error);
      setReportMicroTransitionContext({ state: 'failed', fallbackReason: error.message });
    });
  }, 300);
}

async function evaluateMicroView(generation: number): Promise<void> {
  if (
    generation !== microSwitchGeneration ||
    viewer.getCurrentPreset() !== 'high' ||
    !areaManifest ||
    !currentArea ||
    !currentMicroArea
  ) return;

  const zoomExit = evaluateZoomExitState({
    armed: microZoomExitArmed,
    cameraRange: viewer.getCameraRange(),
    exitThreshold: microZoomExitThreshold(currentMicroArea),
  });
  microZoomExitArmed = zoomExit.armed;
  if (zoomExit.shouldExit) {
    setReportMicroTransitionContext({ state: 'exit_detail', exitReason: 'camera_range_exceeded' });
    await applyMode('medium');
    return;
  }

  const samples = viewer.getCurrentViewSamples();
  const parentDetection = findAreaForViewSamples(areaManifest, samples);
  if (parentDetection.area && parentDetection.area.areaId !== currentArea.areaId) {
    currentArea = parentDetection.area;
    currentMicroArea = null;
    setSelectedAreaOption(currentArea.areaId);
    if (currentArea.datasets.detailMicro?.status !== 'ready') {
      setReportMicroTransitionContext({
        state: 'fallback_explore',
        fallbackReason: 'target_area_not_micro_ready',
      });
      await applyMode('medium');
    } else {
      await applyMode('high');
    }
    return;
  }

  const microManifest = await loadMicroManifest(currentArea);
  if (!microManifest) return;
  const first = findMicroAreaForViewSamples(
    areaManifest,
    microManifest,
    samples,
    currentMicroArea.microAreaId,
    15
  );
  if (!first.cell || first.cell.microAreaId === currentMicroArea.microAreaId) return;

  await new Promise<void>((resolve) => {
    microConfirmationTimer = window.setTimeout(resolve, 200);
  });
  if (generation !== microSwitchGeneration || viewer.getCurrentPreset() !== 'high') return;
  const second = findMicroAreaForViewSamples(
    areaManifest,
    microManifest,
    viewer.getCurrentViewSamples(),
    currentMicroArea.microAreaId,
    15
  );
  if (!second.cell || second.cell.microAreaId !== first.cell.microAreaId || second.cell.status !== 'ready') return;

  const next = second.cell;
  setReportMicroTransitionContext({ reason: 'camera_move_end', state: 'preloading', fallbackReason: null });
  const result = await viewer.switchMicroLayer({
    dataset: next.dataset,
    preset: 'high',
    detailScope: 'micro',
  });
  updateBrowserMetric('microTransitionMs', result.durationMs);
  updateBrowserMetric('microTransitionPeakMemoryBytes', result.peakMemoryBytes);
  updateBrowserMetric('microTransitionTimeout', result.reason === 'timeout' ? 1 : 0);
  if (result.status !== 'ready') {
    setReportMicroTransitionContext({ state: result.status, fallbackReason: result.reason });
    return;
  }

  currentMicroArea = next;
  microSwitchCount += 1;
  updateBrowserMetric('microSwitchCount', microSwitchCount);
  currentResolved = resolveDataset(DATASET, 'high', areaManifest, currentArea, currentMicroArea);
  setDatasetLabel(currentResolved.resolvedDataset);
  setReportDatasetContext(currentResolved);
  setReportMicroTransitionContext({ state: 'ready', reason: 'camera_move_end' });
  await reloadDatasetReport();
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

  if (preset !== 'high') {
    currentMicroArea = null;
    microZoomExitArmed = false;
  } else if (currentArea?.datasets.detailMicro) {
    const microManifest = await loadMicroManifest(currentArea);
    const samples = viewer.getCurrentViewSamples();
    const microDetection = microManifest
      ? findMicroAreaForViewSamples(areaManifest!, microManifest, samples)
      : null;
    currentMicroArea = microDetection?.cell?.status === 'ready' ? microDetection.cell : null;
    if (!currentMicroArea) {
      setReportMicroTransitionContext({
        state: 'fallback_explore',
        fallbackReason: microDetection?.reason ?? 'micro_manifest_unavailable',
      });
      setAreaDetectionStatus('Micro Detail is unavailable for the current view; loading Explore.');
      await applyMode('medium');
      return;
    }
  }

  const resolved = resolveDataset(DATASET, preset, areaManifest, currentArea, currentMicroArea);
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
  const wantsContext = preset !== 'low' && contextLayerEnabled && resolved.detailScope !== 'micro';
  const canLoadContext = wantsContext && resolved.contextStatus === 'ready' && Boolean(resolved.contextDataset);
  const reportResolved = canLoadContext ? resolved : {
    ...resolved,
    contextDataset: null,
    contextStatus: null,
    contextStatusLabel: null,
    contextExcludedAreaId: null,
    contextExcludedSourceChunkId: null,
  };
  const exploreResolved = resolveDataset(DATASET, 'medium', areaManifest, currentArea);
  const microLayer = resolved.detailScope === 'micro' && currentMicroArea
    ? {
        dataset: resolved.resolvedDataset,
        preset: 'high' as const,
        detailScope: 'micro' as const,
      }
    : null;

  if (preset === 'medium' && viewer.isDetailMicroActive()) {
    const exploreTilesetBefore = viewer.getBaseTileset();
    const reusedExplore = await viewer.exitDetailMicroToExplore(exploreResolved.resolvedDataset);
    if (exploreTilesetBefore) {
      console.assert(
        viewer.getExploreTilesetForIdentityCheck() === exploreTilesetBefore,
        'Explore p10 identity must be preserved across Detail → Explore'
      );
    }
    viewer.setPreset('medium');
    setActivePreset('medium');
    setDatasetLabel(exploreResolved.resolvedDataset);
    currentResolved = canLoadContext ? exploreResolved : {
      ...exploreResolved,
      contextDataset: null,
      contextStatus: null,
      contextStatusLabel: null,
      contextExcludedAreaId: null,
      contextExcludedSourceChunkId: null,
    };
    updateReportMode('medium');
    setReportDatasetContext(currentResolved);
    setDetailContextModeValue('off');
    setReportDetailContextMode('off');
    await reloadDatasetReport();
    const exploreContext = canLoadContext && exploreResolved.contextDataset
      ? { dataset: exploreResolved.contextDataset, preset: 'low' as const, detailScope: 'none' as const }
      : null;
    if (reusedExplore) {
      await viewer.syncExploreContextLayer(exploreContext);
    } else {
      await viewer.loadScene({
        primary: { dataset: exploreResolved.resolvedDataset, preset: 'medium', detailScope: 'none' },
        context: exploreContext,
        cameraBehavior: 'preserve',
      });
    }
    updateStats({
      sse: viewer.getSSE(),
      memory: viewer.getCacheMB(),
      tiles: viewer.getExploreTilesetForIdentityCheck() ? 0 : 0,
    });
    return;
  }

  if (preset === 'high' && microLayer) {
    if (
      viewer.isDetailMicroActive() &&
      viewer.getActiveDataset() === microLayer.dataset &&
      !opts.forceReload
    ) {
      viewer.setPreset('high');
      setActivePreset('high');
      currentResolved = reportResolved;
      setReportDatasetContext(reportResolved);
      updateModeAvailability();
      return;
    }

    const fromExplore = previousPreset === 'medium' &&
      viewer.canReuseExploreBase(exploreResolved.resolvedDataset);
    const exploreTilesetBefore = fromExplore
      ? viewer.getExploreTilesetForIdentityCheck()
      : null;

    if (!fromExplore) {
      resetBrowserMetrics();
      updateBrowserMetric('framingMode', 'preserve');
      await reloadDatasetReport();
    } else {
      updateBrowserMetric('framingMode', 'preserve');
    }

    setDetailContextModeValue('off');
    setReportDetailContextMode('off');
    const transition = await viewer.enterDetailMicro({
      micro: microLayer,
      exploreDataset: exploreResolved.resolvedDataset,
      fromExplore,
    });

    updateBrowserMetric('microTransitionMs', transition.durationMs);
    updateBrowserMetric('microTransitionPeakMemoryBytes', transition.peakMemoryBytes);
    updateBrowserMetric('microTransitionTimeout', transition.reason === 'timeout');
    if (transition.status !== 'ready') {
      setReportMicroTransitionContext({
        state: transition.status,
        fallbackReason: transition.reason,
      });
      return;
    }
    microZoomExitArmed = false;

    if (fromExplore && exploreTilesetBefore) {
      console.assert(
        viewer.getBaseTileset() === exploreTilesetBefore,
        'detailBaseTileset === exploreTileset'
      );
    }

    viewer.setPreset('high');
    setActivePreset('high');
    setDatasetLabel(resolved.resolvedDataset);
    currentResolved = reportResolved;
    updateReportMode('high');
    setReportDatasetContext(reportResolved);
    await reloadDatasetReport();
    updateModeAvailability();
    updateStats({
      sse: viewer.getSSE(),
      memory: viewer.getCacheMB(),
      tiles: 0,
    });
    return;
  }

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
      primary: { dataset: resolved.resolvedDataset, preset, detailScope: resolved.detailScope },
      context: canLoadContext && resolved.contextDataset
        ? { dataset: resolved.contextDataset, preset: 'low', detailScope: 'none' }
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
  const preset = viewer.getCurrentPreset();
  setDetailContextAvailability(preset === 'high' && currentResolved.detailScope === 'micro');
  const overviewStatus = resolveDataset(DATASET, 'low', areaManifest, currentArea).modeStatus;
  setPresetAvailability('low', true, statusLabel('overview', overviewStatus));
  const exploreResolved = resolveDataset(DATASET, 'medium', areaManifest, currentArea);
  const exploreStatus = exploreResolved.modeStatus;
  const detailResolved = resolveDataset(DATASET, 'high', areaManifest, currentArea, currentMicroArea);
  const detailStatus = currentArea?.datasets.detailMicro?.status ?? detailResolved.modeStatus;
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
  const microReady = preset === 'high' && detectedArea.datasets.detailMicro?.status === 'ready';
  if (preset !== 'low' && resolved.modeStatus !== 'ready' && !microReady) {
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
  if (area?.areaId !== currentArea?.areaId) currentMicroArea = null;
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
  const resolved = resolveDataset(DATASET, preset, areaManifest, currentArea, currentMicroArea);
  const microReady = preset === 'high' && currentArea?.datasets.detailMicro?.status === 'ready';
  if (resolved.modeStatus !== 'ready' && !microReady) {
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
