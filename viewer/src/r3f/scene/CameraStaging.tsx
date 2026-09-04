import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import type * as THREE from 'three'
import { useBootStore } from '../state/boot-store'
import { useSceneStore } from '../state/scene-store'
import { stageCamera } from '../camera/staging'

/** Camera staging under the loader; re-parks when the parcel layer appears
 * while the loader is still up. */
export function CameraStaging() {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const framesReady = useBootStore((s) => s.framesReady)
  const donation = useSceneStore((s) => s.donation)
  useEffect(() => {
    if (!framesReady) return
    const phase = useBootStore.getState().phase
    if (phase !== 'staging' && phase !== 'ready') return
    stageCamera(camera)
  }, [framesReady, donation, camera])
  return null
}
