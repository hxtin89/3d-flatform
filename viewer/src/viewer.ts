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
const MOBILE_VIEWPORT_QUERY = '(max-width: 640px)';
const MIN_CAMERA_DISTANCE_FLOOR = 0.25;
const MIN_CAMERA_DISTANCE_RATIO = 0.0005;
const MIN_CAMERA_DISTANCE_CEILING = 5;

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

type RuntimeTileset = {
  _selectedTiles?: RuntimeTile[];
  selectedTiles?: RuntimeTile[];
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
  private firstTileLoadedReported = false;
  private firstVisibleReported = false;
  private loadStartTime = 0;
  private detailSseOverride = PRESETS.high.maximumScreenSpaceError;
  private lastLayerRuntimeKey = '';

  constructor(containerId: string, callbacks: ViewerCallbacks) {
    this.callbacks = callbacks;
    this.viewer = this.createViewer(containerId);
  }

  private createViewer(containerId: string): Cesium.Viewer {
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

      // No imagery or terrain from ion
      baseLayer: false,
      terrainProvider: new Cesium.EllipsoidTerrainProvider(),

      // Disable globe, sky, atmosphere via constructor
      globe: false,
      skyBox: false,
      skyAtmosphere: false,
    });

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
      this.installLocalPointCloudControls();

      if (contextTileset) applyPreset(contextTileset, options.context?.preset ?? 'low');
      applyPreset(
        primaryTileset,
        options.primary.preset,
        this.primaryPresetOverrides(options.primary.preset)
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
    this.orbitRange = this.cameraLimitTileset.boundingSphere.radius * (isMobileViewport ? 5.2 : 3.5);
    this.orbitPitch = Cesium.Math.toRadians(-35);
    this.orbitHeading = Cesium.Math.toRadians(35);
    this.applyOrbitCamera();
    return performance.now() - start;
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

    const frustum = this.viewer.camera.frustum;
    if (frustum instanceof Cesium.PerspectiveFrustum) {
      frustum.near = 0.1;
      frustum.far = this.maxCameraDistance * 4;
    }
  }

  private clampCameraDistance(): void {
    if (!this.cameraLimitTileset) return;

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

  private installLocalPointCloudControls(): void {
    this.inputHandler?.destroy();
    const handler = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas);
    this.inputHandler = handler;

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
    applyPreset(this.primaryTileset, preset, this.primaryPresetOverrides(preset));
    this.reportEffectiveSse();
    this.callbacks.onPresetChange(preset);
  }

  setDetailSseOverride(maximumScreenSpaceError: number): void {
    this.detailSseOverride = maximumScreenSpaceError;
    if (this.currentPreset === 'high' && this.primaryTileset) {
      applyPreset(this.primaryTileset, 'high', this.primaryPresetOverrides('high'));
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
    return preset === 'high'
      ? { maximumScreenSpaceError: this.detailSseOverride }
      : {};
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
