import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'

// Published-data smoke, independent of a running browser or tile server.
const tilesRoot = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '../../local-storage/tilesets'))
const ids = [
  'peru-b2-globe', '202508-usk-globe', 'prio-z2-globe',
  '202606-manu-z2-globe', '202606-manu-z4-globe', '202606-manu-z5-globe',
]
const manifests = new Map()

for (const id of ids) {
  const manifest = JSON.parse(await readFile(join(tilesRoot, id, 'area-manifest.json'), 'utf8'))
  assert.equal(manifest.rootTransform?.length, 16, `${id}: missing ENU→ECEF transform`)
  assert.ok(manifest.areas?.length, `${id}: no survey areas`)
  const aphDir = join(tilesRoot, id, `${id}-adaptive-point-hierarchy`)
  const root = JSON.parse(await readFile(join(aphDir, 'tileset.json'), 'utf8'))
  const z0 = root.root?.children?.find((child) => /^z0\/.+\.json$/.test(child.content?.uri ?? ''))
  assert.ok(z0, `${id}: no z0 overview subtree`)
  const overview = JSON.parse(await readFile(join(aphDir, z0.content.uri), 'utf8'))
  assert.match(overview.root?.content?.uri ?? '', /points\/z0\/.+\.pnts$/, `${id}: z0 overview has no PNTS`)
  manifests.set(id, manifest)
}

function bounds(manifest) {
  return manifest.areas.reduce((box, area) => {
    const value = area.bbox
    if (!Array.isArray(value) || value.length !== 6) return box
    return box ? [Math.min(box[0], value[0]), Math.min(box[1], value[1]),
      Math.max(box[2], value[3]), Math.max(box[3], value[4])]
      : [value[0], value[1], value[3], value[4]]
  }, null)
}

const z2 = manifests.get('202606-manu-z2-globe')
const z4 = manifests.get('202606-manu-z4-globe')
const z2Box = bounds(z2)
const z4Box = bounds(z4)
const z4ToZ2 = new THREE.Matrix4().fromArray(z2.rootTransform).invert()
  .multiply(new THREE.Matrix4().fromArray(z4.rootTransform))
const corners = [
  [z4Box[0], z4Box[1]], [z4Box[0], z4Box[3]],
  [z4Box[2], z4Box[1]], [z4Box[2], z4Box[3]],
].map(([x, y]) => new THREE.Vector3(x, y, 0).applyMatrix4(z4ToZ2))
const z4InZ2 = [
  Math.min(...corners.map((corner) => corner.x)), Math.min(...corners.map((corner) => corner.y)),
  Math.max(...corners.map((corner) => corner.x)), Math.max(...corners.map((corner) => corner.y)),
]
assert.ok(z2Box[0] <= z4InZ2[2] && z2Box[2] >= z4InZ2[0]
  && z2Box[1] <= z4InZ2[3] && z2Box[3] >= z4InZ2[1],
'Z2 and Z4 published survey footprints no longer touch')

console.log(JSON.stringify({ ok: true, sites: ids.length, firstPair: ['manu-z2', 'manu-z4'],
  z2Box, z4InZ2 }, null, 2))
