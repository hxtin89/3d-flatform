import * as THREE from 'three'
import { EXPERIENCE_CONFIG } from './config'
import type { GlobeManifest } from './manifest'

export interface WorldSurveyFrame {
  enuFrame: THREE.Matrix4
  enuInverse: THREE.Matrix4
  enuUp: THREE.Vector3
  cloudCenterEnu: THREE.Vector3
  areaMinZ: number
  areaOriginHeight: number
  areaSpan: number
  navigationClearance: number
  navigationFloorZ: number
  navigationBoundsRadius: number
  surveyBbox: readonly number[] | null
  maskBoundsEnu: { minX: number; minY: number; maxX: number; maxY: number } | null
}

export function buildWorldSurveyFrame(manifest: GlobeManifest): WorldSurveyFrame {
  const enuFrame = new THREE.Matrix4().fromArray(manifest.rootTransform)
  const enuInverse = enuFrame.clone().invert()
  const enuUp = new THREE.Vector3().setFromMatrixColumn(enuFrame, 2).normalize()
  const areaMinZ = manifest.areaBbox?.[2] ?? 0
  const areaOriginHeight = manifest.enuOriginLonLat?.[2] ?? 0
  const areaSpan = manifest.areaVerticalSpan ?? EXPERIENCE_CONFIG.navigation.fallbackCloudHeightM
  const navigationClearance = Math.max(EXPERIENCE_CONFIG.navigation.zoomStopHeightM, areaSpan)
  const navigationFloorZ = areaMinZ + navigationClearance
  const surveyBbox = manifest.surveyBbox ?? manifest.areaBbox
  const cloudCenterEnu = new THREE.Vector3(0, 0, areaMinZ + 40)
  let navigationBoundsRadius = 2500
  let maskBoundsEnu: WorldSurveyFrame['maskBoundsEnu'] = null
  if (surveyBbox && surveyBbox.length === 6) {
    const [minX, minY, , maxX, maxY] = surveyBbox
    cloudCenterEnu.set((minX + maxX) / 2, (minY + maxY) / 2, areaMinZ + 40)
    navigationBoundsRadius = Math.max(
      EXPERIENCE_CONFIG.navigation.minimumBoundsRadiusM,
      Math.hypot(maxX - minX, maxY - minY) * EXPERIENCE_CONFIG.navigation.surveyBoundsScale,
    )
    maskBoundsEnu = { minX, minY, maxX, maxY }
  }
  return {
    enuFrame, enuInverse, enuUp, cloudCenterEnu, areaMinZ, areaOriginHeight, areaSpan,
    navigationClearance, navigationFloorZ, navigationBoundsRadius, surveyBbox, maskBoundsEnu,
  }
}
