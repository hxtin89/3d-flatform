import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

import * as THREE from 'three'
import { pass, renderOutput, vec3, vec4 } from 'three/tsl'
import { PerspectiveCamera, RenderPipeline, Scene, WebGPURenderer } from 'three/webgpu'
import DepthOfFieldNode from 'three/addons/tsl/display/DepthOfFieldNode.js'

import { bakeGradeTexels, identityTexels } from './grade-bake.ts'
import { parseGradeState, type GradeState } from './grade-model.ts'
import { createGradeOutput, DEFAULT_GRADE_LUT_SIZE, makeLutTexture } from './grade-output.ts'

// depth-of-field.ts and eye-dome-lighting.ts import './config' without an extension, which Vite
// resolves and node does not. This adds the .ts for relative imports from .ts files, in this
// test file's own process only (node --test runs each file in its own), so depth-of-field.ts is
// imported dynamically, after it.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.\.?\//.test(specifier) && !/\.[a-z]+$/.test(specifier) && context.parentURL?.endsWith('.ts')) {
      return nextResolve(`${specifier}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})

/** A state from a partial one, which must parse without a warning. */
function grade(partial: unknown): GradeState {
  const { state, warnings } = parseGradeState(partial)
  assert.deepEqual(warnings, [], 'the test grade is valid')
  return state
}

const WARM = grade({ temperature: 20, saturation: 1.2, contrast: 1.15 })
const COOL = grade({ temperature: -15, lift: { y: 0.01, u: 0.1, v: 0 } })

const texelsFor = (state: GradeState, n: number) => bakeGradeTexels(state, null, n).texels

/** A renderer that only builds shaders: no canvas, no adapter, so the builders must not ask
 *  about optional features. */
function shaderRenderer(webgl: boolean): any {
  const canvas = { width: 1280, height: 800, style: {}, addEventListener() {}, removeEventListener() {}, getContext() { return null } }
  const renderer: any = new WebGPURenderer({ canvas: canvas as any, forceWebGL: webgl })
  renderer.hasFeature = () => false
  renderer.backend.hasFeature = () => false
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  return renderer
}

/** A new build of a full-screen quad with the backend's own builder, which is what the renderer
 *  does when the quad's cache key has changed (RenderObjects.js:127-131, NodeManager.js:194-305). */
function buildQuad(renderer: any, quad: any): any {
  const builder = renderer.backend.createNodeBuilder(quad, renderer)
  builder.material = quad.material
  builder.context.material = quad.material
  builder.scene = new Scene()
  builder.camera = quad.camera
  builder.build()
  return builder
}

/**
 * The final quad's fragment shader: depth-of-field.ts applyOutput() puts `effectNode` and the
 * stage into a RenderPipeline, then the pipeline's own _update() builds the quad's node as
 * RenderPipeline.render() would (RenderPipeline.js:179-232), and the backend's builder compiles it.
 */
function finalQuadShader(renderer: any, effectNode: any, stage: ((display: any) => any) | null): string {
  const pipeline: any = new RenderPipeline(renderer)
  if (stage) {
    pipeline.outputColorTransform = false
    pipeline.outputNode = stage(renderOutput(effectNode))
  } else {
    pipeline.outputColorTransform = true
    pipeline.outputNode = effectNode
  }
  pipeline.needsUpdate = true
  pipeline._update()
  return buildQuad(renderer, pipeline._quadMesh).fragmentShader as string
}

const count = (text: string, pattern: RegExp) => (text.match(pattern) ?? []).length

test('makeLutTexture: RGBA half floats, trilinear, clamped on all three axes, no mipmaps, no colour space', () => {
  const n = 9
  const texels = new Uint16Array(4 * n ** 3)
  const t = makeLutTexture(n, texels)
  assert.ok(t instanceof THREE.Data3DTexture)
  assert.equal(t.type, THREE.HalfFloatType)
  assert.equal(t.format, THREE.RGBAFormat)
  assert.equal(t.minFilter, THREE.LinearFilter)
  assert.equal(t.magFilter, THREE.LinearFilter)
  assert.equal(t.wrapS, THREE.ClampToEdgeWrapping)
  assert.equal(t.wrapT, THREE.ClampToEdgeWrapping)
  assert.equal(t.wrapR, THREE.ClampToEdgeWrapping)
  assert.equal(t.generateMipmaps, false)
  assert.equal(t.flipY, false)
  assert.equal(t.colorSpace, THREE.NoColorSpace)
  assert.equal(t.version, 1, 'marked for upload')
  assert.equal(t.image.data, texels)
  assert.ok(t.image.data instanceof Uint16Array)
  assert.equal(t.image.data.length, 4 * n ** 3)
  assert.deepEqual([t.image.width, t.image.height, t.image.depth], [n, n, n])
})

test('the first lattice is identityTexels(33) by value, in a copy', () => {
  assert.equal(DEFAULT_GRADE_LUT_SIZE, 33)
  const output = createGradeOutput()
  assert.equal(output.size, 33)
  assert.notEqual(output.texture.image.data, identityTexels(33), 'never the cached array')
  assert.deepEqual(output.texture.image.data, identityTexels(33))
  assert.equal(output.nodes.lut.value, output.texture)
  assert.equal(output.nodes.scale.value, 32 / 33)
  assert.equal(output.nodes.offset.value, 0.5 / 33)
  assert.equal(output.split(), 0)
})

test('a same-size upload keeps the texture, bumps its version and returns the array it replaced', () => {
  const output = createGradeOutput(17)
  const texture = output.texture
  const first = texture.image.data as Uint16Array
  const version = texture.version
  let disposed = 0
  texture.addEventListener('dispose', () => disposed++)

  const warm = texelsFor(WARM, 17)
  assert.equal(output.upload(warm, 17), first)
  assert.equal(output.texture, texture)
  assert.equal(output.nodes.lut.value, texture)
  assert.equal(texture.image.data, warm)
  assert.equal(texture.version, version + 1)

  // The array the texture holds is never handed back: a caller would recycle it under three.
  assert.equal(output.upload(warm, 17), null)
  assert.equal(texture.image.data, warm)
  assert.equal(texture.version, version + 2)

  // The returned array goes back in, and the one it replaces comes out.
  assert.equal(output.upload(first, 17), warm)
  assert.equal(texture.image.data, first)
  assert.equal(output.size, 17)
  assert.equal(output.nodes.scale.value, 16 / 17)
  for (let i = 0; i < 5; i++) output.update()
  assert.equal(disposed, 0, 'a same-size upload never disposes')
})

test('a new-size upload swaps the texture into the tap and disposes the old one after exactly two update() calls', () => {
  const output = createGradeOutput(33)
  const old = output.texture
  // A clone the stage made before the swap: compiled quads hold clones like it.
  const compiledTap = output.nodes.lut.sample(vec3(0.5))
  let oldDisposed = 0
  old.addEventListener('dispose', () => oldDisposed++)

  const texels = texelsFor(COOL, 41)
  assert.equal(output.upload(texels, 41), null)
  const next = output.texture
  assert.notEqual(next, old)
  assert.equal(next.image.data, texels)
  assert.deepEqual([next.image.width, next.image.height, next.image.depth], [41, 41, 41])
  assert.equal(next.type, THREE.HalfFloatType)
  assert.equal(output.size, 41)
  assert.equal(output.nodes.lut.value, next)
  assert.equal(compiledTap.value, next, 'the compiled clone reads the new texture through its reference')
  assert.equal(output.nodes.scale.value, 40 / 41)
  assert.equal(output.nodes.offset.value, 0.5 / 41)

  assert.equal(oldDisposed, 0)
  output.update()
  assert.equal(oldDisposed, 0, 'still drawn with this frame')
  output.update()
  assert.equal(oldDisposed, 1)
  output.update()
  assert.equal(oldDisposed, 1, 'disposed once')

  let nextDisposed = 0
  next.addEventListener('dispose', () => nextDisposed++)
  output.dispose()
  assert.equal(nextDisposed, 1)
  assert.equal(oldDisposed, 1)
})

test('dispose() also frees a texture still waiting to retire', () => {
  const output = createGradeOutput(17)
  const old = output.texture
  let oldDisposed = 0
  old.addEventListener('dispose', () => oldDisposed++)
  output.upload(texelsFor(WARM, 33), 33)
  output.update()
  output.dispose()
  assert.equal(oldDisposed, 1)
  output.update()
  assert.equal(oldDisposed, 1)
})

test('the cached identityTexels array is never the texture\'s data', () => {
  const cached33 = identityTexels(33)
  const snapshot33 = cached33.slice()
  const output = createGradeOutput(33)
  const isCache = () => output.texture.image.data === identityTexels(output.size)
  assert.equal(isCache(), false)

  // A neutral bake copies the identity into its own array.
  const neutral = texelsFor(grade({}), 33)
  assert.notEqual(neutral, cached33)
  assert.deepEqual(neutral, cached33)
  const first = output.upload(neutral, 33)
  assert.equal(isCache(), false)
  assert.notEqual(first, cached33)
  output.upload(texelsFor(WARM, 33), 33)
  assert.equal(isCache(), false)
  output.upload(texelsFor(grade({}), 41), 41)
  assert.equal(isCache(), false)
  output.upload(texelsFor(grade({}), 33), 33)
  assert.equal(isCache(), false)

  assert.equal(identityTexels(33), cached33, 'still the same cache')
  assert.deepEqual(cached33, snapshot33, 'and never written to')
})

test('upload refuses texels that do not make an n³ lattice', () => {
  const output = createGradeOutput(17)
  assert.throws(() => output.upload(new Uint16Array(4 * 17 ** 3), 33), RangeError)
  assert.throws(() => output.upload(new Uint16Array(3 * 17 ** 3), 17), RangeError)
  assert.throws(() => output.upload(new Uint16Array(4), 1), RangeError)
  assert.throws(() => output.upload(new Uint16Array(4 * 8), 2.0000001), RangeError)
  assert.equal(output.size, 17)
})

test('stage builds a vec4 node, and the split is a plain uniform', () => {
  const output = createGradeOutput(17)
  const node = output.stage(vec4(0.2, 0.4, 0.6, 1))
  assert.ok(node && node.isNode, 'a node')
  output.setSplit(0.5)
  assert.equal(output.split(), 0.5)
  assert.equal(output.nodes.split.value, 0.5)
  output.setSplit(2)
  assert.equal(output.split(), 2)
  assert.equal(output.stage, output.stage, 'one function for setOutputStage\'s identity check')
})

for (const backend of ['WebGPU', 'WebGL2'] as const) {
  test(`${backend} final quad: the passthrough stage is today's shader, the grade adds one explicit-level tap and one select`, () => {
    const webgl = backend === 'WebGL2'
    const renderer = shaderRenderer(webgl)
    // The no-post path's chain: the scene pass's texture (depth-of-field.ts rebuild()).
    const effectNode = pass(new Scene(), new PerspectiveCamera()).getTextureNode()
    const output = createGradeOutput(33)

    const today = finalQuadShader(renderer, effectNode, null)
    const passthrough = finalQuadShader(renderer, effectNode, (display) => display)
    assert.equal(passthrough, today, 'routing alone changes no code')

    const graded = finalQuadShader(renderer, effectNode, output.stage)
    if (webgl) {
      assert.equal(count(graded, /\btextureLod\(/g), count(today, /\btextureLod\(/g) + 1, 'one explicit-level tap')
      assert.equal(count(graded, /\btexture\(/g), count(today, /\btexture\(/g), 'the frame read once')
      assert.equal(count(graded, / \? /g), count(today, / \? /g) + 1, 'the split is a ternary')
      // The flipY branch three gives every WebGL texture read, on a uniform that is false here.
      assert.equal(count(graded, /\bif \(/g), count(today, /\bif \(/g) + 1)
    } else {
      assert.equal(count(graded, /\btextureSampleLevel\(/g), count(today, /\btextureSampleLevel\(/g) + 1, 'one explicit-level tap')
      assert.match(graded, /textureSampleLevel\([^;]*, 0\.0 \)/, 'at level 0')
      assert.equal(count(graded, /\btextureSample\(/g), count(today, /\btextureSample\(/g), 'the frame read once')
      assert.equal(count(graded, /\bselect\(/g), count(today, /\bselect\(/g) + 1, 'the split is a select')
      assert.equal(count(graded, /\bif \(/g), count(today, /\bif \(/g), 'no branch')
    }

    // A size change swaps uniforms and the texture, not code.
    output.upload(texelsFor(WARM, 41), 41)
    assert.equal(finalQuadShader(renderer, effectNode, output.stage), graded)
  })
}

test('with DoF on, every rebuild of the final quad makes a new CoC blur, and the layer frees the one it replaced', async (t) => {
  const { createDepthOfFieldLayer } = await import('./depth-of-field.ts')
  const renderer = shaderRenderer(false)

  // Each DoF setup() makes a new CoC blur with two render targets (DepthOfFieldNode.js:381,
  // GaussianBlurNode.js:80-89); this counts the 'dispose' events on them, per blur.
  const blurs: any[] = []
  const targetsFreed: number[] = []
  let dof: any = null
  const dofProto = (DepthOfFieldNode as any).prototype
  const dofSetup = dofProto.setup
  t.mock.method(dofProto, 'setup', function (this: any, builder: any) {
    const result = dofSetup.call(this, builder)
    dof = this
    const blur = this._CoCBlurredMaterial.colorNode
    const i = blurs.push(blur) - 1
    targetsFreed.push(0)
    for (const target of [blur._horizontalRT, blur._verticalRT]) {
      target.addEventListener('dispose', () => targetsFreed[i]++)
    }
    return result
  })
  // No GPU here: a render is the pipeline's own _update(), then a new build of the final quad
  // when that marked its material for one. The renderer does the same: the quad's key is new
  // after every update, so the build never comes from its cache (RenderPipeline.js:200-226,
  // RenderObjects.js:127-131). DoF's own passes are not drawn, so their builds are not run.
  const quadKeys: string[] = []
  t.mock.method((RenderPipeline as any).prototype, 'render', function (this: any) {
    const material = this._quadMesh.material
    const version = material.version
    this._update()
    if (material.version === version) return
    quadKeys.push(material.customProgramCacheKey())
    buildQuad(renderer, this._quadMesh)
  })

  const layer = createDepthOfFieldLayer({ renderer, scene: new Scene(), camera: new PerspectiveCamera() })
  // The shipping default, whatever config.ts says today.
  layer.setEnabled(true)
  layer.setEyeDome(true)
  const output = createGradeOutput(17)
  const passthrough = (display: any) => display

  // DoF's five pass materials, which its setup() marks for a new build each time it runs.
  const passVersions = () => ['_CoCMaterial', '_CoCBlurredMaterial', '_blur64Material', '_blur16Material', '_compositeMaterial']
    .map((name) => dof[name].version)

  layer.render()
  layer.render()
  assert.equal(blurs.length, 1, 'built on the first render, not per frame')
  assert.deepEqual(targetsFreed, [0])
  const versions = passVersions()

  layer.setOutputStage(output.stage)
  layer.render()
  assert.equal(blurs.length, 2, 'a stage change re-runs DoF setup()')
  assert.deepEqual(passVersions(), versions.map((v) => v + 1), 'and with it all five DoF passes, not the final quad alone')
  assert.deepEqual(targetsFreed, [2, 0], 'the replaced blur is freed after the render that replaced it')
  layer.setOutputStage(output.stage)
  layer.render()
  assert.equal(blurs.length, 2, 'the same stage again builds nothing')

  layer.setOutputStage(null)
  layer.render()
  layer.setOutputStage(passthrough)
  layer.render()
  // A tone curve change rebuilds the quad as well (RenderPipeline.js:181-186), with or without
  // a stage; it leaked a blur the same way before stages existed.
  renderer.toneMapping = THREE.AgXToneMapping
  layer.render()
  assert.equal(blurs.length, 5)
  assert.deepEqual(targetsFreed, [2, 2, 2, 2, 0])
  assert.equal(quadKeys.length, 5)
  assert.equal(new Set(quadKeys).size, 5, 'no build reuses a key, not even the change back to null')

  // An effect switch frees the current blur through release(), once.
  layer.setEnabled(false)
  assert.deepEqual(targetsFreed, [2, 2, 2, 2, 2])
  layer.setOutputStage(output.stage)
  layer.render()
  assert.equal(blurs.length, 5, 'without DoF a stage change makes no blur')

  layer.setEnabled(true)
  layer.render()
  layer.setOutputStage(null)
  layer.render()
  assert.deepEqual(targetsFreed, [2, 2, 2, 2, 2, 2, 0])
  layer.dispose()
  assert.deepEqual(targetsFreed, [2, 2, 2, 2, 2, 2, 2], 'every blur freed, each exactly once')
  output.dispose()
})
