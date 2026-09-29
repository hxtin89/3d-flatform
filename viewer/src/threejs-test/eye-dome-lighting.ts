// Eye-dome lighting: shape from depth alone, the shading Potree, CloudCompare and ArcGIS
// put on point clouds because points carry no normals to light.
//
// Every pixel compares its log depth with eight neighbours a pixel or two away. Where a
// neighbour is nearer, the pixel sits just behind a silhouette and is darkened, so each
// crown gets a soft dark rim against what lies behind it — the ground, a lower crown. It
// needs the frame's depth, so it is a screen pass and runs inside the depth-of-field
// pipeline; with both effects off, main.ts renders straight to the canvas and this code
// is never built.
//
// Background pixels (depth 1: sky, nothing drawn) are left alone and never counted as
// neighbours, so the canopy gets no black outline against the sky.
//
// It shades the whole scene pass, so overlays that write no depth of their own — the
// donation parcel's glow, rain, the pivot marker — are darkened by whatever lies behind
// them. Potree avoids that by drawing overlays after EDL; here that would take a second
// scene render on a separate layer, so it is left as a known limit of the effect.
import * as THREE from 'three'
import {
  Fn, exp, float, floor, log2, max, mix, perspectiveDepthToViewZ, screenSize, select, smoothstep, uniform, uv, vec2, vec4,
} from 'three/tsl'
import { EXPERIENCE_CONFIG } from './config'

const FADE = EXPERIENCE_CONFIG.eyeDomeLighting

/** Eight directions on the unit circle. Four is cheaper but leaves the diagonals blind. */
const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [Math.SQRT1_2, Math.SQRT1_2], [0, 1], [-Math.SQRT1_2, Math.SQRT1_2],
  [-1, 0], [-Math.SQRT1_2, -Math.SQRT1_2], [0, -1], [Math.SQRT1_2, -Math.SQRT1_2],
]
/** Potree's response scale. The shade multiplies linear colour before the tone curve and
 *  the sRGB encode, where Potree shades display colour, so a given strength reads roughly
 *  half as strong as the same number in Potree. */
const RESPONSE_SCALE = 300

/**
 * Shade `color` by eye-dome lighting read from `depth`, the scene pass's depth texture.
 * `strength` and `radiusPx` are uniforms, so the panel retunes them without a rebuild.
 * `radiusPx` is a whole number of backbuffer pixels: each tap reads an exact texel centre,
 * because the depth texture is read unfiltered and a fractional offset would snap to
 * whichever texel it happened to round into. Near and far follow `camera` every render,
 * because the far plane eases with the view.
 *
 * `floor` is the darkest the shade may go. Without it the gaps between points — a pixel
 * of far ground next to a near crown — saturate to black at any strength and read as
 * speckle; the rims themselves need far less than that.
 */
export function eyeDomeLighting(
  color: any, depth: any, camera: THREE.PerspectiveCamera, strength: any, radiusPx: any, floor01: any,
): any {
  const near = uniform(camera.near).onRenderUpdate(() => camera.near)
  const far = uniform(camera.far).onRenderUpdate(() => camera.far)
  return Fn(() => {
    const st = uv()
    const texel = floor(st.mul(screenSize)).add(0.5)
    const logDistance = (d: any) => log2(perspectiveDepthToViewZ(d, near, far).negate())
    const centreDepth = depth.sample(st).x
    const centre = logDistance(centreDepth)
    let sum: any = float(0)
    for (const [dx, dy] of NEIGHBOURS) {
      // Rounded per tap, so a diagonal at radius 1 still lands one texel out.
      const offset = floor(vec2(dx, dy).mul(radiusPx).add(0.5))
      const neighbourDepth = depth.sample(texel.add(offset).div(screenSize)).x
      const behind = max(centre.sub(logDistance(neighbourDepth)), 0)
      sum = sum.add(select(neighbourDepth.lessThan(1), behind, float(0)))
    }
    const rawShade = max(exp(sum.div(NEIGHBOURS.length).mul(-RESPONSE_SCALE).mul(strength)), floor01)
    // Faded out with distance: at grazing angles the far ground's depth steps from pixel to
    // pixel read as edges, and there the shading would only darken the distance haze and
    // bring the clipped map edge back.
    const viewDistance = perspectiveDepthToViewZ(centreDepth, near, far).negate()
    const shade = mix(rawShade, float(1), smoothstep(float(FADE.fadeStartM), float(FADE.fadeEndM), viewDistance))
    return vec4(color.rgb.mul(select(centreDepth.lessThan(1), shade, float(1))), color.a)
  })()
}
