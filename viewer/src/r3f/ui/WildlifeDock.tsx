// Compact product-facing controls for the mock FeatureApi. The master switch
// remains in Settings; these buttons merely limit the feature types returned.
import { FEATURE_KINDS, type FeatureKind } from '../wildlife-api'
import { retryWildlifeFeatures, toggleWildlifeType, useWildlifeStore } from '../wildlife-store'
import { supportsWildlifeDataset } from '../wildlife-dataset'
import { useSceneStore } from '../state/scene-store'

const LABEL: Record<FeatureKind, string> = {
  cluster: 'Clusters',
  animal: 'Animals',
  camera: 'Cameras',
  sensor: 'Sensors',
}

export function WildlifeDock() {
  const enabled = useWildlifeStore((state) => state.enabled)
  const types = useWildlifeStore((state) => state.types)
  const response = useWildlifeStore((state) => state.response)
  const load = useWildlifeStore((state) => state.load)
  const activeDataset = useSceneStore((state) => state.datasets[state.activeDatasetId]?.definition)
  const wildlifeSupported = supportsWildlifeDataset(activeDataset)
  const counts = response
    ? `Clusters ${response.clusters.length} · Animals ${response.animals.length} · Cameras ${response.cameras.length} · Sensors ${response.sensors.length}`
    : 'Clusters — · Animals — · Cameras — · Sensors —'

  if (!wildlifeSupported) return null

  return (
    <aside id="wildlifeDock" hidden={!enabled} data-state={load.phase} aria-label="Wildlife feature controls">
      <div className="wildlife-dock-head">
        <strong>Wildlife features</strong>
        <span>{load.phase === 'loading' ? 'Loading' : 'Mock API'}</span>
      </div>
      <span id="wildlifeStatus" role="status" aria-live="polite">{load.message}</span>
      <span id="wildlifeCounts">{counts}</span>
      <div className="wildlife-filters" aria-label="Wildlife feature filters">
        {FEATURE_KINDS.map((type) => {
          const on = types.includes(type)
          return (
            <button
              key={type}
              className={`wildlife-filter ${on ? 'is-on' : ''}`}
              type="button"
              aria-pressed={on}
              onClick={() => toggleWildlifeType(type)}
            >{LABEL[type]}</button>
          )
        })}
      </div>
      {load.phase === 'error' && <button id="wildlifeRetry" type="button" onClick={retryWildlifeFeatures}>Retry</button>}
    </aside>
  )
}
