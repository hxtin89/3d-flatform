// The colour field: a small gain texture that evens out the survey's acquisition drift and
// matches the point cloud to the basemap at landscape scale. Built offline per dataset by
// pipeline/build_colour_field.py; see design.colourMatch in config.ts for what it does.
import * as THREE from 'three'
import type { OrthoMeta } from './ortho-plan'

/** `<dataset>.json` as the builder writes it. */
export interface ColourFieldMeta {
  dataset: string
  /** ENU metres of the texture's lower-left corner, in the tileset's own frame. */
  origin: [number, number]
  /** Ground size the texture covers, in metres. */
  size: [number, number]
  texels: [number, number]
  /** A texel decodes as (code − zero) / scale · stops, in stops (log2 gain). Older fields
   *  carry no `scale`; theirs is 127.5 around a zero of 127.5. `meanCode` is the per-channel
   *  mean the builder wrote, to catch a browser that alters canvas readback. */
  encoding: { kind: 'log2-gain-rgb8'; stops: number; zero: number; scale?: number; meanCode?: [number, number, number] }
  /** Linear per-channel gain that lifts the raw basemap to the cloud's level, measured at
   *  the builder's reference zoom. */
  basemapGain: [number, number, number]
  /** The same gain measured per XYZ zoom (keys are zooms), because MapTiler's satellite
   *  changes colour between levels. */
  basemapGainByZoom?: Record<string, [number, number, number]>
  /** Saturation the basemap was matched at (1 = raw); the viewer applies the same factor. */
  basemapSaturation?: number
  /** The tileset's ENU→ECEF matrix the field was built in (column-major 16). */
  rootTransform?: number[]
  /** Short hash of the PNG, so the texture can never come from a different build than this
   *  metadata (the two files are cached independently in production). */
  pngHash?: string
  /** The drone orthos composited into the basemap, and their fields (ortho-composite.ts). */
  ortho?: OrthoMeta
}

export interface ColourField {
  meta: ColourFieldMeta
  texture: THREE.DataTexture
}

/** Same normalisation the manifest applies to `?dataset=`. */
export function cleanDatasetName(dataset: string): string {
  return dataset.replace(/^\/+|\/+$/g, '')
}

/**
 * Load the field for a dataset, or null when it has none (a 404 is the normal case for a
 * dataset nobody has built one for, and leaves the cloud as captured) or when the browser
 * will not let the page read the decoded codes back unaltered.
 *
 * Decoded into a DataTexture rather than uploaded as an image: an image texture's flipY
 * is honoured differently by the two backends (see the note in globe.ts), and this way
 * row 0 is the PNG's first row — north — on both.
 */
export async function loadColourField(dataset: string, dir: string): Promise<ColourField | null> {
  const name = cleanDatasetName(dataset)
  const base = `${import.meta.env.BASE_URL.replace(/\/?$/, '/')}${dir.replace(/\/?$/, '/')}`
  // Placement data, like the area manifest: always revalidated.
  const response = await fetch(`${base}${name}.json`, { cache: 'no-cache' })
  if (!response.ok) return null
  // A static server's SPA fallback answers a missing file with index.html and 200.
  if (!(response.headers.get('content-type') ?? '').includes('json')) return null
  const meta = await response.json() as ColourFieldMeta
  if (meta.encoding?.kind !== 'log2-gain-rgb8') throw new Error(`colour field: unknown encoding ${meta.encoding?.kind}`)
  const version = meta.pngHash ? `?v=${meta.pngHash}` : ''
  const image = await fetch(`${base}${name}.png${version}`).then((r) => {
    if (!r.ok) throw new Error(`colour field: ${name}.png ${r.status}`)
    return r.blob()
  }).then((blob) => createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }))
  const [w, h] = [image.width, image.height]
  if (meta.texels && (meta.texels[0] !== w || meta.texels[1] !== h)) {
    image.close()
    throw new Error(`colour field: ${name}.png is ${w}x${h}, the metadata says ${meta.texels.join('x')}`)
  }
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true } as CanvasRenderingContext2DSettings)
  if (!ctx) throw new Error('colour field: no 2D context')
  ctx.drawImage(image, 0, 0)
  image.close()
  const pixels = new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer)
  // Privacy modes (Firefox resistFingerprinting) can hand back placeholder data, which would
  // decode as +3 stops on every point. LSB noise moves the mean by far less than two codes.
  if (meta.encoding.meanCode) {
    const sums = [0, 0, 0]
    for (let i = 0; i < pixels.length; i += 4) { sums[0] += pixels[i]; sums[1] += pixels[i + 1]; sums[2] += pixels[i + 2] }
    const n = pixels.length / 4
    if (sums.some((sum, c) => Math.abs(sum / n - meta.encoding.meanCode![c]) > 2)) {
      console.warn('[colour match] the colour field reads back differently from the file (canvas readback blocked or altered by the browser); the cloud stays as captured.')
      return null
    }
  }
  const texture = new THREE.DataTexture(pixels, w, h, THREE.RGBAFormat, THREE.UnsignedByteType)
  // Codes, not colour: no decode, and bilinear between texels so the gain has no steps.
  texture.colorSpace = THREE.NoColorSpace
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.flipY = false
  texture.needsUpdate = true
  return { meta, texture }
}

/** True when the field was built in this ENU frame, or carries no frame to compare. */
export function colourFieldMatchesFrame(meta: ColourFieldMeta, rootTransform: ArrayLike<number>): boolean {
  const built = meta.rootTransform
  if (!built || built.length !== 16) return true
  for (let i = 0; i < 16; i++) {
    const tolerance = i >= 12 && i <= 14 ? 0.01 : 1e-9 // centimetres for the origin
    if (Math.abs(built[i] - rootTransform[i]) > tolerance) return false
  }
  return true
}
