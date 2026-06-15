// ui.ts — UI state management for the point cloud viewer
import { type PresetName, PRESETS } from './presets';
import { type ViewerState } from './viewer';

// ── Status overlay ──────────────────────────────────────────────
const statusOverlay = document.getElementById('status-overlay')!;
const statusTitle = document.getElementById('status-title')!;
const statusMessage = document.getElementById('status-message')!;
const statusSpinner = document.getElementById('status-spinner')!;
const statusCheck = document.getElementById('status-check')!;
const statusErrorIcon = document.getElementById('status-error-icon')!;

// ── Top bar ─────────────────────────────────────────────────────
const metaStatus = document.getElementById('meta-status')!;
const metaDataset = document.getElementById('meta-dataset')!;
const brandBadge = document.getElementById('brand-badge');

// ── Stats ───────────────────────────────────────────────────────
const statSSE = document.getElementById('stat-sse')!;
const statMemory = document.getElementById('stat-memory')!;
const statTiles = document.getElementById('stat-tiles')!;

// ── Preset buttons ───────────────────────────────────────────────
const presetButtons = document.querySelectorAll<HTMLButtonElement>('.preset-btn');

export function setStatus(state: ViewerState, message?: string): void {
  const titleMap: Record<ViewerState, string> = {
    loading: 'Loading Point Cloud',
    ready: 'Point Cloud Ready',
    error: 'Load Failed',
  };

  statusTitle.textContent = titleMap[state];
  statusMessage.textContent = message ?? '';
  metaStatus.textContent = state === 'ready' ? 'Ready' : state === 'error' ? 'Error' : 'Loading…';

  // Icon states
  statusSpinner.classList.toggle('hidden', state !== 'loading');
  statusCheck.classList.toggle('hidden', state !== 'ready');
  statusErrorIcon.classList.toggle('hidden', state !== 'error');

  // Remove overlay after "ready" with a delay
  if (state === 'ready') {
    statusOverlay.classList.add('fading');
    setTimeout(() => {
      statusOverlay.classList.add('hidden');
    }, 1800);
  } else if (state === 'error') {
    statusOverlay.classList.remove('fading', 'hidden');
    statusOverlay.classList.add('error');
  } else {
    statusOverlay.classList.remove('fading', 'hidden', 'error');
  }
}

export function updateStats(opts: {
  sse?: number;
  memory?: number;
  tiles?: number;
}): void {
  if (opts.sse !== undefined) statSSE.textContent = opts.sse.toString();
  if (opts.memory !== undefined) statMemory.textContent = `${opts.memory} MB`;
  if (opts.tiles !== undefined) statTiles.textContent = opts.tiles.toString();
}

export function setDatasetLabel(dataset: string): void {
  metaDataset.textContent = dataset;
}

export function setSourceLabel(source: string): void {
  if (brandBadge) brandBadge.textContent = source.toUpperCase();
}

export function setActivePreset(preset: PresetName): void {
  presetButtons.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.preset === preset);
  });
}

export function initPresetButtons(
  onChange: (preset: PresetName) => void
): void {
  presetButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.preset as PresetName;
      if (!PRESETS[preset]) return;
      setActivePreset(preset);
      onChange(preset);
    });
  });
}

export function initFlyHomeButton(onFly: () => void): void {
  const btn = document.getElementById('btn-fly-home');
  if (btn) btn.addEventListener('click', onFly);
}

export function setServerUrl(url: string): void {
  const el = document.getElementById('server-url');
  if (el) el.textContent = url;
}
