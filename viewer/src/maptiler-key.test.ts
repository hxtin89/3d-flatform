import { afterEach, describe, expect, it, vi } from 'vitest'
import { getMapTilerKey } from './maptiler-key'

afterEach(() => vi.unstubAllEnvs())
describe('MapTiler deployment key selection', () => {
  it('always uses the primary key for production, including localhost previews', () => {
    vi.stubEnv('PROD', true)
    vi.stubEnv('VITE_MAPTILER_API_KEY', ' production ')
    vi.stubEnv('VITE_MAPTILER_API_KEY_LOCAL', 'local')
    for (const host of ['localhost', '127.0.0.1', '[::1]', 'wilderness-prototype.de']) {
      expect(getMapTilerKey(host)).toBe('production')
    }
  })
  it('uses the local key only on development loopback hosts', () => {
    vi.stubEnv('PROD', false)
    vi.stubEnv('VITE_MAPTILER_API_KEY', 'production')
    vi.stubEnv('VITE_MAPTILER_API_KEY_LOCAL', ' local ')
    for (const host of ['localhost', '127.0.0.1', '[::1]']) expect(getMapTilerKey(host)).toBe('local')
    expect(getMapTilerKey('wilderness-prototype.de')).toBe('production')
    expect(getMapTilerKey('localhost.example.com')).toBe('production')
  })
  it('falls back to the primary key when no local key is configured', () => {
    vi.stubEnv('PROD', false)
    vi.stubEnv('VITE_MAPTILER_API_KEY', 'production')
    vi.stubEnv('VITE_MAPTILER_API_KEY_LOCAL', '')
    expect(getMapTilerKey('localhost')).toBe('production')
  })
})
