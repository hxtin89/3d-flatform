import { useEffect } from 'react'
import { CanvasRoot } from './canvas/CanvasRoot'
import { setLoadProgress } from './state/boot-store'
import { Scene } from './scene/Scene'
import { Loader } from './ui/Loader'
import { Hud } from './ui/Hud'
import { Chips } from './ui/Chips'
import { KeyboardGuide } from './ui/KeyboardGuide'
import { BodyClasses } from './ui/BodyClasses'
import { ResumeTourButton } from './ui/ResumeTourButton'
import { TimeDock } from './ui/TimeDock'
import { VideoModal } from './ui/VideoModal'
import { SettingsPanel } from './ui/SettingsPanel'
import { SplatOverlay } from './ui/SplatOverlay'
import { CompareBoot } from './ui/CompareBoot'
import { APP_PARAMS } from './params'
import { useUiStore } from './state/ui-store'
import './state/render-options-bridge'
import {
  AimReticle, Attribution, Captions, InteractionStatus, MarkerOverlay, SplatHint, Vignette,
} from './ui/Overlays'

export function App() {
  const videoOpen = useUiStore((s) => s.videoOpen)
  useEffect(() => { setLoadProgress(0.06, 'Initialisiere GPU und Kartensystem …') }, [])

  return (
    <>
      <div id="appRoot" inert={videoOpen || undefined}>
      <CanvasRoot>
        <Scene />
      </CanvasRoot>
      <Vignette />
      <MarkerOverlay />
      <Captions />
      <SplatHint />
      <InteractionStatus />
      <AimReticle />
      <Loader />
      <Chips />
      <KeyboardGuide />
      <Hud />
      {APP_PARAMS.panelEnabled && <SettingsPanel />}
      <TimeDock />
      <Attribution />
      <ResumeTourButton />
      </div>
      <VideoModal />
      <SplatOverlay />
      <CompareBoot />
      <BodyClasses />
    </>
  )
}
