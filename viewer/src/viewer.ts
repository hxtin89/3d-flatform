// viewer.ts — CesiumJS viewer and 3D Tileset loader
import * as Cesium from 'cesium';
import { applyPreset, cacheBytesToMB, type PresetName, PRESETS } from './presets';

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
  tilesetUrl: string;
  missingConfig: boolean;
} {
  if (TILE_SOURCE === 'local') {
    return {
      source: 'local',
      baseUrl: LOCAL_TILE_SERVER_BASE,
      tilesetUrl: `${LOCAL_TILE_SERVER_BASE}/${DATASET}/tileset.json`,
      missingConfig: false,
    };
  }

  const cloudFrontDomain = normalizeCloudFrontDomain(
    import.meta.env.VITE_AWS_CMS_CLOUDFRONT_DISTRIBUTION_DOMAIN
  );
  const folder = normalizeFolder(import.meta.env.VITE_POINTCLOUD_TILES_FOLDER);
  const baseUrl = cloudFrontDomain
    ? `https://${cloudFrontDomain}/${folder}`
    : '';

  return {
    source: 'cloudfront',
    baseUrl,
    tilesetUrl: baseUrl ? `${baseUrl}/${DATASET}/tileset.json` : '',
    missingConfig: !cloudFrontDomain,
  };
}

export const TILE_CONFIG = buildTileConfig();

export type ViewerState = 'loading' | 'ready' | 'error';

export interface ViewerCallbacks {
  onStateChange: (state: ViewerState, message?: string) => void;
  onTileStats: (loaded: number) => void;
  onPresetChange: (preset: PresetName) => void;
}

export class PointCloudViewer {
  private viewer: Cesium.Viewer;
  private tileset: Cesium.Cesium3DTileset | null = null;
  private inputHandler: Cesium.ScreenSpaceEventHandler | null = null;
  private currentPreset: PresetName = 'medium';
  private callbacks: ViewerCallbacks;
  private tilesLoaded = 0;
  private minCameraDistance = 1;
  private maxCameraDistance = Number.POSITIVE_INFINITY;
  private panScaleBase = 1;
  private orbitTarget = new Cesium.Cartesian3();
  private orbitHeading = Cesium.Math.toRadians(35);
  private orbitPitch = Cesium.Math.toRadians(-35);
  private orbitRange = 1;
  private activeDrag: 'orbit' | 'pan' | null = null;
  private lastPointer: Cesium.Cartesian2 | null = null;

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

  async loadTileset(): Promise<void> {
    this.callbacks.onStateChange('loading', 'Connecting to tile server...');

    try {
      await this.checkTileServer();
      this.callbacks.onStateChange('loading', 'Fetching tileset.json...');

      const preset = PRESETS[this.currentPreset];

      const tileset = await Cesium.Cesium3DTileset.fromUrl(TILE_CONFIG.tilesetUrl, {
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

      this.viewer.scene.primitives.add(tileset);
      this.tileset = tileset;
      this.configureCameraLimits(tileset);
      this.installLocalPointCloudControls();

      // Apply default preset shading
      applyPreset(tileset, this.currentPreset);

      this.flyToTileset();
      this.callbacks.onStateChange('ready', `Streaming: ${TILE_CONFIG.tilesetUrl}`);

      // Keep stats fresh when Cesium reports the first visible set has loaded.
      tileset.initialTilesLoaded.addEventListener(() => {
        this.callbacks.onTileStats(this.tilesLoaded);
      });

      // Track all-tiles-loaded
      tileset.allTilesLoaded.addEventListener(() => {
        this.callbacks.onTileStats(this.tilesLoaded);
      });

      // Count loaded tiles via the post-render loop
      this.viewer.scene.postRender.addEventListener(() => {
        if (!this.tileset) return;
        this.clampCameraDistance();
        // Access statistics via the public property (typed loosely)
        const ts = this.tileset as unknown as {
          statistics?: { numberOfLoadedTilesTotal?: number };
        };
        const n = ts.statistics?.numberOfLoadedTilesTotal ?? 0;
        if (n !== this.tilesLoaded) {
          this.tilesLoaded = n;
          this.callbacks.onTileStats(n);
        }
      });

      // Handle tile load failures
      tileset.tileFailed.addEventListener(
        (event: { url: string; message: string }) => {
          console.warn(`[Viewer] Tile failed: ${event.url} — ${event.message}`);
        }
      );
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

  private async checkTileServer(): Promise<void> {
    if (TILE_CONFIG.missingConfig) {
      throw new Error(
        'Missing VITE_AWS_CMS_CLOUDFRONT_DISTRIBUTION_DOMAIN for CloudFront tile source.'
      );
    }

    try {
      const response = await fetch(TILE_CONFIG.tilesetUrl, {
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

  private flyToTileset(): void {
    if (!this.tileset) return;
    const isMobileViewport = window.matchMedia(MOBILE_VIEWPORT_QUERY).matches;
    this.orbitRange = this.tileset.boundingSphere.radius * (isMobileViewport ? 5.2 : 3.5);
    this.orbitPitch = Cesium.Math.toRadians(-35);
    this.orbitHeading = Cesium.Math.toRadians(35);
    this.applyOrbitCamera();
  }

  private configureCameraLimits(tileset: Cesium.Cesium3DTileset): void {
    const radius = Math.max(tileset.boundingSphere.radius, 1);
    this.orbitTarget = Cesium.Cartesian3.clone(tileset.boundingSphere.center);
    this.panScaleBase = radius;
    this.minCameraDistance = Math.max(radius * 0.01, 1);
    this.maxCameraDistance = radius * 12;
    this.orbitRange = Cesium.Math.clamp(radius * 3.5, this.minCameraDistance, this.maxCameraDistance);

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
    if (!this.tileset) return;

    const camera = this.viewer.camera;
    const center = this.tileset.boundingSphere.center;
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

  private installLocalPointCloudControls(): void {
    this.inputHandler?.destroy();
    const handler = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas);
    this.inputHandler = handler;

    handler.setInputAction((event: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      this.activeDrag = 'orbit';
      this.lastPointer = Cesium.Cartesian2.clone(event.position);
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

    handler.setInputAction((event: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
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
    this.flyToTileset();
  }

  setPreset(preset: PresetName): void {
    if (!this.tileset) {
      console.warn('[Viewer] No tileset loaded yet.');
      return;
    }
    this.currentPreset = preset;
    applyPreset(this.tileset, preset);
    this.callbacks.onPresetChange(preset);
  }

  getCurrentPreset(): PresetName {
    return this.currentPreset;
  }

  getSSE(): number {
    return (
      this.tileset?.maximumScreenSpaceError ??
      PRESETS[this.currentPreset].maximumScreenSpaceError
    );
  }

  getCacheMB(): number {
    return cacheBytesToMB(
      this.tileset?.cacheBytes ?? PRESETS[this.currentPreset].cacheBytes
    );
  }

  destroy(): void {
    this.inputHandler?.destroy();
    this.viewer.destroy();
  }
}
