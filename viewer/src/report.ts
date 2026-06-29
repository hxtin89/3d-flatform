import { DATASET, TILE_CONFIG } from './viewer';
import { PRESETS, type PresetName } from './presets';

type SizeMetric = { bytes: number; human: string } | null;

interface DatasetReport {
  dataset: string;
  sourceType: string;
  sourceDataset: string;
  rawLasSize: SizeMetric;
  lazSize: SizeMetric;
  copcSize: SizeMetric;
  tilesSize: SizeMetric;
  tileCount: number | null;
  maxTilePoints: number | null;
  averageTileBytes?: number | null;
  largestTileBytes?: number | null;
  pointCount: number | null;
  sourcePointCount?: number | null;
  emittedPointCount?: number | null;
  hasRgb: boolean | null;
  crs: string | null;
  pointStep?: number | null;
  densityTarget?: string | null;
  densityApproximate?: boolean | null;
  actualDensityRatio?: number | null;
  areaId?: string | null;
  sourceChunkId?: string | null;
  sourceOverviewDataset?: string | null;
  excludedAreaId?: string | null;
  excludedSourceChunkId?: string | null;
  overviewChildCount?: number | null;
  contextChildCount?: number | null;
  tilePacking?: {
    mode: string;
    groupLevel?: number;
    targetTileBytes?: number;
    hardMaxTileBytes?: number;
    sourceNodeTileCount?: number;
    packedTileCount?: number;
    geometricErrorPolicy?: string;
    rootGeometricErrorBefore?: number;
    rootGeometricErrorAfter?: number;
  } | null;
}

export type BrowserMetricName =
  | 'tilesetLoadTime'
  | 'firstTileLoadedTime'
  | 'firstVisibleTime'
  | 'initialFps'
  | 'interactionFps'
  | 'flyToTime'
  | 'memoryUsage'
  | 'pageReloaded'
  | 'crashSuspected'
  | 'networkRequests'
  | 'networkMbLoaded'
  | 'loadedTiles'
  | 'activeLoadedTiles'
  | 'selectedTiles'
  | 'focusLoadedTiles'
  | 'focusActiveLoadedTiles'
  | 'contextLoadedTiles'
  | 'contextActiveLoadedTiles'
  | 'focusEffectiveSSE'
  | 'contextEffectiveSSE'
  | 'framingMode'
  | 'loadedPointsEstimated'
  | 'visiblePointsEstimated'
  | 'tilesetMemoryBytes'
  | 'cacheHitRate';

type BrowserMetricValue = string | number | boolean;
type BrowserMetrics = Record<BrowserMetricName, BrowserMetricValue>;

interface CloudFrontMetrics {
  pntsRequests: number;
  tilesetRequests: number;
  bytesTransferred: number;
  cacheHitRatio: number | null;
}

export interface AreaDetectionReportContext {
  status: string;
  detectedAreaId: string | null;
  previousAreaId: string | null;
  currentMode: string;
  sampleCount: number;
  matchedSampleCount: number;
  pickedSampleCount: number;
  fallbackUsed: boolean;
  reason: string;
}

const browserMetrics: BrowserMetrics = {
  tilesetLoadTime: '—',
  firstTileLoadedTime: '—',
  firstVisibleTime: '—',
  initialFps: '—',
  interactionFps: '—',
  flyToTime: '—',
  memoryUsage: 'unsupported',
  pageReloaded: pageReloaded(),
  crashSuspected: 'unknown',
  networkRequests: '—',
  networkMbLoaded: '—',
  loadedTiles: '—',
  activeLoadedTiles: 'unsupported',
  selectedTiles: 'unsupported',
  focusLoadedTiles: '—',
  focusActiveLoadedTiles: 'unsupported',
  contextLoadedTiles: '—',
  contextActiveLoadedTiles: 'unsupported',
  focusEffectiveSSE: '—',
  contextEffectiveSSE: '—',
  framingMode: '—',
  loadedPointsEstimated: '—',
  visiblePointsEstimated: '—',
  tilesetMemoryBytes: 'unsupported',
  cacheHitRate: 'unknown',
};

let datasetReport: DatasetReport | null = null;
let currentPresetName: PresetName = 'low';
let logicalDataset = DATASET;
let resolvedDataset = DATASET;
let selectedAreaId: string | null = null;
let modeStatus = 'ready';
let sourceChunkId: string | null = null;
let contextDataset: string | null = null;
let contextStatus: string | null = null;
let contextExcludedAreaId: string | null = null;
let contextExcludedSourceChunkId: string | null = null;
let contextReport: DatasetReport | null = null;
let areaDetectionContext: AreaDetectionReportContext | null = null;
let initialFpsStop: (() => void) | null = null;
let interactionFpsStop: (() => void) | null = null;
let measuredNetworkBytes = 0;
let measuringNetwork = false;
let cloudFrontMetrics: CloudFrontMetrics = emptyCloudFrontMetrics();

const fields = new Map<string, HTMLElement>();
const measuredNetworkUrls = new Set<string>();

export function initDatasetReport(): void {
  performance.setResourceTimingBufferSize?.(20000);

  document.querySelectorAll<HTMLElement>('[data-report-field]').forEach((el) => {
    const key = el.dataset.reportField;
    if (key) fields.set(key, el);
  });

  setText('report-dataset', resolvedDataset);
  renderDatasetContext();
  setText('pageReloaded', String(browserMetrics.pageReloaded));
  setText('crashSuspected', String(browserMetrics.crashSuspected));
  renderModeConfig();
  updateNetworkMetrics();
  updateMemoryMetric();
  initialFpsStop = sampleFps((fps) => updateBrowserMetric('initialFps', fps), 10000);

  fetchFocusDatasetReport().catch(() => {
    setText('report-status', 'report missing');
  });

  window.setInterval(() => {
    updateNetworkMetrics();
    updateMemoryMetric();
  }, 1500);

  document.getElementById('btn-copy-report')?.addEventListener('click', () => {
    copyReport().catch(() => setText('copy-status', 'copy failed'));
  });
}

export function updateBrowserMetric(metric: BrowserMetricName, value: string | number): void {
  browserMetrics[metric] = value;
  setText(metric, formatBrowserMetric(metric, value));

  if (metric === 'firstVisibleTime') {
    initialFpsStop?.();
    initialFpsStop = null;
  }
}

export function updateReportMode(presetName: PresetName): void {
  currentPresetName = presetName;
  renderModeConfig();
}

export function setReportDatasetContext(context: {
  logicalDataset: string;
  resolvedDataset: string;
  selectedAreaId: string | null;
  modeStatus: string;
  sourceChunkId: string | null;
  contextDataset?: string | null;
  contextStatus?: string | null;
  contextExcludedAreaId?: string | null;
  contextExcludedSourceChunkId?: string | null;
}): void {
  logicalDataset = context.logicalDataset;
  resolvedDataset = context.resolvedDataset;
  selectedAreaId = context.selectedAreaId;
  modeStatus = context.modeStatus;
  sourceChunkId = context.sourceChunkId;
  contextDataset = context.contextDataset ?? null;
  contextStatus = context.contextStatus ?? null;
  contextExcludedAreaId = context.contextExcludedAreaId ?? null;
  contextExcludedSourceChunkId = context.contextExcludedSourceChunkId ?? null;
  renderDatasetContext();
}

export function setReportAreaDetectionContext(context: AreaDetectionReportContext): void {
  areaDetectionContext = context;
}

export function resetBrowserMetrics(): void {
  initialFpsStop?.();
  interactionFpsStop?.();
  initialFpsStop = sampleFps((fps) => updateBrowserMetric('initialFps', fps), 10000);
  interactionFpsStop = null;
  measuredNetworkBytes = 0;
  measuringNetwork = false;
  cloudFrontMetrics = emptyCloudFrontMetrics();
  measuredNetworkUrls.clear();
  performance.clearResourceTimings();
  Object.assign(browserMetrics, {
    tilesetLoadTime: '—',
    firstTileLoadedTime: '—',
    firstVisibleTime: '—',
    initialFps: '—',
    interactionFps: '—',
    flyToTime: '—',
    memoryUsage: browserMetrics.memoryUsage,
    pageReloaded: browserMetrics.pageReloaded,
    crashSuspected: browserMetrics.crashSuspected,
    networkRequests: '—',
    networkMbLoaded: '—',
    loadedTiles: '—',
    activeLoadedTiles: 'unsupported',
    selectedTiles: 'unsupported',
    focusLoadedTiles: '—',
    focusActiveLoadedTiles: 'unsupported',
    contextLoadedTiles: '—',
    contextActiveLoadedTiles: 'unsupported',
    focusEffectiveSSE: browserMetrics.focusEffectiveSSE,
    contextEffectiveSSE: browserMetrics.contextEffectiveSSE,
    framingMode: browserMetrics.framingMode,
    loadedPointsEstimated: '—',
    visiblePointsEstimated: '—',
    tilesetMemoryBytes: 'unsupported',
    cacheHitRate: 'unknown',
  });
  renderCloudFrontMetrics();
  for (const [metric, value] of Object.entries(browserMetrics)) {
    setText(metric, formatBrowserMetric(metric as BrowserMetricName, value as string | number));
  }
}

export function updateLoadedTilesEstimate(loadedTiles: number, activeLoadedTiles?: number | string): void {
  updateBrowserMetric('loadedTiles', loadedTiles);
  const pointsPerTile = estimatedPointsPerTile();
  if (!pointsPerTile) return;
  const tilesForEstimate = typeof activeLoadedTiles === 'number' ? activeLoadedTiles : loadedTiles;
  if (activeLoadedTiles !== undefined) {
    updateBrowserMetric('selectedTiles', activeLoadedTiles);
  }
  const estimated = Math.min(
    Math.round(tilesForEstimate * pointsPerTile),
    datasetReport?.pointCount ?? Number.POSITIVE_INFINITY
  );
  updateBrowserMetric('loadedPointsEstimated', estimated);
}

export function markInteraction(): void {
  interactionFpsStop?.();
  interactionFpsStop = sampleFps((fps) => updateBrowserMetric('interactionFps', fps), 1800);
}

async function fetchDatasetReport(dataset: string): Promise<DatasetReport> {
  if (!TILE_CONFIG.baseUrl) throw new Error('Tile source is not configured');
  const reportUrl = `${TILE_CONFIG.baseUrl}/${dataset}/dataset-report.json`;
  const response = await fetch(reportUrl, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json() as DatasetReport;
}

async function fetchFocusDatasetReport(): Promise<void> {
  datasetReport = await fetchDatasetReport(resolvedDataset);
  renderDatasetReport(datasetReport);
  setText('report-status', datasetReport.sourceType);
}

export async function reloadDatasetReport(): Promise<void> {
  datasetReport = null;
  contextReport = null;
  renderDatasetContext();
  resetPipelineFields();
  try {
    await fetchFocusDatasetReport();
  } catch {
    setText('report-status', 'report missing');
  }
  if (contextDataset) {
    try {
      contextReport = await fetchDatasetReport(contextDataset);
    } catch {
      contextReport = null;
    }
  }
}

function renderDatasetReport(report: DatasetReport): void {
  setText('report-dataset', report.dataset);
  setText('sourceType', report.sourceType);
  setText('sourceDataset', report.sourceDataset);
  setText('rawLasSize', formatSize(report.rawLasSize));
  setText('lazSize', formatSize(report.lazSize));
  setText('copcSize', formatSize(report.copcSize));
  setText('tilesSize', formatSize(report.tilesSize));
  setText('tileCount', formatNumber(report.tileCount));
  setText('maxTilePoints', formatNumber(report.maxTilePoints));
  setText('averageTileBytes', formatBytes(report.averageTileBytes));
  setText('largestTileBytes', formatBytes(report.largestTileBytes));
  setText('pointCount', formatNumber(report.pointCount));
  setText('sourcePointCount', formatNumber(report.sourcePointCount ?? null));
  setText('emittedPointCount', formatNumber(report.emittedPointCount ?? null));
  setText('hasRgb', report.hasRgb === null ? 'unknown' : report.hasRgb ? 'yes' : 'no');
  setText('crs', report.crs ?? 'unknown');
  setText('pointStep', report.pointStep == null ? 'unknown' : String(report.pointStep));
  setText('densityTarget', report.densityTarget ?? 'unknown');
  setText('densityApproximate', report.densityApproximate == null ? 'unknown' : String(report.densityApproximate));
  setText(
    'actualDensityRatio',
    typeof report.actualDensityRatio === 'number'
      ? `${(report.actualDensityRatio * 100).toFixed(2)}%`
      : 'unknown'
  );
}

function renderModeConfig(): void {
  const preset = PRESETS[currentPresetName];
  setText('userMode', preset.userMode);
  setText('dataDensity', preset.dataDensity);
  setText('renderQuality', preset.renderQuality);
  setText('maximumScreenSpaceError', String(preset.maximumScreenSpaceError));
  setText('focusEffectiveSSE', String(browserMetrics.focusEffectiveSSE));
  setText('contextEffectiveSSE', String(browserMetrics.contextEffectiveSSE));
  setText('framingMode', String(browserMetrics.framingMode));
  setText('cacheBytes', formatBytes(preset.cacheBytes));
}

function renderDatasetContext(): void {
  setText('logicalDataset', logicalDataset);
  setText('resolvedDataset', resolvedDataset);
  setText('selectedAreaId', selectedAreaId ?? '—');
  setText('modeStatus', modeStatus);
  setText('sourceChunkId', sourceChunkId ?? '—');
  setText('focusDataset', resolvedDataset);
  setText('contextDataset', contextDataset ?? '—');
  setText('contextStatus', contextStatus ?? '—');
  setText('contextExcludedAreaId', contextExcludedAreaId ?? '—');
  setText('contextExcludedSourceChunkId', contextExcludedSourceChunkId ?? '—');
  setText('report-dataset', resolvedDataset);
}

function updateNetworkMetrics(): void {
  const activeDatasets = activeNetworkFragments();
  const entries = performance
    .getEntriesByType('resource')
    .filter((entry) => activeDatasets.some((fragment) => entry.name.includes(`/${fragment}`)));
  const bytes = entries.reduce((total, entry) => {
    const resource = entry as PerformanceResourceTiming;
    return total + (
      resource.transferSize ||
      resource.encodedBodySize ||
      resource.decodedBodySize ||
      0
    );
  }, 0);
  cloudFrontMetrics = buildCloudFrontMetrics(entries, bytes || measuredNetworkBytes);
  renderCloudFrontMetrics();
  updateBrowserMetric('networkRequests', entries.length);
  updateCacheHitRate(entries);
  if (bytes > 0) {
    updateBrowserMetric('networkMbLoaded', bytes / 1024 / 1024);
    return;
  }

  updateBrowserMetric(
    'networkMbLoaded',
    measuredNetworkBytes > 0 ? measuredNetworkBytes / 1024 / 1024 : 'measuring'
  );
  measureResourceContentLength(entries);
}

function activeNetworkFragments(): string[] {
  const fragments = new Set<string>();
  fragments.add(resolvedDataset);
  if (contextDataset) fragments.add(contextDataset);

  const focusSourceRoot = sourceDatasetRoot(resolvedDataset, datasetReport);
  if (sourceChunkId) {
    fragments.add(
      focusSourceRoot
        ? `${focusSourceRoot}-chunked-copc/chunks/${sourceChunkId}`
        : `${logicalDataset}-chunked-copc/chunks/${sourceChunkId}`
    );
  }

  const contextSourceRoot = sourceDatasetRoot(contextDataset, contextReport) ?? focusSourceRoot;
  if (contextDataset?.includes('overview-p001-excluding')) {
    fragments.add(
      contextSourceRoot
        ? `${contextSourceRoot}-overview-p001/chunks`
        : `${logicalDataset}-overview-p001/chunks`
    );
  } else if (contextDataset?.includes('overview-p02-excluding')) {
    fragments.add(
      contextSourceRoot
        ? `${contextSourceRoot}-overview-p02/chunks`
        : `${logicalDataset}-overview-p02/chunks`
    );
  }
  return [...fragments].filter(Boolean);
}

function sourceDatasetRoot(dataset: string | null, report: DatasetReport | null): string | null {
  const sourceDataset = report?.sourceDataset;
  if (!dataset || !sourceDataset) return null;

  const segments = dataset.split('/').filter(Boolean);
  const sourceIndex = segments.findIndex((segment) => (
    segment === sourceDataset || segment.startsWith(`${sourceDataset}-`)
  ));
  if (sourceIndex < 0) return null;

  return [...segments.slice(0, sourceIndex), sourceDataset].join('/');
}

function updateCacheHitRate(entries: PerformanceEntry[]): void {
  const resources = entries as PerformanceResourceTiming[];
  if (resources.length === 0) return;
  const measurable = resources.filter((entry) => (
    entry.transferSize > 0 ||
    entry.encodedBodySize > 0 ||
    entry.decodedBodySize > 0
  ));
  if (measurable.length === 0) {
    updateBrowserMetric('cacheHitRate', 'unknown');
    return;
  }
  const cached = measurable.filter((entry) => (
    entry.transferSize === 0 && (entry.encodedBodySize > 0 || entry.decodedBodySize > 0)
  )).length;
  const hitRatio = cached / measurable.length;
  cloudFrontMetrics = { ...cloudFrontMetrics, cacheHitRatio: hitRatio };
  renderCloudFrontMetrics();
  updateBrowserMetric('cacheHitRate', `${Math.round(hitRatio * 100)}%`);
}

function emptyCloudFrontMetrics(): CloudFrontMetrics {
  return {
    pntsRequests: 0,
    tilesetRequests: 0,
    bytesTransferred: 0,
    cacheHitRatio: null,
  };
}

function buildCloudFrontMetrics(entries: PerformanceEntry[], bytesTransferred: number): CloudFrontMetrics {
  return {
    pntsRequests: entries.filter((entry) => resourcePath(entry.name).endsWith('.pnts')).length,
    tilesetRequests: entries.filter((entry) => resourcePath(entry.name).endsWith('/tileset.json')).length,
    bytesTransferred,
    cacheHitRatio: cloudFrontMetrics.cacheHitRatio,
  };
}

function resourcePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function renderCloudFrontMetrics(): void {
  setText('pntsRequests', formatNumber(cloudFrontMetrics.pntsRequests));
  setText('tilesetRequests', formatNumber(cloudFrontMetrics.tilesetRequests));
  setText('bytesTransferred', formatBytes(cloudFrontMetrics.bytesTransferred));
  setText(
    'cacheHitRatio',
    cloudFrontMetrics.cacheHitRatio == null
      ? 'unknown'
      : `${Math.round(cloudFrontMetrics.cacheHitRatio * 100)}%`
  );
}

function measureResourceContentLength(entries: PerformanceEntry[]): void {
  if (measuringNetwork) return;
  const pendingUrls = entries
    .map((entry) => entry.name)
    .filter((url) => !measuredNetworkUrls.has(url))
    .slice(0, 80);

  if (pendingUrls.length === 0) return;

  measuringNetwork = true;
  Promise.all(pendingUrls.map(async (url) => {
    measuredNetworkUrls.add(url);
    try {
      const response = await fetch(url, { method: 'HEAD', cache: 'force-cache' });
      const length = Number(response.headers.get('content-length') ?? 0);
      if (Number.isFinite(length) && length > 0) {
        measuredNetworkBytes += length;
      }
    } catch {
      // Some servers do not support HEAD; keep the metric best-effort.
    }
  })).finally(() => {
    measuringNetwork = false;
    if (measuredNetworkBytes > 0) {
      updateBrowserMetric('networkMbLoaded', measuredNetworkBytes / 1024 / 1024);
    }
  });
}

function updateMemoryMetric(): void {
  const memory = (performance as Performance & {
    memory?: { usedJSHeapSize?: number };
  }).memory;
  if (!memory?.usedJSHeapSize) return;
  updateBrowserMetric('memoryUsage', memory.usedJSHeapSize / 1024 / 1024);
}

function sampleFps(onDone: (fps: number) => void, durationMs: number): () => void {
  let active = true;
  let frames = 0;
  const start = performance.now();

  const tick = () => {
    if (!active) return;
    frames += 1;
    const elapsed = performance.now() - start;
    if (elapsed >= durationMs) {
      active = false;
      onDone(Math.round((frames * 1000) / elapsed));
      return;
    }
    requestAnimationFrame(tick);
  };

  requestAnimationFrame(tick);

  return () => {
    if (!active) return;
    active = false;
    const elapsed = Math.max(performance.now() - start, 1);
    onDone(Math.round((frames * 1000) / elapsed));
  };
}

async function copyReport(): Promise<void> {
  const preset = PRESETS[currentPresetName];
  const focusDensity = datasetReport?.densityTarget ?? preset.dataDensity;
  const contextDensity = contextReport?.densityTarget ?? null;
  const payload = {
    dataset: resolvedDataset,
    logicalDataset,
    resolvedDataset,
    selectedAreaId,
    modeStatus,
    sourceChunkId,
    sourceType: datasetReport?.sourceType ?? 'unknown',
    sourceDataset: datasetReport?.sourceDataset ?? logicalDataset,
    focusDataset: resolvedDataset,
    focusDensity,
    focusAreaId: selectedAreaId,
    focusSourceChunkId: sourceChunkId,
    contextDataset,
    contextDensity,
    contextExcludedAreaId,
    contextExcludedSourceChunkId,
    focus: {
      dataset: resolvedDataset,
      density: focusDensity,
      areaId: selectedAreaId,
      sourceChunkId,
      report: datasetReport,
    },
    context: contextDataset ? {
      dataset: contextDataset,
      density: contextDensity,
      status: contextStatus,
      excludedAreaId: contextExcludedAreaId,
      excludedSourceChunkId: contextExcludedSourceChunkId,
      report: contextReport,
    } : null,
    userMode: preset.userMode,
    dataDensity: preset.dataDensity,
    renderQuality: preset.renderQuality,
    maximumScreenSpaceError: preset.maximumScreenSpaceError,
    focusEffectiveSSE: browserMetrics.focusEffectiveSSE,
    contextEffectiveSSE: browserMetrics.contextEffectiveSSE,
    framingMode: browserMetrics.framingMode,
    focusLoadedTiles: browserMetrics.focusLoadedTiles,
    activeLoadedTiles: browserMetrics.activeLoadedTiles,
    focusActiveLoadedTiles: browserMetrics.focusActiveLoadedTiles,
    contextLoadedTiles: browserMetrics.contextLoadedTiles,
    contextActiveLoadedTiles: browserMetrics.contextActiveLoadedTiles,
    selectedTiles: browserMetrics.selectedTiles,
    visiblePointsEstimated: browserMetrics.visiblePointsEstimated,
    tilesetMemoryBytes: browserMetrics.tilesetMemoryBytes,
    debugSummary: {
      visiblePointsEstimated: browserMetrics.visiblePointsEstimated,
      selectedTiles: browserMetrics.selectedTiles,
      tilesetMemoryBytes: browserMetrics.tilesetMemoryBytes,
    },
    cacheBytes: {
      bytes: preset.cacheBytes,
      human: formatBytes(preset.cacheBytes),
    },
    timestamp: new Date().toISOString(),
    url: window.location.href,
    userAgent: navigator.userAgent,
    pipeline: datasetReport,
    browser: browserMetrics,
    cloudfront: cloudFrontMetrics,
    areaDetection: areaDetectionContext,
  };
  await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
  setText('copy-status', 'copied');
  window.setTimeout(() => setText('copy-status', ''), 1600);
}

function pageReloaded(): boolean {
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  return nav?.type === 'reload';
}

function formatBrowserMetric(metric: BrowserMetricName, value: string | number): string {
  if (typeof value === 'string') return value;
  if (metric.endsWith('Time')) return `${Math.round(value)} ms`;
  if (metric.endsWith('Fps')) return `${Math.round(value)} fps`;
  if (metric === 'memoryUsage') return `${value.toFixed(1)} MB`;
  if (metric === 'tilesetMemoryBytes') return formatBytes(value);
  if (metric === 'networkMbLoaded') return `${value.toFixed(2)} MB`;
  if (
    metric === 'loadedPointsEstimated' ||
    metric === 'visiblePointsEstimated' ||
    metric === 'selectedTiles'
  ) {
    return formatNumber(value);
  }
  return String(value);
}

function formatSize(value: SizeMetric): string {
  return value?.human ?? 'unknown';
}

function formatNumber(value: number | null): string {
  return typeof value === 'number' ? value.toLocaleString() : 'unknown';
}

function formatBytes(value: number | null | undefined): string {
  if (typeof value !== 'number') return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = units[0];
  for (unit of units) {
    if (size < 1024 || unit === units[units.length - 1]) break;
    size /= 1024;
  }
  return unit === 'B' ? `${Math.round(size)} ${unit}` : `${size.toFixed(1)} ${unit}`;
}

function estimatedPointsPerTile(): number | null {
  if (!datasetReport?.pointCount || !datasetReport.tileCount) return null;
  return datasetReport.pointCount / datasetReport.tileCount;
}

function resetPipelineFields(): void {
  [
    'sourceType',
    'sourceDataset',
    'rawLasSize',
    'lazSize',
    'copcSize',
    'tilesSize',
    'tileCount',
    'maxTilePoints',
    'averageTileBytes',
    'largestTileBytes',
    'pointCount',
    'sourcePointCount',
    'emittedPointCount',
    'hasRgb',
    'crs',
    'pointStep',
    'densityTarget',
    'densityApproximate',
    'actualDensityRatio',
  ].forEach((key) => setText(key, '—'));
}

function setText(key: string, value: string): void {
  const el = fields.get(key) ?? document.getElementById(key);
  if (el) el.textContent = value;
}
