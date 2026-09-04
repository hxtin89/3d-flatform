// Floating origin: everything ECEF-anchored hangs under ecefRoot, whose
// matrix is T(-origin). The camera is the one render-space object R3F owns,
// so it is shifted here; layers register their own listeners.
import { useLayoutEffect, useMemo, type ReactNode } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { getEcefRoot, setOriginEnabled } from '../../threejs-test/origin'
import { APP_PARAMS } from '../params'
import { PHASE } from '../frame-phases'
import { frame } from '../state/frame'
import { updateOrigin } from '../state/survey-frames'
import { useOnRebase } from '../hooks/useOnRebase'

export function FloatingOrigin({ children }: { children?: ReactNode }) {
  const camera = useThree((s) => s.camera)
  const ecefRoot = useMemo(() => getEcefRoot(), [])

  useLayoutEffect(() => { setOriginEnabled(!APP_PARAMS.noOrigin) }, [])

  useOnRebase((delta) => {
    camera.position.add(delta)
    camera.updateMatrixWorld()
  }, [camera])

  // First thing in the frame: one origin for every consumer below.
  useFrame(() => {
    frame.now = performance.now()
    frame.fps.tick(frame.now)
    updateOrigin(camera)
  }, PHASE.ORIGIN)

  return <primitive object={ecefRoot}>{children}</primitive>
}
