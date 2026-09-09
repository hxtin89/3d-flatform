import { afterEach, describe, expect, it, vi } from 'vitest'

const shape = vi.hoisted(() => vi.fn().mockResolvedValue(null))
vi.mock('../threejs-test/donation-shape-data', () => ({
  assetUrl: (path: string) => path, fetchDonationShape: shape,
}))
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

async function load(search: string) {
  vi.resetModules()
  vi.stubGlobal('location', { search, hostname: 'localhost' })
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  const params = await import('./params')
  await params.donationShapePromise
  return params
}

describe('dataset-specific parcel loading', () => {
  it('keeps the default Peru parcel', async () => {
    await load('')
    expect(shape).toHaveBeenCalledOnce()
  })
  it('does not fly another dataset to the Peru parcel', async () => {
    const result = await load('?dataset=another-survey&shape=%20%20')
    expect(result.APP_PARAMS.dataset).toBe('another-survey')
    expect(shape).not.toHaveBeenCalled()
    expect(await result.donationShapePromise).toBeNull()
  })
  it('honours an explicit parcel override on another survey', async () => {
    await load('?dataset=another-survey&shape=%2Fcustom.geojson')
    expect(shape).toHaveBeenCalledWith('/custom.geojson')
  })
})
