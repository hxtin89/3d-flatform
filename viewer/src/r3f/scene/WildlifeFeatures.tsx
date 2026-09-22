// Camera-scoped mock wildlife data in the R3F runtime. The renderer/UI only
// know FeatureApi, so the fixture adapter can later become an HTTP adapter.
import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { EXPERIENCE_CONFIG } from '../../threejs-test/config'
import { createMockFeatureApi, type FeatureBand } from '../wildlife-api'
import { createFeatureController, type FeatureController, type FeatureViewState } from '../wildlife-controller'
import { createFeatureLayer, type FeatureLayer } from '../wildlife-layer'
import { getEcefRoot } from '../../threejs-test/origin'
import { domTargets } from '../dom-targets'
import { PHASE } from '../frame-phases'
import { frame } from '../state/frame'
import { useBootStore } from '../state/boot-store'
import { sceneState, useSceneStore } from '../state/scene-store'
import { geo } from '../state/survey-frames'
import { useWildlifeStore } from '../wildlife-store'
import { supportsWildlifeDataset } from '../wildlife-dataset'

function featureBand(band: number): FeatureBand {
  return band === 0 ? 'detail' : band === 1 ? 'explore' : 'overview'
}

export function WildlifeFeatures() {
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera
  const framesReady = useBootStore((state) => state.framesReady)
  const globe = useSceneStore((state) => state.globe)
  const activeDatasetId = useSceneStore((state) => state.activeDatasetId)
  const activeDataset = useSceneStore((state) => state.datasets[state.activeDatasetId]?.definition)
  const wildlifeSupported = supportsWildlifeDataset(activeDataset)
  const enabled = useWildlifeStore((state) => state.enabled)
  const types = useWildlifeStore((state) => state.types)
  const retryVersion = useWildlifeStore((state) => state.retryVersion)
  const controllerRef = useRef<FeatureController | null>(null)
  const layerRef = useRef<FeatureLayer | null>(null)
  const queryEcefRef = useRef(new THREE.Vector3())
  const cartographicRef = useRef({ lat: 0, lon: 0, height: 0 })
  const stableBandRef = useRef<FeatureBand | null>(null)
  const pendingBandRef = useRef<{ band: FeatureBand; since: number } | null>(null)

  useEffect(() => {
    if (!wildlifeSupported || !framesReady || !globe || !geo.ready || !domTargets.markerOverlay) {
      useWildlifeStore.setState({ response: null, load: initialLoadState() })
      return
    }
    const featureEcef = new THREE.Vector3()
    const layer = createFeatureLayer({
      scene: getEcefRoot(),
      overlay: domTargets.markerOverlay,
      enuFrame: geo.enuFrame,
      zOffset: geo.zOffset,
      toEnu: (longitude, latitude, altitudeM, target) => {
        globe.ellipsoid.getCartographicToPosition(
          THREE.MathUtils.degToRad(latitude),
          THREE.MathUtils.degToRad(longitude),
          altitudeM,
          featureEcef,
        )
        return target.copy(featureEcef).applyMatrix4(geo.enuInverse)
      },
      onFlyTo: (_feature, targetEnu) => {
        sceneState().rig?.flyToPoint(targetEnu, EXPERIENCE_CONFIG.flight.markerApproachDistanceM)
      },
    })
    const controller = createFeatureController({
      api: createMockFeatureApi(),
      onResponse: (response) => {
        layer.setResponse(response)
        useWildlifeStore.setState({ response })
      },
      onState: (load) => useWildlifeStore.setState({ load }),
    })
    controllerRef.current = controller
    layerRef.current = layer
    controller.setTypes(useWildlifeStore.getState().types)
    layer.setVisible(useWildlifeStore.getState().enabled)
    if (!useWildlifeStore.getState().enabled) controller.setEnabled(false)
    else controller.retry()

    return () => {
      controller.dispose()
      layer.dispose()
      if (controllerRef.current === controller) controllerRef.current = null
      if (layerRef.current === layer) layerRef.current = null
      useWildlifeStore.setState({ response: null, load: initialLoadState() })
    }
  // Rebuild on dataset change: its ENU root is tied to that survey's manifest.
  }, [framesReady, globe, activeDatasetId, wildlifeSupported])

  useEffect(() => { controllerRef.current?.setTypes(types) }, [types])

  useEffect(() => {
    layerRef.current?.setVisible(enabled)
    controllerRef.current?.setEnabled(enabled)
  }, [enabled])

  useEffect(() => {
    if (retryVersion > 0) controllerRef.current?.retry()
  }, [retryVersion])

  useFrame(() => {
    const controller = controllerRef.current
    const layer = layerRef.current
    if (!wildlifeSupported || !controller || !layer || !enabled || !geo.ready) return
    const centre = frame.followInit ? frame.followEnu : geo.cloudCenterEnu
    const queryEcef = queryEcefRef.current.set(centre.x, centre.y, geo.areaMinZ).applyMatrix4(geo.enuFrame)
    const cartographic = globe?.ellipsoid.getPositionToCartographic(queryEcef, cartographicRef.current)
    if (!cartographic || !Number.isFinite(cartographic.lon) || !Number.isFinite(cartographic.lat)) return
    const rawBand = featureBand(frame.band)
    if (stableBandRef.current === null) stableBandRef.current = rawBand
    else if (rawBand === stableBandRef.current) pendingBandRef.current = null
    else if (pendingBandRef.current?.band !== rawBand) pendingBandRef.current = { band: rawBand, since: frame.now }
    else if (frame.now - pendingBandRef.current.since >= 350) {
      stableBandRef.current = rawBand
      pendingBandRef.current = null
    }
    const view: FeatureViewState = {
      center: {
        longitude: THREE.MathUtils.radToDeg(cartographic.lon),
        latitude: THREE.MathUtils.radToDeg(cartographic.lat),
      },
      rangeM: Number.isFinite(frame.cameraGroundRange)
        ? Math.max(frame.cameraGroundRange, 1)
        : EXPERIENCE_CONFIG.atmosphere.fallbackRangeM,
      band: stableBandRef.current,
    }
    controller.update(frame.now, view)
    layer.update(camera, frame.cameraGroundRange)
  }, PHASE.LAYERS)

  return null
}

function initialLoadState() {
  return { phase: 'idle' as const, message: 'Wildlife features ready' }
}
