import { test } from 'node:test'
import assert from 'node:assert/strict'

import { EXPERIENCE_CONFIG } from './config.ts'
import { compiledTermsAtBoot, compiledTermsWanted, type CompiledTerm } from './compiled-terms.ts'

const OFF = { maskMode: 0, foveation: false, debugMode: 0, debugIsolate: 1 }

test('a default session emits none of the optional terms', () => {
  assert.deepEqual(compiledTermsWanted(OFF), {
    vignette: false, foveaBend: false, debugPalette: false, debugIsolate: false,
  })
})

test('each term follows its own feature and nothing else', () => {
  assert.equal(compiledTermsWanted({ ...OFF, maskMode: 2 }).vignette, true)
  // Mode 1 never reached the vignette branch of the shader either (> 1.5).
  assert.equal(compiledTermsWanted({ ...OFF, maskMode: 1 }).vignette, false)
  assert.equal(compiledTermsWanted({ ...OFF, foveation: true }).foveaBend, true)
  for (const mode of [1, 2]) {
    const flags = compiledTermsWanted({ ...OFF, debugMode: mode })
    assert.equal(flags.debugPalette, true)
    assert.equal(flags.debugIsolate, true, 'isolate defaults to terminal-only')
    assert.equal(flags.vignette || flags.foveaBend, false)
  }
  assert.equal(compiledTermsWanted({ ...OFF, debugMode: 1, debugIsolate: 0 }).debugIsolate, false)
  // The isolate cut is never emitted without the inspector: it discards.
  assert.equal(compiledTermsWanted({ ...OFF, debugIsolate: 2 }).debugIsolate, false)
})

test('a forced term stays in with its feature off, and only that one', () => {
  for (const term of ['vignette', 'foveaBend', 'debugPalette'] as CompiledTerm[]) {
    const flags = compiledTermsWanted(OFF, new Set([term]))
    for (const other of ['vignette', 'foveaBend', 'debugPalette'] as CompiledTerm[]) {
      assert.equal(flags[other], other === term, `${term} forced, ${other}`)
    }
    assert.equal(flags.debugIsolate, false, 'forcing never brings the discard in')
  }
})

test('the boot flags are what the configured session asks for, so boot rebuilds nothing', () => {
  assert.deepEqual(compiledTermsAtBoot(), compiledTermsWanted({
    maskMode: EXPERIENCE_CONFIG.design.maskMode,
    foveation: EXPERIENCE_CONFIG.lod.foveation.enabled,
    debugMode: 0,
    debugIsolate: 1,
  }))
  // Shipped config: vignette and foveation off, so the boot shader has none of the three.
  assert.deepEqual(compiledTermsAtBoot(), {
    vignette: false, foveaBend: false, debugPalette: false, debugIsolate: false,
  })
})
