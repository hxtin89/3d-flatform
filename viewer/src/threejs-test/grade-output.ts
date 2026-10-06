// The colour grade on the GPU (goal 4, plan 1.4): one trilinear tap into an n³ lattice of half
// floats that grade-bake.ts bakes, on the frame as displayed — after the tone curve and the sRGB
// encode, in the final quad of depth-of-field.ts (setOutputStage) — so it adds no pass. The
// input is what a screenshot shows, in [0, 1], which is also what an exported .cube expects.
// No DOM, so it runs under node --test (grade-output.test.ts, which also builds the final quad's
// shader with three's own WGSL and GLSL builders).
//
// What the tap compiles to in three r185, as grade-output.test.ts checks:
// - WebGPU: textureSampleLevel(lut, sampler, uvw, 0.0) and select(after, before, split);
//   WebGL2: textureLod(lut, uvw, 0.0) and a ternary, plus the branch on a constant-false flipY
//   uniform that every WebGL texture read gets (TextureNode.js:324-346; false for a
//   Data3DTexture, TextureNode.js:907). An explicit level needs no derivatives, so the tap is
//   valid in any control flow (Firefox's uniformity checks included).
// - The frame and the tap are variables on the Fn's stack, built before the select. Built inside
//   it, each operand is isolated in its own node cache (ConditionalNode.js:104-105), and whatever
//   is also read outside the select — the frame's alpha — is generated a second time, the whole
//   effect chain (EDL, DoF) with it.
// - The rest of the quad is today's code byte for byte, and with the passthrough stage
//   (display) => display the whole shader equals the one without a stage.
//
// The lattice node (i, j, k) sits at the colour (i, j, k)/(n − 1); texel centres are at
// (i + 0.5)/n, so the colour is mapped by rgb·(n − 1)/n + 0.5/n before the tap. RGBA16F is
// filterable on WebGPU core (rgba16float) and in WebGL2 (RGBA16F) without extensions.
import * as THREE from 'three'
import { clamp, Fn, screenUV, select, texture3D, uniform, vec4 } from 'three/tsl'
import { identityTexels } from './grade-bake.ts'

/** The lattice the grade bakes without a look; config grade.lutSize takes it over with the panel. */
export const DEFAULT_GRADE_LUT_SIZE = 33

/** Update() calls a replaced texture outlives before it is disposed: the frame that may still
 *  draw with it, and one more. */
const RETIRE_FRAMES = 2

/**
 * An n³ RGBA half-float 3D texture over `texels` (4n³ half bits, red fastest, the .cube order),
 * sampled trilinearly. `texels` becomes the texture's data, so it must not be the cached
 * identityTexels array: copy that one.
 */
export function makeLutTexture(n: number, texels: Uint16Array): THREE.Data3DTexture {
  const t = new THREE.Data3DTexture(texels, n, n, n)
  t.format = THREE.RGBAFormat
  t.type = THREE.HalfFloatType
  // Data3DTexture defaults to Nearest, which compiles to a texel load instead of a sample.
  t.minFilter = THREE.LinearFilter
  t.magFilter = THREE.LinearFilter
  t.wrapS = THREE.ClampToEdgeWrapping
  t.wrapT = THREE.ClampToEdgeWrapping
  t.wrapR = THREE.ClampToEdgeWrapping
  t.generateMipmaps = false
  t.unpackAlignment = 1
  // The lattice holds display-encoded values; no colour conversion on read.
  t.colorSpace = THREE.NoColorSpace
  t.name = 'grade-lut'
  t.needsUpdate = true
  return t
}

export interface GradeOutput {
  /** The stage for depthOfField.setOutputStage. One function for the output's whole life, so
   *  setting it again is a no-op there; uploads and the split are uniforms and texture data and
   *  never recompile. */
  readonly stage: (display: any) => any
  /** The lattice size the tap reads now. */
  readonly size: number
  /** The texture the tap reads now; a size change replaces it. */
  readonly texture: THREE.Data3DTexture
  /** The tap's texture node and uniforms, for tests and the debug handle. */
  readonly nodes: { readonly lut: any; readonly scale: any; readonly offset: any; readonly split: any }
  /**
   * Hands `texels` (4n³ half bits, red fastest; never the cached identityTexels array) to the
   * texture. Same n: the data goes into the same GPU texture on the next render, and the array it
   * replaced comes back for reuse (null when `texels` is that array already). New n: a new
   * texture, swapped into the tap without a recompile; the old one is disposed RETIRE_FRAMES
   * update() calls later; returns null.
   */
  upload(texels: Uint16Array, n: number): Uint16Array | null
  /** Canvas x in [0, 1]: pixels left of it show the frame without the grade. 0 grades all of the
   *  frame, anything above 1 none of it. */
  setSplit(x: number): void
  split(): number
  /** Once per frame, before the render: disposes replaced textures when their time is up. */
  update(): void
  dispose(): void
}

/** The tap on an identity lattice of n³ (a copy of identityTexels(n)), split at 0. */
export function createGradeOutput(n0: number = DEFAULT_GRADE_LUT_SIZE): GradeOutput {
  let n = n0
  let lut = makeLutTexture(n, identityTexels(n).slice())
  // Level 0 given, so every sample() clone of this node keeps it (TextureNode.js:678-686,
  // 918-930) and compiles to an explicit-level read. The clones read .value through their
  // referenceNode, this node (TextureNode.js:186-209), so assigning .value swaps the texture in
  // every compiled quad: the binding notices on its next update (NodeSampledTexture.js:54,
  // Bindings.js:363-392) and rebinds without a recompile.
  const lutNode = texture3D(lut, null, 0)
  const lutScale = uniform((n - 1) / n)
  const lutOffset = uniform(0.5 / n)
  const compareSplit = uniform(0)
  const retired: { tex: THREE.Data3DTexture; frames: number }[] = []

  const stage = (display: any) => Fn(() => {
    const shown = display.toVar()
    const after = lutNode.sample(clamp(shown.rgb, 0, 1).mul(lutScale).add(lutOffset)).rgb.toVar()
    // uniformFlow: both operands as they are, one select or ternary, no branch
    // (ConditionalNode.js:146-158, WGSLNodeBuilder.js:2422-2424, GLSLNodeBuilder.js:285-287).
    return vec4(select(screenUV.x.lessThan(compareSplit), shown.rgb, after).uniformFlow(), shown.a)
  })()

  return {
    stage,
    get size() { return n },
    get texture() { return lut },
    nodes: { lut: lutNode, scale: lutScale, offset: lutOffset, split: compareSplit },
    upload(texels, size) {
      if (!Number.isInteger(size) || size < 2 || texels.length !== 4 * size ** 3) {
        throw new RangeError(`grade upload: ${texels.length} texels do not make a ${size}³ lattice`)
      }
      if (size === n) {
        const prev = lut.image.data as Uint16Array
        // A version bump re-uploads into the same GPU texture (Textures.js:204-207, 314-355):
        // writeTexture per slice on WebGPU, texSubImage3D on WebGL, both from image.data.
        lut.image.data = texels
        lut.needsUpdate = true
        return prev === texels ? null : prev
      }
      retired.push({ tex: lut, frames: RETIRE_FRAMES })
      n = size
      lut = makeLutTexture(n, texels)
      lutNode.value = lut
      lutScale.value = (n - 1) / n
      lutOffset.value = 0.5 / n
      return null
    },
    setSplit(x) { compareSplit.value = x },
    split() { return compareSplit.value },
    update() {
      for (let i = retired.length - 1; i >= 0; i--) {
        if (--retired[i].frames <= 0) {
          retired[i].tex.dispose()
          retired.splice(i, 1)
        }
      }
    },
    dispose() {
      lut.dispose()
      for (const r of retired) r.tex.dispose()
      retired.length = 0
    },
  }
}
