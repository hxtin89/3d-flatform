import type { CloudUniforms } from '../../threejs-test/point-cloud'
import { EXPERIENCE_CONFIG } from '../../threejs-test/config'
import { renderToEcefMatrix } from '../../threejs-test/origin'
import type { WorldDatasetId } from '../world-datasets'
import { frame } from './frame'
import { sceneState } from './scene-store'
import { uiState } from './ui-store'

const SHARED_UNIFORMS = [
  'maskRadius', 'pointSize', 'daylightColor', 'daylightIntensity', 'sunDirectionEnu',
  'cloudShadowOffset', 'cloudShadowStrength', 'cloudShadowScale', 'goldenFactor',
  'warmRimColor', 'cutoffDistance', 'fadeDistance',
] as const

function copyUniform(target: any, source: any): void {
  if (target?.value?.copy && source?.value) target.value.copy(source.value)
  else if (target) target.value = source?.value
}

/** Copy global visuals but retain the runtime's local ENU and height frame. */
export function syncDatasetUniforms(uniforms: CloudUniforms, id: WorldDatasetId): void {
  const runtime = sceneState().datasets[id]
  if (!runtime?.frame) return
  for (const key of SHARED_UNIFORMS) copyUniform(uniforms[key], frame.uniforms[key])
  renderToEcefMatrix(runtime.frame.enuInverse, uniforms.enuInverse.value)
  uniforms.canopyBaseZ.value = runtime.frame.areaMinZ + runtime.frame.zOffset + 8
  uniforms.canopyTopZ.value = runtime.frame.areaMinZ + runtime.frame.zOffset + runtime.frame.canopyHeightM
  uniforms.cloudDeckHeight.value = runtime.frame.areaMinZ + runtime.frame.zOffset + EXPERIENCE_CONFIG.pointLighting.cloudDeckHeightM
  if (id === sceneState().activeDatasetId) {
    copyUniform(uniforms.maskCenter, frame.uniforms.maskCenter)
    uniforms.maskMode.value = frame.uniforms.maskMode.value
    uniforms.vignetteStrength.value = frame.uniforms.vignetteStrength.value
  } else {
    uniforms.maskMode.value = 0
    uniforms.vignetteStrength.value = 0
  }
}

export function applyDatasetHeightOffset(id: WorldDatasetId): void {
  const runtime = sceneState().datasets[id]
  if (!runtime?.stream || !runtime.frame) return
  runtime.stream.group.position.copy(runtime.frame.enuUp)
    .multiplyScalar(uiState().heightOffset ? runtime.frame.zOffset : 0)
}
