// Composition root inside <Canvas>. The frame order is fixed by the PHASE
// priorities, not by the order here; heavy children mount after the survey
// frames exist (framesReady) so nothing compiles before the cloud texture.
import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import { useBootStore } from '../state/boot-store'
import { Boot } from './Boot'
import { FloatingOrigin } from './FloatingOrigin'
import { Basemap } from './Basemap'
import { KeyboardNav } from './KeyboardNav'
import { CameraStaging } from './CameraStaging'
import { MaskFollow } from './MaskFollow'
import { Atmosphere } from './Atmosphere'
import { HudSampler } from './HudSampler'
import { Markers } from './Markers'
import { PointTiles } from './PointTiles'
import { CameraRig } from './CameraRig'
import { Environment } from './Environment'
import { Rain } from './Rain'
import { Audio } from './Audio'
import { DonationShape } from './DonationShape'
import { DoubleClick } from './DoubleClick'

function NoPointerEvents() {
  const setEvents = useThree((s) => s.setEvents)
  useEffect(() => { setEvents({ enabled: false }) }, [setEvents])
  return null
}

export function Scene() {
  const framesReady = useBootStore((s) => s.framesReady)
  return (
    <>
      <NoPointerEvents />
      <Boot />
      <FloatingOrigin>
        {framesReady && (
          <>
            <Basemap />
            <KeyboardNav />
            <CameraRig />
            <CameraStaging />
            <PointTiles />
            <MaskFollow />
            <Atmosphere />
            <Environment />
            <DonationShape />
            <Markers />
            <DoubleClick />
          </>
        )}
      </FloatingOrigin>
      {framesReady && <Rain />}
      {framesReady && <Audio />}
      <HudSampler />
    </>
  )
}
