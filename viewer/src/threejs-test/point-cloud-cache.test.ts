import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'

test('cloud materials use graphs belonging to their exact uniform set', async () => {
  // Vite resolves point-cloud.ts's browser-style extensionless imports without opening a
  // viewer or a WebSocket port. Inspect the actual nodes attached to each material.
  const vite = await createServer({
    configFile: false,
    appType: 'custom',
    server: { middlewareMode: true, ws: false } as any,
  })
  const materials: Array<{ dispose(): void }> = []
  let restoreDome: (() => void) | null = null
  try {
    const {
      createUniforms, createCloudMaterial, rebuildEffectMaterial,
      dropPulledCloudGraphs, dropCloudGraphsForUniforms, setCloudEffectEnabled,
    } = await vite.ssrLoadModule('/src/threejs-test/point-cloud.ts')
    const make = (uniforms: any, mode?: any) => {
      const material = createCloudMaterial(uniforms, 3, undefined, undefined, mode)
      materials.push(material)
      return material
    }
    const nodes = (material: any) => [material.sizeNode, material.positionNode, material.colorNode]
    const peru = createUniforms()
    const z2 = createUniforms()
    const z4 = createUniforms()
    const peruMaterial = make(peru)
    const z2First = make(z2)
    const z2Second = make(z2)
    const z4Material = make(z4)

    for (let i = 0; i < 3; i++) {
      assert.strictEqual(nodes(z2First)[i], nodes(z2Second)[i], 'one site reuses its graph')
      assert.notStrictEqual(nodes(peruMaterial)[i], nodes(z2First)[i], 'Peru and Z2 must not share nodes')
      assert.notStrictEqual(nodes(z2First)[i], nodes(z4Material)[i], 'Z2 and Z4 must not share nodes')
    }

    const beforeRebuild = nodes(z2First)
    assert.equal(setCloudEffectEnabled('sphereFade', false), true)
    restoreDome = () => { setCloudEffectEnabled('sphereFade', true) }
    rebuildEffectMaterial(z2First)
    const afterRebuild = nodes(z2First)
    for (let i = 0; i < 3; i++) {
      assert.notStrictEqual(afterRebuild[i], beforeRebuild[i], 'rebuild must attach new nodes to the material')
      assert.strictEqual(nodes(z2Second)[i], beforeRebuild[i], 'another material is unchanged until rebuilt')
    }
    rebuildEffectMaterial(z2Second)
    for (let i = 0; i < 3; i++) {
      assert.strictEqual(nodes(z2Second)[i], afterRebuild[i], 'rebuilt materials in one site share the new graph')
    }
    rebuildEffectMaterial(z4Material)
    for (let i = 0; i < 3; i++) {
      assert.notStrictEqual(nodes(z4Material)[i], afterRebuild[i], 'rebuild keeps Z4 on its own uniform set')
    }

    const pulled = { shape: 'quad', feed: 'pulled' }
    const z2Pulled = make(z2, pulled)
    const z4Pulled = make(z4, pulled)
    const z2Instanced = make(z2)
    const oldZ2Pulled = nodes(z2Pulled)
    const oldZ4Pulled = nodes(z4Pulled)
    const oldZ2Instanced = nodes(z2Instanced)
    dropPulledCloudGraphs(z2)
    const z2Reloaded = make(z2, pulled)
    const z4StillCached = make(z4, pulled)
    const z2StillInstanced = make(z2)
    for (let i = 0; i < 3; i++) {
      assert.notStrictEqual(nodes(z2Reloaded)[i], oldZ2Pulled[i], 'Z2 pulled cache was evicted')
      assert.strictEqual(nodes(z2Pulled)[i], oldZ2Pulled[i], 'eviction does not mutate a live material')
      assert.strictEqual(nodes(z4StillCached)[i], oldZ4Pulled[i], 'Z4 pulled cache remains in use')
      assert.strictEqual(nodes(z2StillInstanced)[i], oldZ2Instanced[i], 'Z2 instanced cache remains in use')
    }

    dropCloudGraphsForUniforms(z4)
    const z4Remounted = make(z4, pulled)
    const z2AfterZ4Dispose = make(z2, pulled)
    for (let i = 0; i < 3; i++) {
      assert.notStrictEqual(nodes(z4Remounted)[i], oldZ4Pulled[i], 'disposed stream cannot retain its cache')
      assert.strictEqual(nodes(z4Pulled)[i], oldZ4Pulled[i], 'release does not mutate a material')
      assert.strictEqual(nodes(z2AfterZ4Dispose)[i], nodes(z2Reloaded)[i], 'Z2 cache survives Z4 disposal')
    }
  } finally {
    restoreDome?.()
    for (const material of materials) material.dispose()
    await vite.close()
  }
})
