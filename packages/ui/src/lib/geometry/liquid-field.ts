// Renders a whole bento cluster as ONE implicit surface (a signed distance
// field) instead of one hand-cornered SVG silhouette per widget.
//
// WHY THIS EXISTS -- the corner-snapping problem it solves:
//
// geometry/docking.ts classifies each corner discretely (convex / none /
// concave / fill-left / fill-top) by probing for neighbours. That's a
// discrete decision taken from continuous input (rects that move and resize
// every animation frame), so at the instant a classification flips, the path
// jumps. No amount of tweening fixes that -- the classifier itself is the
// discontinuity.
//
// The way out comes from noticing what Figma's Corner atom actually IS. It's
// a boolean `Rectangle - Ellipse` (verified by reading the real component's
// children), i.e. a circular fillet. And every atom in the vocabulary is the
// same operation applied to a different vertex angle of the UNION of the
// widget rects:
//
//     Convex                  -> 90deg vertex, filleted (arc curves inward)
//     Fill-Left / Fill-Top /
//     Concave                 -> 270deg reflex vertex, filleted (bulges out)
//     None                    -> collinear edges, no vertex at all
//
// So the five "types" are one operation, not five things. Evaluate the union
// as a field and fillet it continuously, and the whole classifier disappears:
// as a widget animates, a vertex sweeps smoothly through 180deg, its arc
// shrinks to zero length and reappears on the other side. Nothing flips.
//
// WHY A CIRCULAR SMIN SPECIFICALLY:
//
// The popular polynomial smooth-min (`min(a,b) - h*h*k*0.25`) is an
// approximation -- its blend is NOT a circular arc, so it would quietly
// change the corner radius, which is the one thing that has to stay exactly
// r=60 to match Figma. iq's *circular* smin below produces a true circular
// fillet of radius exactly k, so setting k = the widget radius reproduces
// Figma's atoms geometrically rather than approximately.
//
// Because the real layouts are flush (zero gap between widgets), at rest this
// lands on exactly the same shape the old per-widget silhouettes drew. The
// field only diverges when widgets are separated -- where it necks them
// together like mercury instead of leaving them as unrelated islands.
//
// Antialiasing is analytic (`fwidth` on the distance), which is sharper than
// SVG's default edge AA at the same device pixel ratio -- this is not a
// crispness tradeoff.

import type { CornerType } from "./silhouette"

export interface LiquidWidget {
  x: number
  y: number
  width: number
  height: number
  /** Resolved rgba, 0..1 per channel -- see createAccentResolver(). */
  color: [number, number, number, number]
  /**
   * Per-corner outward-fill amounts as 8 numbers -- [outX, outY] for each of
   * [topLeft, topRight, bottomRight, bottomLeft] -- each in 0..1.
   *
   * This is the CONTINUOUS form of Figma's outward corner atoms (see
   * wedgeTargets for the mapping). It is a pair of amounts rather than a corner
   * enum precisely so it can be interpolated: an enum can only flip, which is
   * what made corners pop mid-animation. At 0/1 it lands exactly on Figma's
   * authored shape; in between it is a partially-grown wedge.
   */
  wedge?: readonly number[]
  /**
   * Per-corner box roundness as 4 numbers in 0..1, for [topLeft, topRight,
   * bottomRight, bottomLeft] -- see roundTargets. When present this REPLACES
   * computeCornerRadii's neighbour-proximity guess for this widget.
   *
   * The proximity guess cannot express the shape Figma actually draws at an
   * interlocking seam: a corner that touches a neighbour but is still a full
   * convex round, with the neighbour's Fill wedge curling in behind it. Given
   * only the distance to the neighbour (zero) it must call that corner square,
   * which squares off the round AND buries the neighbour's wedge under the
   * resulting rectangle. The authored corner type knows the difference, so pass
   * it here whenever it's available and keep proximity as the fallback.
   */
  round?: readonly number[]
}

/**
 * Maps authored corner treatments to the continuous (outX, outY) pairs the
 * field consumes.
 *
 *   fill-left -> reaches outward horizontally      -> (1, 0)
 *   fill-top  -> reaches outward vertically        -> (0, 1)
 *   concave   -> reaches outward on both axes      -> (1, 1)
 *   convex/none -> no outward material             -> (0, 0)
 *
 * Deliberately NOT a direction vector with a separate amount: interpolating a
 * direction collapses the wedge's own square to zero area long before the
 * amount reaches 0, so it would vanish and reappear rather than grow. Two
 * independent amounts scale the wedge's radius instead, so it shrinks toward
 * the vertex continuously and always stays attached to it.
 */
export function wedgeTargets(corners: readonly CornerType[] | undefined): number[] {
  const out = new Array(8).fill(0)
  if (!corners) return out
  for (let c = 0; c < 4; c++) {
    const type = corners[c]
    if (type === "fill-left") out[c * 2] = 1
    else if (type === "fill-top") out[c * 2 + 1] = 1
    else if (type === "concave") {
      out[c * 2] = 1
      out[c * 2 + 1] = 1
    }
  }
  return out
}

/**
 * Maps authored corner treatments to the continuous box-roundness amounts the
 * field consumes -- 1 for a plain convex round, 0 for everything else.
 *
 * 'none' is square by definition. A Fill/Concave corner is square too, but for
 * a different reason: its wedge is what supplies the material there, and
 * rounding the box as well pulls it back from the vertex while the wedge sits
 * outside it (see the wedge fade in render). Both land on 0, so this is a plain
 * per-corner amount that eases in lockstep with the wedge amounts.
 */
export function roundTargets(corners: readonly CornerType[] | undefined): number[] {
  const out = new Array(4).fill(0)
  if (!corners) return out
  for (let c = 0; c < 4; c++) if (corners[c] === "convex") out[c] = 1
  return out
}

export interface LiquidRenderOptions {
  /** Corner radius, px. Matches the Corner atom's own Large/Small sizing (60 default). */
  radius: number
  /** Fillet/neck radius for the blend between widgets, px. Equals `radius` to reproduce Figma. */
  blend: number
  /** CSS px size of the field. */
  width: number
  height: number
  /** How far the canvas extends past the widget bounds, so fillets/necks aren't clipped. */
  pad: number
}

export interface LiquidField {
  render(widgets: LiquidWidget[], options: LiquidRenderOptions): void
  dispose(): void
}

/** Shader loops are bounded; a bento cluster is a handful of widgets, never dozens. */
const MAX_WIDGETS = 12

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`

const FRAG = `#version 300 es
precision highp float;
out vec4 outColor;

uniform vec2 uResolution;
uniform int uCount;
uniform vec4 uRects[${MAX_WIDGETS}];
uniform vec4 uColors[${MAX_WIDGETS}];
uniform vec4 uCorners[${MAX_WIDGETS}];
// Per corner (x=TL, y=TR, z=BR, w=BL), the outward direction of that corner's
// Fill/Concave wedge in corner-local space, or 0 for no wedge. See sdWedge.
uniform vec4 uWedgeX[${MAX_WIDGETS}];
uniform vec4 uWedgeY[${MAX_WIDGETS}];
// Per-corner wedge radius. Scaling this (rather than the direction) is what
// lets a wedge grow and shrink continuously while staying attached to its
// vertex -- 0 means no wedge at all.
uniform vec4 uWedgeR[${MAX_WIDGETS}];
uniform float uBlend;

// How far every shape is inflated, in DEVICE px, purely to close seams.
//
// Flush widgets share an edge, and on it each shape's own distance is exactly 0,
// so the union is ~0 too even though the point is deep inside with material on
// both sides. The AA below then reads 0 as an edge and drops alpha, letting the
// photo through as a hairline. Inflating makes shared edges genuinely interior.
//
// Inflation alone could never win this, though, which is why it is now 0 and the
// real fix lives in the AA below. Growing the boxes only moves the min() ridge
// deeper; it never removes it, and every pixel of depth it buys is a pixel the
// outer silhouette grows by. At a Fill wedge abutting a neighbour's r=60 arc the
// two surfaces are TANGENT, so no finite overlap makes the ridge deeper than the
// overlap itself -- 1.0px of inflation still left the ridge at -0.5 at pixel
// centres, inside a 1px symmetric feather, i.e. ~15% of the background straight
// through the middle of a solid surface. Kept at 0 so the silhouette is exactly
// Figma's geometry.
const float SEAM_OVERLAP = 0.0;
const float MAX_EDGE_AA = 1.0;

float sdBoxSharp(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

/**
 * One Corner atom, in corner-local coords (vertex at origin, the widget's own
 * material filling +x/+y).
 *
 * This is Figma's atom verbatim: an r-square placed in an OUTWARD quadrant,
 * minus a disc of radius r centred on that square's far corner -- exactly the
 * boolean "Rectangle minus Ellipse" the real component is built from. It is the
 * piece a union-of-rects can never produce, because Fill-Left / Fill-Top /
 * Concave ADD material beyond the widget's own box rather than removing it.
 *
 * s selects the quadrant, and is the same for all four corners because the
 * caller works in corner-local space: (-1,+1) reaches away horizontally
 * (Fill-Left), (+1,-1) vertically (Fill-Top), (-1,-1) diagonally (Concave).
 */
float sdWedge(vec2 q, vec2 s, float r) {
  if (r <= 0.0) return 1e9;
  vec2 c = s * r;
  vec2 lo = min(vec2(0.0), c);
  vec2 hi = max(vec2(0.0), c);
  float box = sdBoxSharp(q - (hi + lo) * 0.5, (hi - lo) * 0.5);
  // Inflated by half a device pixel, for the same reason the boxes are (see hs in
  // main). A Fill wedge abuts the NEIGHBOUR's rounded corner along that corner's
  // own arc -- both shapes have distance 0 there, so the union does too, and the
  // analytic AA halves the alpha and lets the photo through. Inflating the boxes
  // alone did not reach this: the wedge is a separate SDF min()'d in, so it kept
  // its exact edge. Measured before: 531 photo-coloured pixels inside the weather
  // cluster along the bar's fill-left wedge.
  return max(box, -(length(q - c) - r)) - SEAM_OVERLAP;
}

/** p -> corner-local coords for corner k (0=TL, 1=TR, 2=BR, 3=BL). */
vec2 cornerLocal(vec2 p, vec2 b, int k) {
  if (k == 0) return p + b;
  if (k == 1) return vec2(b.x - p.x, p.y + b.y);
  if (k == 2) return b - p;
  return vec2(p.x + b.x, b.y - p.y);
}

// Per-corner radius, picked by which quadrant of the box p falls in.
// Order is (topLeft, topRight, bottomRight, bottomLeft) to match the Corners
// convention used everywhere else in this package, in y-DOWN space.
float pickRadius(vec2 p, vec4 r) {
  float top = (p.x < 0.0) ? r.x : r.y;
  float bottom = (p.x < 0.0) ? r.w : r.z;
  return (p.y < 0.0) ? top : bottom;
}

// Rounded-box SDF (iq) with an independent radius per corner -- this is what
// lets a widget round its OUTER corners while leaving the corners it shares
// with a neighbour square, which is what Figma actually draws. A single
// uniform radius would round all four, leaving lens-shaped notches wherever
// two widgets butt together.
float sdRoundBox(vec2 p, vec2 b, vec4 radii) {
  float r = pickRadius(p, radii);
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

// iq's CIRCULAR smooth-min -- the blend region is a true circular arc of
// radius exactly k, unlike the polynomial variant which only approximates one
// and would drift the corner radius off Figma's r=60. See this file's header.
float sminCircular(float a, float b, float k) {
  k *= 1.0 / (1.0 - sqrt(0.5));
  return max(k, min(a, b)) - length(max(k - vec2(a, b), 0.0));
}

void main() {
  // gl_FragCoord is y-up from the bottom; widget rects are y-down from the
  // top (DOM convention), so flip once here rather than at every call site.
  vec2 p = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y);

  float blended = 1e9;
  float nearest = 1e9;
  float runnerUp = 1e9;
  vec4 col = vec4(0.0);

  for (int i = 0; i < ${MAX_WIDGETS}; i++) {
    if (i >= uCount) break;
    vec4 r = uRects[i];
    // Inflate every box by half a device pixel. Two FLUSH widgets share an edge,
    // and on that edge each one's own distance is exactly 0 -- so the union's
    // value there is ~0 too (min() and smin() both are), even though the point is
    // deep INSIDE the union with material on both sides. The analytic AA below
    // then reads 0 as "this is an edge" and halves the alpha, letting the
    // background through as a hairline down every interior seam. Measured at the
    // weather cluster's bar/tile join: rgb(210,210,210) where the fill is 171.
    //
    // Overlapping by a device pixel makes the shared edge genuinely interior, so
    // the field is properly negative there and the AA leaves it alone. The outer
    // silhouette grows by the same half pixel, which is below the threshold of
    // anything we measure against Figma and invisible on screen.
    vec2 hs = r.zw * 0.5 + SEAM_OVERLAP;
    vec2 pl = p - (r.xy + hs);
    float di = sdRoundBox(pl, hs, uCorners[i]);

    // Union in this widget's Fill/Concave corner atoms. Unrolled rather than
    // looped so the corner index stays a constant expression.
    vec4 wx = uWedgeX[i];
    vec4 wy = uWedgeY[i];
    vec4 wr = uWedgeR[i];
    di = min(di, sdWedge(cornerLocal(pl, hs, 0), vec2(wx.x, wy.x), wr.x));
    di = min(di, sdWedge(cornerLocal(pl, hs, 1), vec2(wx.y, wy.y), wr.y));
    di = min(di, sdWedge(cornerLocal(pl, hs, 2), vec2(wx.z, wy.z), wr.z));
    di = min(di, sdWedge(cornerLocal(pl, hs, 3), vec2(wx.w, wy.w), wr.w));
    blended = (i == 0) ? di : sminCircular(blended, di, uBlend);
    // Colour comes from the NEAREST widget by its own un-blended distance, so
    // adjacent widgets of different accents meet on a hard seam (as Figma
    // does) instead of smearing into each other the way the blended field
    // itself does.
    if (di < nearest) { runnerUp = nearest; nearest = di; col = uColors[i]; }
    else if (di < runnerUp) { runnerUp = di; }
  }

  // Analytic AA on the outer edge. Clamped, not raw: the blended distance is a min() of
  // per-widget distances, so it is non-differentiable along the ridge midway
  // between two widgets -- the gradient flips from pointing at one to pointing
  // at the other, and fwidth spikes to many pixels there. Left unbounded that
  // widens the feather far past the edge it is meant to soften, so alpha leaks
  // along the ridge and draws a faint diagonal line across empty space. A
  // feather is only ever meant to be about a pixel wide; the floor keeps the
  // zero-gradient case well defined, for the same reason as the seam feather.
  float edgeAA = clamp(fwidth(blended), 1e-4, MAX_EDGE_AA);
  // ONE-SIDED, not centred on the surface. A centred feather spans [-edgeAA,
  // +edgeAA], so it dims any point less than edgeAA INSIDE the shape -- fine on a
  // lone rounded rect, fatal for a union. min() leaves a ridge along every shared
  // edge whose depth is only the overlap between the two shapes, so a centred
  // feather reads that ridge as an edge and paints a hairline of background down
  // the middle of a joined surface. Starting the feather AT the surface makes
  // every interior point (blended <= 0) exactly opaque no matter how many widgets
  // meet there or how shallow the ridge is, and confines the softening to the
  // outside, where it belongs. Costs ~0.35px of apparent growth on the outer
  // silhouette -- a third of what SEAM_OVERLAP = 1.0 was costing to not fix this.
  float alpha = 1.0 - smoothstep(0.0, edgeAA, blended);

  // A one-pixel feather on the colour seam only -- enough to kill stair-steps
  // if a seam is ever off-axis, far too tight to read as a gradient.
  float seam = (runnerUp - nearest) * 0.5;
  // fwidth(seam) is EXACTLY zero across any region where the two nearest
  // widgets' distance fields have parallel gradients -- e.g. the triangular
  // wedge of an end widget whose nearest edge is the cluster's outer edge,
  // where moving in x changes both distances by the same amount. smoothstep
  // with edge0 == edge1 is undefined in GLSL, and drivers here return 0, which
  // multiplied the alpha to zero and bit a 45-degree chevron out of the first
  // and last widget -- apex exactly on the widget centre, edges exactly on its
  // diagonals, which is that region's boundary. Flooring the width keeps the
  // feather a true one-pixel feather wherever the seam really varies, and makes
  // the constant-seam case resolve to 1 (fully opaque) instead of undefined.
  float seamAA = max(fwidth(seam), 1e-4);
  alpha *= smoothstep(-seamAA, seamAA, seam + seamAA);

  outColor = vec4(col.rgb, col.a * alpha);
}
`

/** Unrounded box SDF, in the same y-down px space as LiquidWidget. Negative inside. */
function sdBox(px: number, py: number, w: LiquidWidget): number {
  const dx = Math.abs(px - (w.x + w.width / 2)) - w.width / 2
  const dy = Math.abs(py - (w.y + w.height / 2)) - w.height / 2
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
  return outside + Math.min(Math.max(dx, dy), 0)
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/**
 * Per-widget, per-corner radius, derived purely from how close the NEAREST
 * other widget is to that corner:
 *
 *   corner buried in / touching a neighbour  -> 0   (square, shared seam)
 *   corner a clear `feather` away from any   -> r   (fully rounded, outer)
 *
 * This is the continuous replacement for docking.ts's convex/none decision.
 * That classifier flipped discretely (hence the snapping); this eases, so a
 * corner that becomes exterior mid-animation *grows* its radius from 0 to r
 * instead of popping. It reproduces Figma's species row exactly at rest:
 * every corner touching a neighbour is square, every free corner is r=60.
 *
 * Radii are computed here on the CPU rather than in the shader because they
 * depend only on the rects, not on the pixel -- doing it per-fragment would
 * be an O(n^2) loop evaluated millions of times for an identical result.
 */
export function computeCornerRadii(widgets: LiquidWidget[], radius: number, feather: number): Float32Array {
  const out = new Float32Array(MAX_WIDGETS * 4)
  for (let i = 0; i < widgets.length && i < MAX_WIDGETS; i++) {
    const w = widgets[i]
    // (topLeft, topRight, bottomRight, bottomLeft) -- matches the shader's pickRadius.
    const corners: [number, number][] = [
      [w.x, w.y],
      [w.x + w.width, w.y],
      [w.x + w.width, w.y + w.height],
      [w.x, w.y + w.height],
    ]
    for (let c = 0; c < 4; c++) {
      const [cx, cy] = corners[c]
      let nearest = Infinity
      for (let j = 0; j < widgets.length; j++) {
        if (j === i) continue
        nearest = Math.min(nearest, Math.max(0, sdBox(cx, cy, widgets[j])))
      }
      out[i * 4 + c] = nearest === Infinity ? radius : radius * smoothstep(0, feather, nearest)
    }
  }
  return out
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`liquid-field shader failed to compile: ${log}`)
  }
  return shader
}

/**
 * Returns null when WebGL2 isn't available, so callers can fall back to the
 * per-widget SVG silhouettes rather than rendering nothing.
 */
export function createLiquidField(canvas: HTMLCanvasElement): LiquidField | null {
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: false, antialias: false })
  if (!gl) return null

  const program = gl.createProgram()!
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT))
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program)
    gl.deleteProgram(program)
    throw new Error(`liquid-field program failed to link: ${log}`)
  }
  gl.useProgram(program)

  // One full-viewport triangle pair; every shape lives in the fragment shader.
  const buffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const aPos = gl.getAttribLocation(program, 'aPos')
  gl.enableVertexAttribArray(aPos)
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

  const uResolution = gl.getUniformLocation(program, 'uResolution')
  const uCount = gl.getUniformLocation(program, 'uCount')
  const uRects = gl.getUniformLocation(program, 'uRects')
  const uColors = gl.getUniformLocation(program, 'uColors')
  const uCorners = gl.getUniformLocation(program, 'uCorners')
  const uWedgeX = gl.getUniformLocation(program, 'uWedgeX')
  const uWedgeY = gl.getUniformLocation(program, 'uWedgeY')
  const uWedgeR = gl.getUniformLocation(program, 'uWedgeR')
  const uBlend = gl.getUniformLocation(program, 'uBlend')

  gl.enable(gl.BLEND)
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

  const rectData = new Float32Array(MAX_WIDGETS * 4)
  const colorData = new Float32Array(MAX_WIDGETS * 4)
  const wedgeXData = new Float32Array(MAX_WIDGETS * 4)
  const wedgeYData = new Float32Array(MAX_WIDGETS * 4)
  const wedgeRData = new Float32Array(MAX_WIDGETS * 4)

  return {
    render(widgets, options) {
      const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1
      const cssW = options.width
      const cssH = options.height
      const pxW = Math.max(1, Math.round(cssW * dpr))
      const pxH = Math.max(1, Math.round(cssH * dpr))
      if (canvas.width !== pxW || canvas.height !== pxH) {
        canvas.width = pxW
        canvas.height = pxH
      }
      canvas.style.width = `${cssW}px`
      canvas.style.height = `${cssH}px`
      gl.viewport(0, 0, pxW, pxH)

      const count = Math.min(widgets.length, MAX_WIDGETS)
      rectData.fill(0)
      colorData.fill(0)
      wedgeXData.fill(0)
      wedgeYData.fill(0)
      wedgeRData.fill(0)
      for (let i = 0; i < count; i++) {
        const w = widgets[i]
        for (let c = 0; c < 4; c++) {
          const outX = w.wedge ? w.wedge[c * 2] : 0
          const outY = w.wedge ? w.wedge[c * 2 + 1] : 0
          // Direction eases from fully inward (+1) to fully outward (-1) with
          // the amount, so a growing wedge sweeps out of the corner instead of
          // appearing at full size.
          wedgeXData[i * 4 + c] = 1 - 2 * outX
          wedgeYData[i * 4 + c] = 1 - 2 * outY
          wedgeRData[i * 4 + c] = options.radius * Math.max(outX, outY) * dpr
        }
        // Everything is uploaded in DEVICE pixels, so the field is evaluated
        // at true screen resolution rather than being sampled at CSS px and
        // upscaled -- this is what keeps the edge as crisp as vector.
        rectData[i * 4 + 0] = (w.x + options.pad) * dpr
        rectData[i * 4 + 1] = (w.y + options.pad) * dpr
        rectData[i * 4 + 2] = w.width * dpr
        rectData[i * 4 + 3] = w.height * dpr
        colorData.set(w.color, i * 4)
      }

      // Corner radii are solved in CSS px against the padded layout (the same
      // space the rects were authored in), then scaled to device px alongside
      // everything else.
      const padded = widgets.slice(0, count).map((w) => ({ ...w, x: w.x + options.pad, y: w.y + options.pad }))
      const cornerData = computeCornerRadii(padded, options.radius, options.radius)
      // The authored corner type wins wherever the caller supplies one: it is
      // the only thing that knows a corner can touch a neighbour and still be a
      // full convex round (see LiquidWidget.round). Proximity stays as the
      // fallback for widgets with no authored corners.
      //
      // Either way, a corner carrying a Fill/Concave wedge must keep its BOX
      // corner sharp: the wedge is what supplies the material there. Rounding it
      // as well pulls the box back from the vertex while the wedge sits outside
      // it, leaving a notch between the two so the wedge reads as a detached
      // tab. Faded by the wedge amount rather than switched, so the box corner
      // un-rounds at exactly the rate the wedge grows in.
      for (let i = 0; i < count; i++) {
        const w = widgets[i]
        for (let c = 0; c < 4; c++) {
          if (w.round) cornerData[i * 4 + c] = options.radius * w.round[c]
          const amount = w.wedge ? Math.max(w.wedge[c * 2], w.wedge[c * 2 + 1]) : 0
          cornerData[i * 4 + c] *= 1 - amount
        }
      }
      for (let i = 0; i < cornerData.length; i++) cornerData[i] *= dpr

      gl.uniform2f(uResolution, pxW, pxH)
      gl.uniform1i(uCount, count)
      gl.uniform4fv(uRects, rectData)
      gl.uniform4fv(uColors, colorData)
      gl.uniform4fv(uCorners, cornerData)
      gl.uniform4fv(uWedgeX, wedgeXData)
      gl.uniform4fv(uWedgeY, wedgeYData)
      gl.uniform4fv(uWedgeR, wedgeRData)
      gl.uniform1f(uBlend, Math.max(0.0001, options.blend * dpr))

      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    },
    dispose() {
      gl.deleteBuffer(buffer)
      gl.deleteProgram(program)
    },
  }
}

/**
 * Resolves a `data-accent` name to its real token colour by letting the
 * cascade do it: a zero-size probe inside `host` inherits the same
 * widget-accent.css rules a real widget would, so this reads the actual
 * --accent-fill rather than duplicating the token values in JS.
 */
export function createAccentResolver(host: HTMLElement) {
  const cache = new Map<string, [number, number, number, number]>()
  const probe = document.createElement('div')
  probe.style.cssText = 'position:absolute;width:0;height:0;visibility:hidden;pointer-events:none'
  host.appendChild(probe)

  return {
    resolve(accent: string): [number, number, number, number] {
      const cached = cache.get(accent)
      if (cached) return cached
      probe.setAttribute('data-accent', accent)
      const raw = getComputedStyle(probe).getPropertyValue('--accent-fill').trim()
      const value = parseCssColor(raw)
      cache.set(accent, value)
      return value
    },
    dispose() {
      probe.remove()
    },
  }
}

/** Handles the `rgb(r g b)` / `rgb(r g b / a)` / `rgb(r, g, b)` forms the token CSS emits. */
function parseCssColor(input: string): [number, number, number, number] {
  const nums = input.match(/[\d.]+/g)
  if (!nums || nums.length < 3) return [0, 0, 0, 1]
  const [r, g, b] = nums.map(Number)
  const a = nums.length > 3 ? Number(nums[3]) : 1
  return [r / 255, g / 255, b / 255, a]
}
