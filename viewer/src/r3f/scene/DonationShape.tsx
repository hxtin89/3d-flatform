// Protected parcel (donation-shape-layer.ts): outline, grid, fill, walls,
// ground probe over the resident point tiles. Style/form/smoothness from
// the ui store; a style change re-frames the camera through the rig.
import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { EXPERIENCE_CONFIG } from '../../threejs-test/config'
import { createDonationShapeLayer } from '../../threejs-test/donation-shape-layer'
import { getEcefRoot } from '../../threejs-test/origin'
import { APP_PARAMS } from '../params'
import { PHASE } from '../frame-phases'
import { domTargets } from '../dom-targets'
import { frame } from '../state/frame'
import { isBootLoading, useBootStore } from '../state/boot-store'
import { sceneState, useSceneStore } from '../state/scene-store'
import { uiState, useUiStore } from '../state/ui-store'
import { geo } from '../state/survey-frames'

export function DonationShape() {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const framesReady = useBootStore((s) => s.framesReady)
  const source = useBootStore((s) => s.donationSource)
  const globe = useSceneStore((s) => s.globe)
  const activeDatasetId = useSceneStore((s) => s.activeDatasetId)
  const style = useUiStore((s) => s.donationStyle)
  const form = useUiStore((s) => s.donationForm)
  const smoothness = useUiStore((s) => s.donationSmoothness)
  const visible = useUiStore((s) => s.effective.donationShape)
  const smoothTimer = useRef(0)
  const activeHasDonationShape = Boolean(useSceneStore.getState().datasets[activeDatasetId]?.definition.hasDonationShape)

  useEffect(() => {
    const manifest = useBootStore.getState().manifest
    if (!framesReady || !source || !globe || !manifest || !domTargets.markerOverlay) return
    const ellipsoid = globe.ellipsoid
    const shapeEcef = new THREE.Vector3()
    const shapeEnu = new THREE.Vector3()
    const layer = createDonationShapeLayer({
      scene: getEcefRoot(),
      overlay: domTargets.markerOverlay,
      enuFrame: geo.enuFrame,
      zOffset: geo.zOffset,
      source,
      // lon/lat -> raw ENU; the ellipsoid returns true ECEF, so this is the one
      // genuinely absolute conversion (enuInverse, not the render variant).
      toLocal: (lon, lat, out) => {
        ellipsoid.getCartographicToPosition(THREE.MathUtils.degToRad(lat), THREE.MathUtils.degToRad(lon), 0, shapeEcef)
        shapeEnu.copy(shapeEcef).applyMatrix4(geo.enuInverse)
        out[0] = shapeEnu.x
        out[1] = shapeEnu.y
        return out
      },
      fallbackGroundZ: geo.areaMinZ,
      canopyHeightM: manifest.areaVerticalSpan ?? EXPERIENCE_CONFIG.navigation.fallbackCloudHeightM,
      probe: (centreEnu, radiusM) => {
        const sample = sceneState().stream?.sampleGroundZ(centreEnu, radiusM, geo.enuInverseRender)
        if (!sample) return null
        // sampleGroundZ reports the tiles' own ENU height; the rest of the app
        // works in the ground-snapped frame, so the lift is removed once, here.
        return { ...sample, groundZ: sample.groundZ - geo.zOffset, canopyZ: sample.canopyZ - geo.zOffset }
      },
      reducedMotion: APP_PARAMS.reducedMotion,
    })
    const ui = uiState()
    layer.setStyle(ui.donationStyle)
    layer.setForm(ui.donationForm)
    layer.setSmoothness(ui.donationSmoothness)
    layer.setVisible(ui.effective.donationShape && activeHasDonationShape)
    const info = layer.info()
    console.info(
      `[donation-shape] ${info.areaM2.toFixed(2)} m² · ${info.cellCount} cells of ${info.cellAreaM2.toFixed(3)} m² · `
      + `${info.gridSegmentCount} grid + ${info.rimSegmentCount} rim segments · lattice ${info.gridExact ? 'exact' : 'rasterised'}`,
    )
    useSceneStore.setState({ donation: layer })
    return () => {
      layer.dispose()
      useSceneStore.setState({ donation: null })
    }
  }, [framesReady, source, globe])

  useEffect(() => {
    const layer = sceneState().donation
    if (!layer) return
    layer.setStyle(style)
    // Re-frame for the new style: a flat footprint framed at the column's
    // distance is a smudge.
    if (activeHasDonationShape && !isBootLoading()) sceneState().rig?.refit()
  }, [style])

  useEffect(() => { sceneState().donation?.setForm(form) }, [form])

  useEffect(() => {
    // Rebuilding runs an SDF + marching squares — debounced, not throttled.
    window.clearTimeout(smoothTimer.current)
    smoothTimer.current = window.setTimeout(() => sceneState().donation?.setSmoothness(smoothness), 140)
    return () => window.clearTimeout(smoothTimer.current)
  }, [smoothness])

  useEffect(() => { sceneState().donation?.setVisible(visible && activeHasDonationShape) }, [visible, activeHasDonationShape])

  useFrame(() => {
    const layer = sceneState().donation
    if (!layer || !uiState().effective.donationShape || !sceneState().datasets[sceneState().activeDatasetId]?.definition.hasDonationShape) return
    layer.update(frame.now, camera)
  }, PHASE.LAYERS)

  return null
}
