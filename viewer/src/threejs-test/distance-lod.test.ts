import { describe, expect, it } from 'vitest'
import { installDistanceLod, isAphOverviewBackgroundUriAllowed } from './distance-lod'

describe('APH background traversal policy', () => {
  it('allows only external z0 documents and p001 content', () => {
    expect(isAphOverviewBackgroundUriAllowed('z0/z0_x000001_y000001/tileset-no-vrv.json')).toBe(true)
    expect(isAphOverviewBackgroundUriAllowed('../../points/z0/z0_x000001_y000001.pnts')).toBe(true)
    expect(isAphOverviewBackgroundUriAllowed('../../points/adaptive/z0_x000001_y000001/d2_q3.pnts')).toBe(false)
    expect(isAphOverviewBackgroundUriAllowed('points/adaptive/tileset.json')).toBe(false)
  })

  it('removes an adaptive tile from traversal before its content can be requested', () => {
    const tiles = {
      errorTarget: 16,
      calculateTileViewError: (_tile: unknown, target: { inView: boolean; error: number }) => {
        target.inView = true
        target.error = 12
      },
    }
    const lod = installDistanceLod(tiles)
    lod.setTraversalPolicy('aph-overview-background')

    const adaptive = { content: { uri: 'points/adaptive/z0_x000001_y000001/d2_q3.pnts' } }
    const adaptiveTarget = { inView: false, error: 0, distanceFromCamera: 100 }
    tiles.calculateTileViewError(adaptive, adaptiveTarget)
    expect(adaptiveTarget).toMatchObject({ inView: false, error: 0 })

    const p001 = { content: { uri: 'points/z0/z0_x000001_y000001.pnts' } }
    const p001Target = { inView: false, error: 0, distanceFromCamera: 100 }
    tiles.calculateTileViewError(p001, p001Target)
    expect(p001Target).toMatchObject({ inView: true, error: 12 })
  })
})
