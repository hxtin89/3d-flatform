import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PNTSLoaderBase } from '3d-tiles-renderer'

// Taken before the patch goes in, so both parses can run side by side.
const originalParse = (PNTSLoaderBase as any).prototype.parse
const { installPntsParseInPlace, pntsParseCounts } = await import('./pnts-parse.ts')

/** A PNTS laid out as pipeline/build_adaptive_point_hierarchy.py writes it: the JSON
 *  padded so the binary body starts 8-aligned, POSITION then RGB, empty batch table. */
function pnts(count: number, withColour: boolean, rtc = false): ArrayBuffer {
  const json: any = { POINTS_LENGTH: count, POSITION: { byteOffset: 0 } }
  if (withColour) json.RGB = { byteOffset: count * 12 }
  if (rtc) json.RTC_CENTER = [1000.5, -2000.25, 30.125]
  let text = JSON.stringify(json)
  while ((28 + text.length) % 8) text += ' '
  const colourBytes = withColour ? count * 3 : 0
  let binLength = count * 12 + colourBytes
  while (binLength % 8) binLength++
  const total = 28 + text.length + binLength
  const buffer = new ArrayBuffer(total)
  const view = new DataView(buffer)
  view.setUint32(0, 0x73746e70, true)
  view.setUint32(4, 1, true)
  view.setUint32(8, total, true)
  view.setUint32(12, text.length, true)
  view.setUint32(16, binLength, true)
  new Uint8Array(buffer, 28, text.length).set(new TextEncoder().encode(text))
  const bin = 28 + text.length
  const positions = new Float32Array(buffer, bin, count * 3)
  for (let i = 0; i < positions.length; i++) positions[i] = Math.sin(i * 12.9898) * 437.5
  if (withColour) {
    const colours = new Uint8Array(buffer, bin + count * 12, colourBytes)
    for (let i = 0; i < colours.length; i++) colours[i] = (i * 37) & 255
  }
  return buffer
}

function tableValues(result: any, count: number, withColour: boolean) {
  const ft = result.featureTable
  return {
    version: result.version,
    header: ft.header,
    position: Array.from(ft.getData('POSITION', count, 'FLOAT', 'VEC3') as Float32Array),
    colour: withColour ? Array.from(ft.getData('RGB', count, 'UNSIGNED_BYTE', 'VEC3') as Uint8Array) : null,
    rtc: ft.getData('RTC_CENTER', 1, 'FLOAT', 'VEC3'),
    batchCount: result.batchTable.count,
  }
}

test('the install stays off when the library parse no longer returns what it expects', async () => {
  const proto = (PNTSLoaderBase as any).prototype
  // A parse that grew a field: taking it over would silently drop that field.
  proto.parse = function (buffer: ArrayBuffer) {
    return originalParse.call(this, buffer).then((result: any) => ({ ...result, extra: true }))
  }
  try {
    const outcome = await installPntsParseInPlace()
    assert.equal(outcome.on, false)
    assert.match(outcome.reason ?? '', /extra/)
  } finally {
    proto.parse = originalParse
  }
})

test('the in-place parse returns what the copying one does, on the fetched body', async () => {
  assert.deepEqual(await installPntsParseInPlace(), { on: true })
  const descriptor = Object.getOwnPropertyDescriptor((PNTSLoaderBase as any).prototype, 'parse')!
  assert.equal(descriptor.enumerable, false, 'shaped like the class method it replaces')
  const loader = new (PNTSLoaderBase as any)()
  for (const [count, withColour, rtc] of [[75_000, true, false], [1, true, true], [3, false, false], [150_000, true, true]] as const) {
    const buffer = pnts(count, withColour, rtc)
    const before = pntsParseCounts().inPlace
    const patched = await loader.parse(buffer)
    assert.equal(pntsParseCounts().inPlace, before + 1, 'took the in-place path')
    const copied = await originalParse.call(loader, buffer)
    assert.deepEqual(tableValues(patched, count, withColour), tableValues(copied, count, withColour), `${count} points`)
    // The point of it: the tables read the fetched body, not a copy of it.
    assert.equal(patched.featureTable.buffer, buffer)
    assert.notEqual(copied.featureTable.buffer, buffer)
    assert.equal(patched.featureTable.binOffset % 8, 0)
  }
})

test('a malformed tile goes to the original parse, and a second install changes nothing', async () => {
  await installPntsParseInPlace()
  const installed = (PNTSLoaderBase as any).prototype.parse
  assert.deepEqual(await installPntsParseInPlace(), { on: true })
  assert.equal((PNTSLoaderBase as any).prototype.parse, installed, 'not wrapped twice')

  const loader = new (PNTSLoaderBase as any)()
  const buffer = pnts(10, true)
  new DataView(buffer).setUint32(8, buffer.byteLength + 4, true) // byteLength that lies
  const before = pntsParseCounts().fallback
  const originalAssert = console.assert
  console.assert = () => {} // the original parse asserts on it, which is the behaviour kept
  try {
    const result = await loader.parse(buffer)
    assert.equal(pntsParseCounts().fallback, before + 1)
    assert.notEqual(result.featureTable.buffer, buffer, 'the copying parse ran')
  } finally {
    console.assert = originalAssert
  }
  assert.equal(pntsParseCounts().fallback, before + 1)
  // The original throws on it synchronously, and so does the fallback.
  assert.throws(() => loader.parse(new ArrayBuffer(8)), RangeError)
  assert.equal(pntsParseCounts().fallback, before + 2, 'too short for a header')
})
