// Development / comparison panel (?panel=1). Every row changes render
// behaviour; the product surface never shows it.
import { useEffect, useMemo, useState } from 'react'
import { EXPERIENCE_CONFIG } from '../../threejs-test/config'
import { AUTO, ZOOM_BAND_ROWS } from '../../threejs-test/point-source'
import { RENDER_OPTION_ROWS } from '../../threejs-test/render-options'
import type { DonationShapeForm, DonationShapeStyle } from '../../threejs-test/donation-shape-data'
import { APP_PARAMS } from '../params'
import { frame } from '../state/frame'
import { sceneState, useSceneStore } from '../state/scene-store'
import { useUiStore } from '../state/ui-store'
import { setMaskMode, setPointSizeScale } from '../state/actions'
import { setCompareMode, setOption } from '../state/render-options-bridge'
import { setRainCycleEnabled } from '../scene/Rain'
import type { WorldDatasetId } from '../world-datasets'

const fmtInt = (value: number) => Math.round(value).toLocaleString('en-US')
const STYLES: DonationShapeStyle[] = ['column', 'xray', 'canopy', 'wall']
const STYLE_LABEL: Record<DonationShapeStyle, string> = { column: 'Column', xray: 'X-ray', canopy: 'Canopy', wall: 'Wall' }
const FORMS: DonationShapeForm[] = ['exact', 'organic']

function ZoomRows() {
  const zoom = useUiStore((s) => s.zoom)
  const packsVersion = useUiStore((s) => s.packsVersion)
  const pointSource = useSceneStore((s) => s.pointSource)
  const packs = useMemo(() => pointSource?.packs() ?? [], [pointSource, packsVersion])
  if (!pointSource) return <div id="zoomPackRows"><span className="weather-note">Reading available density packs…</span></div>
  return (
    <div id="zoomPackRows">
      {ZOOM_BAND_ROWS.map((rowDef) => (
        <div className={`row zoom-row ${zoom?.band === rowDef.band ? 'is-active' : ''}`} key={rowDef.band}>
          <label className="h" htmlFor={`zoomPack-${rowDef.band}`}>{rowDef.label}</label>
          <select
            id={`zoomPack-${rowDef.band}`}
            value={pointSource.assignment(rowDef.band)}
            onChange={(event) => {
              pointSource.setAssignment(rowDef.band, event.target.value)
              frame.userSwapRequested = true
              useUiStore.setState((s) => ({ packsVersion: s.packsVersion + 1 }))
            }}
          >
            <option value={AUTO}>Auto · session tree</option>
            {packs.map((pack) => (
              <option key={pack.id} value={pack.id} disabled={!pack.available}>
                {pack.available ? pack.label : `${pack.label} — ${pack.status}`}
              </option>
            ))}
          </select>
          <span className="weather-note">{rowDef.note}</span>
        </div>
      ))}
    </div>
  )
}

export function SettingsPanel() {
  const datasets = useSceneStore((s) => s.datasets)
  const activeDatasetId = useSceneStore((s) => s.activeDatasetId)
  const [selectedDatasetId, setSelectedDatasetId] = useState<WorldDatasetId>(activeDatasetId)
  const zoom = useUiStore((s) => s.zoom)
  const pointSizeScale = useUiStore((s) => s.pointSizeScale)
  const pointSizePx = useUiStore((s) => s.pointSizePx)
  const highPrecision = useUiStore((s) => s.highPrecision)
  const heightOffset = useUiStore((s) => s.heightOffset)
  const splatSolo = useUiStore((s) => s.splatSolo)
  const splatMessage = useUiStore((s) => s.splatMessage)
  const donationStyle = useUiStore((s) => s.donationStyle)
  const donationForm = useUiStore((s) => s.donationForm)
  const donationSmoothness = useUiStore((s) => s.donationSmoothness)
  const maskMode = useUiStore((s) => s.maskMode)
  const rainCycleEnabled = useUiStore((s) => s.rainCycleEnabled)
  const rainRequested = useUiStore((s) => s.rainRequested)
  const rainVisualActive = useUiStore((s) => s.rainVisualActive)
  const cloudState = useUiStore((s) => s.cloudState)
  const compareMode = useUiStore((s) => s.compareMode)
  const requested = useUiStore((s) => s.requested)
  const selectedRuntime = datasets[selectedDatasetId]
  const activeRuntime = datasets[activeDatasetId]
  const donationControlsEnabled = Boolean(activeRuntime?.definition.hasDonationShape)

  useEffect(() => { setSelectedDatasetId(activeDatasetId) }, [activeDatasetId])

  const rainLabel = !rainCycleEnabled ? '☂ Rain cycle · Off' : !rainRequested ? '☂ Rain cycle · Dry' : rainVisualActive ? '☂ Rain · Active' : '☂ Rain · Near view'
  const cloudActive = cloudState ? cloudState.mode !== 'off' : false
  const cloudLabel = cloudState ? (cloudState.mode === 'volume' ? 'Volumetric' : cloudState.mode === 'soft' ? 'Soft volumes' : 'Off') : 'Detecting…'

  return (
    <div id="panel" className={`card ${compareMode ? 'compare-mode' : ''} ${splatSolo ? 'splat-solo' : ''}`.trim()}>
      <button className="close" data-close="panel" onClick={() => useUiStore.setState({ panelOpen: false })}>×</button>
      <p className="opt-head">Location</p>
      <div className="row" id="locationRow">
        <label className="h" htmlFor="worldLocation">Point-cloud site</label>
        <select id="worldLocation" value={selectedDatasetId} onChange={(event) => setSelectedDatasetId(event.target.value as WorldDatasetId)}>
          {Object.values(datasets).map((runtime) => runtime && (
            <option key={runtime.definition.id} value={runtime.definition.id} disabled={runtime.status !== 'ready'}>
              {runtime.definition.label}{runtime.status === 'ready' ? '' : ` — ${runtime.status}`}
            </option>
          ))}
        </select>
        <button
          className="act primary"
          id="flyToLocation"
          disabled={selectedRuntime?.status !== 'ready' || selectedDatasetId === activeDatasetId}
          onClick={() => useSceneStore.setState({ activeDatasetId: selectedDatasetId })}
        >✈ Fly</button>
        <span className="weather-note" id="locationStatus">{activeRuntime ? `Active · ${activeRuntime.definition.label}` : 'Loading locations…'}</span>
      </div>
      <p className="opt-head">Zoom levels · point source</p>
      <div className="row zoom-row" id="zoomStatusRow">
        <label className="h">Current zoom level</label>
        <div className="stats">
          <span className="k">Level</span><span className="v" id="zoomBandValue">{zoom?.bandLabel ?? '—'}</span>
          <span className="k">LOD range</span><span className="v" id="zoomRangeValue">{zoom && Number.isFinite(zoom.range) ? `${fmtInt(zoom.range)} m` : '—'}</span>
          <span className="k">SSE</span><span className="v" id="zoomSseValue">{zoom ? zoom.sse.toFixed(0) : '—'}</span>
        </div>
        <span className="weather-note" id="zoomDatasetValue" title={zoom?.sourcePath}>{zoom?.sourceLabel ?? 'Reading area manifest…'}</span>
      </div>
      <ZoomRows />
      <p className="opt-head">View</p>
      <button className="act primary" id="flyTo" onClick={() => sceneState().rig?.refit()}>✈ Fly to Point Cloud</button>
      <div className="row">
        <button className="act" id="variantSwitch" type="button" aria-describedby="variantNote" onClick={() => { location.href = './cesium-test.html' + location.search }}>⇄ Switch to Cesium variant</button>
        <span className="weather-note" id="variantNote">Same data and features on CesiumJS — for the side-by-side performance comparison. Keeps URL parameters</span>
      </div>
      <div className="row">
        <label className="h">Point Size · <span className="val" id="sizev">{`${pointSizeScale.toFixed(1)}× · ${pointSizePx.toFixed(1)}px`}</span></label>
        <input type="range" id="size" min={0.5} max={3} step={0.1} value={pointSizeScale} onChange={(event) => setPointSizeScale(Number(event.target.value))} />
      </div>
      <div className="row">
        <label className="h" htmlFor="precisionToggle">Matrix precision</label>
        <button className={`act ${highPrecision ? 'on' : ''}`} id="precisionToggle" type="button" aria-pressed={highPrecision} aria-describedby="precisionNote" onClick={() => useUiStore.setState({ highPrecision: !highPrecision })}>
          ◈ Precision · {highPrecision ? 'High' : 'Medium'}
        </button>
        <span className="weather-note" id="precisionNote">Point cloud only. Off = model-view in the shader (float32); tiles jitter on ECEF rounding. Automatically off during loader and flight</span>
      </div>
      <div className="row">
        <label className="h" htmlFor="liftToggle">Height offset</label>
        <button className={`act ${heightOffset ? 'on' : ''}`} id="liftToggle" type="button" aria-pressed={heightOffset} aria-describedby="liftNote" onClick={() => useUiStore.setState({ heightOffset: !heightOffset })}>
          ⇅ Offset · {heightOffset ? 'On' : 'Off'}
        </button>
        <span className="weather-note" id="liftNote">Diagnostics only: off lowers the cloud, the height uniforms do not follow</span>
      </div>
      <div className="row splat-row">
        <label className="h" htmlFor="gaussianToggle">3DGS test</label>
        <button className={`act ${splatSolo ? 'on' : ''}`} id="gaussianToggle" type="button" aria-pressed={splatSolo} aria-describedby="gaussianNote" onClick={() => {
          if (!APP_PARAMS.gaussianSplatUrl) { useUiStore.setState({ splatMessage: 'CloudFront domain missing — 3DGS test unavailable' }); return }
          useUiStore.setState({ splatSolo: !splatSolo, frameloop: !splatSolo ? 'never' : 'always' })
        }}>
          ✦ 3DGS · {splatSolo ? 'On' : 'Off'}
        </button>
        <span className="weather-note" id="gaussianNote">{splatMessage || 'Feasibility test: Gaussian-splatting model (Spark) in its own WebGL overlay, 61 MB — click to look around'}</span>
      </div>
      <div className="row">
        <label className="h">Shape style</label>
        <div className="seg" id="shapeStyleSeg">
          {STYLES.map((style) => (
            <button key={style} data-shape-style={style} disabled={!donationControlsEnabled} className={donationStyle === style ? 'on' : ''} onClick={() => useUiStore.setState({ donationStyle: style })}>{STYLE_LABEL[style]}</button>
          ))}
        </div>
        <span className="weather-note" id="shapeStyleNote">Protected parcel from GeoJSON. Column = light column through the canopy, X-ray = footprint shines through the trees, Canopy = plate on the crowns, Wall = low glowing wall. Switching re-frames the camera</span>
      </div>
      <div className="row">
        <label className="h">Shape form</label>
        <div className="seg" id="shapeFormSeg">
          {FORMS.map((form) => (
            <button key={form} data-shape-form={form} disabled={!donationControlsEnabled} className={donationForm === form ? 'on' : ''} onClick={() => useUiStore.setState({ donationForm: form })}>{form === 'exact' ? 'Exact' : 'Organic'}</button>
          ))}
        </div>
        <span className="weather-note">Exact = the surveyed staircase with every 1 m² cell line — the authoritative boundary. Organic = rounded, area-preserving, a stylised reading of the same parcel</span>
      </div>
      <div className="row" id="shapeSmoothRow" hidden={donationForm !== 'organic'}>
        <label className="h" htmlFor="shapeSmooth">Rounding · <span className="val" id="shapeSmoothv">{donationSmoothness.toFixed(2)}</span></label>
        <input type="range" id="shapeSmooth" min={0} max={1} step={0.05} disabled={!donationControlsEnabled} value={donationSmoothness} onChange={(event) => useUiStore.setState({ donationSmoothness: Number(event.target.value) })} />
        <span className="weather-note">Radius of the disc the outline is opened and closed with, 0 = untouched staircase</span>
      </div>
      <div className="row">
        <label className="h">Mask</label>
        <div className="seg" id="maskSeg">
          <button data-mask="0" className={maskMode === 0 ? 'on' : ''} onClick={() => setMaskMode(0)}>Off</button>
          <button data-mask="2" className={maskMode === 2 ? 'on' : ''} onClick={() => setMaskMode(2)}>Vignette</button>
        </div>
      </div>
      <div className="row">
        <label className="h" htmlFor="rainToggle">Weather shader</label>
        <button className={`act ${rainCycleEnabled ? 'on' : ''}`} id="rainToggle" type="button" aria-pressed={rainCycleEnabled} aria-describedby="rainNote" onClick={() => setRainCycleEnabled(!rainCycleEnabled)}>{rainLabel}</button>
        <span className="weather-note" id="rainNote">{`Auto · ${EXPERIENCE_CONFIG.rain.dryDurationMs / 1000} sec dry / ${EXPERIENCE_CONFIG.rain.activeDurationMs / 1000} sec rain · below ${EXPERIENCE_CONFIG.rain.maximumRangeM / 1000} km`}</span>
      </div>
      <div className="row">
        <label className="h" htmlFor="cloudToggle">Cloud layer</label>
        <button
          className={`act ${cloudActive ? 'on' : ''} ${cloudState && !cloudActive && /protect/i.test(cloudState.reason) ? 'is-protected' : ''}`.trim()}
          id="cloudToggle" type="button" aria-pressed={cloudActive} aria-describedby="cloudNote" disabled={!cloudState}
          onClick={() => { const env = sceneState().environment; if (env) env.setCloudIntent(env.getCloudState().mode === 'off') }}
        >
          ☁ Clouds · {cloudLabel}
        </button>
        <span className="weather-note" id="cloudNote" aria-live="polite">{cloudState ? `${cloudState.tier} · ${cloudState.reason}` : 'Checking device headroom'}</span>
      </div>
      <p className="opt-head">Optimizations · Cesium comparison</p>
      <div className="row compare-row">
        <label className="h" htmlFor="compareToggle">Compare mode</label>
        <button className={`act ${compareMode ? 'on' : ''}`} id="compareToggle" type="button" aria-pressed={compareMode} aria-describedby="compareNote" onClick={() => setCompareMode(!compareMode)}>⚖ Compare mode · {compareMode ? 'On' : 'Off'}</button>
        <span className="weather-note" id="compareNote">Everything off — only the point cloud with zoom-dependent density, navigation and basemap. Individual choices below are kept</span>
      </div>
      <div className="row compare-row">
        <button className="act" id="compareReload" type="button" aria-describedby="compareReloadNote" onClick={() => {
          const url = new URL(location.href)
          if (APP_PARAMS.compareParam) url.searchParams.delete('compare')
          else url.searchParams.set('compare', '1')
          location.href = url.toString()
        }}>{APP_PARAMS.compareParam ? '⟳ Restart · Normal' : '⟳ Restart in compare mode'}</button>
        <span className="weather-note" id="compareReloadNote">Reloads with ?compare=1: no device benchmark, no startup resolution cap — the full, fair comparison</span>
      </div>
      <div id="compareRows">
        {RENDER_OPTION_ROWS.map((rowDef) => {
          const on = requested[rowDef.key]
          return (
            <div className="row opt-row" key={rowDef.key}>
              <label className="h" htmlFor={`opt-${rowDef.key}`}>{rowDef.label}</label>
              <button type="button" className={`act ${on ? 'on' : ''}`} id={`opt-${rowDef.key}`} aria-pressed={on} onClick={() => setOption(rowDef.key, !on)}>{on ? rowDef.onText : rowDef.offText}</button>
              <span className="weather-note">{rowDef.note}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
