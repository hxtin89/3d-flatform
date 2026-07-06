// viewer.ts — CesiumJS viewer and 3D Tileset loader
import * as Cesium from 'cesium';
import { applyPreset, cacheBytesToMB, type PresetName, PRESETS } from './presets';
import {
  applyOverviewRuntimeTuning,
  clampOverviewPointSizePx,
  clampOverviewPointSizeScale,
  createOverviewPointSizeStyle,
  overviewBandForRatio,
  overviewBasePointSize,
  OVERVIEW_POINT_SIZE_SCALE_DEFAULT,
  type OverviewPointSizeBand,
} from './presets';
import {
  OverviewSseController,
  type BootstrapValidation,
  type OverviewSseMetricCallback,
} from './overview-sse-controller';
import { type BrowserMetricName } from './report';
import {
  ONE_LOD_TREE_TILESET_FILE,
  oneLodTreeCachePolicy,
  oneLodTreeSse,
  shouldTrimOneLodTree,
  tilesetEntryUrl,
} from './one-lod-tree';

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
const DEBUG_OVERVIEW = searchParams.get('debugOverview') === '1';
/** Viewer LOD mode controlled by `?lod=...`. */
export const LOD_MODE: 'manual' | 'one-lod-tree' = searchParams.get('lod') === 'one-lod-tree'
  ? 'one-lod-tree'
  : 'manual';
const REQUESTED_BASEMAP = searchParams.get('basemap');
const MAPTILER_API_KEY = import.meta.env.VITE_MAPTILER_API_KEY?.trim() ?? '';
const MAPTILER_BASEMAP_ENABLED = REQUESTED_BASEMAP === 'maptiler' && Boolean(MAPTILER_API_KEY);
const MOBILE_VIEWPORT_QUERY = '(max-width: 640px)';
//Với Peru Overview hiện tại:
//focusRadius ≈ 7,996.7 m (~8 km)
//Ratio 0.07 tương đương khoảng 559.8 m
//Raio 0.08 tương đương khoảng 621.4 m
//Raio 0.09 tương đương khoảng 683.1 m
//Raio 0.10 tương đương khoảng 744.8 m
const LIMIT_RADIUS_FOR_MINIMUM_ZOOM = 0.10; // giới hạn khoảng cách tới tâm xoay, không phải độ cao mặt đất
const MIN_CAMERA_DISTANCE_FLOOR = 0.25;
const MIN_CAMERA_DISTANCE_RATIO = 0.0005;
const MIN_CAMERA_DISTANCE_CEILING = 5;
const INTERACTION_DRAG_START_THRESHOLD_PX = 20;
/** 1 px in local mode point size */
const OVERVIEW_GLOBE_POINT_SIZE_PX_MIN = OVERVIEW_POINT_SIZE_SCALE_DEFAULT * 1;
const OVERVIEW_DEBUG_LOG_INTERVAL_MS = 500;
const OVERVIEW_DEBUG_REPEAT_INTERVAL_MS = 3_000;
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
  onBrowserMetric: (metric: BrowserMetricName, value: number | string) => void;
  onOverviewSseValidation: (validation: Record<string, unknown> | null) => void;
  onInteraction: () => void;
}

interface LayerRuntimeStats {
  loadedTiles: number;
  selectedTiles: number | string;
  visiblePointsEstimated: number | string;
  tilesetMemoryBytes: number;
}

type RuntimeTileContent = {
  pointsLength?: number;
  innerContents?: RuntimeTileContent[];
};

type RuntimeTile = {
  content?: RuntimeTileContent;
};

type TilesetDocument = {
  asset?: {
    extras?: {
      coordinateMode?: string;
      local_only?: boolean;
    };
  };
  root?: {
    boundingVolume?: {
      box?: number[];
    };
    children?: Array<{
      boundingVolume?: {
        box?: number[];
      };
    }>;
    transform?: number[];
  };
};

type RuntimeTileset = {
  _selectedTiles?: RuntimeTile[];
  selectedTiles?: RuntimeTile[];
  _requestedTiles?: RuntimeTile[];
  _requestedTilesInFlight?: RuntimeTile[];
  _processingQueue?: RuntimeTile[];
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
  private contextTileset: Cesium.Cesium3DTileset | null = null;
  private cameraLimitTileset: Cesium.Cesium3DTileset | null = null;
  private activeDataset = DATASET;
  private postRenderUnsubscribe: Cesium.Event.RemoveCallback | null = null;
  private inputHandler: Cesium.ScreenSpaceEventHandler | null = null;
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
  private dragInteractionStarted = false;
  private dragStartPointer: Cesium.Cartesian2 | null = null;
  private lastPointer: Cesium.Cartesian2 | null = null;
  private touchInputCleanup: (() => void) | null = null;
  private firstTileLoadedReported = false;
  private firstVisibleReported = false;
  private loadStartTime = 0;
  private detailSseOverride = PRESETS.high.maximumScreenSpaceError;
  private lastLayerRuntimeKey = '';
  private globeControlsActive = false;
  private globeOverviewOrbitZoomActive = false;
  private overviewRuntimeActive = false;
  private overviewPointSizeBand: OverviewPointSizeBand | null = null;
  private overviewPointSizeScale = OVERVIEW_POINT_SIZE_SCALE_DEFAULT;
  private overviewPointSizePx = 0;
  private overviewCameraRangeRatio = 0;
  private lastOverviewReportKey = '';
  private lastOverviewDebugLogAt = 0;
  private lastOverviewDebugKey = '';
  private overviewSseController = new OverviewSseController();
  private overviewFirstVisibleFired = false;
  private overviewFirstVisibleUnsubscribe: (() => void) | null = null;
  private oneLodTreeTrimGeneration = 0;

  constructor(containerId: string, callbacks: ViewerCallbacks) {
    this.callbacks = callbacks;
    this.viewer = this.createViewer(containerId);
    this.overviewSseController.setCallback((name, value) => {
      this.callbacks.onBrowserMetric(name as BrowserMetricName, value);
      if (name === 'overviewSse') {
        this.reportEffectiveSse();
      }
    });
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

  /**
   * Load the one-lod sidecar entry without entering the shared manual/auto
   * loadScene path. This keeps progressive Overview SSE and focus/context
   * layer swapping disabled for the lifetime of this single tileset.
   */
  async loadOneLodTree(
    dataset: string,
    tilesetFile = ONE_LOD_TREE_TILESET_FILE
  ): Promise<void> {
    const url = tilesetEntryUrl(TILE_CONFIG.baseUrl, dataset, tilesetFile);
    this.callbacks.onStateChange('loading', 'Connecting to one-lod tileset...');

    try {
      await this.checkTileServer(url);
      this.unloadTilesets();
      this.activeDataset = dataset;
      this.currentPreset = 'low';
      this.callbacks.onStateChange('loading', `Fetching ${tilesetFile}...`);
      this.loadStartTime = performance.now();
      this.firstTileLoadedReported = false;
      this.firstVisibleReported = false;
      this.tilesLoaded = 0;
      this.activeTilesLoaded = 0;
      this.callbacks.onTileStats(0, 0);
      this.reportLayerTileStats();

      const tilesetStart = performance.now();
      const documentPromise = MAPTILER_BASEMAP_ENABLED
        ? fetch(url).then(async (response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            return response.json() as Promise<TilesetDocument>;
          })
        : Promise.resolve(null);
      const [tileset, document] = await Promise.all([
        Cesium.Cesium3DTileset.fromUrl(url, {
          maximumScreenSpaceError: oneLodTreeSse('low'),
          cacheBytes: PRESETS.low.cacheBytes,
          maximumCacheOverflowBytes: PRESETS.low.maximumCacheOverflowBytes,
          skipLevelOfDetail: false,
        }),
        documentPromise,
      ]);
      this.callbacks.onBrowserMetric('tilesetLoadTime', performance.now() - tilesetStart);

      if (document && this.isGlobeDocument(document)) {
        this.alignTilesetBottomToEllipsoid(tileset, document);
      }
      if (DEBUG_TILES) {
        tileset.debugShowBoundingVolume = true;
        tileset.debugShowGeometricError = true;
        tileset.debugShowRenderingStatistics = true;
      }

      this.viewer.scene.primitives.add(tileset);
      this.primaryTileset = tileset;
      this.contextTileset = null;
      this.configureCameraLimits(tileset, null, true, false);
      this.installPointCloudControls(tileset, null);
      this.setOneLodTreePreset('low');
      this.minCameraDistance = 0.05;
      this.viewer.scene.screenSpaceCameraController.minimumZoomDistance = 0.05;

      this.callbacks.onBrowserMetric('flyToTime', this.flyToTileset());
      this.reportEffectiveSse();
      this.callbacks.onStateChange('ready', `Streaming one-lod tree: ${url}`);

      const onInitialTilesLoaded = () => {
        if (!this.firstTileLoadedReported) {
          this.firstTileLoadedReported = true;
          this.callbacks.onBrowserMetric('firstTileLoadedTime', performance.now() - this.loadStartTime);
        }
        this.callbacks.onTileStats(this.tilesLoaded, this.activeTileCount());
      };
      tileset.initialTilesLoaded.addEventListener(onInitialTilesLoaded);
      tileset.allTilesLoaded.addEventListener(() => {
        this.callbacks.onTileStats(this.tilesLoaded, this.activeTileCount());
      });

      this.postRenderUnsubscribe = this.viewer.scene.postRender.addEventListener(() => {
        if (!this.primaryTileset) return;
        const loaded = this.loadedTileCount();
        const active = this.activeTileCount();
        if (loaded !== this.tilesLoaded || active !== this.activeTilesLoaded) {
          this.tilesLoaded = loaded;
          this.activeTilesLoaded = active;
          this.callbacks.onTileStats(loaded, active);
        }
        this.reportLayerTileStats();
        if (loaded > 0 && !this.firstVisibleReported) {
          this.firstVisibleReported = true;
          this.callbacks.onBrowserMetric('firstVisibleTime', performance.now() - this.loadStartTime);
        }
      });
      this.installTileFailureLogging(tileset);
    } catch (err) {
      const error = err as Error;
      console.error('[Viewer] Failed to load one-lod tree:', error);
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
        message = `${tilesetFile} not found for one-lod dataset "${dataset}".\n` +
          '-> Run: npm run pipeline:area:one-lod-tree -- 2404PeruB2 area-001';
      }
      this.callbacks.onStateChange('error', message);
    }
  }

  setOneLodTreePreset(preset: PresetName): void {
    const previousPreset = this.currentPreset;
    this.currentPreset = preset;
    this.oneLodTreeTrimGeneration += 1;
    if (this.primaryTileset) {
      const tileset = this.primaryTileset;
      const cachePolicy = oneLodTreeCachePolicy(preset);
      applyPreset(
        tileset,
        preset,
        { maximumScreenSpaceError: oneLodTreeSse(preset) },
        { variant: this.presetVariantForTileset(tileset) }
      );
      tileset.cacheBytes = cachePolicy.cacheBytes;
      tileset.maximumCacheOverflowBytes = cachePolicy.maximumCacheOverflowBytes;
      if (shouldTrimOneLodTree(previousPreset, preset)) {
        this.scheduleOneLodTreeOverviewTrim(tileset, this.oneLodTreeTrimGeneration);
      }
      this.reportEffectiveSse();
    }
    this.callbacks.onPresetChange(preset);
  }

  /**
   * Wait for Overview selection to settle before trimming. Cesium evicts tiles
   * that were not selected in the previous frame, so trimming synchronously
   * would preserve the Detail selection from the click frame.
   */
  private scheduleOneLodTreeOverviewTrim(
    tileset: Cesium.Cesium3DTileset,
    generation: number
  ): void {
    let renderedFrames = 0;
    const remove = this.viewer.scene.postRender.addEventListener(() => {
      if (
        generation !== this.oneLodTreeTrimGeneration ||
        this.currentPreset !== 'low' ||
        this.primaryTileset !== tileset ||
        tileset.isDestroyed()
      ) {
        remove();
        return;
      }

      renderedFrames += 1;
      if (renderedFrames < 2) {
        this.viewer.scene.requestRender();
        return;
      }

      remove();
      tileset.trimLoadedTiles();
      this.viewer.scene.requestRender();
    });
    this.viewer.scene.requestRender();
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
      this.callbacks.onStateChange('loading', 'Fetching tileset.json...');
      this.loadStartTime = performance.now();
      this.firstTileLoadedReported = false;
      this.firstVisibleReported = false;
      this.tilesLoaded = 0;
      this.activeTilesLoaded = 0;
      this.callbacks.onTileStats(0, 0);
      this.reportLayerTileStats();

      const tilesetStart = performance.now();
      const [contextTileset, primaryTileset, bootstrapValidation] = await Promise.all([
        options.context ? this.loadLayer(options.context) : Promise.resolve(null),
        this.loadLayer(options.primary),
        options.primary.preset === 'low'
          ? this.overviewSseController.fetchValidation(tilesetUrlFor(options.primary.dataset))
          : Promise.resolve(null),
      ]);
      this.callbacks.onBrowserMetric('tilesetLoadTime', performance.now() - tilesetStart);

      if (contextTileset) this.viewer.scene.primitives.add(contextTileset);
      this.viewer.scene.primitives.add(primaryTileset);
      this.contextTileset = contextTileset;
      this.primaryTileset = primaryTileset;
      this.configureCameraLimits(
        primaryTileset,
        contextTileset,
        options.cameraBehavior === 'flyTo' || !options.cameraBehavior,
        options.primary.preset === 'low'
      );
      this.installPointCloudControls(primaryTileset, contextTileset);

      if (contextTileset) applyPreset(
        contextTileset,
        options.context?.preset ?? 'low',
        {},
        { variant: this.presetVariantForTileset(contextTileset) }
      );
      applyPreset(
        primaryTileset,
        options.primary.preset,
        this.primaryPresetOverrides(options.primary.preset),
        { variant: this.presetVariantForTileset(primaryTileset) }
      );

      const cameraStart = performance.now();
      let restoreTravelDistance = 0;
      if (options.cameraBehavior === 'restore' && options.snapshot) {
        restoreTravelDistance = this.restoreCameraSnapshot(options.snapshot);
        this.callbacks.onBrowserMetric('flyToTime', performance.now() - cameraStart);
      } else if (options.cameraBehavior === 'preserve') {
        this.callbacks.onBrowserMetric('flyToTime', 0);
      } else {
        this.callbacks.onBrowserMetric('flyToTime', this.flyToTileset());
      }

      this.syncOverviewRuntime(options.primary.preset, bootstrapValidation);
      const restoreTravelStarted = this.overviewSseController.beginTravel(
        restoreTravelDistance
      );
      this.overviewSseController.endTravel(restoreTravelStarted);
      this.reportEffectiveSse();
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
        this.overviewSseController.onAllTilesLoaded();
      };
      primaryTileset.allTilesLoaded.addEventListener(onAllTilesLoaded);
      contextTileset?.allTilesLoaded.addEventListener(onAllTilesLoaded);

      this.postRenderUnsubscribe = this.viewer.scene.postRender.addEventListener(() => {
        if (!this.primaryTileset && !this.contextTileset) return;
        this.clampCameraDistance();
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
        if (this.overviewRuntimeActive) {
          this.overviewSseController.onTilesetFrame(
            this.primaryTileset?.tilesLoaded ?? false
          );
          this.updateOverviewPointSize();
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
    const preset = PRESETS[config.preset];
    const tilesetUrl = tilesetUrlFor(config.dataset);
    const shouldAlignAreaToMap = MAPTILER_BASEMAP_ENABLED;
    const documentPromise = shouldAlignAreaToMap
      ? fetch(tilesetUrl).then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          return response.json() as Promise<TilesetDocument>;
        })
      : Promise.resolve(null);
    const [tileset, document] = await Promise.all([
      Cesium.Cesium3DTileset.fromUrl(tilesetUrl, {
        maximumScreenSpaceError: preset.maximumScreenSpaceError,
        cacheBytes: preset.cacheBytes,
        maximumCacheOverflowBytes: preset.maximumCacheOverflowBytes,
        skipLevelOfDetail: false,
      }),
      documentPromise,
    ]);

    if (document && this.isGlobeDocument(document)) {
      this.alignTilesetBottomToEllipsoid(tileset, document);
    }

    if (DEBUG_TILES) {
      tileset.debugShowBoundingVolume = true;
      tileset.debugShowGeometricError = true;
      tileset.debugShowRenderingStatistics = true;
    }

    return tileset;
  }

  private isGlobeDocument(document: TilesetDocument): boolean {
    return document.asset?.extras?.coordinateMode === 'globe' ||
      document.asset?.extras?.local_only === false;
  }

  private alignTilesetBottomToEllipsoid(
    tileset: Cesium.Cesium3DTileset,
    document: TilesetDocument
  ): void {
    const root = document.root;
    const rootBox = root?.boundingVolume?.box;
    const transform = document.root?.transform;
    if (!rootBox || rootBox.length !== 12 || !transform || transform.length !== 16) return;

    const rootTransform = Cesium.Matrix4.fromArray(transform);
    const localCenter = new Cesium.Cartesian3(rootBox[0], rootBox[1], rootBox[2]);
    const worldCenter = Cesium.Matrix4.multiplyByPoint(
      rootTransform,
      localCenter,
      new Cesium.Cartesian3()
    );
    const childBoxes = root?.children
      ?.map((child) => child.boundingVolume?.box)
      .filter((box): box is number[] => Array.isArray(box) && box.length === 12) ?? [];
    const boxes = childBoxes.length > 1 ? childBoxes : [rootBox];
    const bottomHeights = boxes.map((box) => {
      let boxMinimumHeight = Number.POSITIVE_INFINITY;
      for (const xSign of [-1, 1]) {
        for (const ySign of [-1, 1]) {
          for (const zSign of [-1, 1]) {
            const corner = new Cesium.Cartesian3(
              box[0] + xSign * box[3] + ySign * box[6] + zSign * box[9],
              box[1] + xSign * box[4] + ySign * box[7] + zSign * box[10],
              box[2] + xSign * box[5] + ySign * box[8] + zSign * box[11]
            );
            const worldCorner = Cesium.Matrix4.multiplyByPoint(
              rootTransform,
              corner,
              new Cesium.Cartesian3()
            );
            const height = Cesium.Cartographic.fromCartesian(worldCorner)?.height;
            if (height !== undefined) {
              boxMinimumHeight = Math.min(boxMinimumHeight, height);
            }
          }
        }
      }
      return boxMinimumHeight;
    }).filter(Number.isFinite).sort((a, b) => a - b);

    if (bottomHeights.length === 0) return;
    const middle = Math.floor(bottomHeights.length / 2);
    const minimumHeight = bottomHeights.length % 2 === 0
      ? (bottomHeights[middle - 1] + bottomHeights[middle]) * 0.5
      : bottomHeights[middle];
    const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(worldCenter, new Cesium.Cartesian3());
    const translation = Cesium.Cartesian3.multiplyByScalar(up, -minimumHeight, up);
    tileset.modelMatrix = Cesium.Matrix4.fromTranslation(translation);
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
    resetOrbit: boolean,
    overviewMode: boolean
  ): void {
    const focusRadius = Math.max(primaryTileset.boundingSphere.radius, 1);
    const limitTileset = contextTileset ?? primaryTileset;
    const limitRadius = Math.max(limitTileset.boundingSphere.radius, focusRadius, 1);
    const usesGlobeControls = this.isGlobeTileset(limitTileset);
    const baseMinCameraDistance = Cesium.Math.clamp(
      focusRadius * MIN_CAMERA_DISTANCE_RATIO,
      MIN_CAMERA_DISTANCE_FLOOR,
      MIN_CAMERA_DISTANCE_CEILING
    );
    this.globeOverviewOrbitZoomActive = usesGlobeControls && overviewMode;
    this.cameraLimitTileset = limitTileset;
    if (resetOrbit) {
      this.orbitTarget = Cesium.Cartesian3.clone(limitTileset.boundingSphere.center);
      this.orbitRange = Cesium.Math.clamp(limitRadius * 3.5, focusRadius * 0.01, limitRadius * 12);
    }
    this.panScaleBase = limitRadius;
    this.minCameraDistance = this.globeOverviewOrbitZoomActive
      ? Math.max(baseMinCameraDistance, focusRadius * LIMIT_RADIUS_FOR_MINIMUM_ZOOM)
      : baseMinCameraDistance;
    this.maxCameraDistance = limitRadius * 12;
    if (!resetOrbit) {
      this.syncOrbitStateFromCamera(primaryTileset.boundingSphere.center);
    }

    const controller = this.viewer.scene.screenSpaceCameraController;
    // Cesium interprets this as height above the ellipsoid. Globe orbit zoom
    // uses minCameraDistance separately as distance to orbitTarget.
    controller.minimumZoomDistance = baseMinCameraDistance;
    controller.maximumZoomDistance = this.maxCameraDistance;
    if (usesGlobeControls) {
      if (!this.globeOverviewOrbitZoomActive) {
        controller.minimumZoomDistance = Math.max(
          baseMinCameraDistance,
          focusRadius * LIMIT_RADIUS_FOR_MINIMUM_ZOOM
        );
      }
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

  private syncOrbitStateFromCamera(referenceTarget: Cesium.Cartesian3): void {
    const camera = this.viewer.camera;
    const direction = Cesium.Cartesian3.normalize(
      camera.directionWC,
      new Cesium.Cartesian3()
    );
    const toReference = Cesium.Cartesian3.subtract(
      referenceTarget,
      camera.positionWC,
      new Cesium.Cartesian3()
    );
    const referenceDistance = Cesium.Cartesian3.magnitude(toReference);
    const projectedDistance = Cesium.Cartesian3.dot(toReference, direction);
    const distance = Cesium.Math.clamp(
      projectedDistance > this.minCameraDistance ? projectedDistance : referenceDistance,
      this.minCameraDistance,
      this.maxCameraDistance
    );
    this.orbitTarget = Cesium.Cartesian3.add(
      camera.positionWC,
      Cesium.Cartesian3.multiplyByScalar(direction, distance, new Cesium.Cartesian3()),
      new Cesium.Cartesian3()
    );
    const offset = Cesium.Cartesian3.negate(
      Cesium.Cartesian3.multiplyByScalar(direction, distance, new Cesium.Cartesian3()),
      new Cesium.Cartesian3()
    );

    this.orbitRange = distance;
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

  private setOrbitTargetFromScreenPosition(position: Cesium.Cartesian2): void {
    const scene = this.viewer.scene;
    let target: Cesium.Cartesian3 | undefined;

    if (scene.pickPositionSupported) {
      try {
        target = scene.pickPosition(position);
      } catch {
        target = undefined;
      }
    }

    if (!target && this.globeControlsActive) {
      const ray = this.viewer.camera.getPickRay(position);
      if (ray) {
        target = scene.globe.pick(ray, scene);
      }
    }

    if (
      !target ||
      !Number.isFinite(target.x) ||
      !Number.isFinite(target.y) ||
      !Number.isFinite(target.z)
    ) {
      return;
    }

    const offset = Cesium.Cartesian3.subtract(
      this.viewer.camera.positionWC,
      target,
      new Cesium.Cartesian3()
    );
    const range = Cesium.Math.clamp(
      Cesium.Cartesian3.magnitude(offset),
      this.minCameraDistance,
      this.maxCameraDistance
    );
    if (range <= 0) return;

    this.orbitTarget = Cesium.Cartesian3.clone(target);
    this.orbitRange = range;
    this.orbitHeading = Math.atan2(offset.x, offset.y);
    this.orbitPitch = Math.asin(Cesium.Math.clamp(offset.z / range, -1, 1));
  }

  private installGlobePointCloudControls(): void {
    this.inputHandler?.destroy();
    this.touchInputCleanup?.();
    this.touchInputCleanup = null;
    const handler = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas);
    let motionFrame: number | null = null;
    let pendingDx = 0;
    let pendingDy = 0;
    let pendingDrag: 'orbit' | 'pan' | null = null;

    const zoomByFactor = (factor: number): void => {
      const camera = this.viewer.camera;
      const offset = Cesium.Cartesian3.subtract(
        camera.positionWC,
        this.orbitTarget,
        new Cesium.Cartesian3()
      );
      const currentRange = Cesium.Cartesian3.magnitude(offset);
      if (currentRange <= 0) return;

      const nextRange = Cesium.Math.clamp(
        currentRange * factor,
        this.minCameraDistance,
        this.maxCameraDistance
      );
      if (Math.abs(nextRange - currentRange) < 0.001) return;

      Cesium.Cartesian3.normalize(offset, offset);
      Cesium.Cartesian3.multiplyByScalar(offset, nextRange, offset);
      const destination = Cesium.Cartesian3.add(
        this.orbitTarget,
        offset,
        new Cesium.Cartesian3()
      );
      const direction = Cesium.Cartesian3.normalize(
        Cesium.Cartesian3.subtract(
          this.orbitTarget,
          destination,
          new Cesium.Cartesian3()
        ),
        new Cesium.Cartesian3()
      );
      camera.setView({
        destination,
        orientation: {
          direction,
          up: camera.upWC,
        },
      });
    };

    const scheduleCameraMotion = (
      drag: 'orbit' | 'pan',
      dx: number,
      dy: number
    ): void => {
      if (pendingDrag !== null && pendingDrag !== drag) {
        pendingDx = 0;
        pendingDy = 0;
      }
      pendingDrag = drag;
      pendingDx += dx;
      pendingDy += dy;
      if (motionFrame !== null) return;

      motionFrame = requestAnimationFrame(() => {
        motionFrame = null;
        const nextDrag = pendingDrag;
        const nextDx = pendingDx;
        const nextDy = pendingDy;
        pendingDrag = null;
        pendingDx = 0;
        pendingDy = 0;

        // A scene reload may replace the input handler before this frame runs.
        if (this.inputHandler !== handler || !nextDrag) return;
        if (nextDrag === 'orbit') {
          this.rotateGlobeCamera(nextDx, nextDy);
        } else {
          this.panGlobeCamera(nextDx, nextDy);
        }
      });
    };

    this.inputHandler = handler;
    this.activeDrag = null;
    this.dragInteractionStarted = false;
    this.dragStartPointer = null;
    this.lastPointer = null;

    const controller = this.viewer.scene.screenSpaceCameraController;
    controller.enableRotate = false;
    controller.enableTranslate = false;
    controller.enableTilt = false;
    controller.enableLook = false;
    controller.enableZoom = !this.globeOverviewOrbitZoomActive;
    controller.inertiaZoom = 0;
    controller.zoomEventTypes = [
      Cesium.CameraEventType.WHEEL,
      Cesium.CameraEventType.PINCH,
    ];

    handler.setInputAction((event: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      this.setOrbitTargetFromScreenPosition(event.position);
      this.activeDrag = 'orbit';
      this.dragInteractionStarted = false;
      this.dragStartPointer = Cesium.Cartesian2.clone(event.position);
      this.lastPointer = Cesium.Cartesian2.clone(event.position);
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

    handler.setInputAction((event: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      this.activeDrag = 'pan';
      this.dragInteractionStarted = false;
      this.dragStartPointer = Cesium.Cartesian2.clone(event.position);
      this.lastPointer = Cesium.Cartesian2.clone(event.position);
    }, Cesium.ScreenSpaceEventType.RIGHT_DOWN);

    handler.setInputAction(() => {
      this.activeDrag = null;
      this.dragInteractionStarted = false;
      this.dragStartPointer = null;
      this.lastPointer = null;
    }, Cesium.ScreenSpaceEventType.LEFT_UP);

    handler.setInputAction(() => {
      this.activeDrag = null;
      this.dragInteractionStarted = false;
      this.dragStartPointer = null;
      this.lastPointer = null;
    }, Cesium.ScreenSpaceEventType.RIGHT_UP);

    handler.setInputAction((movement: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
      if (!this.activeDrag || !this.lastPointer) return;

      const dx = movement.endPosition.x - this.lastPointer.x;
      const dy = movement.endPosition.y - this.lastPointer.y;
      if (!this.dragInteractionStarted && this.dragStartPointer) {
        const totalDragDistance = Cesium.Cartesian2.distance(
          this.dragStartPointer,
          movement.endPosition
        );
        if (totalDragDistance >= INTERACTION_DRAG_START_THRESHOLD_PX) {
          this.dragInteractionStarted = true;
          this.callbacks.onInteraction();
        }
      }
      this.lastPointer = Cesium.Cartesian2.clone(movement.endPosition);

      scheduleCameraMotion(this.activeDrag, dx, dy);
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    handler.setInputAction((delta: number) => {
      this.callbacks.onInteraction();
      if (this.globeOverviewOrbitZoomActive) {
        zoomByFactor(delta > 0 ? 0.86 : 1.16);
      }
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
        zoomByFactor(lastTouchDistance / nextDistance);
      }
      if (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1) {
        this.panGlobeCamera(dx, dy);
      }

      lastTouchDistance = nextDistance;
      lastTouchMidpoint = nextMidpoint;
    };
    const endTwoFingerTouch = (event: TouchEvent): void => {
      if (event.touches.length >= 2) {
        beginTwoFingerTouch(event);
      } else {
        resetTwoFingerTouch();
      }
    };

    if (this.globeOverviewOrbitZoomActive) {
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
  }

  private installLocalPointCloudControls(): void {
    this.inputHandler?.destroy();
    this.touchInputCleanup?.();
    this.touchInputCleanup = null;
    const handler = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas);
    this.inputHandler = handler;
    this.activeDrag = null;
    this.dragInteractionStarted = false;
    this.dragStartPointer = null;
    this.lastPointer = null;

    const controller = this.viewer.scene.screenSpaceCameraController;
    controller.enableRotate = false;
    controller.enableTranslate = false;
    controller.enableTilt = false;
    controller.enableLook = false;
    controller.enableZoom = false;

    handler.setInputAction((event: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      this.setOrbitTargetFromScreenPosition(event.position);
      this.activeDrag = 'orbit';
      this.dragInteractionStarted = false;
      this.dragStartPointer = Cesium.Cartesian2.clone(event.position);
      this.lastPointer = Cesium.Cartesian2.clone(event.position);
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

    handler.setInputAction((event: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      this.activeDrag = 'pan';
      this.dragInteractionStarted = false;
      this.dragStartPointer = Cesium.Cartesian2.clone(event.position);
      this.lastPointer = Cesium.Cartesian2.clone(event.position);
    }, Cesium.ScreenSpaceEventType.RIGHT_DOWN);

    handler.setInputAction(() => {
      this.activeDrag = null;
      this.dragInteractionStarted = false;
      this.dragStartPointer = null;
      this.lastPointer = null;
    }, Cesium.ScreenSpaceEventType.LEFT_UP);

    handler.setInputAction(() => {
      this.activeDrag = null;
      this.dragInteractionStarted = false;
      this.dragStartPointer = null;
      this.lastPointer = null;
    }, Cesium.ScreenSpaceEventType.RIGHT_UP);

    handler.setInputAction((movement: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
      if (!this.activeDrag || !this.lastPointer) return;

      const dx = movement.endPosition.x - this.lastPointer.x;
      const dy = movement.endPosition.y - this.lastPointer.y;
      if (!this.dragInteractionStarted && this.dragStartPointer) {
        const totalDragDistance = Cesium.Cartesian2.distance(
          this.dragStartPointer,
          movement.endPosition
        );
        if (totalDragDistance >= INTERACTION_DRAG_START_THRESHOLD_PX) {
          this.dragInteractionStarted = true;
          this.callbacks.onInteraction();
        }
      }
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
    const target = this.orbitTarget;
    const offset = Cesium.Cartesian3.subtract(
      camera.positionWC,
      target,
      new Cesium.Cartesian3()
    );
    const range = Math.max(Cesium.Cartesian3.magnitude(offset), this.minCameraDistance);
    if (range <= 0) return;

    const angleX = -dx * 0.004;
    const angleY = -dy * 0.003;
    const localUp = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(
      target,
      new Cesium.Cartesian3()
    );
    const eastWestRotation = Cesium.Matrix3.fromQuaternion(
      Cesium.Quaternion.fromAxisAngle(localUp, angleX)
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
      this.orbitTarget
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
    Cesium.Cartesian3.add(this.orbitTarget, move, this.orbitTarget);
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
    const destination = this.cameraLimitTileset?.boundingSphere?.center;
    const distance = destination
      ? Cesium.Cartesian3.distance(this.orbitTarget, destination)
      : 0;
    const started = this.overviewSseController.beginTravel(distance);
    this.callbacks.onBrowserMetric('flyToTime', this.flyToTileset());
    this.overviewSseController.endTravel(started);
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
      { variant: this.presetVariantForTileset(this.primaryTileset) }
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
        { variant: this.presetVariantForTileset(this.primaryTileset) }
      );
      this.reportEffectiveSse();
      this.callbacks.onPresetChange('high');
    }
  }

  setOverviewPointSizeScale(scale: number): void {
    const clamped = clampOverviewPointSizeScale(scale);
    if (Math.abs(clamped - this.overviewPointSizeScale) < 1e-9) return;
    this.overviewPointSizeScale = clamped;
    if (this.overviewRuntimeActive) {
      this.updateOverviewPointSize();
    }
  }

  getOverviewPointSizeScale(): number {
    return this.overviewPointSizeScale;
  }

  private syncOverviewRuntime(
    preset: PresetName,
    validation: BootstrapValidation | null = null
  ): void {
    if (preset === 'low' && this.primaryTileset) {
      this.enterOverviewRuntime(validation);
    } else {
      this.exitOverviewRuntime();
    }
  }

  private enterOverviewRuntime(validation: BootstrapValidation | null = null): void {
    if (!this.primaryTileset) return;
    this.overviewRuntimeActive = true;
    this.overviewPointSizeBand = null;
    this.updateOverviewCameraRangeRatio();
    const band = overviewBandForRatio(this.overviewCameraRangeRatio, null);
    const px = this.pointSizePxForOverviewBand(band);
    this.overviewPointSizeBand = band;
    this.overviewPointSizePx = px;
    this.lastOverviewReportKey = '';
    applyOverviewRuntimeTuning(this.primaryTileset, { pointSizePx: px });
    this.callbacks.onOverviewSseValidation(
      validation as Record<string, unknown> | null
    );
    this.overviewSseController.activate(this.primaryTileset, validation);
    this.registerFirstVisibleListener();
    this.reportOverviewTuning();
    this.logOverviewDiagnostics(true);
  }

  private registerFirstVisibleListener(): void {
    this.overviewFirstVisibleUnsubscribe?.();
    this.overviewFirstVisibleUnsubscribe = null;
    this.overviewFirstVisibleFired = false;
    if (!this.primaryTileset) return;
    const tileset = this.primaryTileset;
    const onTileVisible = (): void => {
      if (this.overviewFirstVisibleFired) return;
      this.overviewFirstVisibleFired = true;
      this.overviewSseController.onFirstVisible();
      this.overviewFirstVisibleUnsubscribe?.();
      this.overviewFirstVisibleUnsubscribe = null;
    };
    tileset.tileVisible.addEventListener(onTileVisible);
    this.overviewFirstVisibleUnsubscribe = () => {
      tileset.tileVisible.removeEventListener(onTileVisible);
    };
  }

  private exitOverviewRuntime(): void {
    if (!this.overviewRuntimeActive) return;
    this.overviewRuntimeActive = false;
    this.overviewPointSizeBand = null;
    this.overviewPointSizePx = 0;
    this.overviewCameraRangeRatio = 0;
    this.lastOverviewReportKey = '';
    if (this.primaryTileset) {
      this.primaryTileset.style = undefined;
    }
    this.overviewFirstVisibleUnsubscribe?.();
    this.overviewFirstVisibleUnsubscribe = null;
    this.overviewFirstVisibleFired = false;
    this.overviewSseController.deactivate();
    this.callbacks.onOverviewSseValidation(null);
    this.resetOverviewSseReporting();
    this.reportOverviewTuning();
  }

  private resetOverviewSseReporting(): void {
    this.callbacks.onBrowserMetric('overviewSsePhase', '—');
    this.callbacks.onBrowserMetric('overviewSse', '—');
    this.callbacks.onBrowserMetric('overviewBootstrapRequests', 0);
    this.callbacks.onBrowserMetric('overviewBootstrapBytes', 0);
    this.callbacks.onBrowserMetric('overviewTravelRequests', 0);
    this.callbacks.onBrowserMetric('overviewTravelBytes', 0);
    this.callbacks.onBrowserMetric('overviewRefiningRequests', 0);
    this.callbacks.onBrowserMetric('overviewRefiningBytes', 0);
    this.callbacks.onBrowserMetric('overviewReadyRequests', 0);
    this.callbacks.onBrowserMetric('overviewReadyBytes', 0);
    this.callbacks.onBrowserMetric('overviewTravelDistance', 0);
  }

  private updateOverviewPointSize(): void {
    if (!this.overviewRuntimeActive || !this.primaryTileset) return;
    this.updateOverviewCameraRangeRatio();
    const nextBand = overviewBandForRatio(
      this.overviewCameraRangeRatio,
      this.overviewPointSizeBand
    );
    const nextPx = this.pointSizePxForOverviewBand(nextBand);
    const pxChanged = nextPx !== this.overviewPointSizePx;
    this.overviewPointSizeBand = nextBand;
    this.overviewPointSizePx = nextPx;
    if (pxChanged) {
      this.primaryTileset.style = createOverviewPointSizeStyle(nextPx);
    }
    this.reportOverviewTuning();
    this.logOverviewDiagnostics();
  }

  private pointSizePxForOverviewBand(band: OverviewPointSizeBand): number {
    const px = clampOverviewPointSizePx(
      overviewBasePointSize(band) * this.overviewPointSizeScale
    );
    return this.globeControlsActive
      ? Math.max(px, OVERVIEW_GLOBE_POINT_SIZE_PX_MIN)
      : px;
  }

  private logOverviewDiagnostics(force = false): void {
    if (!DEBUG_OVERVIEW || !this.overviewRuntimeActive || !this.primaryTileset) return;

    const now = performance.now();
    if (!force && now - this.lastOverviewDebugLogAt < OVERVIEW_DEBUG_LOG_INTERVAL_MS) return;

    const tileset = this.primaryTileset;
    const runtime = tileset as unknown as RuntimeTileset;
    const selectedTiles = runtime._selectedTiles?.length
      ?? runtime.selectedTiles?.length
      ?? runtime.statistics?.numberOfTilesSelected
      ?? 'unsupported';
    const requestedTiles = runtime._requestedTiles?.length ?? 'unsupported';
    const requestedTilesInFlight = runtime._requestedTilesInFlight?.length ?? 'unsupported';
    const processingQueue = runtime._processingQueue?.length ?? 'unsupported';
    const phase = this.overviewSseController.getPhase();
    const key = [
      phase,
      tileset.maximumScreenSpaceError,
      tileset.tilesLoaded,
      selectedTiles,
      requestedTiles,
      requestedTilesInFlight,
      processingQueue,
      this.overviewPointSizePx,
      this.overviewPointSizeBand,
      this.overviewCameraRangeRatio.toFixed(3),
    ].join('|');
    if (
      !force
      && key === this.lastOverviewDebugKey
      && now - this.lastOverviewDebugLogAt < OVERVIEW_DEBUG_REPEAT_INTERVAL_MS
    ) {
      return;
    }

    this.lastOverviewDebugLogAt = now;
    this.lastOverviewDebugKey = key;
    console.log('[Overview Debug]', {
      dataset: this.activeDataset,
      phase,
      maximumScreenSpaceError: tileset.maximumScreenSpaceError,
      tilesLoaded: tileset.tilesLoaded,
      selectedTiles,
      requestedTiles,
      requestedTilesInFlight,
      processingQueue,
      statistics: runtime.statistics ? { ...runtime.statistics } : undefined,
      visiblePointsEstimated: selectedPointCount(runtime),
      pointSizePx: this.overviewPointSizePx,
      pointSizeBand: this.overviewPointSizeBand,
      pointSizeScale: this.overviewPointSizeScale,
      cameraRangeRatio: Number(this.overviewCameraRangeRatio.toFixed(3)),
      tilesetMemoryBytes: tileset.totalMemoryUsageInBytes,
    });
  }

  private updateOverviewCameraRangeRatio(): void {
    if (!this.primaryTileset) {
      this.overviewCameraRangeRatio = 0;
      return;
    }
    const radius = this.primaryTileset.boundingSphere.radius;
    const range = this.currentOverviewCameraRange();
    this.overviewCameraRangeRatio = radius > 0 ? range / radius : 0;
  }

  private currentOverviewCameraRange(): number {
    if (this.globeControlsActive) {
      return Cesium.Cartesian3.distance(
        this.viewer.camera.positionWC,
        this.orbitTarget
      );
    }
    return this.orbitRange;
  }

  private reportOverviewTuning(): void {
    const px: number | string = this.overviewRuntimeActive ? this.overviewPointSizePx : '—';
    const band: string = this.overviewRuntimeActive
      ? (this.overviewPointSizeBand ?? '—')
      : '—';
    const scale: number | string = this.overviewRuntimeActive
      ? this.overviewPointSizeScale
      : '—';
    const ratio: number | string = this.overviewRuntimeActive
      ? Number(this.overviewCameraRangeRatio.toFixed(2))
      : '—';
    const key = `${px}|${band}|${scale}|${ratio}`;
    if (key === this.lastOverviewReportKey) return;
    this.lastOverviewReportKey = key;
    this.callbacks.onBrowserMetric('pointSizePx', px);
    this.callbacks.onBrowserMetric('pointSizeBand', band);
    this.callbacks.onBrowserMetric('pointSizeScale', scale);
    this.callbacks.onBrowserMetric('cameraRangeRatio', ratio);
  }

  getCurrentPreset(): PresetName {
    return this.currentPreset;
  }

  getActiveDataset(): string {
    return this.activeDataset;
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

  restoreCameraSnapshot(snapshot: CameraSnapshot): number {
    const destination = pointToCartesian(snapshot.orbitTarget);
    const distance = Cesium.Cartesian3.distance(this.orbitTarget, destination);
    this.orbitTarget = destination;
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
    return distance;
  }

  destroy(): void {
    this.unloadTilesets();
    this.inputHandler?.destroy();
    this.touchInputCleanup?.();
    this.touchInputCleanup = null;
    this.overviewSseController.dispose();
    this.viewer.destroy();
  }

  private unloadTilesets(): void {
    this.postRenderUnsubscribe?.();
    this.postRenderUnsubscribe = null;
    for (const tileset of [this.primaryTileset, this.contextTileset]) {
      if (!tileset) continue;
      this.viewer.scene.primitives.remove(tileset);
      if (!tileset.isDestroyed()) {
        tileset.destroy();
      }
    }
    this.primaryTileset = null;
    this.contextTileset = null;
    this.cameraLimitTileset = null;
    this.tilesLoaded = 0;
    this.activeTilesLoaded = 0;
    this.lastLayerRuntimeKey = '';
    this.overviewRuntimeActive = false;
    this.overviewPointSizeBand = null;
    this.overviewPointSizePx = 0;
    this.overviewCameraRangeRatio = 0;
    this.lastOverviewReportKey = '';
    this.overviewFirstVisibleUnsubscribe?.();
    this.overviewFirstVisibleUnsubscribe = null;
    this.overviewFirstVisibleFired = false;
    this.overviewSseController.deactivate();
    this.callbacks.onOverviewSseValidation(null);
    this.resetOverviewSseReporting();
    this.reportOverviewTuning();
    this.reportLayerTileStats();
  }

  private primaryPresetOverrides(
    preset: PresetName
  ): { maximumScreenSpaceError?: number } {
    if (preset === 'high') {
      return { maximumScreenSpaceError: this.detailSseOverride };
    }
    return {};
  }

  private presetVariantForTileset(tileset: Cesium.Cesium3DTileset): 'local' | 'globe' {
    return this.isGlobeTileset(tileset) ? 'globe' : 'local';
  }

  private loadedTileCount(): number {
    return [this.primaryTileset, this.contextTileset].reduce((total, tileset) => {
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
    const values = [this.primaryTileset, this.contextTileset]
      .filter((tileset): tileset is Cesium.Cesium3DTileset => tileset !== null)
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
    const focus = this.layerRuntimeStats(this.primaryTileset);
    const context = this.layerRuntimeStats(this.contextTileset);
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
    this.callbacks.onBrowserMetric(
      'cacheBytesRuntime',
      this.primaryTileset?.cacheBytes ?? PRESETS[this.currentPreset].cacheBytes
    );
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
