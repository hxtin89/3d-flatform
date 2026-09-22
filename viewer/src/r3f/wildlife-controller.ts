import { distanceM, FEATURE_KINDS, type FeatureApi, type FeatureBand, type FeatureKind, type FeatureQuery, type FeatureResponse } from './wildlife-api'

export interface FeatureViewState { center: { longitude: number; latitude: number }; rangeM: number; band: FeatureBand }
export interface FeatureLoadState { phase: 'idle' | 'loading' | 'ready' | 'error'; message: string }
export interface FeatureControllerOptions { api: FeatureApi; debounceMs?: number; onResponse(response: FeatureResponse | null): void; onState(state: FeatureLoadState): void }
export interface FeatureController { update(now: number, view: FeatureViewState): void; setEnabled(enabled: boolean): void; setTypes(types: Iterable<FeatureKind>): void; retry(): void; dispose(): void }

function sameTypes(left: Set<FeatureKind>, right: Set<FeatureKind>): boolean {
  return left.size === right.size && Array.from(left).every((type) => right.has(type))
}

function queryFor(view: FeatureViewState, types: Set<FeatureKind>): FeatureQuery {
  return { center: { ...view.center }, rangeM: Math.max(1, view.rangeM), band: view.band, types: FEATURE_KINDS.filter((type) => types.has(type)) }
}

function viewChanged(next: FeatureViewState, previous: FeatureQuery | null, types: Set<FeatureKind>): boolean {
  if (!previous || next.band !== previous.band || !sameTypes(types, new Set(previous.types))) return true
  const movementThreshold = Math.max(75, Math.min(previous.rangeM * 0.25, 1_000))
  if (distanceM(next.center, previous.center) >= movementThreshold) return true
  return Math.abs(next.rangeM - previous.rangeM) >= Math.max(20, previous.rangeM * 0.25)
}

/** Converts a hot render-loop camera feed into deliberate, abortable API requests. */
export function createFeatureController(options: FeatureControllerOptions): FeatureController {
  const debounceMs = options.debounceMs ?? 260
  let enabled = true
  let types = new Set<FeatureKind>(FEATURE_KINDS)
  let latestView: FeatureViewState | null = null
  let lastRequest: FeatureQuery | null = null
  let scheduledAt: number | null = null
  let force = true
  let generation = 0
  let activeAbort: AbortController | null = null
  let disposed = false
  const setState = (phase: FeatureLoadState['phase'], message: string) => options.onState({ phase, message })
  const clear = () => { activeAbort?.abort(); activeAbort = null; generation += 1; lastRequest = null; scheduledAt = null; options.onResponse(null) }
  const request = (view: FeatureViewState) => {
    const query = queryFor(view, types)
    if (query.types.length === 0) { lastRequest = query; options.onResponse(null); setState('idle', 'No wildlife layers selected'); return }
    activeAbort?.abort()
    const abort = new AbortController()
    activeAbort = abort
    const requestGeneration = ++generation
    lastRequest = query
    setState('loading', 'Loading wildlife observations…')
    void options.api.fetchFeatures(query, abort.signal).then((response) => {
      if (disposed || !enabled || requestGeneration !== generation) return
      activeAbort = null
      options.onResponse(response)
      setState('ready', response.meta.total ? `${response.meta.total} wildlife features loaded` : 'No wildlife features in this view')
    }).catch((error: unknown) => {
      if (disposed || requestGeneration !== generation || (error instanceof DOMException && error.name === 'AbortError')) return
      activeAbort = null
      options.onResponse(null)
      setState('error', error instanceof Error ? error.message : 'Unable to load wildlife features')
    })
  }
  return {
    update(now, view) {
      if (disposed) return
      latestView = view
      if (!enabled) return
      if (force || viewChanged(view, lastRequest, types)) if (scheduledAt === null) scheduledAt = force ? now : now + debounceMs
      if (scheduledAt === null || now < scheduledAt) return
      scheduledAt = null; force = false; request(latestView)
    },
    setEnabled(nextEnabled) {
      if (disposed || enabled === nextEnabled) return
      enabled = nextEnabled
      if (!enabled) { clear(); setState('idle', 'Wildlife features are off'); return }
      force = true; scheduledAt = 0; setState('idle', 'Wildlife features ready')
    },
    setTypes(nextTypes) {
      const next = new Set(Array.from(nextTypes).filter((type): type is FeatureKind => FEATURE_KINDS.includes(type)))
      if (sameTypes(types, next)) return
      types = next; clear(); force = true; scheduledAt = 0
      if (enabled) setState('idle', 'Wildlife filters updated')
    },
    retry() { if (!disposed && enabled) { activeAbort?.abort(); activeAbort = null; force = true; scheduledAt = 0 } },
    dispose() { if (!disposed) { disposed = true; clear() } },
  }
}
