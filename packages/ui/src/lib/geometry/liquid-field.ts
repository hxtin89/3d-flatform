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

export interface LiquidWidget {
  x: number
  y: number
  width: number
  height: number
  /** Resolved rgba, 0..1 per channel -- see resolveAccentColor(). */
  color: [number, number, number, number]
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
uniform float uBlend;

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
    vec2 hs = r.zw * 0.5;
    float di = sdRoundBox(p - (r.xy + hs), hs, uCorners[i]);
    blended = (i == 0) ? di : sminCircular(blended, di, uBlend);
    // Colour comes from the NEAREST widget by its own un-blended distance, so
    // adjacent widgets of different accents meet on a hard seam (as Figma
    // does) instead of smearing into each other the way the blended field
    // itself does.
    if (di < nearest) { runnerUp = nearest; nearest = di; col = uColors[i]; }
    else if (di < runnerUp) { runnerUp = di; }
  }

  // Analytic AA on the outer edge.
  float edgeAA = fwidth(blended);
  float alpha = 1.0 - smoothstep(-edgeAA, edgeAA, blended);

  // A one-pixel feather on the colour seam only -- enough to kill stair-steps
  // if a seam is ever off-axis, far too tight to read as a gradient.
  float seam = (runnerUp - nearest) * 0.5;
  float seamAA = fwidth(seam);
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
  const uBlend = gl.getUniformLocation(program, 'uBlend')

  gl.enable(gl.BLEND)
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

  const rectData = new Float32Array(MAX_WIDGETS * 4)
  const colorData = new Float32Array(MAX_WIDGETS * 4)

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
      for (let i = 0; i < count; i++) {
        const w = widgets[i]
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
      for (let i = 0; i < cornerData.length; i++) cornerData[i] *= dpr

      gl.uniform2f(uResolution, pxW, pxH)
      gl.uniform1i(uCount, count)
      gl.uniform4fv(uRects, rectData)
      gl.uniform4fv(uColors, colorData)
      gl.uniform4fv(uCorners, cornerData)
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
