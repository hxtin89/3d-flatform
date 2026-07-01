// viewer.ts — CesiumJS viewer and 3D Tileset loader
import * as Cesium from 'cesium';
import {
  applyDetailContextMode,
  trimBaseTileset,
  type DetailContextMode,
} from './detail-context';
import {
  assertBaseIdentity,
  contentMemoryBytes,
  computeLayerCounts,
  computeMemoryMetrics,
  DETAIL_TRANSITION_MEMORY_BUDGET_BYTES,
  DETAIL_TRANSITION_TIMEOUT_MS,
  evaluatePerformanceGate,
  type PerformanceGateStatus,
} from './detail-micro-lifecycle';
import {
  applyPreset,
  cacheBytesToMB,
  presetFor,
  type DetailScope,
  type PresetName,
  PRESETS,
} from './presets';
import { type BrowserMetricName } from './report';

export type { DetailContextMode };

// Disable Cesium ion — fully self-hosted setup
Cesium.Ion.defaultAccessToken = '';

type TileSource = 'local' | 'cloudfront';

const LOCAL_TILE_SERVER_BASE = 'http://localhost:8081';
const LOCAL_DEFAULT_DATASET = 'autzen';
const CLOUDFRONT_DEFAULT_DATASET = 'wi-1-copc';
const DATASET_PATTERN = /^[a-zA-Z0-9_-]+$/;

const searchParams = new URLSearchParams(window.location.search);
const requestedSource = searchParams.get('source');
export const TILE_SOURCE: TileSource = requestedSource === 'cloudfront'
  ? 'cloudfront'
  : 'local';
const requestedDataset = searchParams.get('dataset');
export const DATASET = requestedDataset?.match(DATASET_PATTERN)
  ? requestedDataset
  : TILE_SOURCE === 'cloudfront'
    ? CLOUDFRONT_DEFAULT_DATASET
    : LOCAL_DEFAULT_DATASET;
const DEBUG_TILES = searchParams.get('debugTiles') === '1';
const REQUESTED_BASEMAP = searchParams.get('basemap');
const MAPTILER_API_KEY = import.meta.env.VITE_MAPTILER_API_KEY?.trim() ?? '';
const MAPTILER_BASEMAP_ENABLED = REQUESTED_BASEMAP === 'maptiler' && Boolean(MAPTILER_API_KEY);
const MOBILE_VIEWPORT_QUERY = '(max-width: 640px)';
const MIN_CAMERA_DISTANCE_FLOOR = 0.25;
const MIN_CAMERA_DISTANCE_RATIO = 0.0005;
const MIN_CAMERA_DISTANCE_CEILING = 5;
const MAPTILER_GLOBE_FRUSTUM_FAR = 20_000_000;
const MAPTILER_SATELLITE_URL = 'https://api.maptiler.com/maps/satellite-v4/{z}/{x}/{y}.jpg';
const MAPTILER_ATTRIBUTION = '<a href="https://www.maptiler.com/copyright/" target="_blank">&copy; MapTiler</a> <a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>';

function normalizeCloudFrontDomain(domain: string | undefined): string | null {
  const value = domain?.trim();
  if (!value) return null;
  return value.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

function normalizeFolder(folder: string | undefined): string {
  return (folder ?? 'pointcloud-tiles').trim().replace(/^\/+|\/+$/g, '');
}

function buildTileConfig(): {
  source: TileSource;
  baseUrl: string;
  missingConfig: boolean;
} {
  if (TILE_SOURCE === 'local') {
    return {
      source: 'local',
      baseUrl: LOCAL_TILE_SERVER_BASE,
      missingConfig: false,
    };
  }

  const cloudFrontDomain = normalizeCloudFrontDomain(
    import.meta.env.VITE_AWS_MEDIA_CLOUDFRONT_DISTRIBUTION_DOMAIN
  );
  const folder = normalizeFolder(import.meta.env.VITE_POINTCLOUD_TILES_FOLDER);
  const baseUrl = cloudFrontDomain
    ? `https://${cloudFrontDomain}/${folder}`
    : '';

  return {
    source: 'cloudfront',
    baseUrl,
    missingConfig: !cloudFrontDomain,
  };
}

export const TILE_CONFIG = buildTileConfig();

export function tilesetUrlFor(dataset: string): string {
  return TILE_CONFIG.baseUrl ? `${TILE_CONFIG.baseUrl}/${dataset}/tileset.json` : '';
}

export type ViewerState = 'loading' | 'ready' | 'error';

export interface CurrentViewPoint {
  x: number;
  y: number;
  z: number;
}

export interface CurrentViewSample extends CurrentViewPoint {
  weight: number;
  source: 'pickPosition' | 'orbitTarget';
}

export interface CameraSnapshot {
  orbitTarget: CurrentViewPoint;
  orbitHeading: number;
  orbitPitch: number;
  orbitRange: number;
  position: CurrentViewPoint;
  direction: CurrentViewPoint;
  up: CurrentViewPoint;
  frustumNear: number | null;
  frustumFar: number | null;
}

export interface SceneLayerConfig {
  dataset: string;
  preset: PresetName;
  detailScope?: DetailScope;
}

export interface MicroTransitionResult {
  status: 'ready' | 'aborted' | 'failed';
  durationMs: number;
  peakMemoryBytes: number;
  reason: string;
}

export interface LoadSceneOptions {
  primary: SceneLayerConfig;
  context?: SceneLayerConfig | null;
  cameraBehavior?: 'flyTo' | 'preserve' | 'restore';
  snapshot?: CameraSnapshot | null;
}

export interface ViewerCallbacks {
  onStateChange: (state: ViewerState, message?: string) => void;
  onTileStats: (loaded: number, active?: number | string) => void;
  onPresetChange: (preset: PresetName) => void;
  onBrowserMetric: (metric: BrowserMetricName, value: number | string | boolean) => void;
  onInteraction: () => void;
  onViewSettled: () => void;
  onDetailContextModeChange?: (mode: DetailContextMode, reason: string | null) => void;
}

interface LayerRuntimeStats {
  loadedTiles: number;
  selectedTiles: number | string;
  visiblePointsEstimated: number | string;
  tilesetMemoryBytes: number;
}

type RuntimeTileContent = {
  pointsLength?: number;
  geometryByteLength?: number;
  texturesByteLength?: number;
  batchTableByteLength?: number;
  innerContents?: RuntimeTileContent[];
};

type RuntimeTile = {
  content?: RuntimeTileContent;
};

type RuntimeTileset = {
  _selectedTiles?: RuntimeTile[];
  selectedTiles?: RuntimeTile[];
  asset?: {
    extras?: {
      coordinateMode?: string;
      local_only?: boolean;
    };
  };
  statistics?: {
    numberOfLoadedTilesTotal?: number;
    numberOfTilesSelected?: number;
    numberOfTilesWithContentReady?: number;
    numberOfPointsSelected?: number;
  };
};

export class PointCloudViewer {
  private viewer: Cesium.Viewer;
  private primaryTileset: Cesium.Cesium3DTileset | null = null;
  private baseTileset: Cesium.Cesium3DTileset | null = null;
  private contextTileset: Cesium.Cesium3DTileset | null = null;
  private candidateTileset: Cesium.Cesium3DTileset | null = null;
  private detailMicroActive = false;
  private detailContextMode: DetailContextMode = 'off';
  private dimAlphaSupported = true;
  private baseDataset: string | null = null;
  private detailContextFallbackReason: string | null = null;
  private performanceGateStatus: PerformanceGateStatus = 'ok';
  private performanceGateFailures: string[] = [];
  private cameraLimitTileset: Cesium.Cesium3DTileset | null = null;
  private activeDataset = DATASET;
  private postRenderUnsubscribe: Cesium.Event.RemoveCallback | null = null;
  private inputHandler: Cesium.ScreenSpaceEventHandler | null = null;
  private cameraMoveEndUnsubscribe: Cesium.Event.RemoveCallback | null = null;
  private currentPreset: PresetName = 'low';
  private callbacks: ViewerCallbacks;
  private tilesLoaded = 0;
  private activeTilesLoaded: number | string = 0;
  private minCameraDistance = 1;
  private maxCameraDistance = Number.POSITIVE_INFINITY;
  private panScaleBase = 1;
  private orbitTarget = new Cesium.Cartesian3();
  private orbitHeading = Cesium.Math.toRadians(35);
  private orbitPitch = Cesium.Math.toRadians(-35);
  private orbitRange = 1;
  private activeDrag: 'orbit' | 'pan' | null = null;
  private lastPointer: Cesium.Cartesian2 | null = null;
  private touchInputCleanup: (() => void) | null = null;
  private firstTileLoadedReported = false;
  private firstVisibleReported = false;
  private loadStartTime = 0;
  private detailSseOverride: number | null = null;
  private currentDetailScope: DetailScope = 'none';
  private microTransitionGeneration = 0;
  private lastLayerRuntimeKey = '';
  private globeControlsActive = false;

  constructor(containerId: string, callbacks: ViewerCallbacks) {
    this.callbacks = callbacks;
    this.viewer = this.createViewer(containerId);
  }

  private createViewer(containerId: string): Cesium.Viewer {
    const mapTilerBaseLayer = buildMapTilerBaseLayer();
    const viewer = new Cesium.Viewer(containerId, {
      // Disable all default widgets
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      vrButton: false,
      infoBox: false,
      selectionIndicator: false,

      // No Cesium ion imagery; MapTiler is opt-in via ?basemap=maptiler.
      baseLayer: mapTilerBaseLayer ?? false,
      terrainProvider: new Cesium.EllipsoidTerrainProvider(),

      // Keep the Phase 1 local-coordinate viewer globe-free unless MapTiler is requested.
      ...(MAPTILER_BASEMAP_ENABLED ? {} : { globe: false }),
      skyBox: false,
      skyAtmosphere: false,
    });

    if (MAPTILER_BASEMAP_ENABLED) {
      viewer.creditDisplay.addStaticCredit(new Cesium.Credit(MAPTILER_ATTRIBUTION, true));
    }

    // Dark background
    viewer.scene.backgroundColor = new Cesium.Color(0.04, 0.04, 0.06, 1.0);
    viewer.scene.logarithmicDepthBuffer = true;
    this.cameraMoveEndUnsubscribe = viewer.camera.moveEnd.addEventListener(() => {
      this.callbacks.onViewSettled();
    });

    const controller = viewer.scene.screenSpaceCameraController;
    controller.inertiaZoom = 0.35;
    controller.minimumZoomDistance = 1;
    controller.enableRotate = false;
    controller.enableTranslate = false;
    controller.enableTilt = false;
    controller.enableLook = false;
    controller.enableZoom = false;

    return viewer;
  }

  async loadTileset(dataset = this.activeDataset): Promise<void> {
    await this.loadScene({
      primary: { dataset, preset: this.currentPreset },
      cameraBehavior: 'flyTo',
    });
  }

  async loadScene(options: LoadSceneOptions): Promise<void> {
    this.callbacks.onStateChange('loading', 'Connecting to tile server...');

    try {
      const primaryUrl = tilesetUrlFor(options.primary.dataset);
      const contextUrl = options.context ? tilesetUrlFor(options.context.dataset) : null;
      await Promise.all([
        this.checkTileServer(primaryUrl),
        contextUrl ? this.checkTileServer(contextUrl) : Promise.resolve(),
      ]);
      this.unloadTilesets();
      this.activeDataset = options.primary.dataset;
      this.currentDetailScope = options.primary.detailScope ?? 'none';
      this.callbacks.onStateChange('loading', 'Fetching tileset.json...');
      this.loadStartTime = performance.now();
      this.firstTileLoadedReported = false;
      this.firstVisibleReported = false;
      this.tilesLoaded = 0;
      this.activeTilesLoaded = 0;
      this.callbacks.onTileStats(0, 0);
      this.reportLayerTileStats();

      const tilesetStart = performance.now();
      const contextTileset = options.context
        ? await this.loadLayer(options.context)
        : null;
      const primaryTileset = await this.loadLayer(options.primary);
      this.callbacks.onBrowserMetric('tilesetLoadTime', performance.now() - tilesetStart);

      if (contextTileset) this.viewer.scene.primitives.add(contextTileset);
      this.viewer.scene.primitives.add(primaryTileset);
      this.contextTileset = contextTileset;
      this.primaryTileset = primaryTileset;
      this.configureCameraLimits(
        primaryTileset,
        contextTileset,
        options.cameraBehavior === 'flyTo' || !options.cameraBehavior
      );
      this.installPointCloudControls(primaryTileset, contextTileset);

      if (contextTileset) applyPreset(
        contextTileset,
        options.context?.preset ?? 'low',
        {},
        { variant: this.presetVariantForTileset(contextTileset), detailScope: options.context?.detailScope }
      );
      applyPreset(
        primaryTileset,
        options.primary.preset,
        this.primaryPresetOverrides(options.primary.preset),
        { variant: this.presetVariantForTileset(primaryTileset), detailScope: options.primary.detailScope }
      );
      this.reportEffectiveSse();

      const cameraStart = performance.now();
      if (options.cameraBehavior === 'restore' && options.snapshot) {
        this.restoreCameraSnapshot(options.snapshot);
        this.callbacks.onBrowserMetric('flyToTime', performance.now() - cameraStart);
      } else if (options.cameraBehavior === 'preserve') {
        this.callbacks.onBrowserMetric('flyToTime', 0);
      } else {
        this.callbacks.onBrowserMetric('flyToTime', this.flyToTileset());
      }
      this.callbacks.onStateChange(
        'ready',
        contextUrl ? `Streaming focus + context: ${primaryUrl}` : `Streaming: ${primaryUrl}`
      );

      const onInitialTilesLoaded = () => {
        if (!this.firstTileLoadedReported) {
          this.firstTileLoadedReported = true;
          this.callbacks.onBrowserMetric('firstTileLoadedTime', performance.now() - this.loadStartTime);
        }
        this.callbacks.onTileStats(this.tilesLoaded, this.activeTileCount());
      };
      primaryTileset.initialTilesLoaded.addEventListener(onInitialTilesLoaded);
      contextTileset?.initialTilesLoaded.addEventListener(onInitialTilesLoaded);

      const onAllTilesLoaded = () => {
        this.callbacks.onTileStats(this.tilesLoaded, this.activeTileCount());
      };
      primaryTileset.allTilesLoaded.addEventListener(onAllTilesLoaded);
      contextTileset?.allTilesLoaded.addEventListener(onAllTilesLoaded);

      this.postRenderUnsubscribe = this.viewer.scene.postRender.addEventListener(() => {
        if (!this.primaryTileset && !this.contextTileset && !this.baseTileset) return;
        this.clampCameraDistance();
        if (this.detailMicroActive) {
          this.enforcePerformanceGate();
        }
        const n = this.loadedTileCount();
        const active = this.activeTileCount();
        if (n !== this.tilesLoaded || active !== this.activeTilesLoaded) {
          this.tilesLoaded = n;
          this.activeTilesLoaded = active;
          this.callbacks.onTileStats(n, active);
        }
        this.reportLayerTileStats();
        if (n > 0 && !this.firstVisibleReported) {
          this.firstVisibleReported = true;
          this.callbacks.onBrowserMetric('firstVisibleTime', performance.now() - this.loadStartTime);
        }
      });

      this.installTileFailureLogging(primaryTileset);
      if (contextTileset) this.installTileFailureLogging(contextTileset);
    } catch (err) {
      const error = err as Error;
      console.error('[Viewer] Failed to load tileset:', error);

      let message = error.message ?? 'Unknown error';
      if (
        message.includes('Failed to fetch') ||
        message.includes('NetworkError') ||
        message.includes('ECONNREFUSED') ||
        message.includes('ERR_CONNECTION_REFUSED')
      ) {
        message = TILE_CONFIG.source === 'cloudfront'
          ? `Cannot reach CloudFront tiles at ${TILE_CONFIG.baseUrl}.`
          : `Cannot reach tile server at ${TILE_CONFIG.baseUrl}.\n-> Run: npm run pipeline:serve`;
      } else if (message.includes('404') || message.includes('Not Found')) {
        message = TILE_CONFIG.source === 'cloudfront'
          ? `tileset.json not found on CloudFront for dataset "${DATASET}".`
          : `tileset.json not found.\n-> Run: npm run pipeline:tiles`;
      }

      this.callbacks.onStateChange('error', message);
    }
  }

  private async loadLayer(config: SceneLayerConfig): Promise<Cesium.Cesium3DTileset> {
    const preset = presetFor(config.preset, { detailScope: config.detailScope });
    const tileset = await Cesium.Cesium3DTileset.fromUrl(tilesetUrlFor(config.dataset), {
      maximumScreenSpaceError: preset.maximumScreenSpaceError,
      cacheBytes: preset.cacheBytes,
      maximumCacheOverflowBytes: preset.maximumCacheOverflowBytes,
      skipLevelOfDetail: false,
    });

    if (DEBUG_TILES) {
      tileset.debugShowBoundingVolume = true;
      tileset.debugShowGeometricError = true;
      tileset.debugShowRenderingStatistics = true;
    }

    return tileset;
  }

  async switchMicroLayer(
    config: SceneLayerConfig,
    options: { timeoutMs?: number; memoryBudgetBytes?: number; generation?: number } = {}
  ): Promise<MicroTransitionResult> {
    const started = performance.now();
    const timeoutMs = options.timeoutMs ?? DETAIL_TRANSITION_TIMEOUT_MS;
    const memoryBudgetBytes = options.memoryBudgetBytes ?? DETAIL_TRANSITION_MEMORY_BUDGET_BYTES;
    const generation = options.generation ?? ++this.microTransitionGeneration;
    const oldTileset = this.primaryTileset;
    if (!oldTileset) {
      await this.loadScene({ primary: config, cameraBehavior: 'preserve' });
      return { status: 'ready', durationMs: performance.now() - started, peakMemoryBytes: 0, reason: 'initial_load' };
    }

    await this.checkTileServer(tilesetUrlFor(config.dataset));
    if (generation !== this.microTransitionGeneration) {
      return { status: 'aborted', durationMs: performance.now() - started, peakMemoryBytes: 0, reason: 'stale_generation' };
    }

    const candidate = await this.loadLayer(config);
    candidate.show = false;
    candidate.preloadWhenHidden = true;
    this.candidateTileset = candidate;
    applyPreset(
      candidate,
      config.preset,
      this.primaryPresetOverrides(config.preset),
      { variant: this.presetVariantForTileset(candidate), detailScope: config.detailScope }
    );

    let peakMemoryBytes = 0;
    let failedReason: string | null = null;
    const onFailure = (event: { url: string; message: string }) => {
      failedReason = `tile_failed:${event.url}:${event.message}`;
    };
    candidate.tileFailed.addEventListener(onFailure);

    const completion = new Promise<'ready' | 'timeout' | 'memory' | 'failed' | 'stale'>((resolve) => {
      let settled = false;
      const finish = (result: 'ready' | 'timeout' | 'memory' | 'failed' | 'stale') => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        removeReady();
        removeMonitor();
        resolve(result);
      };
      const removeReady = candidate.initialTilesLoaded.addEventListener(() => finish('ready'));
      const removeMonitor = this.viewer.scene.postRender.addEventListener(() => {
        peakMemoryBytes = Math.max(
          peakMemoryBytes,
          this.tilesetMemoryBytes(this.baseTileset) +
            this.tilesetMemoryBytes(oldTileset) +
            this.tilesetMemoryBytes(candidate)
        );
        if (generation !== this.microTransitionGeneration) finish('stale');
        else if (failedReason) finish('failed');
        else if (peakMemoryBytes > memoryBudgetBytes) finish('memory');
      });
      const timeout = window.setTimeout(() => finish('timeout'), timeoutMs);
    });

    this.viewer.scene.primitives.add(candidate);
    this.reportLayerCountMetrics();
    const outcome = await completion;
    candidate.tileFailed.removeEventListener(onFailure);
    const durationMs = performance.now() - started;
    if (outcome !== 'ready') {
      this.destroyTileset(candidate);
      if (this.candidateTileset === candidate) this.candidateTileset = null;
      this.reportLayerCountMetrics();
      return {
        status: outcome === 'failed' ? 'failed' : 'aborted',
        durationMs,
        peakMemoryBytes,
        reason: outcome === 'memory' ? 'memory_budget_exceeded' : outcome === 'timeout' ? 'timeout' : outcome,
      };
    }

    oldTileset.show = false;
    candidate.show = true;
    this.primaryTileset = candidate;
    this.candidateTileset = null;
    this.activeDataset = config.dataset;
    this.currentDetailScope = config.detailScope ?? 'micro';
    this.cameraLimitTileset = candidate;
    this.reportLayerCountMetrics();
    const removeAfterRender = this.viewer.scene.postRender.addEventListener(() => {
      removeAfterRender();
      this.destroyTileset(oldTileset);
      this.reportLayerCountMetrics();
      this.reportLayerTileStats();
    });
    this.installTileFailureLogging(candidate);
    return { status: 'ready', durationMs, peakMemoryBytes, reason: 'initial_tiles_loaded' };
  }

  cancelMicroTransition(): void {
    this.microTransitionGeneration += 1;
  }

  getDetailContextMode(): DetailContextMode {
    return this.detailContextMode;
  }

  isDetailMicroActive(): boolean {
    return this.detailMicroActive;
  }

  getBaseTileset(): Cesium.Cesium3DTileset | null {
    return this.baseTileset;
  }

  getExploreTilesetForIdentityCheck(): Cesium.Cesium3DTileset | null {
    if (this.detailMicroActive && this.baseTileset) return this.baseTileset;
    if (this.currentPreset === 'medium' && this.primaryTileset) return this.primaryTileset;
    return null;
  }

  canReuseExploreBase(exploreDataset: string): boolean {
    return (
      this.currentPreset === 'medium' &&
      Boolean(this.primaryTileset) &&
      this.activeDataset === exploreDataset &&
      !this.detailMicroActive &&
      this.currentDetailScope !== 'micro'
    );
  }

  async enterDetailMicro(options: {
    micro: SceneLayerConfig;
    exploreDataset: string;
    fromExplore: boolean;
    timeoutMs?: number;
    memoryBudgetBytes?: number;
  }): Promise<MicroTransitionResult> {
    const started = performance.now();
    const timeoutMs = options.timeoutMs ?? DETAIL_TRANSITION_TIMEOUT_MS;
    const memoryBudgetBytes = options.memoryBudgetBytes ?? DETAIL_TRANSITION_MEMORY_BUDGET_BYTES;
    const generation = ++this.microTransitionGeneration;
    this.callbacks.onStateChange('loading', 'Loading Detail micro layer...');
    this.detailContextFallbackReason = null;
    this.performanceGateFailures = [];
    this.performanceGateStatus = 'ok';

    const previousPrimary = this.primaryTileset;
    const previousContext = this.contextTileset;
    if (
      options.fromExplore &&
      (!previousPrimary || this.activeDataset !== options.exploreDataset)
    ) {
      throw new Error('Explore p10 must be resident before Detail micro transition');
    }

    let candidate: Cesium.Cesium3DTileset;
    try {
      await this.checkTileServer(tilesetUrlFor(options.micro.dataset));
      candidate = await this.loadLayer(options.micro);
    } catch (error) {
      this.callbacks.onStateChange('ready', 'Detail micro failed; keeping the current dataset visible.');
      return {
        status: 'failed',
        durationMs: performance.now() - started,
        peakMemoryBytes: 0,
        reason: `micro_load_failed:${(error as Error).message}`,
      };
    }
    candidate.show = false;
    candidate.preloadWhenHidden = true;
    applyPreset(
      candidate,
      options.micro.preset,
      this.primaryPresetOverrides(options.micro.preset),
      { variant: this.presetVariantForTileset(candidate), detailScope: options.micro.detailScope }
    );
    this.viewer.scene.primitives.add(candidate);
    this.candidateTileset = candidate;
    this.reportLayerCountMetrics();

    let peakMemoryBytes = 0;
    let tileFailure: string | null = null;
    const onFailure = (event: { url: string; message: string }) => {
      tileFailure = `tile_failed:${event.url}:${event.message}`;
    };
    candidate.tileFailed.addEventListener(onFailure);
    const outcome = await new Promise<'ready' | 'timeout' | 'memory' | 'failed' | 'stale'>((resolve) => {
      let settled = false;
      const finish = (value: 'ready' | 'timeout' | 'memory' | 'failed' | 'stale') => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        removeReady();
        removeMonitor();
        resolve(value);
      };
      const removeReady = candidate.initialTilesLoaded.addEventListener(() => finish('ready'));
      const removeMonitor = this.viewer.scene.postRender.addEventListener(() => {
        peakMemoryBytes = Math.max(
          peakMemoryBytes,
          this.tilesetMemoryBytes(previousPrimary) +
            this.tilesetMemoryBytes(previousContext) +
            this.tilesetMemoryBytes(candidate)
        );
        if (generation !== this.microTransitionGeneration) finish('stale');
        else if (tileFailure) finish('failed');
        else if (peakMemoryBytes > memoryBudgetBytes) finish('memory');
      });
      const timeout = window.setTimeout(() => finish('timeout'), timeoutMs);
    });
    candidate.tileFailed.removeEventListener(onFailure);

    if (outcome !== 'ready') {
      this.destroyTileset(candidate);
      if (this.candidateTileset === candidate) this.candidateTileset = null;
      this.reportLayerCountMetrics();
      this.callbacks.onStateChange('ready', 'Detail micro failed; keeping the current dataset visible.');
      return {
        status: outcome === 'failed' ? 'failed' : 'aborted',
        durationMs: performance.now() - started,
        peakMemoryBytes,
        reason: outcome === 'memory'
          ? 'memory_budget_exceeded'
          : outcome === 'failed'
            ? tileFailure ?? 'tile_failed'
            : outcome,
      };
    }

    this.detailContextMode = 'off';
    this.baseDataset = options.exploreDataset;
    if (options.fromExplore && previousPrimary) {
      this.baseTileset = previousPrimary;
      assertBaseIdentity(this.baseTileset, previousPrimary);
      const contextResult = applyDetailContextMode(this.baseTileset, 'off');
      this.dimAlphaSupported = contextResult.dimAlphaSupported;
    } else {
      this.baseTileset = null;
      previousPrimary && (previousPrimary.show = false);
    }
    if (previousContext) previousContext.show = false;
    candidate.show = true;
    this.primaryTileset = candidate;
    this.candidateTileset = null;
    this.contextTileset = null;
    this.activeDataset = options.micro.dataset;
    this.currentDetailScope = options.micro.detailScope ?? 'micro';
    this.currentPreset = 'high';
    this.detailMicroActive = true;
    this.cameraLimitTileset = candidate;
    this.configureCameraLimits(candidate, null, false);
    this.installTileFailureLogging(candidate);
    const removeAfterRender = this.viewer.scene.postRender.addEventListener(() => {
      removeAfterRender();
      if (!options.fromExplore && previousPrimary) this.destroyTileset(previousPrimary);
      if (previousContext) this.destroyTileset(previousContext);
    });
    this.reportLayerCountMetrics();
    this.reportLayerTileStats();
    this.notifyDetailContextModeChange('off', null);
    this.callbacks.onStateChange('ready', `Streaming Detail micro: ${options.micro.dataset}`);
    return {
      status: 'ready',
      durationMs: performance.now() - started,
      peakMemoryBytes,
      reason: 'initial_tiles_loaded',
    };
  }

  async exitDetailMicroToExplore(exploreDataset: string): Promise<Cesium.Cesium3DTileset | null> {
    const reusedBase = this.baseTileset;
    if (this.primaryTileset && this.primaryTileset !== reusedBase) {
      this.destroyTileset(this.primaryTileset);
    }
    if (this.candidateTileset) {
      this.destroyTileset(this.candidateTileset);
      this.candidateTileset = null;
    }

    if (reusedBase) {
      this.primaryTileset = reusedBase;
      assertBaseIdentity(this.primaryTileset, reusedBase);
      this.activeDataset = exploreDataset;
      reusedBase.show = true;
      reusedBase.preloadWhenHidden = false;
      reusedBase.cullRequestsWhileMoving = true;
      reusedBase.style = undefined;
      applyPreset(
        reusedBase,
        'medium',
        {},
        { variant: this.presetVariantForTileset(reusedBase), detailScope: 'none' }
      );
    } else {
      this.primaryTileset = null;
    }

    this.baseTileset = null;
    this.baseDataset = null;
    this.detailMicroActive = false;
    this.detailContextMode = 'off';
    this.detailContextFallbackReason = null;
    this.currentDetailScope = 'none';
    this.currentPreset = 'medium';
    this.cameraLimitTileset = this.primaryTileset;
    if (this.primaryTileset) {
      this.configureCameraLimits(this.primaryTileset, this.contextTileset, false);
    }
    this.reportLayerCountMetrics();
    this.reportLayerTileStats();
    return reusedBase;
  }

  async setDetailContextMode(mode: DetailContextMode): Promise<void> {
    if (!this.detailMicroActive) return;
    this.detailContextMode = mode;
    this.detailContextFallbackReason = null;

    if ((mode === 'dim' || mode === 'full') && !this.baseTileset && this.baseDataset) {
      try {
        await this.ensureBaseLoaded(this.baseDataset);
      } catch (error) {
        this.detailContextMode = 'off';
        this.detailContextFallbackReason = `base_load_failed:${(error as Error).message}`;
        this.notifyDetailContextModeChange('off', this.detailContextFallbackReason);
        this.reportLayerCountMetrics();
        this.reportLayerTileStats();
        return;
      }
    }

    if (this.baseTileset) {
      const result = applyDetailContextMode(this.baseTileset, mode, {
        dimAlphaSupported: this.dimAlphaSupported,
      });
      this.dimAlphaSupported = result.dimAlphaSupported;
    }

    this.notifyDetailContextModeChange(mode, null);
    this.reportLayerCountMetrics();
    this.reportLayerTileStats();
  }

  async syncExploreContextLayer(config: SceneLayerConfig | null): Promise<void> {
    if (config) {
      if (this.contextTileset) return;
      const contextTileset = await this.loadLayer(config);
      this.viewer.scene.primitives.add(contextTileset);
      this.contextTileset = contextTileset;
      applyPreset(
        contextTileset,
        config.preset,
        {},
        { variant: this.presetVariantForTileset(contextTileset), detailScope: config.detailScope }
      );
      this.installTileFailureLogging(contextTileset);
      if (this.primaryTileset) {
        this.configureCameraLimits(this.primaryTileset, contextTileset, false);
      }
      return;
    }

    if (!this.contextTileset) return;
    this.destroyTileset(this.contextTileset);
    this.contextTileset = null;
    if (this.primaryTileset) {
      this.configureCameraLimits(this.primaryTileset, null, false);
    }
  }

  private async ensureBaseLoaded(exploreDataset: string): Promise<void> {
    if (this.baseTileset) return;
    await this.checkTileServer(tilesetUrlFor(exploreDataset));
    const tileset = await this.loadLayer({
      dataset: exploreDataset,
      preset: 'medium',
      detailScope: 'none',
    });
    tileset.show = false;
    tileset.preloadWhenHidden = true;
    this.viewer.scene.primitives.add(tileset);
    let failure: string | null = null;
    const onFailure = (event: { url: string; message: string }) => {
      failure = `tile_failed:${event.url}:${event.message}`;
    };
    tileset.tileFailed.addEventListener(onFailure);
    const outcome = await new Promise<'ready' | 'timeout' | 'failed' | 'memory'>((resolve) => {
      let settled = false;
      const finish = (value: 'ready' | 'timeout' | 'failed' | 'memory') => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        removeReady();
        removeMonitor();
        resolve(value);
      };
      const removeReady = tileset.initialTilesLoaded.addEventListener(() => finish('ready'));
      const removeMonitor = this.viewer.scene.postRender.addEventListener(() => {
        if (failure) finish('failed');
        else if (
          this.tilesetMemoryBytes(this.primaryTileset) + this.tilesetMemoryBytes(tileset) >
          DETAIL_TRANSITION_MEMORY_BUDGET_BYTES
        ) finish('memory');
      });
      const timeout = window.setTimeout(() => finish('timeout'), DETAIL_TRANSITION_TIMEOUT_MS);
    });
    tileset.tileFailed.removeEventListener(onFailure);
    if (outcome !== 'ready') {
      this.destroyTileset(tileset);
      throw new Error(outcome === 'failed' ? failure ?? 'tile_failed' : outcome);
    }

    const result = applyDetailContextMode(tileset, this.detailContextMode, {
      dimAlphaSupported: this.dimAlphaSupported,
    });
    this.baseTileset = tileset;
    this.dimAlphaSupported = result.dimAlphaSupported;
    this.installTileFailureLogging(tileset);
  }

  private notifyDetailContextModeChange(mode: DetailContextMode, reason: string | null): void {
    this.callbacks.onDetailContextModeChange?.(mode, reason);
  }

  private reportLayerCountMetrics(): void {
    const counts = computeLayerCounts({
      baseTileset: this.baseTileset,
      baseShow: Boolean(this.baseTileset?.show),
      detailTileset: this.detailMicroActive ? this.primaryTileset : null,
      detailShow: Boolean(this.primaryTileset?.show),
      candidateTileset: this.candidateTileset,
    });
    this.callbacks.onBrowserMetric('visibleP10LayerCount', counts.visibleP10LayerCount);
    this.callbacks.onBrowserMetric('residentP10TilesetCount', counts.residentP10TilesetCount);
    this.callbacks.onBrowserMetric('visibleP100LayerCount', counts.visibleP100LayerCount);
    this.callbacks.onBrowserMetric('residentP100TilesetCount', counts.residentP100TilesetCount);
  }

  private enforcePerformanceGate(): void {
    if (!this.detailMicroActive) return;

    const combinedActiveTiles = this.combinedActiveTileCount();
    const memory = this.detailMemoryMetrics();
    const gate = evaluatePerformanceGate({
      detailContextMode: this.detailContextMode,
      combinedResidentMemoryBytes: memory.combinedResidentMemoryBytes,
      combinedActiveTiles,
    });

    this.performanceGateStatus = gate.status;
    this.performanceGateFailures = gate.failures;

    if (gate.suggestedContextMode && gate.suggestedContextMode !== this.detailContextMode) {
      this.detailContextMode = gate.suggestedContextMode;
      this.detailContextFallbackReason = gate.failures.join(';') || 'performance_gate';
      if (this.baseTileset) {
        applyDetailContextMode(this.baseTileset, 'off');
        trimBaseTileset(this.baseTileset);
      }
      this.notifyDetailContextModeChange('off', this.detailContextFallbackReason);
    } else if (gate.shouldHideBase && this.baseTileset) {
      this.detailContextFallbackReason = gate.failures.join(';') || 'performance_gate';
      applyDetailContextMode(this.baseTileset, 'off');
      trimBaseTileset(this.baseTileset);
      this.notifyDetailContextModeChange('off', this.detailContextFallbackReason);
    }

    this.callbacks.onBrowserMetric('performanceGateStatus', this.performanceGateStatus);
    this.callbacks.onBrowserMetric(
      'performanceGateFailures',
      this.performanceGateFailures.join(';') || 'none'
    );
    this.callbacks.onBrowserMetric(
      'detailContextFallbackReason',
      this.detailContextFallbackReason ?? 'none'
    );
  }

  private detailMemoryMetrics(): ReturnType<typeof computeMemoryMetrics> {
    return computeMemoryMetrics({
      baseShow: Boolean(this.baseTileset?.show),
      baseResidentMemoryBytes: this.tilesetMemoryBytes(this.baseTileset),
      baseSelectedTileBytes: this.selectedTilesMemoryBytes(this.baseTileset),
      detailResidentMemoryBytes: this.tilesetMemoryBytes(this.primaryTileset),
      detailSelectedTileBytes: this.selectedTilesMemoryBytes(this.primaryTileset),
    });
  }

  private combinedActiveTileCount(): number | string {
    const detail = this.layerActiveTileCount(this.primaryTileset);
    const base = this.baseTileset?.show ? this.layerActiveTileCount(this.baseTileset) : 0;
    if (typeof detail === 'string' || typeof base === 'string') return 'unsupported';
    return detail + base;
  }

  private selectedTilesMemoryBytes(
    tileset: Cesium.Cesium3DTileset | null
  ): number | null {
    if (!tileset || !tileset.show) return tileset?.show === false ? 0 : null;
    const ts = tileset as unknown as RuntimeTileset;
    const selectedTiles = Array.isArray(ts._selectedTiles)
      ? ts._selectedTiles
      : ts.selectedTiles;
    if (!Array.isArray(selectedTiles)) return null;

    let total = 0;
    for (const tile of selectedTiles as RuntimeTile[]) {
      const bytes = contentMemoryBytes(tile.content);
      if (bytes === null) return null;
      total += bytes;
    }
    return total;
  }

  private reportDetailMicroMetrics(
    _focus: LayerRuntimeStats,
    context: LayerRuntimeStats,
    base: LayerRuntimeStats,
    detail: LayerRuntimeStats
  ): void {
    const memory = this.detailMemoryMetrics();
    const combinedActiveTiles = this.combinedActiveTileCount();

    this.callbacks.onBrowserMetric('detailContextMode', this.detailContextMode);
    this.callbacks.onBrowserMetric('dimAlphaSupported', this.dimAlphaSupported);
    this.callbacks.onBrowserMetric('baseDataset', this.baseDataset ?? '—');
    this.callbacks.onBrowserMetric('baseResident', Boolean(this.baseTileset));
    this.callbacks.onBrowserMetric('baseLoadedTiles', base.loadedTiles);
    this.callbacks.onBrowserMetric(
      'baseActiveTiles',
      this.baseTileset?.show ? base.selectedTiles : 0
    );
    this.callbacks.onBrowserMetric(
      'baseVisiblePointsEstimated',
      this.baseTileset?.show ? base.visiblePointsEstimated : 0
    );
    this.callbacks.onBrowserMetric('baseResidentMemoryBytes', memory.baseResidentMemoryBytes);
    this.callbacks.onBrowserMetric('baseVisibleMemoryBytes', memory.baseVisibleMemoryBytes);
    this.callbacks.onBrowserMetric('detailDataset', this.activeDataset);
    this.callbacks.onBrowserMetric('detailLoadedTiles', detail.loadedTiles);
    this.callbacks.onBrowserMetric('detailActiveTiles', detail.selectedTiles);
    this.callbacks.onBrowserMetric('detailVisiblePointsEstimated', detail.visiblePointsEstimated);
    this.callbacks.onBrowserMetric('detailResidentMemoryBytes', memory.detailResidentMemoryBytes);
    this.callbacks.onBrowserMetric('detailVisibleMemoryBytes', memory.detailVisibleMemoryBytes);
    this.callbacks.onBrowserMetric('combinedActiveTiles', combinedActiveTiles);
    this.callbacks.onBrowserMetric('combinedResidentMemoryBytes', memory.combinedResidentMemoryBytes);
    this.callbacks.onBrowserMetric(
      'detailContextFallbackReason',
      this.detailContextFallbackReason ?? 'none'
    );
    this.callbacks.onBrowserMetric('performanceGateStatus', this.performanceGateStatus);
    this.callbacks.onBrowserMetric(
      'performanceGateFailures',
      this.performanceGateFailures.join(';') || 'none'
    );

    const selectedTiles = sumNumericStats(
      sumNumericStats(detail.selectedTiles, context.selectedTiles),
      this.baseTileset?.show ? base.selectedTiles : 0
    );
    const visiblePoints = sumNumericStats(
      sumNumericStats(detail.visiblePointsEstimated, context.visiblePointsEstimated),
      this.baseTileset?.show ? base.visiblePointsEstimated : 0
    );
    const tilesetMemoryBytes =
      detail.tilesetMemoryBytes + context.tilesetMemoryBytes + memory.baseResidentMemoryBytes;

    this.callbacks.onBrowserMetric('focusLoadedTiles', detail.loadedTiles);
    this.callbacks.onBrowserMetric('focusActiveLoadedTiles', detail.selectedTiles);
    this.callbacks.onBrowserMetric('contextLoadedTiles', context.loadedTiles);
    this.callbacks.onBrowserMetric('contextActiveLoadedTiles', context.selectedTiles);
    this.callbacks.onBrowserMetric('activeLoadedTiles', selectedTiles);
    this.callbacks.onBrowserMetric('selectedTiles', selectedTiles);
    this.callbacks.onBrowserMetric('visiblePointsEstimated', visiblePoints);
    this.callbacks.onBrowserMetric('tilesetMemoryBytes', tilesetMemoryBytes);
  }

  private installTileFailureLogging(tileset: Cesium.Cesium3DTileset): void {
    tileset.tileFailed.addEventListener(
      (event: { url: string; message: string }) => {
        console.warn(`[Viewer] Tile failed: ${event.url} — ${event.message}`);
      }
    );
  }

  private async checkTileServer(tilesetUrl: string): Promise<void> {
    if (TILE_CONFIG.missingConfig) {
      throw new Error(
        'Missing VITE_AWS_MEDIA_CLOUDFRONT_DISTRIBUTION_DOMAIN for CloudFront tile source.'
      );
    }

    try {
      const response = await fetch(tilesetUrl, {
        method: 'HEAD',
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
    } catch (err) {
      const error = err as Error;
      if (error.name === 'TimeoutError') {
        const message = TILE_CONFIG.source === 'cloudfront'
          ? 'CloudFront tile request timed out.'
          : 'Tile server timed out. Is it running?\n-> Run: npm run pipeline:serve';
        throw new Error(message);
      }
      throw error;
    }
  }

  private flyToTileset(): number {
    const start = performance.now();
    if (!this.cameraLimitTileset) return 0;
    const isMobileViewport = window.matchMedia(MOBILE_VIEWPORT_QUERY).matches;
    if (this.isGlobeTileset(this.cameraLimitTileset)) {
      const sphere = this.cameraLimitTileset.boundingSphere;
      this.orbitTarget = Cesium.Cartesian3.clone(sphere.center);
      this.orbitRange = sphere.radius * (isMobileViewport ? 5.2 : 3.5);
      this.orbitPitch = Cesium.Math.toRadians(-35);
      this.orbitHeading = Cesium.Math.toRadians(35);
      this.viewer.camera.viewBoundingSphere(
        sphere,
        new Cesium.HeadingPitchRange(this.orbitHeading, this.orbitPitch, this.orbitRange)
      );
      this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      return performance.now() - start;
    }
    this.orbitRange = this.cameraLimitTileset.boundingSphere.radius * (isMobileViewport ? 5.2 : 3.5);
    this.orbitPitch = Cesium.Math.toRadians(-35);
    this.orbitHeading = Cesium.Math.toRadians(35);
    this.applyOrbitCamera();
    return performance.now() - start;
  }

  private isGlobeTileset(tileset: Cesium.Cesium3DTileset): boolean {
    const runtime = tileset as unknown as RuntimeTileset;
    return runtime.asset?.extras?.coordinateMode === 'globe' ||
      runtime.asset?.extras?.local_only === false;
  }

  private configureCameraLimits(
    primaryTileset: Cesium.Cesium3DTileset,
    contextTileset: Cesium.Cesium3DTileset | null,
    resetOrbit: boolean
  ): void {
    const focusRadius = Math.max(primaryTileset.boundingSphere.radius, 1);
    const limitTileset = contextTileset ?? primaryTileset;
    const limitRadius = Math.max(limitTileset.boundingSphere.radius, focusRadius, 1);
    this.cameraLimitTileset = limitTileset;
    if (resetOrbit) {
      this.orbitTarget = Cesium.Cartesian3.clone(limitTileset.boundingSphere.center);
      this.orbitRange = Cesium.Math.clamp(limitRadius * 3.5, focusRadius * 0.01, limitRadius * 12);
    }
    this.panScaleBase = limitRadius;
    this.minCameraDistance = Cesium.Math.clamp(
      focusRadius * MIN_CAMERA_DISTANCE_RATIO,
      MIN_CAMERA_DISTANCE_FLOOR,
      MIN_CAMERA_DISTANCE_CEILING
    );
    this.maxCameraDistance = limitRadius * 12;
    if (!resetOrbit) {
      this.syncOrbitStateFromCamera(primaryTileset.boundingSphere.center);
    }

    const controller = this.viewer.scene.screenSpaceCameraController;
    controller.minimumZoomDistance = this.minCameraDistance;
    controller.maximumZoomDistance = this.maxCameraDistance;
    if (this.isGlobeTileset(limitTileset)) {
      controller.minimumZoomDistance = Math.max(this.minCameraDistance, focusRadius * 0.02);
      controller.maximumZoomDistance = Math.max(this.maxCameraDistance, limitRadius * 80);
    }

    const frustum = this.viewer.camera.frustum;
    if (frustum instanceof Cesium.PerspectiveFrustum) {
      frustum.near = 0.1;
      frustum.far = MAPTILER_BASEMAP_ENABLED
        ? Math.max(this.maxCameraDistance * 4, MAPTILER_GLOBE_FRUSTUM_FAR)
        : this.maxCameraDistance * 4;
    }
  }

  private clampCameraDistance(): void {
    if (!this.cameraLimitTileset || this.globeControlsActive) return;

    const camera = this.viewer.camera;
    const center = this.cameraLimitTileset.boundingSphere.center;
    const offset = Cesium.Cartesian3.subtract(
      camera.positionWC,
      center,
      new Cesium.Cartesian3()
    );
    const distance = Cesium.Cartesian3.magnitude(offset);

    if (distance >= this.minCameraDistance && distance <= this.maxCameraDistance) {
      return;
    }

    const safeDirection = distance > 0
      ? Cesium.Cartesian3.normalize(offset, offset)
      : Cesium.Cartesian3.normalize(camera.directionWC, offset);
    const clampedDistance = Cesium.Math.clamp(
      distance,
      this.minCameraDistance,
      this.maxCameraDistance
    );
    const destination = Cesium.Cartesian3.add(
      center,
      Cesium.Cartesian3.multiplyByScalar(
        safeDirection,
        clampedDistance,
        new Cesium.Cartesian3()
      ),
      new Cesium.Cartesian3()
    );

    camera.setView({
      destination,
      orientation: {
        direction: camera.directionWC,
        up: camera.upWC,
      },
    });
  }

  private syncOrbitStateFromCamera(target: Cesium.Cartesian3): void {
    this.orbitTarget = Cesium.Cartesian3.clone(target);
    const offset = Cesium.Cartesian3.subtract(
      this.viewer.camera.positionWC,
      this.orbitTarget,
      new Cesium.Cartesian3()
    );
    const distance = Cesium.Cartesian3.magnitude(offset);
    if (distance <= 0) return;

    this.orbitRange = Cesium.Math.clamp(
      distance,
      this.minCameraDistance,
      this.maxCameraDistance
    );
    this.orbitHeading = Math.atan2(offset.x, offset.y);
    this.orbitPitch = Math.asin(Cesium.Math.clamp(offset.z / distance, -1, 1));
  }

  private installPointCloudControls(
    primaryTileset: Cesium.Cesium3DTileset,
    contextTileset: Cesium.Cesium3DTileset | null
  ): void {
    const usesGlobeControls = this.isGlobeTileset(contextTileset ?? primaryTileset);
    this.globeControlsActive = usesGlobeControls;
    if (usesGlobeControls) {
      this.installGlobePointCloudControls();
      return;
    }
    this.installLocalPointCloudControls();
  }

  private installGlobePointCloudControls(): void {
    this.inputHandler?.destroy();
    const handler = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas);
    this.inputHandler = handler;
    this.activeDrag = null;
    this.lastPointer = null;

    const controller = this.viewer.scene.screenSpaceCameraController;
    controller.enableRotate = false;
    controller.enableTranslate = false;
    controller.enableTilt = false;
    controller.enableLook = false;
    controller.enableZoom = true;
    controller.inertiaZoom = 0.35;
    controller.zoomEventTypes = [
      Cesium.CameraEventType.WHEEL,
      Cesium.CameraEventType.PINCH,
    ];

    handler.setInputAction((event: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      this.callbacks.onInteraction();
      this.activeDrag = 'orbit';
      this.lastPointer = Cesium.Cartesian2.clone(event.position);
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

    handler.setInputAction((event: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      this.callbacks.onInteraction();
      this.activeDrag = 'pan';
      this.lastPointer = Cesium.Cartesian2.clone(event.position);
    }, Cesium.ScreenSpaceEventType.RIGHT_DOWN);

    handler.setInputAction(() => {
      this.activeDrag = null;
      this.lastPointer = null;
    }, Cesium.ScreenSpaceEventType.LEFT_UP);

    handler.setInputAction(() => {
      this.activeDrag = null;
      this.lastPointer = null;
    }, Cesium.ScreenSpaceEventType.RIGHT_UP);

    handler.setInputAction((movement: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
      if (!this.activeDrag || !this.lastPointer) return;

      const dx = movement.endPosition.x - this.lastPointer.x;
      const dy = movement.endPosition.y - this.lastPointer.y;
      this.lastPointer = Cesium.Cartesian2.clone(movement.endPosition);

      if (this.activeDrag === 'orbit') {
        this.rotateGlobeCamera(dx, dy);
      } else {
        this.panGlobeCamera(dx, dy);
      }
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
  }

  private installLocalPointCloudControls(): void {
    this.inputHandler?.destroy();
    this.touchInputCleanup?.();
    this.touchInputCleanup = null;
    const handler = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas);
    this.inputHandler = handler;

    const controller = this.viewer.scene.screenSpaceCameraController;
    controller.enableRotate = false;
    controller.enableTranslate = false;
    controller.enableTilt = false;
    controller.enableLook = false;
    controller.enableZoom = false;

    handler.setInputAction((event: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      this.callbacks.onInteraction();
      this.activeDrag = 'orbit';
      this.lastPointer = Cesium.Cartesian2.clone(event.position);
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

    handler.setInputAction((event: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      this.callbacks.onInteraction();
      this.activeDrag = 'pan';
      this.lastPointer = Cesium.Cartesian2.clone(event.position);
    }, Cesium.ScreenSpaceEventType.RIGHT_DOWN);

    handler.setInputAction(() => {
      this.activeDrag = null;
      this.lastPointer = null;
    }, Cesium.ScreenSpaceEventType.LEFT_UP);

    handler.setInputAction(() => {
      this.activeDrag = null;
      this.lastPointer = null;
    }, Cesium.ScreenSpaceEventType.RIGHT_UP);

    handler.setInputAction((movement: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
      if (!this.activeDrag || !this.lastPointer) return;

      const dx = movement.endPosition.x - this.lastPointer.x;
      const dy = movement.endPosition.y - this.lastPointer.y;
      this.lastPointer = Cesium.Cartesian2.clone(movement.endPosition);

      if (this.activeDrag === 'orbit') {
        this.orbitHeading -= dx * 0.006;
        this.orbitPitch = Cesium.Math.clamp(
          this.orbitPitch - dy * 0.004,
          Cesium.Math.toRadians(-85),
          Cesium.Math.toRadians(85)
        );
      } else {
        this.panOrbitTarget(dx, dy);
      }

      this.applyOrbitCamera();
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    handler.setInputAction((delta: number) => {
      this.callbacks.onInteraction();
      const zoomFactor = delta > 0 ? 0.86 : 1.16;
      this.orbitRange = Cesium.Math.clamp(
        this.orbitRange * zoomFactor,
        this.minCameraDistance,
        this.maxCameraDistance
      );
      this.applyOrbitCamera();
    }, Cesium.ScreenSpaceEventType.WHEEL);

    const canvas = this.viewer.scene.canvas;
    let lastTouchDistance = 0;
    let lastTouchMidpoint: Cesium.Cartesian2 | null = null;

    const touchPoint = (touch: Touch): Cesium.Cartesian2 => {
      const rect = canvas.getBoundingClientRect();
      return new Cesium.Cartesian2(touch.clientX - rect.left, touch.clientY - rect.top);
    };
    const touchMidpoint = (touches: TouchList): Cesium.Cartesian2 => {
      const first = touchPoint(touches[0]);
      const second = touchPoint(touches[1]);
      return new Cesium.Cartesian2(
        (first.x + second.x) * 0.5,
        (first.y + second.y) * 0.5
      );
    };
    const touchDistance = (touches: TouchList): number => {
      const first = touchPoint(touches[0]);
      const second = touchPoint(touches[1]);
      return Cesium.Cartesian2.distance(first, second);
    };
    const resetTwoFingerTouch = (): void => {
      lastTouchDistance = 0;
      lastTouchMidpoint = null;
    };
    const beginTwoFingerTouch = (event: TouchEvent): void => {
      if (event.touches.length < 2) return;
      event.preventDefault();
      this.callbacks.onInteraction();
      lastTouchDistance = touchDistance(event.touches);
      lastTouchMidpoint = touchMidpoint(event.touches);
    };
    const moveTwoFingerTouch = (event: TouchEvent): void => {
      if (event.touches.length < 2 || !lastTouchMidpoint || lastTouchDistance <= 0) return;
      event.preventDefault();
      this.callbacks.onInteraction();
      const nextDistance = touchDistance(event.touches);
      const nextMidpoint = touchMidpoint(event.touches);
      const dx = nextMidpoint.x - lastTouchMidpoint.x;
      const dy = nextMidpoint.y - lastTouchMidpoint.y;

      if (Math.abs(nextDistance - lastTouchDistance) > 0.5) {
        this.orbitRange = Cesium.Math.clamp(
          this.orbitRange * (lastTouchDistance / nextDistance),
          this.minCameraDistance,
          this.maxCameraDistance
        );
      }
      if (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1) {
        this.panOrbitTarget(dx, dy);
      }

      lastTouchDistance = nextDistance;
      lastTouchMidpoint = nextMidpoint;
      this.applyOrbitCamera();
    };
    const endTwoFingerTouch = (event: TouchEvent): void => {
      if (event.touches.length >= 2) {
        beginTwoFingerTouch(event);
      } else {
        resetTwoFingerTouch();
      }
    };

    canvas.addEventListener('touchstart', beginTwoFingerTouch, { passive: false });
    canvas.addEventListener('touchmove', moveTwoFingerTouch, { passive: false });
    canvas.addEventListener('touchend', endTwoFingerTouch, { passive: false });
    canvas.addEventListener('touchcancel', resetTwoFingerTouch, { passive: false });
    this.touchInputCleanup = () => {
      canvas.removeEventListener('touchstart', beginTwoFingerTouch);
      canvas.removeEventListener('touchmove', moveTwoFingerTouch);
      canvas.removeEventListener('touchend', endTwoFingerTouch);
      canvas.removeEventListener('touchcancel', resetTwoFingerTouch);
    };
  }

  private rotateGlobeCamera(dx: number, dy: number): void {
    if (!this.cameraLimitTileset) return;

    const camera = this.viewer.camera;
    const target = this.cameraLimitTileset.boundingSphere.center;
    const offset = Cesium.Cartesian3.subtract(
      camera.positionWC,
      target,
      new Cesium.Cartesian3()
    );
    const range = Math.max(Cesium.Cartesian3.magnitude(offset), this.minCameraDistance);
    if (range <= 0) return;

    const angleX = -dx * 0.004;
    const angleY = -dy * 0.003;
    const eastWestRotation = Cesium.Matrix3.fromQuaternion(
      Cesium.Quaternion.fromAxisAngle(Cesium.Cartesian3.UNIT_Z, angleX)
    );
    let rotatedOffset = Cesium.Matrix3.multiplyByVector(
      eastWestRotation,
      offset,
      new Cesium.Cartesian3()
    );
    const rightAxis = Cesium.Cartesian3.normalize(camera.rightWC, new Cesium.Cartesian3());
    const northSouthRotation = Cesium.Matrix3.fromQuaternion(
      Cesium.Quaternion.fromAxisAngle(rightAxis, angleY)
    );
    rotatedOffset = Cesium.Matrix3.multiplyByVector(
      northSouthRotation,
      rotatedOffset,
      rotatedOffset
    );
    Cesium.Cartesian3.normalize(rotatedOffset, rotatedOffset);
    Cesium.Cartesian3.multiplyByScalar(rotatedOffset, range, rotatedOffset);

    const destination = Cesium.Cartesian3.add(target, rotatedOffset, new Cesium.Cartesian3());
    const direction = Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.subtract(target, destination, new Cesium.Cartesian3()),
      new Cesium.Cartesian3()
    );
    const surfaceNormal = Cesium.Cartesian3.normalize(destination, new Cesium.Cartesian3());
    let right = Cesium.Cartesian3.cross(direction, surfaceNormal, new Cesium.Cartesian3());
    if (Cesium.Cartesian3.magnitude(right) < 0.001) {
      right = Cesium.Cartesian3.clone(camera.rightWC);
    }
    Cesium.Cartesian3.normalize(right, right);
    const up = Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.cross(right, direction, new Cesium.Cartesian3()),
      new Cesium.Cartesian3()
    );

    camera.setView({
      destination,
      orientation: { direction, up },
    });
  }

  private panGlobeCamera(dx: number, dy: number): void {
    if (!this.cameraLimitTileset) return;

    const camera = this.viewer.camera;
    const range = Cesium.Cartesian3.distance(
      camera.positionWC,
      this.cameraLimitTileset.boundingSphere.center
    );
    const panScale = Math.max(range, this.panScaleBase * 0.2) * 0.0012;
    const right = Cesium.Cartesian3.multiplyByScalar(
      camera.rightWC,
      -dx * panScale,
      new Cesium.Cartesian3()
    );
    const up = Cesium.Cartesian3.multiplyByScalar(
      camera.upWC,
      dy * panScale,
      new Cesium.Cartesian3()
    );
    const move = Cesium.Cartesian3.add(right, up, new Cesium.Cartesian3());
    const amount = Cesium.Cartesian3.magnitude(move);
    if (amount <= 0) return;
    camera.move(Cesium.Cartesian3.normalize(move, move), amount);
  }

  private panOrbitTarget(dx: number, dy: number): void {
    const camera = this.viewer.camera;
    const panScale = Math.max(this.orbitRange, this.panScaleBase * 0.2) * 0.0012;
    const right = Cesium.Cartesian3.multiplyByScalar(
      camera.rightWC,
      -dx * panScale,
      new Cesium.Cartesian3()
    );
    const up = Cesium.Cartesian3.multiplyByScalar(
      camera.upWC,
      dy * panScale,
      new Cesium.Cartesian3()
    );
    Cesium.Cartesian3.add(this.orbitTarget, right, this.orbitTarget);
    Cesium.Cartesian3.add(this.orbitTarget, up, this.orbitTarget);
  }

  private applyOrbitCamera(): void {
    const cosPitch = Math.cos(this.orbitPitch);
    const offset = new Cesium.Cartesian3(
      this.orbitRange * cosPitch * Math.sin(this.orbitHeading),
      this.orbitRange * cosPitch * Math.cos(this.orbitHeading),
      this.orbitRange * Math.sin(this.orbitPitch)
    );
    const destination = Cesium.Cartesian3.add(
      this.orbitTarget,
      offset,
      new Cesium.Cartesian3()
    );
    const direction = Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.subtract(this.orbitTarget, destination, new Cesium.Cartesian3()),
      new Cesium.Cartesian3()
    );
    let right = Cesium.Cartesian3.cross(
      direction,
      Cesium.Cartesian3.UNIT_Z,
      new Cesium.Cartesian3()
    );
    if (Cesium.Cartesian3.magnitude(right) < 0.001) {
      right = Cesium.Cartesian3.cross(direction, Cesium.Cartesian3.UNIT_X, right);
    }
    Cesium.Cartesian3.normalize(right, right);
    const up = Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.cross(right, direction, new Cesium.Cartesian3()),
      new Cesium.Cartesian3()
    );

    this.viewer.camera.setView({
      destination,
      orientation: { direction, up },
    });
  }

  flyHome(): void {
    this.callbacks.onBrowserMetric('flyToTime', this.flyToTileset());
  }

  setPreset(preset: PresetName): void {
    this.currentPreset = preset;
    if (!this.primaryTileset) {
      this.callbacks.onPresetChange(preset);
      return;
    }
    applyPreset(
      this.primaryTileset,
      preset,
      this.primaryPresetOverrides(preset),
      { variant: this.presetVariantForTileset(this.primaryTileset), detailScope: this.currentDetailScope }
    );
    this.reportEffectiveSse();
    this.callbacks.onPresetChange(preset);
  }

  setDetailSseOverride(maximumScreenSpaceError: number): void {
    this.detailSseOverride = maximumScreenSpaceError;
    if (this.currentPreset === 'high' && this.primaryTileset) {
      applyPreset(
        this.primaryTileset,
        'high',
        this.primaryPresetOverrides('high'),
        { variant: this.presetVariantForTileset(this.primaryTileset), detailScope: this.currentDetailScope }
      );
      this.reportEffectiveSse();
      this.callbacks.onPresetChange('high');
    }
  }

  getCurrentPreset(): PresetName {
    return this.currentPreset;
  }

  getActiveDataset(): string {
    return this.activeDataset;
  }

  getCameraRange(): number {
    return this.orbitRange;
  }

  getCurrentViewPoint(): CurrentViewPoint | null {
    return this.getCurrentViewSamples()[0] ?? null;
  }

  getCurrentViewSamples(): CurrentViewSample[] {
    if (!this.primaryTileset && !this.contextTileset) return [];

    const samples = this.pickViewportSamples();
    if (samples.length > 0) return samples;

    return [{
      x: this.orbitTarget.x,
      y: this.orbitTarget.y,
      z: this.orbitTarget.z,
      weight: 0.2,
      source: 'orbitTarget',
    }];
  }

  getSSE(): number {
    return (
      this.primaryTileset?.maximumScreenSpaceError ??
      PRESETS[this.currentPreset].maximumScreenSpaceError
    );
  }

  getContextSSE(): number | null {
    return this.contextTileset?.maximumScreenSpaceError ?? null;
  }

  getCacheMB(): number {
    const activeCacheBytes =
      (this.primaryTileset?.cacheBytes ?? 0) +
      (this.baseTileset?.cacheBytes ?? 0) +
      (this.contextTileset?.cacheBytes ?? 0);
    return cacheBytesToMB(
      activeCacheBytes || PRESETS[this.currentPreset].cacheBytes
    );
  }

  captureCameraSnapshot(): CameraSnapshot {
    const camera = this.viewer.camera;
    const frustum = camera.frustum;
    return {
      orbitTarget: cartesianToPoint(this.orbitTarget),
      orbitHeading: this.orbitHeading,
      orbitPitch: this.orbitPitch,
      orbitRange: this.orbitRange,
      position: cartesianToPoint(camera.positionWC),
      direction: cartesianToPoint(camera.directionWC),
      up: cartesianToPoint(camera.upWC),
      frustumNear: frustum instanceof Cesium.PerspectiveFrustum ? frustum.near : null,
      frustumFar: frustum instanceof Cesium.PerspectiveFrustum ? frustum.far : null,
    };
  }

  restoreCameraSnapshot(snapshot: CameraSnapshot): void {
    this.orbitTarget = pointToCartesian(snapshot.orbitTarget);
    this.orbitHeading = snapshot.orbitHeading;
    this.orbitPitch = snapshot.orbitPitch;
    this.orbitRange = Cesium.Math.clamp(
      snapshot.orbitRange,
      this.minCameraDistance,
      this.maxCameraDistance
    );

    const frustum = this.viewer.camera.frustum;
    if (frustum instanceof Cesium.PerspectiveFrustum) {
      if (snapshot.frustumNear !== null) frustum.near = snapshot.frustumNear;
      if (snapshot.frustumFar !== null) frustum.far = snapshot.frustumFar;
    }

    this.viewer.camera.setView({
      destination: pointToCartesian(snapshot.position),
      orientation: {
        direction: pointToCartesian(snapshot.direction),
        up: pointToCartesian(snapshot.up),
      },
    });
  }

  destroy(): void {
    this.unloadTilesets();
    this.cameraMoveEndUnsubscribe?.();
    this.cameraMoveEndUnsubscribe = null;
    this.inputHandler?.destroy();
    this.touchInputCleanup?.();
    this.touchInputCleanup = null;
    this.viewer.destroy();
  }

  private unloadTilesets(): void {
    this.postRenderUnsubscribe?.();
    this.postRenderUnsubscribe = null;
    this.microTransitionGeneration += 1;
    for (const tileset of [
      this.primaryTileset,
      this.baseTileset,
      this.contextTileset,
      this.candidateTileset,
    ]) {
      if (!tileset) continue;
      this.destroyTileset(tileset);
    }
    this.primaryTileset = null;
    this.baseTileset = null;
    this.contextTileset = null;
    this.candidateTileset = null;
    this.cameraLimitTileset = null;
    this.detailMicroActive = false;
    this.detailContextMode = 'off';
    this.baseDataset = null;
    this.detailContextFallbackReason = null;
    this.performanceGateStatus = 'ok';
    this.performanceGateFailures = [];
    this.tilesLoaded = 0;
    this.activeTilesLoaded = 0;
    this.lastLayerRuntimeKey = '';
    this.reportLayerCountMetrics();
    this.reportLayerTileStats();
  }

  private primaryPresetOverrides(
    preset: PresetName
  ): { maximumScreenSpaceError?: number } {
    if (preset === 'high' && this.detailSseOverride !== null) {
      return { maximumScreenSpaceError: this.detailSseOverride };
    }
    return {};
  }


  private tilesetMemoryBytes(tileset: Cesium.Cesium3DTileset | null): number {
    return (tileset as unknown as { totalMemoryUsageInBytes?: number } | null)
      ?.totalMemoryUsageInBytes ?? 0;
  }

  private destroyTileset(tileset: Cesium.Cesium3DTileset): void {
    this.viewer.scene.primitives.remove(tileset);
    if (!tileset.isDestroyed()) tileset.destroy();
  }

  private presetVariantForTileset(tileset: Cesium.Cesium3DTileset): 'local' | 'globe' {
    return this.isGlobeTileset(tileset) ? 'globe' : 'local';
  }

  private loadedTileCount(): number {
    return [this.primaryTileset, this.baseTileset, this.contextTileset].reduce((total, tileset) => {
      const ts = tileset as unknown as {
        statistics?: { numberOfLoadedTilesTotal?: number };
      } | null;
      return total + (ts?.statistics?.numberOfLoadedTilesTotal ?? 0);
    }, 0);
  }

  private layerLoadedTileCount(tileset: Cesium.Cesium3DTileset | null): number {
    const ts = tileset as unknown as {
      statistics?: { numberOfLoadedTilesTotal?: number };
    } | null;
    return ts?.statistics?.numberOfLoadedTilesTotal ?? 0;
  }

  private activeTileCount(): number | string {
    const values = [this.primaryTileset, this.baseTileset, this.contextTileset]
      .filter((tileset): tileset is Cesium.Cesium3DTileset => tileset !== null)
      .filter((tileset) => tileset.show)
      .map((tileset) => this.layerActiveTileCount(tileset));
    if (values.length === 0) return 0;
    if (values.some((value) => typeof value !== 'number')) return 'unsupported';
    const numericValues = values as number[];
    return numericValues.reduce((total, value) => total + value, 0);
  }

  private layerActiveTileCount(tileset: Cesium.Cesium3DTileset | null): number | string {
    if (!tileset) return 0;
    const ts = tileset as unknown as RuntimeTileset;
    if (Array.isArray(ts._selectedTiles)) return ts._selectedTiles.length;
    if (Array.isArray(ts.selectedTiles)) return ts.selectedTiles.length;
    if (typeof ts.statistics?.numberOfTilesSelected === 'number') {
      return ts.statistics.numberOfTilesSelected;
    }
    if (typeof ts.statistics?.numberOfTilesWithContentReady === 'number') {
      return ts.statistics.numberOfTilesWithContentReady;
    }
    return 'unsupported';
  }

  private reportLayerTileStats(): void {
    const detail = this.layerRuntimeStats(this.detailMicroActive ? this.primaryTileset : null);
    const focus = this.layerRuntimeStats(this.detailMicroActive ? null : this.primaryTileset);
    const base = this.layerRuntimeStats(this.baseTileset);
    const context = this.layerRuntimeStats(this.contextTileset);

    if (this.detailMicroActive) {
      const runtimeKey = [
        this.detailContextMode,
        detail.loadedTiles,
        detail.selectedTiles,
        detail.visiblePointsEstimated,
        base.loadedTiles,
        base.selectedTiles,
        base.visiblePointsEstimated,
        context.loadedTiles,
        context.selectedTiles,
        this.tilesetMemoryBytes(this.baseTileset) + this.tilesetMemoryBytes(this.primaryTileset),
      ].join('|');
      if (runtimeKey === this.lastLayerRuntimeKey) return;
      this.lastLayerRuntimeKey = runtimeKey;
      this.reportDetailMicroMetrics(focus, context, base, detail);
      this.reportLayerCountMetrics();
      return;
    }

    const selectedTiles = sumNumericStats(focus.selectedTiles, context.selectedTiles);
    const visiblePoints = sumNumericStats(
      focus.visiblePointsEstimated,
      context.visiblePointsEstimated
    );
    const tilesetMemoryBytes = focus.tilesetMemoryBytes + context.tilesetMemoryBytes;
    const runtimeKey = [
      focus.loadedTiles,
      focus.selectedTiles,
      focus.visiblePointsEstimated,
      context.loadedTiles,
      context.selectedTiles,
      context.visiblePointsEstimated,
      tilesetMemoryBytes,
    ].join('|');
    if (runtimeKey === this.lastLayerRuntimeKey) return;
    this.lastLayerRuntimeKey = runtimeKey;

    this.callbacks.onBrowserMetric('focusLoadedTiles', focus.loadedTiles);
    this.callbacks.onBrowserMetric('focusActiveLoadedTiles', focus.selectedTiles);
    this.callbacks.onBrowserMetric('contextLoadedTiles', context.loadedTiles);
    this.callbacks.onBrowserMetric('contextActiveLoadedTiles', context.selectedTiles);
    this.callbacks.onBrowserMetric('activeLoadedTiles', selectedTiles);
    this.callbacks.onBrowserMetric('selectedTiles', selectedTiles);
    this.callbacks.onBrowserMetric('visiblePointsEstimated', visiblePoints);
    this.callbacks.onBrowserMetric('tilesetMemoryBytes', tilesetMemoryBytes);
  }

  private layerRuntimeStats(tileset: Cesium.Cesium3DTileset | null): LayerRuntimeStats {
    if (!tileset) {
      return {
        loadedTiles: 0,
        selectedTiles: 0,
        visiblePointsEstimated: 0,
        tilesetMemoryBytes: 0,
      };
    }

    const ts = tileset as unknown as RuntimeTileset;
    const selectedTiles = this.layerActiveTileCount(tileset);
    return {
      loadedTiles: this.layerLoadedTileCount(tileset),
      selectedTiles,
      visiblePointsEstimated: selectedPointCount(ts),
      tilesetMemoryBytes: tileset.totalMemoryUsageInBytes,
    };
  }

  private reportEffectiveSse(): void {
    this.callbacks.onBrowserMetric('focusEffectiveSSE', this.getSSE());
    const contextSSE = this.getContextSSE();
    this.callbacks.onBrowserMetric('contextEffectiveSSE', contextSSE ?? '—');
  }

  private pickViewportSamples(): CurrentViewSample[] {
    const scene = this.viewer.scene;
    const canvas = scene.canvas;
    const canPick = Boolean(
      (this.primaryTileset || this.contextTileset) &&
      canvas?.clientWidth &&
      canvas?.clientHeight &&
      scene.pickPositionSupported
    );
    if (!canPick) return [];

    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const pattern = [
      { dx: 0, dy: 0, weight: 1.0 },
      { dx: 0, dy: -0.12, weight: 0.75 },
      { dx: 0.12, dy: 0, weight: 0.75 },
      { dx: 0, dy: 0.12, weight: 0.75 },
      { dx: -0.12, dy: 0, weight: 0.75 },
      { dx: -0.12, dy: -0.12, weight: 0.55 },
      { dx: 0.12, dy: -0.12, weight: 0.55 },
      { dx: 0.12, dy: 0.12, weight: 0.55 },
      { dx: -0.12, dy: 0.12, weight: 0.55 },
      { dx: 0, dy: -0.25, weight: 0.35 },
      { dx: 0.25, dy: 0, weight: 0.35 },
      { dx: 0, dy: 0.25, weight: 0.35 },
      { dx: -0.25, dy: 0, weight: 0.35 },
    ];

    const samples: CurrentViewSample[] = [];
    for (const item of pattern) {
      const position = new Cesium.Cartesian2(
        width * (0.5 + item.dx),
        height * (0.5 + item.dy)
      );

      try {
        const picked = scene.pickPosition(position);
        if (
          picked &&
          Number.isFinite(picked.x) &&
          Number.isFinite(picked.y) &&
          Number.isFinite(picked.z)
        ) {
          samples.push({
            x: picked.x,
            y: picked.y,
            z: picked.z,
            weight: item.weight,
            source: 'pickPosition',
          });
        }
      } catch (err) {
        console.debug('[Viewer] pickPosition failed for current-view sample:', err);
      }
    }

    return samples;
  }
}

function cartesianToPoint(value: Cesium.Cartesian3): CurrentViewPoint {
  return { x: value.x, y: value.y, z: value.z };
}

function pointToCartesian(value: CurrentViewPoint): Cesium.Cartesian3 {
  return new Cesium.Cartesian3(value.x, value.y, value.z);
}

function buildMapTilerBaseLayer(): Cesium.ImageryLayer | null {
  if (REQUESTED_BASEMAP !== 'maptiler') return null;
  if (!MAPTILER_API_KEY) {
    console.warn('[Viewer] ?basemap=maptiler was requested but VITE_MAPTILER_API_KEY is missing.');
    return null;
  }

  return new Cesium.ImageryLayer(new Cesium.UrlTemplateImageryProvider({
    url: `${MAPTILER_SATELLITE_URL}?key=${encodeURIComponent(MAPTILER_API_KEY)}`,
    minimumLevel: 0,
    maximumLevel: 20,
    tileWidth: 512,
    tileHeight: 512,
  }));
}

function sumNumericStats(
  primary: number | string,
  context: number | string
): number | string {
  if (typeof primary === 'number' && typeof context === 'number') {
    return primary + context;
  }
  return 'unsupported';
}

function selectedPointCount(tileset: RuntimeTileset): number | string {
  if (typeof tileset.statistics?.numberOfPointsSelected === 'number') {
    return tileset.statistics.numberOfPointsSelected;
  }

  const selectedTiles = Array.isArray(tileset._selectedTiles)
    ? tileset._selectedTiles
    : tileset.selectedTiles;
  if (!Array.isArray(selectedTiles)) return 'unsupported';

  return selectedTiles.reduce(
    (total, tile) => total + contentPointCount(tile.content),
    0
  );
}

function contentPointCount(content: RuntimeTileContent | undefined): number {
  if (!content) return 0;
  const ownPoints = typeof content.pointsLength === 'number'
    ? content.pointsLength
    : 0;
  const innerPoints = content.innerContents?.reduce(
    (total, innerContent) => total + contentPointCount(innerContent),
    0
  ) ?? 0;
  return ownPoints + innerPoints;
}
