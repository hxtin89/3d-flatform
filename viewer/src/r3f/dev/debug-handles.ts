// window.__wild / __three / __bench for console diagnosis (port of main.ts).
import type * as THREE from 'three'
import { ecefToRender, originStats, renderToEcef } from '../../threejs-test/origin'
import { updateOrigin } from '../state/survey-frames'
import { frame } from '../state/frame'
import { sceneState } from '../state/scene-store'
import { geo } from '../state/survey-frames'
import { openFieldVideo } from '../ui/video-modal-actions'

export function installDebugHandles(renderer: any, scene: THREE.Scene, camera: THREE.Camera): () => void {
  const w = window as any
  w.__wild = {
    camera,
    get stream() { return sceneState().stream },
    get source() { return sceneState().activeSource },
    get flight() { return frame.cameraBusy },
    get sse() { return frame.sseAuto },
    get range() { return frame.rangeDebug },
    get origin() { return originStats() },
    get geo() { return geo },
    get rig() { return sceneState().rig },
    toEcef(value: THREE.Vector3) { return renderToEcef(value) },
    /** Diagnostics: open the field film without hunting for the chip. */
    openVideo: openFieldVideo,
    toRender(value: THREE.Vector3) { return ecefToRender(value) },
    /** Diagnostics: put the camera at an absolute ECEF pose (perf comparisons). */
    setPoseEcef(pose: { p: [number, number, number]; q: [number, number, number, number] }) {
      sceneState().rig?.takeover()
      const p = ecefToRender(new (camera.position.constructor as any)(...pose.p))
      camera.position.copy(p)
      camera.quaternion.set(pose.q[0], pose.q[1], pose.q[2], pose.q[3])
      camera.updateMatrixWorld()
      updateOrigin(camera, true)
    },
  }
  w.__three = {
    renderer, scene, camera, uniforms: frame.uniforms,
    get globe() { return sceneState().globe },
    get stream() { return sceneState().stream },
    get environmentLayer() { return sceneState().environment },
    get donationShapeLayer() { return sceneState().donation },
    get markerLayer() { return sceneState().markers },
    get renderOptions() { return sceneState().renderOptions },
  }
  w.__bench = async (frames = 60) => {
    const started = performance.now()
    for (let index = 0; index < frames; index++) await renderer.renderAsync(scene, camera)
    const ms = (performance.now() - started) / frames
    return {
      frames,
      msPerFrame: Number(ms.toFixed(2)),
      fps: Number((1000 / ms).toFixed(1)),
      density: frame.lastStreamStats?.density,
      visiblePoints: frame.lastStreamStats?.points,
      sse: frame.sseAuto,
    }
  }
  return () => { delete w.__wild; delete w.__three; delete w.__bench }
}
