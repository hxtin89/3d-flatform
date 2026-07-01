// viewer.ts — CesiumJS viewer and 3D Tileset loader
import * as Cesium from 'cesium';
import { applyPreset, cacheBytesToMB, type PresetName, PRESETS } from './presets';
import { type BrowserMetricName } from './report';

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
  private lastPointer: Cesium.Cartesian2 | null = null;
  private touchInputCleanup: (() => void) | null = null;
  private firstTileLoadedReported = false;
  private firstVisibleReported = false;
  private loadStartTime = 0;
  private detailSseOverride = PRESETS.high.maximumScreenSpaceError;
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
        { variant: this.presetVariantForTileset(contextTileset) }
      );
      applyPreset(
        primaryTileset,
        options.primary.preset,
        this.primaryPresetOverrides(options.primary.preset),
        { variant: this.presetVariantForTileset(primaryTileset) }
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
    controller.inertiaZoom = 0;
    controller.zoomEventTypes = [
      Cesium.CameraEventType.WHEEL,
      Cesium.CameraEventType.PINCH,
    ];

    handler.setInputAction((event: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      this.callbacks.onInteraction();
      if (this.cameraLimitTileset) {
        this.syncOrbitStateFromCamera(this.cameraLimitTileset.boundingSphere.center);
      }
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
      if (this.cameraLimitTileset) {
        this.syncOrbitStateFromCamera(this.cameraLimitTileset.boundingSphere.center);
      }
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
    this.inputHandler?.destroy();
    this.touchInputCleanup?.();
    this.touchInputCleanup = null;
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
