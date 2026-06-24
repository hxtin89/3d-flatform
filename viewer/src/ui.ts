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
const areaSelect = document.getElementById('area-select') as HTMLSelectElement | null;
const useCurrentViewButton = document.getElementById(
  'btn-use-current-view'
) as HTMLButtonElement | null;
const areaDetectStatus = document.getElementById('area-detect-status');
const contextLayerToggle = document.getElementById(
  'toggle-context-layer'
) as HTMLInputElement | null;
const detailSseSelect = document.getElementById(
  'select-detail-sse'
) as HTMLSelectElement | null;

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
      if (btn.disabled) return;
      const preset = btn.dataset.preset as PresetName;
      if (!PRESETS[preset]) return;
      onChange(preset);
    });
  });
}

export function setPresetAvailability(
  preset: PresetName,
  enabled: boolean,
  label: string
): void {
  const btn = document.querySelector<HTMLButtonElement>(`.preset-btn[data-preset="${preset}"]`);
  if (btn) {
    btn.disabled = !enabled;
    btn.title = enabled ? '' : label;
  }
  const status = document.getElementById(`mode-status-${preset}`);
  if (status) status.textContent = label;
}

export function initAreaSelect(onChange: (areaId: string) => void): void {
  areaSelect?.addEventListener('change', () => {
    if (areaSelect.value) onChange(areaSelect.value);
  });
}

export function initUseCurrentViewButton(onClick: () => void): void {
  useCurrentViewButton?.addEventListener('click', onClick);
}

export function initContextLayerToggle(onChange: (enabled: boolean) => void): void {
  contextLayerToggle?.addEventListener('change', () => {
    onChange(Boolean(contextLayerToggle.checked));
  });
}

export function initDetailSseSelect(onChange: (sse: number) => void): void {
  detailSseSelect?.addEventListener('change', () => {
    const sse = Number(detailSseSelect.value);
    if (Number.isFinite(sse) && sse > 0) onChange(sse);
  });
}

export function setContextLayerAvailability(enabled: boolean, label: string): void {
  if (!contextLayerToggle) return;
  contextLayerToggle.disabled = !enabled;
  contextLayerToggle.title = enabled ? '' : label;
}

export function isContextLayerEnabled(): boolean {
  return contextLayerToggle?.checked ?? false;
}

export function setAreaOptions(
  areas: Array<{ areaId: string; label: string }>,
  selectedAreaId: string | null
): void {
  if (!areaSelect) return;
  areaSelect.innerHTML = '';
  if (areas.length === 0) {
    areaSelect.disabled = true;
    areaSelect.append(new Option('No area manifest', ''));
    return;
  }
  areas.forEach((area) => {
    areaSelect.append(new Option(area.label, area.areaId));
  });
  areaSelect.value = selectedAreaId ?? areas[0].areaId;
  areaSelect.disabled = false;
}

export function setSelectedAreaOption(areaId: string | null): void {
  if (!areaSelect || !areaId) return;
  areaSelect.value = areaId;
}

export function setUseCurrentViewAvailability(enabled: boolean, label: string): void {
  if (!useCurrentViewButton) return;
  useCurrentViewButton.disabled = !enabled;
  useCurrentViewButton.title = enabled ? '' : label;
}

export function setAreaDetectionStatus(message: string): void {
  if (areaDetectStatus) areaDetectStatus.textContent = message;
}

export function initFlyHomeButton(onFly: () => void): void {
  const btn = document.getElementById('btn-fly-home');
  if (btn) btn.addEventListener('click', onFly);
}

export function setServerUrl(url: string): void {
  const el = document.getElementById('server-url');
  if (el) el.textContent = url;
}
