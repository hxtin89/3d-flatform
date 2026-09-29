import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  BOOT_FEATURE_STATE, compiledTermsAtBoot, compiledTermsWanted, type CompiledTerm,
} from './compiled-terms.ts'

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

test('the inspector boots in the state the panel markup starts it in, so boot rebuilds nothing', () => {
  // main.ts's bindSeg writes the uniform from the button marked `on` while the module
  // loads, then syncs the shader terms. Those buttons must match BOOT_FEATURE_STATE, or
  // the first sync rebuilds every tile shader the loader has already built.
  const html = readFileSync(new URL('../../threejs-test.html', import.meta.url), 'utf8')
  const onValue = (seg: string, attribute: string): number => {
    const block = new RegExp(String.raw`id="${seg}"[\s\S]*?</div>`).exec(html)?.[0] ?? ''
    return Number(new RegExp(String.raw`data-${attribute}="(\d+)" class="on"`).exec(block)?.[1])
  }
  assert.equal(onValue('debugModeSeg', 'debug-mode'), BOOT_FEATURE_STATE.debugMode)
  assert.equal(onValue('debugIsolateSeg', 'debug-isolate'), BOOT_FEATURE_STATE.debugIsolate)
})

test('shipped config: vignette and foveation off, so the boot shader has none of the optional terms', () => {
  // A pin on today's config, not on a rule: turning the vignette or foveation on by
  // default is fine, and means updating this.
  assert.deepEqual(compiledTermsAtBoot(), {
    vignette: false, foveaBend: false, debugPalette: false, debugIsolate: false,
  })
})
