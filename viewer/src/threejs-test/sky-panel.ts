// The sky package's three panel sections — Sky & sun, Sun shadows, Sky clouds — built from
// tables like the volumetric fog's, so the controls, their config defaults and Copy values
// cannot drift apart. The switches that change what is compiled go through callbacks into
// main.ts, which owns the rebuilds (tile shaders, the post graph).
import * as THREE from 'three'
import type { SkyAtmosphere, SkyParams } from './sky-atmosphere'
import type { SunShadowLayer, SunShadowParams } from './sun-shadows'
import type { CloudLook, SkyClouds, SkyCloudParams } from './sky-clouds'
import type { AtmosphereSettings } from './atmosphere-model'
import type { GroundFogParams } from './ground-fog'

export interface SunLightParams {
  sunIntensity: number
  skyIntensity: number
  tint: THREE.Color
  nightLevel: number
}

export interface SkyPanelSwitches {
  sky: { get(): boolean; set(on: boolean): void }
  sunLight: { get(): boolean; set(on: boolean): void }
  shadows: { get(): boolean; set(on: boolean): void }
  fogShadows: { get(): boolean; set(on: boolean): void }
  clouds: { get(): boolean; set(on: boolean): void }
  fogCloudShadows: { get(): boolean; set(on: boolean): void }
  cloudShadows: { get(): boolean; set(on: boolean): void }
  aerialVolume: { get(): boolean; set(on: boolean): void }
}

export interface SkyPanelOptions {
  containers: { sky: HTMLElement; shadows: HTMLElement; clouds: HTMLElement }
  sky: SkyAtmosphere
  sunLight: SunLightParams
  /** The side-light uniform of the tile shaders. */
  sideLight: { value: number }
  fog: GroundFogParams
  shadows: SunShadowLayer
  clouds: SkyClouds
  switches: SkyPanelSwitches
  /** A preset was picked: its haze goes to the atmosphere. */
  onPreset(look: CloudLook): void
}

interface Row {
  key: string
  label: string
  min: number
  max: number
  step: number
  format?: (v: number) => string
  note?: string
  get(): number
  set(v: number): void
}

const fixed = (digits: number) => (v: number) => v.toFixed(digits)
const percent = (v: number) => `${Math.round(v * 100)} %`
const km = (v: number) => `${v.toFixed(2)} km`
const metres = (v: number) => `${v.toFixed(v < 10 ? 1 : 0)} m`
const degrees = (v: number) => `${v.toFixed(1)}°`

export function mountSkyPanel(opts: SkyPanelOptions): { copyValues(): Record<string, unknown>; refresh(): void } {
  const { sky, sunLight, fog, shadows, clouds, switches } = opts
  const refreshers: (() => void)[] = []
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]) => {
    const node = document.createElement(tag); Object.assign(node, props); node.append(...children); return node
  }
  const note = (text: string) => make('span', { className: 'weather-note', textContent: text })
  const toggle = (label: string, state: { get(): boolean; set(on: boolean): void }) => {
    const button = make('button', { className: 'act', type: 'button' })
    const sync = () => { const on = state.get(); button.classList.toggle('on', on); button.setAttribute('aria-pressed', String(on)); button.textContent = `${label} · ${on ? 'On' : 'Off'}` }
    button.addEventListener('click', () => { state.set(!state.get()); sync(); refreshAll() })
    refreshers.push(sync)
    sync()
    return button
  }
  const slider = (container: HTMLElement, prefix: string, row: Row) => {
    const id = `${prefix}_${row.key}`
    const input = make('input', { type: 'range', id, min: String(row.min), max: String(row.max), step: String(row.step) })
    const value = make('span', { className: 'val' })
    const format = row.format ?? fixed(2)
    const refresh = () => { input.value = String(row.get()); value.textContent = format(Number(input.value)) }
    input.addEventListener('input', () => { row.set(Number(input.value)); value.textContent = format(Number(input.value)) })
    refreshers.push(refresh)
    refresh()
    container.append(make('div', { className: 'row' }, make('label', { className: 'h', htmlFor: id }, `${row.label} · `, value), input, ...(row.note ? [note(row.note)] : [])))
  }
  const colour = (container: HTMLElement, id: string, label: string, target: THREE.Color, apply: () => void = () => {}) => {
    const input = make('input', { type: 'color', id, value: `#${target.getHexString()}` })
    input.addEventListener('input', () => { target.set(input.value); apply() })
    refreshers.push(() => { input.value = `#${target.getHexString()}` })
    container.append(make('div', { className: 'row' }, make('label', { className: 'h', htmlFor: id, textContent: label }), input))
  }
  const heading = (container: HTMLElement, text: string) => container.append(make('div', { className: 'vfog-heading', textContent: text }))
  const refreshAll = () => refreshers.forEach((refresh) => refresh())

  // ---------------------------------------------------------------- sky & sun
  const skyBox = opts.containers.sky
  const p: SkyParams = sky.params
  const atmosphereRow = (key: keyof AtmosphereSettings, label: string, min: number, max: number, step: number, format?: (v: number) => string, noteText?: string): Row => ({
    key, label, min, max, step, format, note: noteText,
    get: () => sky.getAtmosphere()[key] as number,
    set: (v) => sky.setAtmosphere({ ...sky.getAtmosphere(), [key]: v }),
  })
  const param = (key: keyof SkyParams, label: string, min: number, max: number, step: number, format?: (v: number) => string, noteText?: string): Row => ({
    key, label, min, max, step, format, note: noteText,
    get: () => p[key] as number,
    set: (v) => { (p as any)[key] = v },
  })
  skyBox.append(
    make('div', { className: 'row' }, make('label', { className: 'h', textContent: 'Physical sky' }), toggle('◐ Physical sky', switches.sky),
      note('Hillaire’s atmosphere in four small tables, a full-resolution sun disc and aerial perspective in place of the haze curve. Off is the graded sky and haze of before. ?sky=0|1')),
    make('div', { className: 'row' }, make('label', { className: 'h', textContent: 'Sun light' }), toggle('☀ Sun light', switches.sunLight),
      note('The sun and sky light the points and the basemap (the captured colours relit). Off is the daylight grade')),
    make('div', { className: 'row' }, make('label', { className: 'h', textContent: 'Aerial perspective' }), toggle('◫ Aerial volume', switches.aerialVolume),
      note('The haze from a 32 × 32 × 32 camera volume, drawn when the view moves and read with two lookups per pixel. Off evaluates it per pixel. ?apvol=0|1')),
  )
  heading(skyBox, 'Exposure')
  for (const row of [
    param('exposure', 'Exposure', 0.2, 3, 0.01, fixed(2), 'A white surface under a clear 60° sun shows as this'),
    param('adaptation', 'Adaptation', 0, 1, 0.01, percent, 'How far dim scenes (dusk, overcast) are lifted toward the reference'),
    param('adaptationMax', 'Adaptation ceiling', 1, 16, 0.1, (v) => `× ${v.toFixed(1)}`),
    param('weatherAdaptation', 'Weather adaptation', 0, 1, 0.01, percent, 'How much of the clouds’ darkening the exposure follows: 0 % adapts to the time of day alone, so a storm reads dark'),
    param('whiteBalance', 'White balance', 0, 1, 0.01, percent, '100 % sets white to the noon sun, as a camera on daylight'),
    param('skyBrightness', 'Sky brightness', 0.2, 3, 0.01, fixed(2), 'Artistic: the sky’s own glow, background and haze, not the light it casts'),
    param('overcastGlow', 'Overcast glow', 0, 1, 0.01, percent, 'Under a full overcast, the share of the clear sky’s glow the haze keeps'),
  ]) slider(skyBox, 'sky', row)
  heading(skyBox, 'Air')
  for (const row of [
    atmosphereRow('aerosolDepth', 'Haze (aerosol depth)', 0, 1.5, 0.01, fixed(2), '0.005 pristine · 0.1 wet season · 0.25 humid haze · 1 smoke'),
    atmosphereRow('aerosolHeightKm', 'Haze layer height', 0.3, 5, 0.05, km),
    atmosphereRow('aerosolAlbedo', 'Haze albedo', 0.5, 1, 0.005, fixed(3), 'Smoke absorbs (0.88), water haze hardly (0.95+)'),
    atmosphereRow('aerosolG', 'Haze forward glow', 0, 0.95, 0.01, fixed(2), 'How tight the glow around the sun is'),
    atmosphereRow('angstrom', 'Haze colour (Ångström)', 0, 2.5, 0.05, fixed(2), '0 grey haze, 1.3 bluish, 2 smoke'),
    atmosphereRow('rayleighScale', 'Air (Rayleigh)', 0, 3, 0.01, fixed(2)),
    atmosphereRow('ozoneScale', 'Ozone', 0, 3, 0.01, fixed(2), 'Keeps the zenith blue at dusk'),
    param('aerialStartM', 'Aerial clear zone', 0, 3000, 10, metres),
    param('aerialDensity', 'Aerial density', 0, 4, 0.01, fixed(2), 'Multiplier on the air’s optical depth over distance'),
  ]) slider(skyBox, 'sky', row)
  heading(skyBox, 'Sun disc')
  for (const row of [
    param('sunIntensity', 'Disc intensity', 0, 4, 0.01, fixed(2)),
    param('sunSize', 'Disc size', 0.25, 6, 0.05, (v) => `× ${v.toFixed(2)}`, 'Against the real 0.53°; the disc keeps its total light'),
    param('sunSharpnessPx', 'Edge width', 0.25, 12, 0.25, (v) => `${v.toFixed(2)} px`),
    param('sunLimbDarkening', 'Limb darkening', 0, 1, 0.01, percent),
    param('sunGlow', 'Glow', 0, 0.3, 0.001, fixed(3), 'Artistic halo on top of the haze’s own'),
    param('sunGlowSize', 'Glow size', 0, 1, 0.01, percent),
    param('sunMaxRadiance', 'Disc ceiling', 1, 500, 1, fixed(0), 'Keeps the half-float frame finite and the bokeh of the sun bearable'),
  ]) slider(skyBox, 'sky', row)
  colour(skyBox, 'skySunTint', 'Disc tint', p.sunTint)
  heading(skyBox, 'Light on the scene')
  for (const row of [
    { key: 'sunIntensity', label: 'Sunlight', min: 0, max: 3, step: 0.01, get: () => sunLight.sunIntensity, set: (v: number) => { sunLight.sunIntensity = v } },
    { key: 'skyIntensity', label: 'Skylight', min: 0, max: 3, step: 0.01, get: () => sunLight.skyIntensity, set: (v: number) => { sunLight.skyIntensity = v } },
    { key: 'sideLight', label: 'Side light', min: 0, max: 1, step: 0.01, format: percent, note: 'How much sun a normal-less point catches beyond flat ground: crowns are round', get: () => opts.sideLight.value, set: (v: number) => { opts.sideLight.value = v } },
    { key: 'nightLevel', label: 'Night floor', min: 0, max: 1, step: 0.01, format: percent, get: () => sunLight.nightLevel, set: (v: number) => { sunLight.nightLevel = v } },
    { key: 'skySunScale', label: 'Fog: sunlight', min: 0, max: 3, step: 0.01, note: 'The volumetric fog’s share of the atmosphere’s sun', get: () => fog.skySunScale, set: (v: number) => { fog.skySunScale = v } },
    { key: 'skyAmbientScale', label: 'Fog: skylight', min: 0, max: 6, step: 0.01, get: () => fog.skyAmbientScale, set: (v: number) => { fog.skyAmbientScale = v } },
  ] as Row[]) slider(skyBox, 'sky', row)
  colour(skyBox, 'skyLightTint', 'Sunlight tint', sunLight.tint)

  // ---------------------------------------------------------------- shadows
  const shadowBox = opts.containers.shadows
  const sp: SunShadowParams = shadows.params
  const shadowRow = (key: keyof SunShadowParams, label: string, min: number, max: number, step: number, format?: (v: number) => string, noteText?: string): Row => ({
    key, label, min, max, step, format, note: noteText,
    get: () => sp[key] as number,
    set: (v) => { (sp as any)[key] = v; shadows.invalidate() },
  })
  shadowBox.append(
    make('div', { className: 'row' }, make('label', { className: 'h', textContent: 'Canopy shadows' }), toggle('◑ Canopy shadows', switches.shadows),
      note('The canopy’s soft sun shadows on the points, the basemap and in the fog: an optical-depth map of the drawn points from the sun, fitted to the dome. ?shadows=0|1')),
    make('div', { className: 'row' }, toggle('☁ Volumetric shadows in the fog', switches.fogShadows),
      note('Light shafts: each fog step reads the map. One texture read per step')),
  )
  heading(shadowBox, 'Map')
  for (const row of [
    shadowRow('resolution', 'Resolution', 256, 4096, 256, (v) => `${2 ** Math.round(Math.log2(Math.max(v, 256)))} px`, 'Texels per side of the dome-fitted map'),
    shadowRow('cascades', 'Cascades', 1, 2, 1, fixed(0), '2 adds an inner map over the dome’s middle for close-ups'),
    shadowRow('cascadeSplit', 'Inner map size', 0.1, 0.9, 0.01, percent),
    shadowRow('updateEvery', 'Redraw every', 1, 30, 1, (v) => `${v} frames`, 'Skipped anyway while nothing moved'),
    shadowRow('pointFraction', 'Points drawn', 0.02, 1, 0.01, percent, 'Share of each tile’s points the map takes; the rest is made up by the weight'),
    shadowRow('splatScale', 'Splat size', 0.2, 3, 0.01, fixed(2), 'Against the points’ spacing'),
    shadowRow('minSplatTexels', 'Smallest splat', 0.5, 4, 0.05, (v) => `${v.toFixed(2)} texels`),
  ]) slider(shadowBox, 'shadow', row)
  heading(shadowBox, 'Look')
  for (const row of [
    shadowRow('density', 'Canopy density', 0, 6, 0.01, fixed(2), 'Optical depth of one full layer of points: a rainforest lets 5–10 % of the sun through'),
    shadowRow('strength', 'Strength', 0, 4, 0.01, fixed(2)),
    shadowRow('softnessM', 'Softness', 0, 12, 0.1, metres, 'Blur, one standard deviation'),
    shadowRow('selfOffsetM', 'Self offset', 0, 15, 0.1, metres, 'A point lifts itself toward the sun before it looks up its shadow'),
    shadowRow('minSpreadM', 'Minimum spread', 0.1, 10, 0.1, metres),
    shadowRow('fadeStartDeg', 'Fade in from', -2, 20, 0.1, degrees, 'Sun elevation below which there are no shadows'),
    shadowRow('fadeEndDeg', 'Full from', 0, 30, 0.1, degrees),
    shadowRow('fogStrength', 'Fog: shadow strength', 0, 4, 0.01, fixed(2)),
    shadowRow('fogLodBias', 'Fog: softness', 0, 6, 0.1, (v) => `+${v.toFixed(1)} mips`),
  ]) {
    // The fog reads its two through its own params.
    if (row.key === 'fogStrength') { row.get = () => fog.canopyShadowStrength; row.set = (v) => { fog.canopyShadowStrength = v; sp.fogStrength = v } }
    if (row.key === 'fogLodBias') { row.get = () => fog.canopyShadowLodBias; row.set = (v) => { fog.canopyShadowLodBias = v; sp.fogLodBias = v } }
    slider(shadowBox, 'shadow', row)
  }

  // ---------------------------------------------------------------- clouds
  const cloudBox = opts.containers.clouds
  const cp: SkyCloudParams = clouds.params
  const presetSelect = make('select', { id: 'skyCloudPreset' })
  for (const name of clouds.presets()) presetSelect.append(make('option', { value: name, textContent: name }))
  presetSelect.value = cp.preset
  presetSelect.addEventListener('change', () => {
    const look = clouds.applyPreset(presetSelect.value)
    if (look) opts.onPreset(look)
    refreshAll()
  })
  refreshers.push(() => { presetSelect.value = cp.preset })
  cloudBox.append(
    make('div', { className: 'row' }, make('label', { className: 'h', textContent: 'Sky clouds' }), toggle('☁ Sky clouds', switches.clouds),
      note('Clouds baked into a panorama from the survey’s centre: volumetric light, infinitely far. Re-baked when the sun moves half a degree or a setting changes, over a few dozen frames. ?clouds=0|1|<preset>')),
    make('div', { className: 'row' }, make('label', { className: 'h', htmlFor: 'skyCloudPreset', textContent: 'Weather' }), presetSelect,
      note('Each preset brings its own haze')),
    make('div', { className: 'row' }, toggle('▤ Cloud shadows', switches.cloudShadows), toggle('☁ … in the fog', switches.fogCloudShadows)),
  )
  const look = (key: keyof CloudLook, label: string, min: number, max: number, step: number, format?: (v: number) => string, noteText?: string): Row => ({
    key, label, min, max, step, format, note: noteText,
    get: () => cp.look[key] as number,
    set: (v) => { (cp.look as any)[key] = v; clouds.invalidate() },
  })
  heading(cloudBox, 'Clouds')
  for (const row of [
    look('coverage', 'Coverage', 0, 1, 0.01, percent),
    look('cells', 'Clumping', 0, 1, 0.01, percent, 'How strongly cumulus cells gather the cover'),
    look('type', 'Type', 0, 1, 0.01, fixed(2), '0 stratus · 0.5 cumulus · 1 cumulonimbus'),
    look('typeVariation', 'Type variation', 0, 1, 0.01, percent),
    look('baseKm', 'Base', 0.1, 4, 0.01, km),
    look('thicknessKm', 'Thickness', 0.2, 14, 0.05, km),
    look('densityPerKm', 'Density', 1, 120, 0.5, (v) => `${v.toFixed(1)} /km`),
    look('erosion', 'Erosion', 0, 1, 0.01, percent, 'Wispy edges'),
    look('shapeScaleKm', 'Billow size', 0.5, 12, 0.05, km),
    look('weatherScaleKm', 'Weather size', 5, 150, 1, km),
    look('absorption', 'Darkness', 0, 0.9, 0.01, percent, 'Rain clouds absorb'),
    look('precipitation', 'Rain shafts', 0, 1, 0.01, percent),
    look('anvil', 'Anvils', 0, 1, 0.01, percent),
    look('highCoverage', 'High layer', 0, 1, 0.01, percent, 'Altocumulus or cirrus sheet'),
    look('highAltitudeKm', 'High layer altitude', 2, 15, 0.1, km),
    look('highDepth', 'High layer depth', 0, 3, 0.01, fixed(2)),
    look('aerosolDepth', 'Haze with it', 0, 1.5, 0.01, fixed(2), 'The aerosol depth the preset sets'),
    { key: 'offsetX', label: 'Field offset east', min: -60, max: 60, step: 0.1, format: km, get: () => cp.look.offsetKm[0], set: (v: number) => { cp.look.offsetKm[0] = v; clouds.invalidate() } },
    { key: 'offsetY', label: 'Field offset north', min: -60, max: 60, step: 0.1, format: km, get: () => cp.look.offsetKm[1], set: (v: number) => { cp.look.offsetKm[1] = v; clouds.invalidate() } },
  ] as Row[]) {
    if (row.key === 'aerosolDepth') {
      const set = row.set
      row.set = (v) => { set(v); opts.onPreset(cp.look) }
    }
    slider(cloudBox, 'cloud', row)
  }
  const cloudParam = (key: keyof SkyCloudParams, label: string, min: number, max: number, step: number, format?: (v: number) => string, noteText?: string): Row => ({
    key, label, min, max, step, format, note: noteText,
    get: () => cp[key] as number,
    set: (v) => { (cp as any)[key] = v; clouds.invalidate() },
  })
  heading(cloudBox, 'Light and shadows')
  for (const row of [
    cloudParam('sunLight', 'Sunlight', 0, 4, 0.01),
    cloudParam('ambient', 'Skylight', 0, 4, 0.01),
    cloudParam('diffuse', 'Diffuse bounce', 0, 2, 0.01, fixed(2), 'The light so often scattered inside it forgets the sun: bright, white tops'),
    cloudParam('diffusePenetration', 'Bounce fall-off', 0.01, 1, 0.005, fixed(3), '(1 − g) in 2 / (2 + (1 − g)τ): lower lights the bases'),
    cloudParam('powder', 'Powder', 0, 1, 0.01, percent, 'Darker edges facing the sun'),
    cloudParam('ambientOcclusion', 'Ambient occlusion', 0, 0.5, 0.005, fixed(3), 'How much the cloud above a point hides the sky: dark storm cores'),
    cloudParam('haze', 'Haze on the clouds', 0, 1, 0.01, percent, 'Share of the air’s optical depth: lower keeps distant towers standing out'),
    cloudParam('shadowStrength', 'Shadow strength', 0, 3, 0.01, fixed(2)),
    cloudParam('shadowSoftness', 'Shadow softness', 0, 6, 0.1, (v) => `+${v.toFixed(1)} mips`),
  ]) slider(cloudBox, 'cloud', row)
  heading(cloudBox, 'Bake')
  for (const row of [
    cloudParam('bakeWidth', 'Panorama width', 256, 4096, 64, (v) => `${v} px`),
    cloudParam('bakeHeight', 'Panorama height', 128, 2048, 32, (v) => `${v} px`),
    cloudParam('bakeSteps', 'Steps per ray', 8, 160, 1, fixed(0)),
    cloudParam('bakeFrames', 'Spread over', 1, 240, 1, (v) => `${v} frames`),
    cloudParam('fadeSeconds', 'Cross-fade', 0, 10, 0.1, (v) => `${v.toFixed(1)} s`),
  ]) slider(cloudBox, 'cloud', row)

  const round = (v: number) => Math.round(v * 1000) / 1000
  const hex = (c: THREE.Color) => `0x${c.getHexString()}`
  return {
    refresh: refreshAll,
    copyValues: () => ({
      sky: {
        enabled: switches.sky.get(),
        atmosphere: sky.getAtmosphere(),
        exposure: round(p.exposure), adaptation: round(p.adaptation), adaptationMax: round(p.adaptationMax),
        weatherAdaptation: round(p.weatherAdaptation),
        sunIntensity: round(p.sunIntensity), sunSize: round(p.sunSize), sunSharpnessPx: round(p.sunSharpnessPx),
        sunLimbDarkening: round(p.sunLimbDarkening), sunGlow: round(p.sunGlow), sunGlowSize: round(p.sunGlowSize),
        sunTint: hex(p.sunTint), sunMaxRadiance: round(p.sunMaxRadiance), nightSky: hex(p.nightSky),
        aerialStartM: round(p.aerialStartM), aerialDensity: round(p.aerialDensity),
        whiteBalance: round(p.whiteBalance), skyBrightness: round(p.skyBrightness), overcastGlow: round(p.overcastGlow),
        aerialVolume: { enabled: switches.aerialVolume.get() },
        sunLight: {
          enabled: switches.sunLight.get(), sunIntensity: round(sunLight.sunIntensity), skyIntensity: round(sunLight.skyIntensity),
          sideLight: round(opts.sideLight.value), tint: hex(sunLight.tint), nightLevel: round(sunLight.nightLevel),
        },
      },
      volumetricFogSky: { skySunScale: round(fog.skySunScale), skyAmbientScale: round(fog.skyAmbientScale) },
      sunShadows: { enabled: switches.shadows.get(), fog: switches.fogShadows.get(), ...Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, round(v)])) },
      skyClouds: {
        enabled: switches.clouds.get(), preset: cp.preset, look: JSON.parse(JSON.stringify(cp.look)),
        cloudShadows: switches.cloudShadows.get(), fogCloudShadows: switches.fogCloudShadows.get(),
        bakeWidth: cp.bakeWidth, bakeHeight: cp.bakeHeight, bakeSteps: cp.bakeSteps, bakeFrames: cp.bakeFrames,
        fadeSeconds: round(cp.fadeSeconds), sunLight: round(cp.sunLight), ambient: round(cp.ambient),
        diffuse: round(cp.diffuse), diffusePenetration: round(cp.diffusePenetration), powder: round(cp.powder),
        ambientOcclusion: round(cp.ambientOcclusion), haze: round(cp.haze),
        shadowStrength: round(cp.shadowStrength), shadowSoftness: round(cp.shadowSoftness),
      },
    }),
  }
}
