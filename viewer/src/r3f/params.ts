// URL / environment parameters of the React app, parsed once at module load.
// Port of the config block at the top of src/threejs-test/main.ts, minus the
// field models and the model editor, which the React app does not carry.
import * as THREE from 'three'
import { getMapTilerKey } from '../maptiler-key'
import { EXPERIENCE_CONFIG } from '../threejs-test/config'
import {
  assetUrl as shapeAssetUrl,
  fetchDonationShape,
  type DonationShapeSource,
} from '../threejs-test/donation-shape-data'
import type { MouseOrbitPivot } from '../threejs-test/smoothed-globe-controls'
import type { ZoomBand } from '../threejs-test/point-source'
import { configuredWorldDatasets } from './world-datasets'

const params = new URLSearchParams(location.search)
const domain = (import.meta.env.VITE_AWS_MEDIA_CLOUDFRONT_DISTRIBUTION_DOMAIN ?? '')
  .replace(/^https?:\/\//, '').replace(/\/+$/, '')
const folder = (import.meta.env.VITE_POINTCLOUD_TILES_FOLDER ?? 'pointcloud-tiles').replace(/^\/+|\/+$/g, '')
const baseUrl = domain ? `https://${domain}/${folder}` : ''

const easeParam = Number(params.get('ease'))
const rotParam = Number(params.get('rot'))
const debugProgressRaw = import.meta.env.DEV ? params.get('eagleProgress') : null
const debugProgressParsed = debugProgressRaw === null ? Number.NaN : Number(debugProgressRaw)
const freeOrbit = params.has('freeorbit')
const datasetOverride = params.get('dataset')
const worldDatasets = configuredWorldDatasets(datasetOverride)
const dataset = worldDatasets[0].logicalDataset
const donationShapeOverride = params.get('shape')?.trim() || null
const donationShapeUrl = donationShapeOverride ?? shapeAssetUrl(EXPERIENCE_CONFIG.donationShape.sourcePath)

export const APP_PARAMS = Object.freeze({
  params,
  baseUrl,
  maptilerKey: getMapTilerKey(),
  dataset,
  worldDatasets,
  initialDatasetId: worldDatasets[0].id,
  singleDatasetMode: Boolean(datasetOverride),
  /** 3DGS feasibility test model (Spark, own WebGL overlay). */
  gaussianSplatUrl: baseUrl ? `${baseUrl}/ply-result/point_cloud/iteration_100/point_cloud_5.ply` : '',
  pointTree: (params.get('tree') === 'one-lod' ? 'one-lod' : 'aph') as 'aph' | 'one-lod',
  forceWebGL: params.has('webgl'),
  groundSnap: !params.has('nosnap'),
  noOrigin: params.has('noorigin'),
  /** Diagnostics: lifts the orbit ceiling, navigation floor and zoom stop. */
  freeOrbit,
  mouseOrbitEaseMs: params.has('ease') && Number.isFinite(easeParam)
    ? Math.max(0, easeParam)
    : EXPERIENCE_CONFIG.navigation.mouseOrbitEaseMs,
  mouseRotationSpeed: params.has('rot') && Number.isFinite(rotParam) && rotParam > 0
    ? rotParam
    : EXPERIENCE_CONFIG.navigation.mouseRotationSpeed,
  mouseInertia: params.has('inertia')
    ? params.get('inertia') !== '0'
    : EXPERIENCE_CONFIG.navigation.mouseInertia,
  mouseOrbitPivot: (params.get('pivot') === 'cursor' ? 'cursor' : params.get('pivot') === 'center' ? 'center' : 'canopy') as MouseOrbitPivot,
  /** Donor story (spring camera) instead of the plain approach; ?intro=0 disables. */
  storyEnabled: EXPERIENCE_CONFIG.story.enabled && params.get('intro') !== '0',
  /** ?scrub=1 shows the story replay slider. */
  scrubber: params.get('scrub') === '1',
  /** The panel is always available; ?panel=1 merely opens it at startup. */
  panelEnabled: true,
  panelInitiallyOpen: params.get('panel') === '1',
  /** ?compare=1: no loader benchmark, no boot DPR cap, compare mode on. */
  compareParam: params.get('compare') === '1',
  showDiagnostics: freeOrbit || params.has('diag') || import.meta.env.DEV,
  reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  compactViewport: matchMedia('(max-width: 700px)').matches,
  donationShapeUrl,
  loaderDebugProgress: Number.isFinite(debugProgressParsed)
    ? THREE.MathUtils.clamp(debugProgressParsed, 0, 1)
    : null,
  /** ?zoom0=area:detail … shareable density-pack assignments. */
  zoomAssignments: ([0, 1, 2] as ZoomBand[]).map((band) => [band, params.get(`zoom${band}`)] as const)
    .filter((entry): entry is readonly [ZoomBand, string] => Boolean(entry[1])),
  fieldVideoUrl: 'https://d2ijqnyf2ixq2j.cloudfront.net/media/smaller-image-bettter/WI-Imagefilm-WebsiteHeaderHD.mp4',
})

/** Started at module load, before the renderer initialises, so the story can
 * be aimed at the parcel without the boot sequence waiting on it. */
export const donationShapePromise: Promise<DonationShapeSource | null> = dataset === 'peru-b2-globe' || donationShapeOverride
  ? fetchDonationShape(donationShapeUrl)
    .catch((error) => {
      console.warn('[donation-shape] source unavailable', donationShapeUrl, error)
      return null
    })
  : Promise.resolve(null)
