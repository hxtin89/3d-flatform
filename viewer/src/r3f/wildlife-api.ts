export const FEATURE_KINDS = ['cluster', 'animal', 'camera', 'sensor'] as const

export type FeatureKind = typeof FEATURE_KINDS[number]
export type FeatureBand = 'overview' | 'explore' | 'detail'
export type Position = [longitude: number, latitude: number, altitudeM: number]

export interface FeatureQuery {
  center: { longitude: number; latitude: number }
  rangeM: number
  band: FeatureBand
  types: FeatureKind[]
}

interface BaseFeature { id: string; label: string; position: Position }

export interface AnimalFeature extends BaseFeature {
  type: 'animal'
  speciesName: string
  observedAt: string
  confidence: number
  thumbnailUrl: string
  imageAlt: string
}
export interface AnimalClusterFeature extends BaseFeature {
  type: 'cluster'
  count: number
  animalIds: string[]
  thumbnailUrl: string
  imageAlt: string
}
export interface CameraFeature extends BaseFeature {
  type: 'camera'
  status: 'online' | 'offline' | 'maintenance'
  lastSeenAt: string
  iconUrl: string
}
export interface SensorFeature extends BaseFeature {
  type: 'sensor'
  sensorType: 'temperature' | 'humidity' | 'acoustic' | 'water-level'
  status: 'online' | 'offline' | 'maintenance'
  value: number
  unit: string
  measuredAt: string
}
export type FeatureEntry = AnimalClusterFeature | AnimalFeature | CameraFeature | SensorFeature

export interface FeatureResponse {
  clusters: AnimalClusterFeature[]
  animals: AnimalFeature[]
  cameras: CameraFeature[]
  sensors: SensorFeature[]
  meta: { requestId: string; generatedAt: string; band: FeatureBand; total: number }
}

export interface FeatureFixture { animals: AnimalFeature[]; cameras: CameraFeature[]; sensors: SensorFeature[] }
export interface FeatureApi { fetchFeatures(query: FeatureQuery, signal: AbortSignal): Promise<FeatureResponse> }
export interface MockFeatureApiOptions { loadFixture?: () => Promise<FeatureFixture>; latencyMs?: number; now?: () => Date }

const EARTH_RADIUS_M = 6_371_008.8
type GeoPoint = Position | { longitude: number; latitude: number }

export function distanceM(left: GeoPoint, right: GeoPoint): number {
  const [leftLon, leftLat] = Array.isArray(left) ? [left[0], left[1]] : [left.longitude, left.latitude]
  const [rightLon, rightLat] = Array.isArray(right) ? [right[0], right[1]] : [right.longitude, right.latitude]
  const lat1 = leftLat * Math.PI / 180
  const lat2 = rightLat * Math.PI / 180
  const dLat = (rightLat - leftLat) * Math.PI / 180
  const dLon = (rightLon - leftLon) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export function responseEntries(response: FeatureResponse): FeatureEntry[] {
  return [...response.clusters, ...response.animals, ...response.cameras, ...response.sensors]
}

function abortError(): DOMException { return new DOMException('Wildlife request aborted', 'AbortError') }

function waitForMockLatency(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError())
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { window.clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(abortError()) }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function isVisible(feature: Pick<BaseFeature, 'position'>, query: FeatureQuery): boolean {
  return distanceM(feature.position, query.center) <= query.rangeM
}

function supportedTypes(band: FeatureBand): Set<FeatureKind> {
  if (band === 'overview') return new Set(['cluster'])
  if (band === 'explore') return new Set(['cluster', 'camera', 'sensor'])
  return new Set(['animal', 'camera', 'sensor'])
}

function clusterAnimals(animals: AnimalFeature[], band: Exclude<FeatureBand, 'detail'>): AnimalClusterFeature[] {
  const radiusM = band === 'overview' ? 420 : 150
  const clusters: AnimalFeature[][] = []
  for (const animal of animals) {
    const cluster = clusters.find((members) => distanceM(animal.position, members[0].position) <= radiusM)
    if (cluster) cluster.push(animal)
    else clusters.push([animal])
  }
  return clusters.map((members, index) => {
    const [longitude, latitude, altitudeM] = members.reduce(
      (total, animal) => [total[0] + animal.position[0], total[1] + animal.position[1], total[2] + animal.position[2]],
      [0, 0, 0] as Position,
    )
    const representative = members[0]
    return {
      id: `cluster:${band}:${index}`,
      type: 'cluster',
      label: `${members.length} animal observations`,
      position: [longitude / members.length, latitude / members.length, altitudeM / members.length],
      count: members.length,
      animalIds: members.map((animal) => animal.id),
      thumbnailUrl: representative.thumbnailUrl,
      imageAlt: representative.imageAlt,
    }
  })
}

async function loadDefaultFixture(): Promise<FeatureFixture> {
  const response = await fetch(`${import.meta.env.BASE_URL}mock/wildlife-features.json`, { cache: 'no-cache' })
  if (!response.ok) throw new Error(`wildlife fixture HTTP ${response.status}`)
  return response.json() as Promise<FeatureFixture>
}

/** Local adapter with the same query/response boundary as the future HTTP API. */
export function createMockFeatureApi(options: MockFeatureApiOptions = {}): FeatureApi {
  const loadFixture = options.loadFixture ?? loadDefaultFixture
  const latencyMs = options.latencyMs ?? 260
  const now = options.now ?? (() => new Date())
  let fixturePromise: Promise<FeatureFixture> | null = null
  let requestSequence = 0
  const fixture = () => (fixturePromise ??= loadFixture())

  return {
    async fetchFeatures(query, signal) {
      const requestId = `mock-wildlife-${++requestSequence}`
      const [source] = await Promise.all([fixture(), waitForMockLatency(latencyMs, signal)])
      if (signal.aborted) throw abortError()
      const enabled = new Set(query.types.filter((type) => supportedTypes(query.band).has(type)))
      const visibleAnimals = source.animals.filter((feature) => isVisible(feature, query))
      const clusters = query.band !== 'detail' && enabled.has('cluster') ? clusterAnimals(visibleAnimals, query.band) : []
      const animals = query.band === 'detail' && enabled.has('animal') ? visibleAnimals : []
      const cameras = enabled.has('camera') ? source.cameras.filter((feature) => isVisible(feature, query)) : []
      const sensors = enabled.has('sensor') ? source.sensors.filter((feature) => isVisible(feature, query)) : []
      return { clusters, animals, cameras, sensors, meta: {
        requestId, generatedAt: now().toISOString(), band: query.band,
        total: clusters.length + animals.length + cameras.length + sensors.length,
      } }
    },
  }
}
