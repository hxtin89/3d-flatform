import { APP_PARAMS } from '../params'
import { useUiStore } from '../state/ui-store'

const fmtInt = (value: number) => Math.round(value).toLocaleString('en-US')
const fmtMiB = (value: number) => `${Math.round(value / (1024 * 1024))} MB`

export function fpsClass(fps: number): string {
  return fps >= 58 ? 'good' : fps >= 40 ? 'warn' : 'bad'
}

export function Hud() {
  const hud = useUiStore((s) => s.hud)
  const backend = useUiStore((s) => s.backendLabel)
  const statusLine = useUiStore((s) => s.statusLine)
  const fps = hud?.fps ?? 0
  return (
    <div id="hud" className="card">
      <button className="close" data-close="hud" onClick={() => useUiStore.setState({ hudOpen: false })}>×</button>
      <h1>Adaptive Point Cloud</h1>
      <span id="backend" className={`badge ${backend === 'WebGL2' ? 'webgl' : ''}`.trim()}>{backend}</span>
      <div id="status">{statusLine}</div>
      <div className="stats">
        <span className="k">Density</span><span className="v" id="loaded">{hud?.density ?? '—'}</span>
        <span className="k">Adaptive LOD</span><span className="v" id="displayed">{hud ? `SSE ${hud.sse.toFixed(0)}` : '—'}</span>
        <span className="k">Visible points</span><span className="v" id="visible">{hud ? fmtInt(hud.points) : '0'}</span>
        <span className="k">Point tiles</span><span className="v" id="blocks">{hud?.pointTiles ?? 0}</span>
        <span className="k">Map tiles</span><span className="v" id="mapTiles">{hud?.mapTiles ?? 0}</span>
        <span className="k">Cache CPU · GPU</span><span className="v" id="cache">{hud ? `${fmtMiB(hud.cacheBytes)} · ${fmtMiB(hud.gpuBytes)}` : '0 MB · 0 MB'}</span>
        <span className="k">FPS</span><span className={`v ${fpsClass(fps)}`} id="fpsv">{fps ? fps.toFixed(0) : '—'}</span>
        <span className="k">ms/frame</span><span className="v" id="msv">{hud?.frameMs ? hud.frameMs.toFixed(1) : '—'}</span>
      </div>
      {APP_PARAMS.showDiagnostics && (
        <div className="stats" id="diagStats">
          <span className="k">Höhe über Grund</span><span className="v" id="diagAltitude">{hud?.altitude != null ? `${Math.round(hud.altitude)} m` : '—'}</span>
          <span className="k">LOD-Distanz</span><span className="v" id="diagRange">{hud?.range != null ? `${Math.round(hud.range)} m` : '—'}</span>
          <span className="k">Zoom-Anschlag</span><span className="v" id="diagStop">{hud ? `${Math.round(hud.clearance)} m` : '—'}</span>
          <span className="k">Fehlende Kacheln</span><span className="v" id="diagMissing">{hud?.missingTiles ?? 0}</span>
          <span className="k">Origin-Abstand</span><span className="v" id="diagOrigin">{hud ? `${Math.round(hud.originDistance)} m · ${hud.rebases}× · cut ${Math.round(hud.distanceCutoff)} m · q${hud.perfScale.toFixed(2)}/${hud.perfSse.toFixed(1)}` : '—'}</span>
        </div>
      )}
    </div>
  )
}
