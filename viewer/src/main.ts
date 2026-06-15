// main.ts — Entry point for the SBB CesiumJS Point Cloud Viewer
import './style.css';
import {
  DATASET,
  TILE_CONFIG,
  TILE_SOURCE,
  PointCloudViewer,
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
} from './ui';

setDatasetLabel(DATASET);
setSourceLabel(TILE_SOURCE);
setServerUrl(TILE_CONFIG.baseUrl || 'CloudFront not configured');

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
  onTileStats: (loaded: number) => {
    updateStats({ tiles: loaded });
  },
  onPresetChange: (_preset: PresetName) => {
    updateStats({
      sse: viewer.getSSE(),
      memory: viewer.getCacheMB(),
    });
  },
});

// Wire up UI controls
initPresetButtons((preset: PresetName) => {
  viewer.setPreset(preset);
});

initFlyHomeButton(() => {
  viewer.flyHome();
});

// Set initial active preset
setActivePreset(viewer.getCurrentPreset());

// Load the tileset
viewer.loadTileset().catch((err) => {
  console.error('[Main] Unexpected error:', err);
  setStatus('error', `Unexpected error: ${err.message}`);
});
