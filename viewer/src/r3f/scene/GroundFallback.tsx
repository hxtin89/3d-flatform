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
import { uniform } from 'three/tsl'
import { getEcefRoot } from '../../threejs-test/origin'
import { PHASE } from '../frame-phases'
import { frame } from '../state/frame'
import { useBootStore } from '../state/boot-store'
import { geo } from '../state/survey-frames'

/** Damp forest tone: never brighter than the imagery it stands in for. */
const GROUND_COLOR = 0x35502f
/** Metres below the ellipsoid surface — deep enough to lose the depth fight
 * against a loaded tile, shallow enough to stay under the point cloud. */
const SINK_M = 6

export function GroundFallback() {
  const framesReady = useBootStore((s) => s.framesReady)

  const { mesh, tint } = useMemo(() => {
    // Uniform rather than a constant so the tone can follow the daylight.
    const tint = uniform(new THREE.Color(GROUND_COLOR))
    const material = new MeshBasicNodeMaterial()
    // Daylight grading, same as the imagery gets, without going darker than
    // the canopy it stands behind.
    material.colorNode = tint.mul(frame.uniforms.daylightColor).mul(frame.uniforms.daylightIntensity)
    material.fog = true
    material.depthWrite = true
    const mesh = new THREE.Mesh(new THREE.CircleGeometry(1, 64), material)
    mesh.name = 'ground-fallback'
    mesh.frustumCulled = false
    mesh.renderOrder = -1
    // The matrix is built from the ENU frame every frame — a lookAt along the
    // disc's own up axis is degenerate and leaves it edge-on or NaN.
    mesh.matrixAutoUpdate = false
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
    // Big enough that its rim always sits beyond the fog's far distance, so
    // the edge is never visible — it fades into the sky like the terrain does.
    const radius = Math.max(4_000, frame.fogRange * 4)
    // Absolute ENU frame: the disc hangs under ecefRoot, whose own matrix
    // already carries the floating origin — the render-space frame would
    // apply that shift twice.
    _local.makeTranslation(frame.followEnu.x, frame.followEnu.y, geo.areaMinZ - SINK_M + geo.zOffset)
    _scale.makeScale(radius, radius, 1)
    mesh.matrix.multiplyMatrices(geo.enuFrame, _local).multiply(_scale)
    mesh.matrixWorldNeedsUpdate = true
  }, PHASE.LAYERS)

  return null
}

const _local = new THREE.Matrix4()
const _scale = new THREE.Matrix4()
