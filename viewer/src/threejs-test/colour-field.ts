// The colour field: a small gain texture that evens out the survey's acquisition drift and
// matches the point cloud to the basemap at landscape scale. Built offline per dataset by
// pipeline/build_colour_field.py; see design.colourMatch in config.ts for what it does.
import * as THREE from 'three'

/** `<dataset>.json` as the builder writes it. */
export interface ColourFieldMeta {
  dataset: string
  /** ENU metres of the texture's lower-left corner, in the tileset's own frame. */
  origin: [number, number]
  /** Ground size the texture covers, in metres. */
  size: [number, number]
  texels: [number, number]
  encoding: { kind: 'log2-gain-rgb8'; stops: number; zero: number }
  /** Linear per-channel gain that lifts the raw basemap to the cloud's level. */
  basemapGain: [number, number, number]
  /** Saturation the basemap was matched at (1 = raw); the viewer applies the same factor. */
  basemapSaturation?: number
}

export interface ColourField {
  meta: ColourFieldMeta
  texture: THREE.DataTexture
}

/**
 * Load the field for a dataset, or null when it has none (a 404 is the normal case for a
 * dataset nobody has built one for, and leaves the cloud as captured).
 *
 * Decoded into a DataTexture rather than uploaded as an image: an image texture's flipY
 * is honoured differently by the two backends (see the note in globe.ts), and this way
 * row 0 is the PNG's first row — north — on both.
 */
export async function loadColourField(dataset: string, dir: string): Promise<ColourField | null> {
  const base = `${import.meta.env.BASE_URL.replace(/\/?$/, '/')}${dir.replace(/\/?$/, '/')}`
  const response = await fetch(`${base}${dataset}.json`)
  if (!response.ok) return null
  const meta = await response.json() as ColourFieldMeta
  if (meta.encoding?.kind !== 'log2-gain-rgb8') throw new Error(`colour field: unknown encoding ${meta.encoding?.kind}`)
  const image = await fetch(`${base}${dataset}.png`).then((r) => {
    if (!r.ok) throw new Error(`colour field: ${dataset}.png ${r.status}`)
    return r.blob()
  }).then((blob) => createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }))
  const [w, h] = [image.width, image.height]
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb' } as CanvasRenderingContext2DSettings)
  if (!ctx) throw new Error('colour field: no 2D context')
  ctx.drawImage(image, 0, 0)
  image.close()
  const pixels = new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer)
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
