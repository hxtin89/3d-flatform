import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ATMOSPHERE_TOP_KM, DEFAULT_ATMOSPHERE, PLANET_RADIUS_KM, atmosphereParameters, ellipsoidHeight, luminance,
  referenceIlluminance, skyViewParams, skyViewUv, sunIlluminance, transmittance, transmittanceRMu, transmittanceUv,
} from './atmosphere-model.ts'

const p = atmosphereParameters(DEFAULT_ATMOSPHERE)
const ground = PLANET_RADIUS_KM + 0.001

test('the aerosol optical depth comes back out of the zenith transmittance', () => {
  const clean = atmosphereParameters({ ...DEFAULT_ATMOSPHERE, aerosolDepth: 0, ozoneScale: 0 })
  const hazy = atmosphereParameters({ ...DEFAULT_ATMOSPHERE, ozoneScale: 0 })
  const [, gClean] = transmittance(clean, ground, 1, 400)
  const [, gHazy] = transmittance(hazy, ground, 1, 400)
  // The ratio of the two is the aerosols' own transmittance: e^(−AOD) at 550 nm.
  assert.ok(Math.abs(-Math.log(gHazy / gClean) - DEFAULT_ATMOSPHERE.aerosolDepth) < 0.003)
  // Molecular air alone: optical depth β·H ≈ 13.558e-3 · 8 ≈ 0.108 at 550 nm.
  assert.ok(Math.abs(-Math.log(gClean) - 13.558e-3 * 8) < 0.005)
})

test('a low sun is redder and dimmer than a high one, and gone below the limb', () => {
  const noon = sunIlluminance(p, 0, Math.PI / 2.2)
  const low = sunIlluminance(p, 0, (4 * Math.PI) / 180)
  assert.ok(luminance(low) < luminance(noon) * 0.6)
  assert.ok(low[2] / low[0] < noon[2] / noon[0])
  assert.deepEqual(sunIlluminance(p, 0, (-2 * Math.PI) / 180), [0, 0, 0])
  // From 18 km the horizon dips by ~4.3°: a sun 2° below the horizontal is still up there.
  assert.ok(luminance(sunIlluminance(p, 18, (-2 * Math.PI) / 180)) > 0.1)
})

test('the exposure anchor lies between the overhead sun and nothing', () => {
  const e = referenceIlluminance(p)
  assert.ok(e > 0.4 && e < 1.2, String(e))
})

test('the transmittance LUT mapping round-trips', () => {
  for (const r of [ground, PLANET_RADIUS_KM + 2, PLANET_RADIUS_KM + 30, ATMOSPHERE_TOP_KM - 1]) {
    for (const mu of [1, 0.5, 0.05, 0]) {
      const [u, v] = transmittanceUv(p, r, mu)
      const [r2, mu2] = transmittanceRMu(p, u, v)
      assert.ok(Math.abs(r2 - r) < 1e-6 * r, `r ${r}`)
      assert.ok(Math.abs(mu2 - mu) < 1e-4, `mu ${mu} → ${mu2}`)
    }
  }
})

test('the sky-view mapping round-trips and puts the horizon at v = 0.5', () => {
  for (const r of [ground, PLANET_RADIUS_KM + 1, PLANET_RADIUS_KM + 18]) {
    const horizonMu = -Math.sqrt(1 - (PLANET_RADIUS_KM / r) ** 2)
    assert.ok(Math.abs(skyViewUv(p, false, horizonMu, 0, r)[1] - 0.5) < 1e-6)
    for (const [mu, ground_] of [[0.9, false], [0.2, false], [horizonMu - 0.05, true], [-0.8, true]] as const) {
      for (const cosLight of [1, 0.3, -0.7]) {
        const [u, v] = skyViewUv(p, ground_, mu, cosLight, r)
        const [mu2, cosLight2] = skyViewParams(p, u, v, r)
        assert.ok(Math.abs(mu2 - mu) < 1e-6, `mu ${mu} at ${r}: ${mu2}`)
        assert.ok(Math.abs(cosLight2 - cosLight) < 1e-6)
      }
    }
  }
})

test('ellipsoid height of a point on and above the WGS84 surface', () => {
  // Lima-ish latitude and longitude, on the ellipsoid and 1 km above it.
  const lat = (-12 * Math.PI) / 180
  const lon = (-71 * Math.PI) / 180
  const a = 6_378_137
  const e2 = (1 / 298.257223563) * (2 - 1 / 298.257223563)
  const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2)
  for (const h of [0, 1000, 18_000]) {
    const x = (n + h) * Math.cos(lat) * Math.cos(lon)
    const y = (n + h) * Math.cos(lat) * Math.sin(lon)
    const z = (n * (1 - e2) + h) * Math.sin(lat)
    assert.ok(Math.abs(ellipsoidHeight(x, y, z) - h) < 0.01, `h ${h}: ${ellipsoidHeight(x, y, z)}`)
  }
})
