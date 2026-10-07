// Pure lon/lat helpers for the science layers (science-layer.ts): where a label goes, which
// features share a draw call, and how a source name reads on screen. No three.js here, so
// the node tests (science-geometry.test.ts) cover it.

import type { Position, ProtectedAreaCollection, TrailCollection } from './science-data-format.ts'

const EARTH_RADIUS_M = 6_371_008.8
const DEG = Math.PI / 180

export interface LabelAnchor {
  text: string
  lon: number
  lat: number
}

/** "Bootkiller_Trail" → "Bootkiller Trail". The source names are file names as often as not. */
export function displayName(name: string): string {
  return name.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Equirectangular distance in metres; exact enough below ~100 km, monotonic beyond. */
export function approxDistanceM(a: Position, b: Position): number {
  const x = (b[0] - a[0]) * DEG * Math.cos(((a[1] + b[1]) / 2) * DEG)
  const y = (b[1] - a[1]) * DEG
  return Math.hypot(x, y) * EARTH_RADIUS_M
}

function pathLengthM(path: Position[]): number {
  let length = 0
  for (let i = 1; i < path.length; i++) length += approxDistanceM(path[i - 1], path[i])
  return length
}

/** The point halfway along a path, by length. */
export function pathMidpoint(path: Position[]): Position {
  const half = pathLengthM(path) / 2
  let walked = 0
  for (let i = 1; i < path.length; i++) {
    const step = approxDistanceM(path[i - 1], path[i])
    if (walked + step >= half && step > 0) {
      const t = (half - walked) / step
      return [path[i - 1][0] + (path[i][0] - path[i - 1][0]) * t, path[i - 1][1] + (path[i][1] - path[i - 1][1]) * t]
    }
    walked += step
  }
  return path[0]
}

/** One label per trail name, halfway along that name's longest piece. */
export function trailLabelAnchors(collection: TrailCollection): LabelAnchor[] {
  const longest = new Map<string, { path: Position[]; length: number }>()
  for (const feature of collection.features) {
    const text = displayName(feature.properties.trail_name)
    for (const path of feature.geometry.coordinates) {
      const length = pathLengthM(path)
      const best = longest.get(text)
      if (!best || length > best.length) longest.set(text, { path, length })
    }
  }
  return [...longest].map(([text, { path }]) => {
    const [lon, lat] = pathMidpoint(path)
    return { text, lon, lat }
  })
}

/** Area-weighted centroid and area (m²) of a ring, in a plane tangent at its first point. */
function ringCentroid(ring: Position[]): { centre: Position; areaM2: number } {
  const [lon0, lat0] = ring[0]
  const kx = DEG * Math.cos(lat0 * DEG) * EARTH_RADIUS_M
  const ky = DEG * EARTH_RADIUS_M
  let twiceArea = 0
  let cx = 0
  let cy = 0
  for (let i = 0; i < ring.length - 1; i++) {
    const x0 = (ring[i][0] - lon0) * kx
    const y0 = (ring[i][1] - lat0) * ky
    const x1 = (ring[i + 1][0] - lon0) * kx
    const y1 = (ring[i + 1][1] - lat0) * ky
    const cross = x0 * y1 - x1 * y0
    twiceArea += cross
    cx += (x0 + x1) * cross
    cy += (y0 + y1) * cross
  }
  if (Math.abs(twiceArea) < 1e-6) return { centre: ring[0], areaM2: 0 }
  return {
    centre: [lon0 + cx / (3 * twiceArea) / kx, lat0 + cy / (3 * twiceArea) / ky],
    areaM2: Math.abs(twiceArea) / 2,
  }
}

/** The centroid of a MultiPolygon's largest outer ring: where its label or marker goes. */
export function largestRingCentre(polygons: Position[][][]): Position {
  let best = { centre: polygons[0][0][0], areaM2: -1 }
  for (const polygon of polygons) {
    const candidate = ringCentroid(polygon[0])
    if (candidate.areaM2 > best.areaM2) best = candidate
  }
  return best.centre
}

/** One label per area, at the centroid of its largest outer ring. */
export function areaLabelAnchors(collection: ProtectedAreaCollection): LabelAnchor[] {
  return collection.features.map((feature) => {
    const [lon, lat] = largestRingCentre(feature.geometry.coordinates)
    return { text: displayName(feature.properties.area_name), lon, lat }
  })
}

/**
 * Groups items whose points lie within `maxDistanceM` of a group's first item. Each group
 * becomes one draw call around one anchor, so the float32 offsets stay small: Peru and
 * British Columbia, or the SFO station and Pantiacolla 190 km away, never share an anchor.
 */
export function clusterByDistance<T>(items: T[], pointOf: (item: T) => Position, maxDistanceM: number): T[][] {
  const clusters: Array<{ seed: Position; items: T[] }> = []
  for (const item of items) {
    const point = pointOf(item)
    const home = clusters.find(cluster => approxDistanceM(cluster.seed, point) <= maxDistanceM)
    if (home) home.items.push(item)
    else clusters.push({ seed: point, items: [item] })
  }
  return clusters.map(cluster => cluster.items)
}
