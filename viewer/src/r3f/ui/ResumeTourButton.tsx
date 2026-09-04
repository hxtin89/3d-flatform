// "Tour fortsetzen" once the user took the camera; replay with ?scrub=1.
import { APP_PARAMS } from '../params'
import { sceneState } from '../state/scene-store'
import { useUiStore } from '../state/ui-store'
import { useBootStore } from '../state/boot-store'

export function ResumeTourButton() {
  const rigMode = useUiStore((s) => s.rigMode)
  const entered = useBootStore((s) => s.phase === 'entered')
  if (!entered || !APP_PARAMS.storyEnabled) return null
  const showResume = rigMode === 'user'
  return (
    <div id="tourControls">
      {showResume && (
        <button className="tour-button" type="button" onClick={() => sceneState().rig?.resume()}>
          ↻ Tour fortsetzen
        </button>
      )}
      {APP_PARAMS.scrubber && (
        <button className="tour-button" type="button" onClick={() => sceneState().rig?.replay()}>
          ⟲ Replay
        </button>
      )}
    </div>
  )
}
