// main.ts — Entry point for the SBB CesiumJS Point Cloud Viewer
import './style.css';
import {
  DATASET,
  TILE_CONFIG,
  TILE_SOURCE,
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
  isContextLayerEnabled,
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
  type BrowserMetricName,
} from './report';
import {
  fetchAreaManifest,
  findAreaForViewSamples,
  modeForPreset,
  resolveDataset,
  selectedArea,
  statusLabel,
  type AreaManifest,
  type AreaManifestEntry,
  type ResolvedDataset,
} from './manifest';

setDatasetLabel(DATASET);
setSourceLabel(TILE_SOURCE);
setServerUrl(TILE_CONFIG.baseUrl || 'CloudFront not configured');
initDatasetReport();

let areaManifest: AreaManifest | null = null;
let currentArea: AreaManifestEntry | null = null;
let currentResolved: ResolvedDataset = resolveDataset(DATASET, 'low', null, null);
let preDetailCameraSnapshot: CameraSnapshot | null = null;
let contextLayerEnabled = false;

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
  onBrowserMetric: (metric: BrowserMetricName, value: number | string) => {
    updateBrowserMetric(metric, value);
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
  viewer.setDetailSseOverride(sse);
  updateStats({
    sse: viewer.getSSE(),
    memory: viewer.getCacheMB(),
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
