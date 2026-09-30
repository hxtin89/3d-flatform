import { BatchTable, FeatureTable, PNTSLoaderBase } from '3d-tiles-renderer'

/**
 * Parse PNTS tiles without copying their bytes a second time.
 *
 * 3d-tiles-renderer 0.4.28's `PNTSLoaderBase.parse` hands its feature and batch tables a
 * `buffer.slice()` of the fetched body — for our tiles that is the whole file again, 15
 * bytes a point (1.1 / 2.2 / 3.9 MiB at 75k / 150k / 270k points), made in the tile's
 * arrival frame and dropped a few microtasks later once the app has packed the points
 * (streaming.ts nulls the tables). Both tables take a start offset, so they can read the
 * fetched body in place instead; every accessor goes through that offset.
 *
 * What it buys is memory, not time: about 100 MB less garbage per 90-tile drag, and so
 * fewer large collections. Time comes out even — the parse drops from about 0.6 ms to
 * under 0.05 ms a tile, but the pack then reads the fetched body cold instead of a copy
 * the parse has just written, and gives most of it back (interleaved in one page,
 * 2026-09-30: the two sat within each other's noise).
 *
 * It applies to every PNTS any TilesRenderer parses. It only goes in if the library's
 * own parse still behaves as this expects (probed at install), anything that does not
 * look like a well-formed PNTS goes to the original, asserts and all, and it can be
 * removed once 3d-tiles-renderer builds the tables in place itself.
 */
const IN_PLACE = Symbol('sbb.pntsInPlace')
const counts = { inPlace: 0, fallback: 0 }

/** How many tiles took the in-place path and how many fell back, for __cost. */
export function pntsParseCounts(): { inPlace: number; fallback: number } {
  return { ...counts }
}

/** Resolves to whether the in-place parse is on, and if not why. */
export async function installPntsParseInPlace(): Promise<{ on: boolean; reason?: string }> {
  const proto = (PNTSLoaderBase as any).prototype
  const descriptor = proto && Object.getOwnPropertyDescriptor(proto, 'parse')
  const original = descriptor?.value
  if (typeof original !== 'function') return { on: false, reason: 'no parse to replace' }
  // A second install (a hot reload) keeps the first.
  if (original[IN_PLACE]) return { on: true }

  function parse(this: unknown, buffer: ArrayBuffer): Promise<unknown> {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 28) {
      counts.fallback++
      return original.call(this, buffer)
    }
    const view = new DataView(buffer)
    const featureJson = view.getUint32(12, true)
    const featureBin = view.getUint32(16, true)
    const batchJson = view.getUint32(20, true)
    const batchBin = view.getUint32(24, true)
    const batchStart = 28 + featureJson + featureBin
    const wellFormed = view.getUint32(0, true) === 0x73746e70 // 'pnts', little-endian
      && view.getUint32(4, true) === 1
      && view.getUint32(8, true) === buffer.byteLength
      && batchStart + batchJson + batchBin <= buffer.byteLength
    if (!wellFormed) {
      counts.fallback++
      return original.call(this, buffer)
    }
    try {
      // The original's construction, on the fetched body at the tables' own offsets.
      const featureTable = new FeatureTable(buffer, 28, featureJson, featureBin)
      const batchTable = new BatchTable(
        buffer,
        (featureTable as any).getData('BATCH_LENGTH') || (featureTable as any).getData('POINTS_LENGTH'),
        batchStart,
        batchJson,
        batchBin,
      )
      counts.inPlace++
      return Promise.resolve({ version: 1, featureTable, batchTable })
    } catch {
      counts.fallback++
      return original.call(this, buffer)
    }
  }

  // Probe both on a one-point tile before switching: the original must still return
  // exactly these three fields on a copy (else there is nothing to save, or a field this
  // would drop), and the replacement must read the same values out of it.
  try {
    const probe = onePointPnts()
    const expected: any = await original.call(Object.create(proto), probe)
    const fields = Object.keys(expected ?? {}).sort().join()
    if (fields !== 'batchTable,featureTable,version') return { on: false, reason: `parse now returns ${fields}` }
    if (expected.featureTable.buffer === probe) return { on: false, reason: 'parse already reads in place' }
    const got: any = await parse.call(Object.create(proto), probe)
    counts.inPlace = 0
    const same = JSON.stringify(got.featureTable.header) === JSON.stringify(expected.featureTable.header)
      && String(got.featureTable.getData('POSITION', 1, 'FLOAT', 'VEC3'))
        === String(expected.featureTable.getData('POSITION', 1, 'FLOAT', 'VEC3'))
      && got.batchTable.count === expected.batchTable.count
    if (!same) return { on: false, reason: 'the in-place tables read differently' }
  } catch (error) {
    return { on: false, reason: `probe failed: ${error}` }
  }

  ;(parse as any)[IN_PLACE] = true
  // Same shape as the class method it replaces: non-enumerable, and so on.
  Object.defineProperty(proto, 'parse', { ...descriptor, value: parse })
  return { on: true }
}

/** The smallest well-formed PNTS: one point, as the pipeline lays tiles out. */
function onePointPnts(): ArrayBuffer {
  let json = JSON.stringify({ POINTS_LENGTH: 1, POSITION: { byteOffset: 0 } })
  while ((28 + json.length) % 8) json += ' '
  const binLength = 16 // 12 bytes of position, padded to 8
  const buffer = new ArrayBuffer(28 + json.length + binLength)
  const view = new DataView(buffer)
  view.setUint32(0, 0x73746e70, true)
  view.setUint32(4, 1, true)
  view.setUint32(8, buffer.byteLength, true)
  view.setUint32(12, json.length, true)
  view.setUint32(16, binLength, true)
  new Uint8Array(buffer, 28, json.length).set(new TextEncoder().encode(json))
  new Float32Array(buffer, 28 + json.length, 3).set([1.5, -2.25, 3.125])
  return buffer
}
