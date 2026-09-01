// Generates a Subtitle stack in Figma from ONE paragraph: wraps it, then builds
// one hugging pill per resulting line with the right corner types and radii.
//
// Run it through the Figma Desktop Bridge (figma_execute) or paste it into a
// plugin console. It is a generator, not a live component -- Figma components
// cannot run code, and the Plugin API does not expose where a text node wraps.
//
// The trick is to not ask Figma where it broke the text. We measure candidate
// lines ourselves against a scratch text node in the same font, decide the
// breaks, and then write each line's string into its own pill. Every pill
// therefore contains exactly the string whose width we measured, so the
// rendered width and the width the corner logic reasoned about cannot drift
// apart. (Verified: all four rendered pills matched their measured width to
// the pixel.)
//
// Re-run it whenever the copy changes; it replaces the previous output frame.

const TEXT =
  'Im Secret Forest ist es gerade 4:50. Nur noch eine Stunde, dann beginnt der ' +
  'Dawn Chorus. Halte Ausschau nach dem Sira Giftfrosch am Ufer, dort wo der ' +
  'Nebel am längsten über dem Wasser steht.'
const MAX_WIDTH = 1010          // pill width cap; 1010 fits the 1080 mobile frame inside the thin border
const OUT_NAME = 'Test: Subtitle (auto-wrapped)'

const SUBTITLE_LINE = '25638:1681'
const VAR_PILL = 'VariableID:25556:340'    // Radius/Semantic label/pill = 30
const VAR_NONE = 'VariableID:25506:1021'   // _Radius/Primitive radius/none = 0
const VAR_BG = 'VariableID:25506:1058'     // Color/Semantic bg/subtle
const ATOM = { convex: '25556:607', none: '25556:608', fillLeft: '25556:610', fillTop: '25556:611' }
const RADIUS = 30

const line = await figma.getNodeByIdAsync(SUBTITLE_LINE)
const page = figma.currentPage
const pill = await figma.variables.getVariableByIdAsync(VAR_PILL)
const none = await figma.variables.getVariableByIdAsync(VAR_NONE)
const bg = await figma.variables.getVariableByIdAsync(VAR_BG)

const defs = line.componentPropertyDefinitions
const key = (p) => Object.keys(defs).find((k) => k.split('#')[0] === p)
const K = {
  text: key('Text'),
  tl: key('Corner Top Left'),
  tr: key('Corner Top Right'),
  br: key('Corner Bottom Right'),
  bl: key('Corner Bottom Left'),
}

// --- measure -------------------------------------------------------------
const sample = line.findOne((n) => n.type === 'TEXT')
await figma.loadFontAsync(sample.fontName)
const padding = line.paddingLeft + line.paddingRight
const probe = figma.createText()
page.appendChild(probe)
probe.fontName = sample.fontName
probe.fontSize = sample.fontSize
probe.textAutoResize = 'WIDTH_AND_HEIGHT'
const widthOf = (s) => {
  probe.characters = s
  return probe.width + padding
}

// Greedy wrap, breaking only at whitespace. Authored newlines are kept as hard
// breaks so a caller can still force a line where the copy needs one.
function wrap(text, maxWidth) {
  const out = []
  for (const para of text.split('\n')) {
    let cur = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = cur ? cur + ' ' + word : word
      if (cur && widthOf(next) > maxWidth) {
        out.push(cur)
        cur = word
      } else {
        cur = next
      }
    }
    if (cur) out.push(cur)
  }
  return out
}

const lines = wrap(TEXT, MAX_WIDTH)
const widths = lines.map(widthOf)
probe.remove()

// --- build ---------------------------------------------------------------
const previous = page.children.find((c) => c.name === OUT_NAME)
if (previous) previous.remove()

const host = figma.createFrame()
host.name = OUT_NAME
host.layoutMode = 'VERTICAL'
host.itemSpacing = 0
host.counterAxisAlignItems = 'MIN'
host.paddingTop = host.paddingBottom = host.paddingLeft = host.paddingRight = 60
host.fills = [figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }, 'color', bg)]
page.appendChild(host)
host.layoutSizingHorizontal = 'HUG'
host.layoutSizingVertical = 'HUG'

// Same rule as packages/ui/src/lib/geometry/label-stack.ts -- deliberately, so the
// Figma output and the runtime component cannot drift into different corner logic.
//
// Both RIGHT-hand corners answer the same question: is my vertical neighbour on
// that side LONGER than me? If so this line's free edge has to sweep out past
// itself and land tangent on the longer line, which is Fill-Left. Top-right looks
// up, bottom-right looks down. (An earlier version used Fill-Top for the top-right
// case, which bulges the wrong way.)
//
// A fillet cannot draw in less than its own radius of width difference; below that
// it collapses into a sliver that reads as a nick in the edge. Wrapped copy hits
// this constantly -- two lines filled to the same cap land a pixel or two apart --
// so near-equal counts as flush and the edge runs straight through.
const free = (neighbor, w) => {
  if (neighbor === undefined) return ATOM.convex
  if (Math.abs(neighbor - w) < RADIUS) return ATOM.none
  return neighbor < w ? ATOM.convex : ATOM.fillLeft
}
// Only a real exterior corner is rounded. Every wedge and every flush join sits at 0.
const radiusFor = (type) => (type === ATOM.convex ? pill : none)

lines.forEach((text, i) => {
  const inst = line.createInstance()
  host.appendChild(inst)
  const isFirst = i === 0
  const isLast = i === lines.length - 1

  const tr = free(isFirst ? undefined : widths[i - 1], widths[i])
  const br = free(isLast ? undefined : widths[i + 1], widths[i])
  // Anchor-side caps close the stack top and bottom; the anchor side BETWEEN
  // lines is never bitten into, so it stays flush.
  const tl = isFirst ? ATOM.fillTop : ATOM.none
  const bl = isLast ? ATOM.fillTop : ATOM.none

  inst.setProperties({ [K.text]: text, [K.tl]: tl, [K.tr]: tr, [K.br]: br, [K.bl]: bl })
  inst.setBoundVariable('topLeftRadius', radiusFor(tl))
  inst.setBoundVariable('topRightRadius', radiusFor(tr))
  inst.setBoundVariable('bottomRightRadius', radiusFor(br))
  inst.setBoundVariable('bottomLeftRadius', radiusFor(bl))
})

return {
  lines: lines.length,
  pills: host.children.map((c, i) => ({
    width: Math.round(c.width),
    measured: Math.round(widths[i]),
    matches: Math.round(c.width) === Math.round(widths[i]),
  })),
}
