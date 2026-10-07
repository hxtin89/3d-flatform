import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// globe.ts builds the basemap's colour graph once and caches it under imageryEffectsKey()
// (point-cloud.ts). The effect switches compile their terms out rather than turning them
// down, so the key has to name every flag that graph reads, or a flip hands a rebuilt map
// tile the old graph; and nothing else, or a point-only switch costs the next map tile a
// fresh build. Neither module loads under node (extensionless imports, TSL), so this reads
// their sources: imageryColorNode and every function it calls, transitively.
const read = (file: string) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '')
const GRAPH_SOURCES = ['globe.ts', 'point-cloud.ts', 'sun-shadows.ts', 'sky-clouds.ts'].map(read)

/** A top-level function declaration's source, from its name to its closing brace at column 0. */
function functionSource(name: string): string | null {
  for (const source of GRAPH_SOURCES) {
    const start = new RegExp(String.raw`^(?:export )?function ${name}\(`, 'm').exec(source)
    if (!start) continue
    const rest = source.slice(start.index)
    const end = /^\}\r?$/m.exec(rest)
    assert.ok(end, `${name} has a closing brace at column 0`)
    return rest.slice(0, end.index)
  }
  return null
}

/** The effect flags `name` reads, directly or through the functions it calls. */
function flagsReadBy(name: string, seen = new Set<string>(), flags = new Set<string>()): Set<string> {
  if (seen.has(name)) return flags
  seen.add(name)
  const body = functionSource(name)
  if (body === null) return flags
  for (const m of body.matchAll(/\beffects\.(\w+)|isCloudEffectEnabled\('(\w+)'\)/g)) flags.add(m[1] ?? m[2])
  for (const m of body.matchAll(/\b([A-Za-z_]\w*)\(/g)) flagsReadBy(m[1], seen, flags)
  return flags
}

test('the basemap graph cache is keyed on imageryEffectsKey', () => {
  const graph = functionSource('imageryColorNode')
  assert.ok(graph, 'imageryColorNode is in globe.ts')
  assert.match(graph, /const key = imageryEffectsKey\(\)/)
  assert.match(graph, /imageryGraphCache\.get\(key\)/)
  assert.match(graph, /imageryGraphCache\.set\(key, /)
})

test('the key names exactly the effect flags the basemap graph reads', () => {
  // The key itself is called from imageryColorNode; walking into it would count its own list.
  const graphFlags = [...flagsReadBy('imageryColorNode', new Set(['imageryEffectsKey']))].sort()
  const keyFlags = [...(functionSource('imageryEffectsKey') ?? '').matchAll(/\beffects\.(\w+)/g)]
    .map((m) => m[1]).sort()
  assert.deepEqual(keyFlags, graphFlags)
  // A pin on today's graph: the vignette is compiled out of it while off, so its switch has to
  // rebuild the map; the fovea bend, the inspector's terms and the point-only switches never
  // reach it.
  assert.ok(graphFlags.includes('vignette'))
  for (const pointOnly of ['foveaBend', 'debugPalette', 'debugIsolate', 'roundDots', 'colourField', 'pointGrade', 'exactDecode']) {
    assert.ok(!graphFlags.includes(pointOnly), pointOnly)
  }
})

test('the sky modules the graph calls into read no effect flags of their own', () => {
  // Their helpers are arrow constants, which functionSource does not follow; this keeps that
  // blind spot empty.
  for (const file of ['sun-shadows.ts', 'sky-clouds.ts']) {
    assert.doesNotMatch(read(file), /isCloudEffectEnabled|\beffects\./, file)
  }
})
