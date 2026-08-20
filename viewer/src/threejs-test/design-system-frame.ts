// Owns the "grey frame" backdrop: a gray/200 SVG rect masked to show a big
// rounded window (the point-cloud viewport) plus whatever notches docked
// elements report. Mirrors how Figma's real "S1: Photo" node works -- it's
// a VECTOR with a notched-polygon path (not a plain rounded rect), cutting
// room for the logo and the weather cluster out of one continuous shape:
//   M 0 1789 L 0 57.5 L 122.78 57.5 L 122.78 0 L 600 0 L 600 359.1
//   L 960 359.1 L 960 1789 Z
// (mobile Frame 1, local to the photo). Frame 1 Desktop has the identical
// two-notch pattern at desktop scale, confirming it's deliberate, not a
// mobile-only shape.
//
// Margin is live, animatable state (not a fixed computed constant), so the
// frame can reveal/retract by tweening margin between 0 and its resting
// value -- see animateMarginTo().

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Frame {
  /** Sets the margin instantly (no animation) and re-renders the window and every notch. */
  setMargin(px: number): void
  getMargin(): number
  /** The frame's resting margin for the current viewport -- a real visible border, not a thin sliver. */
  getTargetMargin(): number
  /**
   * Registers/updates a named notch's cutout rect (viewport pixel coords).
   * A notch is just "reveal the 3D scene here" -- passing an element's full
   * bounding rect is always correct, whether it sits fully inside the
   * window already (a no-op, since that area is already revealed) or pokes
   * past its edge (a real cutout). No need to compute the non-overlapping
   * part separately.
   */
  setNotch(id: string, rect: Rect): void
  /** Tweens margin from its current value to `px` over `durationMs`, calling onTick after every frame's setMargin (so callers can reposition frame-docked elements as the margin moves). */
  animateMarginTo(px: number, durationMs: number, onTick?: () => void): Promise<void>
  /** Recomputes svg/window sizing for the current viewport -- call on resize. */
  handleResize(): void
  dispose(): void
}

const SVG_NS = 'http://www.w3.org/2000/svg'

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value)
  return el
}

// Fixed corner offset for the eagle logo notch, matching where the "Vector"
// eagle icon sits in Figma (165,30,114,68) in BOTH the mobile and desktop
// frames -- anchored to the corner at a constant pixel offset, not tied to
// the viewport-relative margin.
const LOGO_NOTCH: Rect = { x: 20, y: 20, width: 130, height: 74 }

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

export function createFrame(): Frame {
  const svg = svgEl('svg')
  svg.style.position = 'fixed'
  svg.style.inset = '0'
  svg.style.zIndex = '40'
  svg.style.pointerEvents = 'none'

  const maskId = 'design-system-demo-frame-mask'
  const mask = svgEl('mask', { id: maskId })
  const maskBackground = svgEl('rect', { x: '0', y: '0', fill: 'white' })
  const windowNotch = svgEl('rect', { fill: 'black' })
  const logoNotch = svgEl('rect', { fill: 'black' })
  mask.append(maskBackground, windowNotch, logoNotch)

  const gray = svgEl('rect', { x: '0', y: '0', fill: 'var(--gray-200)' })
  gray.setAttribute('mask', `url(#${maskId})`)

  svg.append(mask, gray)
  document.body.append(svg)

  const notchElements = new Map<string, SVGRectElement>()

  function setRect(el: SVGRectElement, rect: Rect, radius: number) {
    el.setAttribute('x', String(rect.x))
    el.setAttribute('y', String(rect.y))
    el.setAttribute('width', String(Math.max(0, rect.width)))
    el.setAttribute('height', String(Math.max(0, rect.height)))
    el.setAttribute('rx', String(radius))
  }

  let margin = 0

  function render() {
    const w = String(window.innerWidth)
    const h = String(window.innerHeight)
    svg.setAttribute('width', w)
    svg.setAttribute('height', h)
    maskBackground.setAttribute('width', w)
    maskBackground.setAttribute('height', h)
    gray.setAttribute('width', w)
    gray.setAttribute('height', h)
    setRect(windowNotch, { x: margin, y: margin, width: window.innerWidth - margin * 2, height: window.innerHeight - margin * 2 }, 60)
    setRect(logoNotch, LOGO_NOTCH, 16)
  }
  render()

  // Observed in testing: a mask="url(#id)" reference set in the same tick
  // the <mask> element is inserted can render as if the mask weren't there
  // at all (fully opaque, no cutouts) until something forces the browser to
  // re-resolve the reference. A same-frame requestAnimationFrame reset
  // wasn't a long enough delay to fix it reliably; toggling the attribute
  // off and back on after the page has had a moment to settle is what
  // verified clean across repeated fresh loads.
  setTimeout(() => {
    gray.removeAttribute('mask')
    gray.setAttribute('mask', `url(#${maskId})`)
  }, 200)

  function apply(px: number) {
    margin = px
    render()
  }

  let animationFrame = 0

  return {
    setMargin: apply,
    getMargin() {
      return margin
    },
    getTargetMargin() {
      return Math.min(window.innerWidth, window.innerHeight) * 0.12
    },
    setNotch(id, rect) {
      let el = notchElements.get(id)
      if (!el) {
        el = svgEl('rect', { fill: 'black' })
        mask.append(el)
        notchElements.set(id, el)
      }
      setRect(el, rect, 40)
    },
    animateMarginTo(target, durationMs, onTick) {
      return new Promise((resolve) => {
        cancelAnimationFrame(animationFrame)
        const start = margin
        const startTime = performance.now()
        function tick(now: number) {
          const t = Math.min(1, (now - startTime) / durationMs)
          apply(start + (target - start) * easeOutCubic(t))
          onTick?.()
          if (t < 1) {
            animationFrame = requestAnimationFrame(tick)
          } else {
            resolve()
          }
        }
        animationFrame = requestAnimationFrame(tick)
      })
    },
    handleResize: render,
    dispose() {
      cancelAnimationFrame(animationFrame)
      svg.remove()
    },
  }
}
