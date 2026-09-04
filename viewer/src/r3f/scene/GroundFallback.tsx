// A plain disc under the imagery, in the daylight ground tone.
//
// Satellite tiles arrive one by one and can fail outright (a rate-limited or
// restricted MapTiler key answers 403 for every tile). Without something
// behind them the sky's clear colour shows through each missing tile as a
// bright blue rectangle in the middle of the forest. The disc sits slightly
// below the ellipsoid surface, so it is only ever visible through those holes,
// and it takes the same daylight tint as the rest of the scene.
import { useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import { color, uniform } from 'three/tsl'
import { getEcefRoot } from '../../threejs-test/origin'
import { PHASE } from '../frame-phases'
import { frame } from '../state/frame'
import { useBootStore } from '../state/boot-store'
import { enuToWorld, geo } from '../state/survey-frames'

/** Damp forest tone: never brighter than the imagery it stands in for. */
const GROUND_COLOR = 0x2f4a2b
/** Metres below the ellipsoid surface — deep enough to lose the depth fight
 * against a loaded tile, shallow enough to stay under the point cloud. */
const SINK_M = 6

export function GroundFallback() {
  const framesReady = useBootStore((s) => s.framesReady)

  const { mesh, tint } = useMemo(() => {
    const tint = uniform(new THREE.Color(GROUND_COLOR))
    const material = new MeshBasicNodeMaterial()
    material.colorNode = color(GROUND_COLOR).mul(frame.uniforms.daylightIntensity).mul(tint.mul(1 / 0.18))
    material.fog = true
    material.depthWrite = true
    const mesh = new THREE.Mesh(new THREE.CircleGeometry(1, 64), material)
    mesh.name = 'ground-fallback'
    mesh.frustumCulled = false
    mesh.renderOrder = -1
    return { mesh, tint }
  }, [])

  useEffect(() => {
    if (!framesReady) return
    const root = getEcefRoot()
    root.add(mesh)
    return () => {
      root.remove(mesh)
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
  }, [framesReady, mesh])

  useFrame(() => {
    if (!geo.ready) return
    // Follow the camera's ground point so a modest disc covers the view, and
    // scale with the fog range so its rim is always inside the haze.
    const radius = Math.max(2_000, frame.fogRange * 1.6)
    mesh.scale.setScalar(radius)
    _centre.set(frame.followEnu.x, frame.followEnu.y, geo.areaMinZ - SINK_M)
    enuToWorld(_centre, _world)
    mesh.position.copy(_world)
    mesh.up.copy(geo.enuUp)
    mesh.lookAt(_world.clone().addScaledVector(geo.enuUp, 1000))
    mesh.updateMatrixWorld()
    tint.value.copy(frame.daylight?.daylightColor ?? _white)
  }, PHASE.LAYERS)

  return null
}

const _centre = new THREE.Vector3()
const _world = new THREE.Vector3()
const _white = new THREE.Color(0xffffff)
