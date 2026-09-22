// UI-only state for the camera-scoped wildlife prototype. Keeping this outside
// the shared scene/UI stores means the feature can be removed or replaced by a
// real HTTP adapter without expanding the application's global state surface.
import { create } from 'zustand'
import {
  FEATURE_KINDS,
  type FeatureKind,
  type FeatureResponse,
} from './wildlife-api'
import type { FeatureLoadState } from './wildlife-controller'

interface WildlifeState {
  enabled: boolean
  types: FeatureKind[]
  response: FeatureResponse | null
  load: FeatureLoadState
  retryVersion: number
}

const initialLoad: FeatureLoadState = { phase: 'idle', message: 'Wildlife features ready' }

export const useWildlifeStore = create<WildlifeState>(() => ({
  enabled: true,
  types: [...FEATURE_KINDS],
  response: null,
  load: initialLoad,
  retryVersion: 0,
}))

export function setWildlifeEnabled(enabled: boolean): void {
  useWildlifeStore.setState({ enabled })
}

export function toggleWildlifeType(type: FeatureKind): void {
  useWildlifeStore.setState((state) => {
    const selected = new Set(state.types)
    if (selected.has(type)) selected.delete(type)
    else selected.add(type)
    return { types: FEATURE_KINDS.filter((kind) => selected.has(kind)) }
  })
}

export function retryWildlifeFeatures(): void {
  useWildlifeStore.setState((state) => ({ retryVersion: state.retryVersion + 1 }))
}
