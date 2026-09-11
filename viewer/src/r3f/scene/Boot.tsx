// Boot sequence inside the Canvas: the renderer is initialised (async gl),
// so this is renderer → backend badge → cloud noise texture (must precede
// the first tile material) → manifest → survey frames → point source →
// donation source → 'staging'. Port of the first half of main() in main.ts.
import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import { EXPERIENCE_CONFIG } from '../../threejs-test/config'
import { createCloudNoiseTexture } from '../../threejs-test/cloud-noise'
import { classifyTier } from '../../threejs-test/environment-layer'
import { fetchGlobeManifest } from '../../threejs-test/manifest'
import { createUniforms, setCloudShadowTexture } from '../../threejs-test/point-cloud'
import { createPointSource } from '../../threejs-test/point-source'
import { APP_PARAMS, donationShapePromise } from '../params'
import { isWebGPUBackend } from '../canvas/createRenderer'
import { DAYLIGHT_SKY } from '../state/frame'
import { setLoadProgress, useBootStore } from '../state/boot-store'
import { useSceneStore, type DatasetRuntime } from '../state/scene-store'
import { useUiStore } from '../state/ui-store'
import { activateSurveyFrame, createSurveyFrame } from '../state/survey-frames'
import { installDebugHandles } from '../dev/debug-handles'

function describeCoordinates(polygons: { outer: Array<readonly [number, number]> }[]): string | null {
  let lon = 0
  let lat = 0
  let count = 0
  for (const polygon of polygons) for (const [x, y] of polygon.outer) { lon += x; lat += y; count += 1 }
  if (!count) return null
  lon /= count
  lat /= count
  return `${Math.abs(lat).toFixed(5)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(5)}° ${lon >= 0 ? 'O' : 'W'}`
}

function installGraphicsRecovery(renderer: any, canvas: HTMLCanvasElement): () => void {
  const stop = (message: string) => {
    useUiStore.setState({ frameloop: 'never', hudOpen: true, statusLine: message })
    useBootStore.getState().fail(message)
  }
  const onLost = (event: Event) => { event.preventDefault(); stop('Graphics memory exhausted · reload the page') }
  const onRestored = () => location.reload()
  canvas.addEventListener('webglcontextlost', onLost)
  canvas.addEventListener('webglcontextrestored', onRestored)
  const lost = renderer?.backend?.device?.lost
  if (lost && typeof lost.then === 'function') {
    void lost.then((info: any) => {
      const reason = info?.reason && info.reason !== 'unknown' ? ` (${info.reason})` : ''
      stop(`GPU device lost${reason} · reload the page`)
    })
  }
  return () => {
    canvas.removeEventListener('webglcontextlost', onLost)
    canvas.removeEventListener('webglcontextrestored', onRestored)
  }
}

export function Boot() {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera)

  useEffect(() => {
    let cancelled = false
    const boot = useBootStore.getState()
    if (!APP_PARAMS.baseUrl) { boot.fail('CloudFront-Domain fehlt in der Umgebung.'); return }
    if (!APP_PARAMS.maptilerKey) { boot.fail('MapTiler-Schlüssel fehlt in der Umgebung.'); return }

    const renderer: any = gl
    const isWebGPU = isWebGPUBackend(renderer)
    useBootStore.setState({ isWebGPU, phase: 'graphics' })
    useUiStore.setState({ backendLabel: isWebGPU ? 'WebGPU' : 'WebGL2', statusLine: 'Loading adaptive point-cloud tree…' })
    setLoadProgress(0.16, 'Grafiksystem bereit. Verbinde Feldstation …')
    try {
      const backend = renderer.backend
      const adapterInfo = backend?.adapter?.info ?? backend?.device?.adapterInfo
      console.info(`[graphics] backend=${isWebGPU ? 'WebGPU' : 'WebGL2'}`
        + (adapterInfo ? ` adapter=${adapterInfo.vendor ?? '?'} ${adapterInfo.architecture ?? ''} ${adapterInfo.description ?? ''}`.trimEnd() : ''))
    } catch { /* best-effort diagnostics */ }
    const removeRecovery = installGraphicsRecovery(renderer, renderer.domElement)
    renderer.setClearColor(DAYLIGHT_SKY, 1)
    const removeDebug = installDebugHandles(renderer, scene, camera)

    // One shared density volume drives the volumetric clouds and the canopy
    // shadows in the point material — registered before any tile compiles.
    const cloudNoiseTexture = createCloudNoiseTexture(
      classifyTier(isWebGPU) === 'strong'
        ? EXPERIENCE_CONFIG.clouds.textureSizeStrong
        : EXPERIENCE_CONFIG.clouds.textureSize,
    )
    setCloudShadowTexture(cloudNoiseTexture)
    useBootStore.setState({ cloudNoiseTexture })

    ;(async () => {
      setLoadProgress(0.22, 'Lade Fluggebiet und Koordinaten …')
      useBootStore.setState({ phase: 'manifest' })
      const definitions = APP_PARAMS.worldDatasets
      const loading = Object.fromEntries(definitions.map((definition) => [definition.id, {
        definition,
        status: 'loading',
        error: null,
        manifest: null,
        frame: null,
        uniforms: null,
        pointSource: null,
        activeSource: null,
        stream: null,
        stats: null,
        appliedHighPrecision: null,
      } satisfies DatasetRuntime]))
      useSceneStore.setState({ datasets: loading, activeDatasetId: APP_PARAMS.initialDatasetId })
      const loadRuntime = async (definition: typeof definitions[number]) => {
        const manifest = await fetchGlobeManifest(APP_PARAMS.baseUrl, definition.logicalDataset)
        const pointSource = createPointSource({
          baseUrl: APP_PARAMS.baseUrl,
          manifest,
          basePack: APP_PARAMS.pointTree,
          onChange: () => useUiStore.setState((s) => ({ packsVersion: s.packsVersion + 1 })),
        })
        for (const [band, packId] of APP_PARAMS.zoomAssignments) pointSource.setAssignment(band, packId)
        return {
          definition,
          status: 'ready' as const,
          error: null,
          manifest,
          frame: createSurveyFrame(manifest),
          uniforms: createUniforms(0),
          pointSource,
          activeSource: pointSource.base(),
          stream: null,
          stats: null,
          appliedHighPrecision: null,
        } satisfies DatasetRuntime
      }
      const promises = definitions.map((definition) => loadRuntime(definition))
      const initial = await promises[0]
      if (cancelled) return
      setLoadProgress(0.28, 'Fluggebiet lokalisiert. Baue Szene …')
      activateSurveyFrame(initial.frame!)
      useSceneStore.setState((state) => ({
        datasets: { ...state.datasets, [initial.definition.id]: initial },
        pointSource: initial.pointSource,
        activeSource: initial.activeSource,
        stream: null,
        swapReason: 'boot',
      }))

      // Other sites start concurrently but are deliberately not part of the
      // loader's critical path; a failed remote site remains selectable only
      // after its manifest succeeds.
      promises.slice(1).forEach((promise, index) => {
        const definition = definitions[index + 1]
        void promise.then((runtime) => {
          if (cancelled) return
          useSceneStore.setState((state) => ({
            datasets: { ...state.datasets, [runtime.definition.id]: runtime },
          }))
        }).catch((reason) => {
          if (cancelled) return
          const error = reason instanceof Error ? reason.message : String(reason)
          console.warn(`[world] ${definition.label} unavailable: ${error}`)
          useSceneStore.setState((state) => ({
            datasets: {
              ...state.datasets,
              [definition.id]: { ...state.datasets[definition.id]!, status: 'failed', error },
            },
          }))
        })
      })

      const donationSource = await donationShapePromise
      if (cancelled) return
      useBootStore.setState({
        manifest: initial.manifest,
        framesReady: true,
        donationSource,
        donationCoordinates: donationSource ? describeCoordinates(donationSource.polygons) : null,
        phase: 'staging',
      })
      useUiStore.setState({ statusLine: 'Adaptive streaming · loading tiles…' })
      setLoadProgress(0.35, 'Lade erste Kronendach-Punktwolken …')
    })().catch((error: any) => {
      console.error('[r3f] boot failed', error)
      useBootStore.getState().fail(`Laden fehlgeschlagen: ${error?.message ?? error}`)
    })

    return () => {
      cancelled = true
      removeRecovery()
      removeDebug()
      cloudNoiseTexture.dispose()
    }
  }, [gl, scene, camera])

  return null
}
