// Native 3D-Gaussian-Splatting layer. Unlike the three.js variant (Spark in a
// separate WebGL overlay without shared depth), Cesium 1.142 renders the splat
// tileset in the SAME scene as the point cloud and basemap — shared depth,
// shared camera, no second renderer. Asset produced by tools/ply-to-splat-tileset.mjs.
import * as Cesium from 'cesium'
import type { EnuFrame } from './enu'

export interface GaussianSplatState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  message: string
}

export interface GaussianSplatLayer {
  isEnabled(): boolean
  /** Loads lazily on first enable. */
  setEnabled(on: boolean): void
  /** Camera pose from the INRIA cameras.json startup entry (inside the splat). */
  seatCamera(): void
  dispose(): void
}

interface StartupCamera {
  position: [number, number, number]
  rotation: number[][]
}

export function createGaussianSplatLayer(opts: {
  /** tileset.json URL of the converted splat asset. */
  url: string
  /** cameras.json of the INRIA training run (single startup camera). */
  camerasUrl?: string
  scene: Cesium.Scene
  camera: Cesium.Camera
  enuFrame: EnuFrame
  /** ENU placement of the splat origin (Z-up model sits on this point). */
  originEnu: { x: number; y: number; z: number }
  onStateChange?: (state: GaussianSplatState) => void
}): GaussianSplatLayer {
  let tileset: Cesium.Cesium3DTileset | null = null
  let startupCamera: StartupCamera | null = null
  let enabled = false
  let loadStarted = false
  let disposed = false

  const state: GaussianSplatState = { status: 'idle', message: 'off' }
  const setState = (status: GaussianSplatState['status'], message: string) => {
    state.status = status
    state.message = message
    opts.onStateChange?.(state)
  }

  // Splat-local (INRIA Z-up) -> ENU -> ECEF. The converter's glTF node already
  // handles Z-up -> Y-up -> Cesium; the model matrix only places the origin.
  const modelMatrix = Cesium.Matrix4.multiply(
    opts.enuFrame.matrix,
    Cesium.Matrix4.fromTranslation(new Cesium.Cartesian3(
      opts.originEnu.x, opts.originEnu.y, opts.originEnu.z,
    )),
    new Cesium.Matrix4(),
  )

  async function load(): Promise<void> {
    loadStarted = true
    setState('loading', 'loading 3DGS tileset …')
    try {
      const loaded = await Cesium.Cesium3DTileset.fromUrl(opts.url)
      if (disposed) { loaded.destroy(); return }
      loaded.modelMatrix = modelMatrix
      loaded.show = enabled
      opts.scene.primitives.add(loaded)
      tileset = loaded
      if (opts.camerasUrl) {
        try {
          const response = await fetch(opts.camerasUrl)
          const cameras = await response.json()
          startupCamera = Array.isArray(cameras) ? cameras[0] : null
        } catch { /* startup pose is optional */ }
      }
      setState('ready', 'ready · native Cesium splats')
      if (enabled) seatCamera()
    } catch (error) {
      setState('error', `Error: ${(error as Error)?.message ?? error}`)
    }
  }

  function seatCamera(): void {
    // Startup camera is inside the splat sphere; fall back to a close orbit.
    const local = startupCamera?.position ?? [0, 0, 1]
    // INRIA frame is Z-up like ENU here — the converter kept world axes, so
    // local splat coordinates map 1:1 into the ENU offset around originEnu.
    const eyeEnu = new Cesium.Cartesian3(
      opts.originEnu.x + local[0],
      opts.originEnu.y + local[1],
      opts.originEnu.z + local[2],
    )
    const targetEnu = new Cesium.Cartesian3(
      opts.originEnu.x + local[0],
      opts.originEnu.y + local[1] + 10, // look along +Y (INRIA forward)
      opts.originEnu.z + local[2],
    )
    const eye = opts.enuFrame.enuToWorld(eyeEnu)
    const target = opts.enuFrame.enuToWorld(targetEnu)
    const direction = Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.subtract(target, eye, new Cesium.Cartesian3()),
      new Cesium.Cartesian3(),
    )
    opts.camera.setView({ destination: eye, orientation: { direction, up: opts.enuFrame.up } })
  }

  return {
    isEnabled: () => enabled,
    setEnabled(on) {
      enabled = on
      if (tileset) tileset.show = on
      if (on && !loadStarted) void load()
      else if (on && tileset) seatCamera()
    },
    seatCamera,
    dispose() {
      disposed = true
      if (tileset) {
        if (opts.scene.primitives.contains(tileset)) opts.scene.primitives.remove(tileset)
        else if (!tileset.isDestroyed()) tileset.destroy()
        tileset = null
      }
    },
  }
}
