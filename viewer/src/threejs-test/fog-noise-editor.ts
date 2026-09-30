// Noise editor for the volumetric ground fog: inspect the baked tiles, change every layer's
// settings and see the result in the fog as it rebakes.
//
// Built the first time its panel section is opened, so a closed editor costs nothing. The
// previews read three different things, each from where it is exact:
//   · the four 2D layers and their RGBA composite, drawn from the baked texels themselves,
//     each repeated 2×2 so a seam would show as a cross through the middle;
//   · the 3D comparison texture, as a strip of z slices plus the three orthogonal cuts
//     through a movable point;
//   · the fog density the march actually sees — a top view at a chosen height, a side view
//     through the band and the column density seen from above — rendered on the GPU by the
//     fog's own density node (ground-fog.ts), so the preview cannot drift from the shader.
import { NOISE_KINDS, type FogNoiseSettings, type NoiseKind, type NoiseLayerSettings } from './fog-noise'

export type DensitySliceKind = 'top' | 'side' | 'column'
export interface DensitySliceRequest {
  kind: DensitySliceKind
  /** Width of the previewed window in metres, centred on the view centre. */
  spanM: number
  /** 'top': height above the band floor. 'side': north offset of the vertical cut. */
  offsetM: number
  width: number
  height: number
}

export interface FogNoiseEditorOptions {
  container: HTMLElement
  settings: FogNoiseSettings
  defaults: FogNoiseSettings
  /** Rebakes and uploads; resolves with the new texels, or null if a newer bake replaced it. */
  apply(settings: FogNoiseSettings): Promise<Uint8Array | null>
  bake3d(size: number): Promise<Uint8Array | null>
  /** RGBA8 pixels of a density slice, row 0 at the top; resolves null while the fog is off. */
  renderDensitySlice?(request: DensitySliceRequest): Promise<Uint8Array | null>
  /** Band height in metres, for the side view's scale. */
  bandHeightM(): number
}

const CHANNEL_ROLES = [
  ['R', 'Coverage', 'Where the mist pools — the broad banks'],
  ['G', 'Billows', 'Rounded clumps between the crowns'],
  ['B', 'Wisps', 'Height detail: read as stacked slices, it carves the mist into puffs and frays the plumes'],
  ['A', 'Erosion', 'Holes carved into the billows'],
] as const

const TILE_PX = 112

export interface FogNoiseEditor {
  /** Redraw the density slices, e.g. after a fog shape slider moved. */
  refreshDensity(): void
  dispose(): void
}

export function mountFogNoiseEditor(options: FogNoiseEditorOptions): FogNoiseEditor {
  const { container } = options
  let settings: FogNoiseSettings = JSON.parse(JSON.stringify(options.settings))
  let texels: Uint8Array | null = null
  let disposed = false
  container.replaceChildren()
  container.classList.add('fog-noise-editor')

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]) => {
    const node = document.createElement(tag)
    Object.assign(node, props)
    node.append(...children)
    return node
  }
  const note = (text: string) => el('span', { className: 'weather-note', textContent: text })
  const status = el('span', { className: 'weather-note', textContent: 'Baking…' })

  // ---- top row: size, actions
  const sizeSelect = el('select', { id: 'fogNoiseSize' })
  for (const size of [64, 128, 256, 512]) sizeSelect.append(el('option', { value: String(size), textContent: `${size}²` }))
  sizeSelect.value = String(settings.size)
  const resetButton = el('button', { className: 'act', type: 'button', textContent: '↺ Defaults' })
  const copyButton = el('button', { className: 'act', type: 'button', textContent: '⧉ Copy noise settings' })
  const seamButton = el('button', { className: 'act', type: 'button', textContent: '┼ Seam guides · Off' })
  seamButton.setAttribute('aria-pressed', 'false')
  container.append(
    el('div', { className: 'row' }, el('label', { className: 'h', htmlFor: 'fogNoiseSize', textContent: 'Tile size' }), sizeSelect,
      note('Texels per tile edge. Larger tiles hold finer detail at the same world scale; each doubling quadruples bake time and memory')),
    el('div', { className: 'row fog-noise-actions' }, resetButton, copyButton, seamButton, status),
  )

  // ---- per-channel cards
  const channelCanvases: HTMLCanvasElement[] = []
  const histogramCanvases: HTMLCanvasElement[] = []
  const statLines: HTMLSpanElement[] = []
  const controlRefreshers: (() => void)[] = []
  const grid = el('div', { className: 'fog-noise-grid' })
  settings.layers.forEach((_, channel) => {
    const [letter, name, role] = CHANNEL_ROLES[channel]
    const canvas = el('canvas', { width: TILE_PX * 2, height: TILE_PX * 2, className: 'fog-noise-tile' })
    canvas.title = `${name} (${letter}), repeated 2×2`
    const histogram = el('canvas', { width: TILE_PX * 2, height: 28, className: 'fog-noise-histogram' })
    const stats = el('span', { className: 'weather-note' })
    channelCanvases.push(canvas); histogramCanvases.push(histogram); statLines.push(stats)
    const card = el('div', { className: 'fog-noise-card' },
      el('div', { className: 'h', textContent: `${letter} · ${name}` }), note(role), canvas, histogram, stats)
    const layer = () => settings.layers[channel]
    const kind = el('select')
    for (const k of NOISE_KINDS) kind.append(el('option', { value: k, textContent: k }))
    kind.addEventListener('change', () => { layer().kind = kind.value as NoiseKind; schedule() })
    card.append(el('div', { className: 'row' }, el('label', { className: 'h', textContent: 'Kind' }), kind))
    const slider = (key: keyof NoiseLayerSettings, label: string, min: number, max: number, step: number, format = (v: number) => String(v)) => {
      const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step) })
      const value = el('span', { className: 'val' })
      const sync = () => { input.value = String(layer()[key]); value.textContent = format(Number(input.value)) }
      input.addEventListener('input', () => {
        ;(layer() as unknown as Record<string, number>)[key] = Number(input.value)
        value.textContent = format(Number(input.value))
        schedule()
      })
      controlRefreshers.push(sync)
      card.append(el('div', { className: 'row' }, el('label', { className: 'h' }, `${label} · `, value), input))
    }
    slider('period', 'Period (cells)', 1, 32, 1)
    slider('octaves', 'Octaves', 1, 8, 1)
    slider('gain', 'Gain', 0.2, 0.9, 0.01, (v) => v.toFixed(2))
    slider('warp', 'Warp (cells)', 0, 3, 0.05, (v) => v.toFixed(2))
    slider('contrast', 'Contrast', 0.25, 4, 0.05, (v) => v.toFixed(2))
    slider('seed', 'Seed', 0, 999, 1)
    const invert = el('button', { className: 'act', type: 'button' })
    const syncInvert = () => { invert.textContent = `⇅ Invert · ${layer().invert ? 'On' : 'Off'}`; invert.setAttribute('aria-pressed', String(layer().invert)) }
    invert.addEventListener('click', () => { layer().invert = !layer().invert; syncInvert(); schedule() })
    const reseed = el('button', { className: 'act', type: 'button', textContent: '⚄ New seed' })
    reseed.addEventListener('click', () => { layer().seed = Math.floor(Math.random() * 1000); refreshControls(); schedule() })
    controlRefreshers.push(() => { kind.value = layer().kind; syncInvert() })
    card.append(el('div', { className: 'row' }, invert, reseed))
    grid.append(card)
  })
  const composite = el('canvas', { width: TILE_PX * 2, height: TILE_PX * 2, className: 'fog-noise-tile' })
  composite.title = 'R, G and B together, repeated 2×2'
  grid.append(el('div', { className: 'fog-noise-card' },
    el('div', { className: 'h', textContent: 'RGB composite' }), note('All layers at once: the colour shows which layer dominates where'), composite))
  container.append(grid)

  // ---- fog density slices (GPU)
  const densityTop = el('canvas', { width: 256, height: 256, className: 'fog-noise-slice' })
  const densitySide = el('canvas', { width: 256, height: 96, className: 'fog-noise-slice' })
  const densityColumn = el('canvas', { width: 256, height: 256, className: 'fog-noise-slice' })
  const spanInput = el('input', { type: 'range', min: '100', max: '4000', step: '50', value: '800' })
  const spanVal = el('span', { className: 'val' })
  const heightInput = el('input', { type: 'range', min: '0', max: '1', step: '0.01', value: '0.35' })
  const heightVal = el('span', { className: 'val' })
  const cutInput = el('input', { type: 'range', min: '-0.5', max: '0.5', step: '0.01', value: '0' })
  const cutVal = el('span', { className: 'val' })
  const densityNote = note('')
  container.append(
    el('div', { className: 'h fog-noise-heading', textContent: 'Fog density the march sees' }),
    note('Rendered by the fog shader itself: top view at a height, side view through the band, and the column density — what the fog looks like from straight above'),
    el('div', { className: 'row' }, el('label', { className: 'h' }, 'Window · ', spanVal), spanInput),
    el('div', { className: 'row' }, el('label', { className: 'h' }, 'Top view height · ', heightVal), heightInput),
    el('div', { className: 'row' }, el('label', { className: 'h' }, 'Side view cut · ', cutVal), cutInput),
    el('div', { className: 'fog-noise-grid' },
      el('figure', {}, densityTop, el('figcaption', { textContent: 'Top view at the chosen height' })),
      el('figure', {}, densityColumn, el('figcaption', { textContent: 'Column density (from above)' })),
      el('figure', { className: 'wide' }, densitySide, el('figcaption', { textContent: 'Side view: west → east, floor at the bottom' }))),
    densityNote,
  )

  // ---- 3D comparison slices
  const strip = el('canvas', { width: 8 * 64, height: 64, className: 'fog-noise-strip' })
  const ortho = el('canvas', { width: 3 * 96, height: 96, className: 'fog-noise-strip' })
  const zInput = el('input', { type: 'range', min: '0', max: '1', step: '0.01', value: '0.5' })
  const zVal = el('span', { className: 'val' })
  const bake3dButton = el('button', { className: 'act', type: 'button', textContent: '▦ Bake 3D baseline (64³)' })
  let volume: Uint8Array | null = null
  const volumeSize = 64
  container.append(
    el('div', { className: 'h fog-noise-heading', textContent: '3D baseline' }),
    note('The 3D-texture variant the panel can switch to for the cost comparison: eight z slices, then the XY, XZ and YZ cuts through the marker'),
    el('div', { className: 'row' }, bake3dButton, el('label', { className: 'h' }, 'Cut position · ', zVal), zInput),
    strip, ortho,
  )

  // ---- drawing
  const gray = (data: Uint8Array, size: number, channel: number, stride: number) => {
    const image = new ImageData(size, size)
    for (let i = 0; i < size * size; i++) {
      const v = data[i * stride + channel]
      image.data[i * 4] = v; image.data[i * 4 + 1] = v; image.data[i * 4 + 2] = v; image.data[i * 4 + 3] = 255
    }
    return image
  }
  const scratch = document.createElement('canvas')
  const drawTiled = (canvas: HTMLCanvasElement, image: ImageData) => {
    scratch.width = image.width; scratch.height = image.height
    scratch.getContext('2d')!.putImageData(image, 0, 0)
    const ctx = canvas.getContext('2d')!
    ctx.imageSmoothingEnabled = true
    const half = canvas.width / 2
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) ctx.drawImage(scratch, x * half, y * half, half, half)
    if (seamButton.getAttribute('aria-pressed') === 'true') {
      ctx.strokeStyle = 'rgba(255, 64, 160, 0.7)'; ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(half + 0.5, 0); ctx.lineTo(half + 0.5, canvas.height); ctx.moveTo(0, half + 0.5); ctx.lineTo(canvas.width, half + 0.5); ctx.stroke()
    }
  }
  const drawHistogram = (canvas: HTMLCanvasElement, data: Uint8Array, channel: number) => {
    const bins = new Uint32Array(64)
    const n = data.length / 4
    let sum = 0; let above = 0
    for (let i = 0; i < n; i++) { const v = data[i * 4 + channel]; bins[v >> 2]++; sum += v; if (v >= 128) above++ }
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const peak = Math.max(...bins)
    ctx.fillStyle = 'rgba(160, 200, 180, 0.9)'
    const w = canvas.width / 64
    bins.forEach((count, i) => { const h = (count / peak) * canvas.height; ctx.fillRect(i * w, canvas.height - h, Math.max(w - 1, 1), h) })
    return { mean: sum / n / 255, above: above / n }
  }
  const drawChannels = () => {
    if (!texels) return
    const size = Math.round(Math.sqrt(texels.length / 4))
    for (let c = 0; c < 4; c++) {
      drawTiled(channelCanvases[c], gray(texels, size, c, 4))
      const { mean, above } = drawHistogram(histogramCanvases[c], texels, c)
      statLines[c].textContent = `mean ${(mean * 100).toFixed(0)} % · above half ${(above * 100).toFixed(0)} %`
    }
    const rgb = new ImageData(size, size)
    for (let i = 0; i < size * size; i++) {
      rgb.data[i * 4] = texels[i * 4]; rgb.data[i * 4 + 1] = texels[i * 4 + 1]; rgb.data[i * 4 + 2] = texels[i * 4 + 2]; rgb.data[i * 4 + 3] = 255
    }
    drawTiled(composite, rgb)
  }
  const drawVolume = () => {
    const sctx = strip.getContext('2d')!; const octx = ortho.getContext('2d')!
    if (!volume) {
      for (const ctx of [sctx, octx]) { ctx.fillStyle = '#1b2420'; ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height) }
      return
    }
    const n = volumeSize
    const at = (x: number, y: number, z: number) => volume![(z * n + y) * n + x]
    const slice = (fn: (a: number, b: number) => number) => {
      const image = new ImageData(n, n)
      for (let b = 0; b < n; b++) for (let a = 0; a < n; a++) {
        const v = fn(a, b); const i = (b * n + a) * 4
        image.data[i] = v; image.data[i + 1] = v; image.data[i + 2] = v; image.data[i + 3] = 255
      }
      return image
    }
    const paint = (ctx: CanvasRenderingContext2D, image: ImageData, x: number, px: number) => {
      scratch.width = n; scratch.height = n
      scratch.getContext('2d')!.putImageData(image, 0, 0)
      ctx.drawImage(scratch, x, 0, px, px)
    }
    for (let s = 0; s < 8; s++) {
      const z = Math.round((s / 8) * n) % n
      paint(sctx, slice((a, b) => at(a, b, z)), s * 64, 64)
    }
    const c = Math.min(n - 1, Math.round(Number(zInput.value) * (n - 1)))
    zVal.textContent = `${c} / ${n - 1}`
    paint(octx, slice((a, b) => at(a, b, c)), 0, 96)
    paint(octx, slice((a, b) => at(a, c, b)), 96, 96)
    paint(octx, slice((a, b) => at(c, a, b)), 192, 96)
    octx.fillStyle = 'rgba(255, 255, 255, 0.85)'; octx.font = '10px monospace'
    octx.fillText('XY', 4, 12); octx.fillText('XZ', 100, 12); octx.fillText('YZ', 196, 12)
    // The current z slice in the strip.
    sctx.strokeStyle = 'rgba(255, 64, 160, 0.9)'
    sctx.strokeRect(Math.floor(Number(zInput.value) * 8) * 64 + 0.5, 0.5, 63, 63)
  }
  let densityBusy = false
  let densityAgain = false
  const drawDensity = async () => {
    const render = options.renderDensitySlice
    const spanM = Number(spanInput.value)
    const band = options.bandHeightM()
    spanVal.textContent = `${spanM} m`
    heightVal.textContent = `${(Number(heightInput.value) * band).toFixed(0)} m`
    cutVal.textContent = `${(Number(cutInput.value) * spanM).toFixed(0)} m N`
    if (!render) { densityNote.textContent = 'Switch the volumetric fog on to preview its density.'; return }
    densityNote.textContent = ''
    if (densityBusy) { densityAgain = true; return }
    densityBusy = true
    try {
      const jobs: [HTMLCanvasElement, DensitySliceRequest][] = [
        [densityTop, { kind: 'top', spanM, offsetM: Number(heightInput.value) * band, width: 256, height: 256 }],
        [densityColumn, { kind: 'column', spanM, offsetM: 0, width: 256, height: 256 }],
        [densitySide, { kind: 'side', spanM, offsetM: Number(cutInput.value) * spanM, width: 256, height: 96 }],
      ]
      for (const [canvas, request] of jobs) {
        const pixels = await render(request)
        if (disposed) break
        // The layer answers null while the fog is switched off.
        if (!pixels) { densityNote.textContent = 'Switch the volumetric fog on to preview its density.'; break }
        const image = new ImageData(new Uint8ClampedArray(pixels), request.width, request.height)
        canvas.getContext('2d')!.putImageData(image, 0, 0)
      }
    } finally {
      densityBusy = false
      if (densityAgain && !disposed) { densityAgain = false; void drawDensity() }
    }
  }

  // ---- baking
  let bakeTimer: number | undefined
  const schedule = () => {
    window.clearTimeout(bakeTimer)
    // Short debounce: the baker drops stale requests anyway, this only saves worker time.
    bakeTimer = window.setTimeout(() => { void bake() }, 60)
  }
  const bake = async () => {
    status.textContent = 'Baking…'
    const started = performance.now()
    const data = await options.apply(settings)
    if (disposed || !data) return
    texels = data
    status.textContent = `Baked ${settings.size}² in ${Math.round(performance.now() - started)} ms`
    drawChannels()
    void drawDensity()
  }
  const refreshControls = () => {
    sizeSelect.value = String(settings.size)
    for (const refresh of controlRefreshers) refresh()
  }

  sizeSelect.addEventListener('change', () => { settings.size = Number(sizeSelect.value); schedule() })
  resetButton.addEventListener('click', () => { settings = JSON.parse(JSON.stringify(options.defaults)); refreshControls(); schedule() })
  copyButton.addEventListener('click', async () => {
    const snippet = `noise: ${JSON.stringify(settings, null, 2)}`
    try { await navigator.clipboard.writeText(snippet); copyButton.textContent = '✓ Copied' } catch { console.info(`[fog noise]\n${snippet}`); copyButton.textContent = '⧉ To console' }
    window.setTimeout(() => { copyButton.textContent = '⧉ Copy noise settings' }, 1600)
  })
  seamButton.addEventListener('click', () => {
    const on = seamButton.getAttribute('aria-pressed') !== 'true'
    seamButton.setAttribute('aria-pressed', String(on))
    seamButton.classList.toggle('on', on)
    seamButton.textContent = `┼ Seam guides · ${on ? 'On' : 'Off'}`
    drawChannels()
  })
  for (const input of [spanInput, heightInput, cutInput]) input.addEventListener('input', () => { void drawDensity() })
  zInput.addEventListener('input', drawVolume)
  bake3dButton.addEventListener('click', async () => {
    bake3dButton.textContent = '▦ Baking…'
    volume = await options.bake3d(volumeSize) ?? volume
    bake3dButton.textContent = '▦ Rebake 3D baseline (64³)'
    drawVolume()
  })

  refreshControls()
  drawVolume()
  void bake()

  return {
    refreshDensity() { void drawDensity() },
    dispose() {
      disposed = true
      window.clearTimeout(bakeTimer)
      container.replaceChildren()
    },
  }
}
