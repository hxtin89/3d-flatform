import * as Cesium from 'cesium';

export type DetailContextMode = 'off' | 'dim' | 'full';

export const BASE_CONTEXT_SSE = 64;
export const BASE_CONTEXT_CACHE_BYTES = 128 * 1024 * 1024;
export const BASE_CONTEXT_OVERFLOW_BYTES = 16 * 1024 * 1024;
export const DIM_POINT_SIZE = 1;
export const DIM_ALPHA = 0.3;
export const DIM_COLOR_EXPRESSION = '${COLOR} * vec4(1.0, 1.0, 1.0, 0.3)';

export interface DetailContextApplyResult {
  dimAlphaSupported: boolean;
}

export function applyDetailContextMode(
  tileset: Cesium.Cesium3DTileset,
  mode: DetailContextMode,
  options: { dimAlphaSupported?: boolean } = {}
): DetailContextApplyResult {
  let dimAlphaSupported = options.dimAlphaSupported ?? true;

  switch (mode) {
    case 'off':
      tileset.show = false;
      tileset.preloadWhenHidden = false;
      tileset.cullRequestsWhileMoving = true;
      break;
    case 'dim':
      tileset.show = true;
      tileset.preloadWhenHidden = true;
      tileset.cullRequestsWhileMoving = false;
      tileset.maximumScreenSpaceError = BASE_CONTEXT_SSE;
      tileset.cacheBytes = BASE_CONTEXT_CACHE_BYTES;
      tileset.maximumCacheOverflowBytes = BASE_CONTEXT_OVERFLOW_BYTES;
      try {
        tileset.style = new Cesium.Cesium3DTileStyle({
          pointSize: DIM_POINT_SIZE,
          ...(dimAlphaSupported ? { color: DIM_COLOR_EXPRESSION } : {}),
        });
      } catch {
        dimAlphaSupported = false;
        tileset.style = new Cesium.Cesium3DTileStyle({
          pointSize: DIM_POINT_SIZE,
        });
      }
      break;
    case 'full':
      tileset.show = true;
      tileset.preloadWhenHidden = true;
      tileset.cullRequestsWhileMoving = false;
      tileset.maximumScreenSpaceError = BASE_CONTEXT_SSE;
      tileset.cacheBytes = BASE_CONTEXT_CACHE_BYTES;
      tileset.maximumCacheOverflowBytes = BASE_CONTEXT_OVERFLOW_BYTES;
      tileset.style = undefined;
      break;
  }

  return { dimAlphaSupported };
}

export function trimBaseTileset(tileset: Cesium.Cesium3DTileset | null): void {
  if (!tileset || tileset.isDestroyed()) return;
  tileset.trimLoadedTiles();
}
