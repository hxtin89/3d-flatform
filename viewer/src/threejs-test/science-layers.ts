import type * as THREE from 'three'
import { openScienceData, type ScienceDataSource } from './science-data-loader'
import { createScienceLineLayer, type EcefEllipsoid, type LabelBox, type ScienceLineStyle } from './science-layer'
import { createScienceCard, createScienceMarkerLayer, type ScienceMarkerStyle } from './science-marker-layer'
import { areaLabelAnchors, trailLabelAnchors } from './science-geometry'
import { bigTreeMarkers, surveySiteMarkers, treePlotMarkers } from './science-markers'
import type { DatasetId, DatasetShapes, Position } from './science-data-format'

/**
 * Every science layer behind one switch each (render-options.ts, Settings panel): which
 * datasets a switch needs, how they are drawn, and the order in which their name chips
 * claim screen space. All start switched off; a layer fetches its data and builds itself
 * the first time it is switched on, so a visit that never opens one costs the index alone.
 */
export const SCIENCE_LAYER_KEYS = ['protectedAreas', 'trails', 'fieldBigTrees', 'treePlots', 'herps', 'mammals'] as const
export type ScienceLayerKey = (typeof SCIENCE_LAYER_KEYS)[number]

/** Chips claim their place in this order; an earlier layer keeps its chip when two collide. */
const LABEL_ORDER: readonly ScienceLayerKey[] = ['herps', 'mammals', 'fieldBigTrees', 'trails', 'treePlots', 'protectedAreas']

const DATASETS: Record<ScienceLayerKey, readonly DatasetId[]> = {
  protectedAreas: ['protected-areas'],
  trails: ['trails'],
  fieldBigTrees: ['big-trees'],
  treePlots: ['tree-plots'],
  herps: ['herps', 'herp-transects'],
  mammals: ['mammals'],
}

export interface ScienceLayersConfig {
  clusterRadiusM: number
  areas: ScienceLineStyle
  trails: ScienceLineStyle
  bigTrees: ScienceMarkerStyle
  treePlots: { outline: ScienceLineStyle; markers: ScienceMarkerStyle }
  herps: { tracks: ScienceLineStyle; markers: ScienceMarkerStyle }
  mammals: { markers: ScienceMarkerStyle }
}

export interface ScienceLayersOptions {
  /** The floating-origin ECEF root. */
  scene: THREE.Object3D
  overlay: HTMLElement
  /** Where the record card goes; it is fixed-positioned over the canvas. */
  cardHost: HTMLElement
  ellipsoid: EcefEllipsoid
  indexUrl: string
  config: ScienceLayersConfig
}

export interface ScienceLayers {
  /** Switches a layer; the first switch-on fetches its data and builds it. */
  setVisible(key: ScienceLayerKey, visible: boolean): void
  update(camera: THREE.Camera): void
  /** Per layer: not wanted yet, loading, failed, or its feature count. */
  status(): Record<ScienceLayerKey, string | number>
  dispose(): void
}

interface Part {
  setVisible(visible: boolean): void
  update(camera: THREE.Camera, taken: LabelBox[]): void
  count(): number
  dispose(): void
}

interface Slot {
  wanted: boolean
  state: 'idle' | 'loading' | 'ready' | 'failed'
  parts: Part[]
}

export function createScienceLayers(options: ScienceLayersOptions): ScienceLayers {
  const { scene, overlay, ellipsoid, config } = options
  const card = createScienceCard(options.cardHost, () => { dirty = true })
  const slots = Object.fromEntries(SCIENCE_LAYER_KEYS.map(key => [key, { wanted: false, state: 'idle', parts: [] }])) as unknown as Record<ScienceLayerKey, Slot>
  const taken: LabelBox[] = []
  let source: Promise<ScienceDataSource> | null = null
  let disposed = false
  // The view the chips were last placed for. While it and the layers stay the same there
  // is nothing to move, and a still camera costs nothing.
  const lastView = new Float64Array(34)
  let dirty = true

  const lines = (name: string, features: Position[][][], style: ScienceLineStyle, labels: ReturnType<typeof areaLabelAnchors> = [], labelClass = '') =>
    createScienceLineLayer({ name, scene, overlay, ellipsoid, features, labels, labelClass, clusterRadiusM: config.clusterRadiusM, style })
  const markers = (list: ReturnType<typeof bigTreeMarkers>, className: string, style: ScienceMarkerStyle) =>
    createScienceMarkerLayer({ scene, overlay, ellipsoid, markers: list, className, style, card })

  function build(key: ScienceLayerKey, data: Partial<DatasetShapes>): Part[] {
    switch (key) {
      case 'protectedAreas': {
        const areas = data['protected-areas']
        return areas ? [lines('wi-protected-areas', areas.features.map(f => f.geometry.coordinates.flat()), config.areas, areaLabelAnchors(areas), 'science-label--area')] : []
      }
      case 'trails': {
        const trails = data.trails
        return trails ? [lines('wi-trails', trails.features.map(f => f.geometry.coordinates), config.trails, trailLabelAnchors(trails), 'science-label--trail')] : []
      }
      case 'fieldBigTrees': {
        const trees = data['big-trees']
        return trees ? [markers(bigTreeMarkers(trees), 'science-marker--tree', config.bigTrees)] : []
      }
      case 'treePlots': {
        const plots = data['tree-plots']
        if (!plots) return []
        const outlines = plots.features.flatMap(f => (f.geometry.type === 'MultiPolygon' ? [f.geometry.coordinates.flat()] : []))
        return [lines('wi-tree-plots', outlines, config.treePlots.outline), markers(treePlotMarkers(plots), 'science-marker--plot', config.treePlots.markers)]
      }
      case 'herps': {
        const parts: Part[] = []
        const tracks = data['herp-transects']
        if (tracks) parts.push(lines('wi-herp-tracks', tracks.features.map(f => f.geometry.coordinates), config.herps.tracks))
        if (data.herps) parts.push(markers(surveySiteMarkers(data.herps, 'herps'), 'science-marker--herp', config.herps.markers))
        return parts
      }
      case 'mammals': {
        return data.mammals ? [markers(surveySiteMarkers(data.mammals, 'mammals'), 'science-marker--mammal', config.mammals.markers)] : []
      }
    }
  }

  async function load(key: ScienceLayerKey): Promise<void> {
    const slot = slots[key]
    slot.state = 'loading'
    try {
      source ??= openScienceData(options.indexUrl)
      const opened = await source
      const loaded = await Promise.all(DATASETS[key].map(async id => [id, await opened.load(id)] as const))
      if (disposed) return
      const data: Partial<DatasetShapes> = {}
      for (const [id, collection] of loaded) {
        if (collection) (data as Record<DatasetId, unknown>)[id] = collection
      }
      slot.parts = build(key, data)
      for (const part of slot.parts) part.setVisible(slot.wanted)
      slot.state = 'ready'
      dirty = true
      console.info(`[science-data] ${key}: ${slot.parts.map(p => p.count()).join(' + ')} features`)
    } catch (error) {
      // Switching the layer off and on again tries once more.
      slot.state = 'failed'
      source = null
      console.warn(`[science-data] ${key} failed`, error)
    }
  }

  return {
    setVisible(key, visible) {
      const slot = slots[key]
      slot.wanted = visible
      dirty = true
      if (slot.state === 'ready') {
        for (const part of slot.parts) part.setVisible(visible)
      } else if (visible && (slot.state === 'idle' || slot.state === 'failed')) {
        void load(key)
      }
    },
    update(camera) {
      const view = camera.matrixWorld.elements
      const projection = camera.projectionMatrix.elements
      let same = !dirty && lastView[32] === window.innerWidth && lastView[33] === window.innerHeight
      for (let i = 0; i < 16; i++) {
        if (lastView[i] !== view[i] || lastView[16 + i] !== projection[i]) same = false
        lastView[i] = view[i]
        lastView[16 + i] = projection[i]
      }
      lastView[32] = window.innerWidth
      lastView[33] = window.innerHeight
      if (same) return
      dirty = false
      taken.length = 0
      for (const key of LABEL_ORDER) {
        const slot = slots[key]
        if (!slot.wanted || slot.state !== 'ready') continue
        for (const part of slot.parts) part.update(camera, taken)
      }
    },
    status() {
      return Object.fromEntries(SCIENCE_LAYER_KEYS.map((key) => {
        const slot = slots[key]
        const value = slot.state === 'ready' ? slot.parts.reduce((sum, part) => sum + part.count(), 0) : slot.wanted ? slot.state : 'off'
        return [key, value]
      })) as Record<ScienceLayerKey, string | number>
    },
    dispose() {
      disposed = true
      for (const slot of Object.values(slots)) {
        for (const part of slot.parts) part.dispose()
        slot.parts = []
      }
      card.dispose()
    },
  }
}
