// main.ts — Entry point for the SBB CesiumJS Point Cloud Viewer
import './style.css';
import {
  DATASET,
  ADAPTIVE_POINT_HIERARCHY_CONTROLLER,
  ADAPTIVE_POINT_HIERARCHY_PREVIEW_Z0,
  ADAPTIVE_POINT_HIERARCHY_VRV,
  LOD_MODE,
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
  initOverviewPointSizeSlider,
  initAdaptivePointHierarchyTuning,
  initAdaptivePointHierarchyPointSizeTuning,
  initAdaptivePointHierarchySimpleSse,
  setOverviewPointSizeScale,
  setOverviewPointSizeAvailability,
  setAdaptivePointHierarchyTuning,
  setAdaptivePointHierarchyPointSizeTuning,
  setAdaptivePointHierarchySimpleSse,
  setAdaptivePointHierarchyControllerMode,
  isContextLayerEnabled,
  setAreaOptions,
  setAreaDetectionStatus,
  setContextLayerAvailability,
  setPresetAvailability,
  setPanelLodMode,
  setReportVariant,
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
  updateSpatialLodActiveTileSamples,
  useRuntimeOnlyDatasetReport,
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
import {
  ONE_LOD_TREE_TILESET_FILE,
  oneLodTreeDataset,
  oneLodTreeSse,
} from './one-lod-tree';
import {
  SPATIAL_LOD_TILESET_FILE,
  spatialLodDataset,
  type SpatialLodLevelStats,
} from './spatial-lod';
import {
  adaptivePointHierarchyDataset,
  adaptivePointHierarchyTilesetFile,
  formatAdaptivePointHierarchyDepthStats,
  type AdaptivePointHierarchyDepthStats,
} from './adaptive-point-hierarchy';

setDatasetLabel(DATASET);
setSourceLabel(TILE_SOURCE);
setServerUrl(TILE_CONFIG.baseUrl || 'CloudFront not configured');
setPanelLodMode(LOD_MODE);
setAdaptivePointHierarchyControllerMode(ADAPTIVE_POINT_HIERARCHY_CONTROLLER);
setReportVariant(LOD_MODE === 'manual' ? 'dataset' : 'runtime');
initDatasetReport();

let areaManifest: AreaManifest | null = null;
let currentArea: AreaManifestEntry | null = null;
let currentResolved: ResolvedDataset = resolveDataset(DATASET, 'low', null, null);
let preDetailCameraSnapshot: CameraSnapshot | null = null;
let contextLayerEnabled = false;
let spatialLodLevelStats: SpatialLodLevelStats | null = { z0: 0, z1: 0, z2: 0, z3: 0, z4: 0 };
let adaptivePointHierarchyDepthStats: AdaptivePointHierarchyDepthStats | null = null;

function renderSpatialLodStatus(): void {
  if (LOD_MODE !== 'spatial-lod') return;
  const sse = viewer.getSSE();
  if (spatialLodLevelStats === null) {
    setAreaDetectionStatus(`Spatial LOD · SSE ${sse} · z-levels: —`);
    return;
  }
  const s = spatialLodLevelStats;
  setAreaDetectionStatus(
    `Spatial LOD · SSE ${sse} · z0=${s.z0} z1=${s.z1} z2=${s.z2} z3=${s.z3} z4=${s.z4}`
  );
}

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
    const pointSizeAvailable = LOD_MODE === 'one-lod-tree' || LOD_MODE === 'adaptive-point-hierarchy' || (LOD_MODE === 'manual' && preset === 'low');
    const pointSizeDisabledLabel = LOD_MODE === 'spatial-lod'
      ? 'Runtime hierarchy mode'
      : 'Available in Overview only';
    setOverviewPointSizeAvailability(
      pointSizeAvailable,
      pointSizeAvailable ? '' : pointSizeDisabledLabel
    );
    if (pointSizeAvailable) setOverviewPointSizeScale(viewer.getOverviewPointSizeScale());
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
  onSpatialLodLevelStats: (stats: SpatialLodLevelStats | null, _active: number | string) => {
    spatialLodLevelStats = stats;
    renderSpatialLodStatus();
  },
  onSpatialLodActiveTileSamples: (samples) => {
    updateSpatialLodActiveTileSamples(samples);
  },
  onAdaptivePointHierarchyDepthStats: (stats) => {
    adaptivePointHierarchyDepthStats = stats;
    setAreaDetectionStatus(
      `Adaptive Point Hierarchy · SSE ${viewer.getSSE()} · ${formatAdaptivePointHierarchyDepthStats(stats)}`
    );
  },
});

// Wire up UI controls
initPresetButtons((preset: PresetName) => {
  if (LOD_MODE === 'one-lod-tree') {
    applyOneLodTreePreset(preset);
    return;
  }
  if (LOD_MODE === 'spatial-lod') {
    return;
  }
  if (LOD_MODE === 'adaptive-point-hierarchy') return;
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
  if (LOD_MODE !== 'manual') return;
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

initAdaptivePointHierarchyPointSizeTuning((tuning) => {
  if (LOD_MODE !== 'adaptive-point-hierarchy') return;
  const normalized = viewer.setAdaptivePointHierarchyPointSizeTuning(tuning);
  setAdaptivePointHierarchyPointSizeTuning(normalized);
});

initAdaptivePointHierarchyTuning((tuning) => {
  if (LOD_MODE !== 'adaptive-point-hierarchy') return;
  const normalized = viewer.setAdaptivePointHierarchyTuning(tuning);
  setAdaptivePointHierarchyTuning(normalized);
  updateStats({ sse: viewer.getSSE(), memory: viewer.getCacheMB() });
});

initAdaptivePointHierarchySimpleSse((sse) => {
  if (LOD_MODE !== 'adaptive-point-hierarchy' || ADAPTIVE_POINT_HIERARCHY_CONTROLLER !== 'simple') return;
  const normalized = viewer.setAdaptivePointHierarchySimpleSse(sse);
  setAdaptivePointHierarchySimpleSse(normalized);
  updateStats({ sse: viewer.getSSE(), memory: viewer.getCacheMB() });
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
  if (LOD_MODE === 'one-lod-tree') {
    await bootstrapOneLodTree();
    return;
  }
  if (LOD_MODE === 'spatial-lod') {
    await bootstrapSpatialLod();
    return;
  }
  if (LOD_MODE === 'adaptive-point-hierarchy') {
    await bootstrapAdaptivePointHierarchy();
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

async function bootstrapOneLodTree(): Promise<void> {
  const resolvedDataset = oneLodTreeDataset(DATASET);
  currentResolved = {
    logicalDataset: DATASET,
    resolvedDataset,
    selectedAreaId: null,
    modeStatus: 'ready',
    modeStatusLabel: 'single external tree',
    sourceChunkId: null,
    contextDataset: null,
    contextStatus: null,
    contextStatusLabel: null,
    contextExcludedAreaId: null,
    contextExcludedSourceChunkId: null,
  };

  setDatasetLabel(resolvedDataset);
  setReportDatasetContext(currentResolved);
  useRuntimeOnlyDatasetReport();
  setAreaOptions([], null);
  setUseCurrentViewAvailability(false, 'Single-tree mode');
  setContextLayerAvailability(false, 'Single-tree mode');
  setOverviewPointSizeAvailability(true, '');
  setOverviewPointSizeScale(viewer.getOverviewPointSizeScale());
  setPresetAvailability('low', true, `Single tree · SSE ${oneLodTreeSse('low')}`);
  setPresetAvailability('medium', true, `Single tree · SSE ${oneLodTreeSse('medium')}`);
  setPresetAvailability('high', true, `Single tree · SSE ${oneLodTreeSse('high')}`);
  const detailSseSelect = document.getElementById('select-detail-sse') as HTMLSelectElement | null;
  if (detailSseSelect) detailSseSelect.disabled = true;
  setAreaDetectionStatus('One LOD Tree: Cesium camera-driven external refinement');

  resetBrowserMetrics();
  updateBrowserMetric('framingMode', 'flyTo');
  await viewer.loadOneLodTree(resolvedDataset, ONE_LOD_TREE_TILESET_FILE);
  useRuntimeOnlyDatasetReport();
  setActivePreset('low');
  updateReportMode('low');
  setOverviewPointSizeScale(viewer.getOverviewPointSizeScale());
  updateStats({
    sse: viewer.getSSE(),
    memory: viewer.getCacheMB(),
    tiles: 0,
  });
}

function applyOneLodTreePreset(preset: PresetName): void {
  viewer.setOneLodTreePreset(preset);
  setActivePreset(preset);
  updateReportMode(preset);
  updateBrowserMetric('focusEffectiveSSE', viewer.getSSE());
  updateStats({
    sse: viewer.getSSE(),
    memory: viewer.getCacheMB(),
  });
  setAreaDetectionStatus(
    `One LOD Tree: ${modeForPreset(preset)} render budget · SSE ${oneLodTreeSse(preset)}`
  );
}

async function bootstrapSpatialLod(): Promise<void> {
  const resolvedDataset = spatialLodDataset(DATASET);
  currentResolved = {
    logicalDataset: DATASET,
    resolvedDataset,
    selectedAreaId: null,
    modeStatus: 'ready',
    modeStatusLabel: 'spatial-lod tree',
    sourceChunkId: null,
    contextDataset: null,
    contextStatus: null,
    contextStatusLabel: null,
    contextExcludedAreaId: null,
    contextExcludedSourceChunkId: null,
  };

  setDatasetLabel(resolvedDataset);
  setReportDatasetContext(currentResolved);
  useRuntimeOnlyDatasetReport();

  // Area manifest is metadata + camera navigation only.
  try {
    areaManifest = await fetchAreaManifest(DATASET);
  } catch (err) {
    console.warn('[Main] Failed to load area manifest for spatial-lod:', err);
    areaManifest = null;
  }
  currentArea = selectedArea(areaManifest, areaManifest?.defaultAreaId ?? null);
  if (currentArea) {
    currentResolved = { ...currentResolved, selectedAreaId: currentArea.areaId };
    setReportDatasetContext(currentResolved);
  }
  if (areaManifest) {
    setAreaOptions(
      areaManifest.areas.map((area) => ({ areaId: area.areaId, label: area.label })),
      currentArea?.areaId ?? null
    );
    setUseCurrentViewAvailability(areaManifest.areas.length > 0, 'Area manifest is not ready yet.');
  } else {
    setAreaOptions([], null);
    setUseCurrentViewAvailability(false, 'Area manifest is not ready yet.');
  }

  // Spatial LOD is one adaptive runtime: z0/p001 bootstraps; z1-z4 refine by budget.
  setContextLayerAvailability(false, 'Spatial LOD mode');
  setOverviewPointSizeAvailability(false, 'Spatial LOD mode');
  const detailSseSelect = document.getElementById('select-detail-sse') as HTMLSelectElement | null;
  if (detailSseSelect) detailSseSelect.disabled = true;
  setAreaDetectionStatus('Spatial LOD: adaptive point-budget refinement');

  resetBrowserMetrics();
  updateBrowserMetric('framingMode', 'flyTo');
  await viewer.loadSpatialLod(resolvedDataset, SPATIAL_LOD_TILESET_FILE);
  useRuntimeOnlyDatasetReport();
  setActivePreset('low');
  updateReportMode('low');
  updateBrowserMetric('focusEffectiveSSE', viewer.getSSE());
  updateStats({
    sse: viewer.getSSE(),
    memory: viewer.getCacheMB(),
    tiles: 0,
  });
  renderSpatialLodStatus();
}

async function bootstrapAdaptivePointHierarchy(): Promise<void> {
  const resolvedDataset = adaptivePointHierarchyDataset(DATASET);
  const tilesetFile = adaptivePointHierarchyTilesetFile(
    ADAPTIVE_POINT_HIERARCHY_PREVIEW_Z0,
    ADAPTIVE_POINT_HIERARCHY_VRV
  );
  currentResolved = {
    logicalDataset: DATASET,
    resolvedDataset,
    selectedAreaId: ADAPTIVE_POINT_HIERARCHY_PREVIEW_Z0,
    modeStatus: 'ready',
    modeStatusLabel: ADAPTIVE_POINT_HIERARCHY_PREVIEW_Z0 ? 'z0 preview' : 'full hierarchy',
    sourceChunkId: null,
    contextDataset: null,
    contextStatus: null,
    contextStatusLabel: null,
    contextExcludedAreaId: null,
    contextExcludedSourceChunkId: null,
  };

  setDatasetLabel(resolvedDataset);
  setReportDatasetContext(currentResolved);
  useRuntimeOnlyDatasetReport();
  setAreaOptions([], null);
  setUseCurrentViewAvailability(false, 'Adaptive Point Hierarchy preview');
  setContextLayerAvailability(false, 'Adaptive Point Hierarchy mode');
  setOverviewPointSizeAvailability(true, '');
  setOverviewPointSizeScale(viewer.getOverviewPointSizeScale());
  setAdaptivePointHierarchyPointSizeTuning(viewer.getAdaptivePointHierarchyPointSizeTuning());
  if (ADAPTIVE_POINT_HIERARCHY_CONTROLLER === 'advanced') {
    setAdaptivePointHierarchyTuning(viewer.getAdaptivePointHierarchyTuning());
  } else {
    setAdaptivePointHierarchySimpleSse(viewer.getAdaptivePointHierarchySimpleSse());
  }
  setPresetAvailability(
    'low',
    true,
    `Adaptive tree · ${ADAPTIVE_POINT_HIERARCHY_CONTROLLER} · VRV ${ADAPTIVE_POINT_HIERARCHY_VRV}`
  );
  setPresetAvailability('medium', false, 'Adaptive Point Hierarchy uses one runtime budget');
  setPresetAvailability('high', false, 'Adaptive Point Hierarchy uses one runtime budget');
  const detailSseSelect = document.getElementById('select-detail-sse') as HTMLSelectElement | null;
  if (detailSseSelect) detailSseSelect.disabled = true;
  const preview = ADAPTIVE_POINT_HIERARCHY_PREVIEW_Z0 ?? 'full dataset';
  setAreaDetectionStatus(
    `Adaptive Point Hierarchy: ${ADAPTIVE_POINT_HIERARCHY_CONTROLLER} · loading ${preview} · VRV ${ADAPTIVE_POINT_HIERARCHY_VRV}`
  );

  resetBrowserMetrics();
  updateBrowserMetric('framingMode', 'flyTo');
  await viewer.loadAdaptivePointHierarchy(resolvedDataset, tilesetFile);
  useRuntimeOnlyDatasetReport();
  setActivePreset('low');
  updateReportMode('low');
  if (ADAPTIVE_POINT_HIERARCHY_CONTROLLER === 'advanced') {
    setAdaptivePointHierarchyTuning(viewer.getAdaptivePointHierarchyTuning());
  } else {
    setAdaptivePointHierarchySimpleSse(viewer.getAdaptivePointHierarchySimpleSse());
  }
  updateStats({ sse: viewer.getSSE(), memory: viewer.getCacheMB(), tiles: 0 });
  if (adaptivePointHierarchyDepthStats) {
    setAreaDetectionStatus(
      `Adaptive Point Hierarchy · ${formatAdaptivePointHierarchyDepthStats(adaptivePointHierarchyDepthStats)}`
    );
  }
}

/** Area selection in spatial-lod mode only flies the camera; it never reloads. */
function flyToSpatialArea(area: AreaManifestEntry | null): void {
  if (!area || !areaManifest) return;
  const transform = areaManifest.rootTransform;
  if (!Array.isArray(transform) || transform.length !== 16) {
    setAreaDetectionStatus(`Spatial LOD: ${areaLabel(area)} (no ENU transform — flying home)`);
    viewer.flyHome();
    return;
  }
  viewer.flyToEnuBBox(area.bbox, transform);
  setAreaDetectionStatus(`Spatial LOD: flew to ${areaLabel(area)}`);
}

/** In spatial-lod mode, "Use current view" only updates Area metadata. */
function useCurrentViewSpatial(preset: PresetName, previousAreaId: string | null): void {
  if (!areaManifest) {
    setAreaDetectionStatus('Area manifest is not ready yet.');
    return;
  }
  const detected = detectCurrentViewArea(preset);
  if (!detected?.area) return;
  const area = detected.area;
  currentArea = area;
  setSelectedAreaOption(area.areaId);
  currentResolved = { ...currentResolved, selectedAreaId: area.areaId };
  setReportDatasetContext(currentResolved);
  setAreaDetectionStatus(
    `Spatial LOD: current view is ${areaLabel(area)} ${detectionStatusSuffix(detected.detection)} (metadata only)`
  );
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
  if (LOD_MODE === 'adaptive-point-hierarchy') return;
  if (LOD_MODE === 'spatial-lod') {
    useCurrentViewSpatial(preset, previousAreaId);
    return;
  }
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
  if (LOD_MODE === 'adaptive-point-hierarchy') return;
  if (LOD_MODE === 'spatial-lod') {
    flyToSpatialArea(currentArea);
    currentResolved = { ...currentResolved, selectedAreaId: currentArea?.areaId ?? null };
    setReportDatasetContext(currentResolved);
    return;
  }
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
