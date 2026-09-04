// Double-click on the terrain dollies there (rig.flyToPoint). Attached to the
// canvas only — every overlay sits above it.
import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { EXPERIENCE_CONFIG } from '../../threejs-test/config'
import { frame } from '../state/frame'
import { isBootLoading } from '../state/boot-store'
import { sceneState } from '../state/scene-store'
import { uiState } from '../state/ui-store'
import { geo, worldToEnu } from '../state/survey-frames'
import { setAimMode } from '../state/actions'

const ray = new THREE.Raycaster()
const ndc = new THREE.Vector2()
const hit = new THREE.Vector3()

export function DoubleClick() {
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  useEffect(() => {
    const canvas = gl.domElement
    const onDblClick = (event: MouseEvent) => {
      if (isBootLoading() || frame.cameraBusy || uiState().aimMode || uiState().videoOpen || !geo.ready) return
      ndc.set((event.clientX / window.innerWidth) * 2 - 1, -(event.clientY / window.innerHeight) * 2 + 1)
      ray.setFromCamera(ndc, camera)
      if (!ray.ray.intersectPlane(geo.groundPlane, hit)) return
      const targetEnu = worldToEnu(hit)
      const endDistance = THREE.MathUtils.clamp(
        frame.cameraGroundRange * 0.38,
        EXPERIENCE_CONFIG.flight.dblClickMinRangeM,
        Math.max(frame.cameraGroundRange, EXPERIENCE_CONFIG.flight.dblClickMinRangeM),
      )
      setAimMode(false, false)
      sceneState().rig?.flyToPoint(targetEnu, endDistance)
    }
    canvas.addEventListener('dblclick', onDblClick)
    return () => canvas.removeEventListener('dblclick', onDblClick)
  }, [gl, camera])
  return null
}
