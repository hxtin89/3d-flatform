// Subtitle Autowrap — paste this whole file into the Scripter plugin and press Run.
//
// It takes ONE paragraph, breaks it into lines, and builds one hugging pill per
// line with the corner types and radii solved from the resulting widths. A Figma
// component cannot do this itself: components run no code, and the Plugin API
// never exposes where a text node wrapped. So the break is computed here and each
// line is written as its own pill.
//
// The trick is to not ask Figma where it broke the text. Candidate lines are
// measured against a scratch text node in the pill's own font, the break is
// decided here, and each line's string is then written into its own pill — so
// every pill holds exactly the string whose width was measured, and the rendered
// width and the width the corner logic reasoned about cannot disagree.
//
// Also runs unchanged through the MCP bridge (figma_execute), where `print` does
// not exist and the trailing expression is the output instead.
//
// Everything is looked up BY NAME, never by node id: ids are per-file and go
// stale as soon as anything is duplicated, and a generator that silently targets
// the wrong node is worse than one that refuses to run.

// ---------------------------------------------------------------------------
// EDIT THESE TWO, THEN RUN
// ---------------------------------------------------------------------------
const TEXT = "Das sind die 52m², welche mit deiner Spende geschützt wurden.";
const MAX_WIDTH = 1010; // pill width cap; 1010 fits the 1080 mobile frame inside the thin border
// ---------------------------------------------------------------------------

const LINE_COMPONENT = "Subtitle Line";
const CORNER_SET = "Corner";
const OUT_NAME = "Test: Subtitle (auto-wrapped)";
const RADIUS = 30;

const log = typeof print === "function" ? print : (m) => console.log(m);

// Scripter's manifest may or may not use dynamic-page access; load only if the
// API is there, so the same file runs under both.
if (typeof figma.loadAllPagesAsync === "function") await figma.loadAllPagesAsync();

const findByName = (type, name) => figma.root.findOne((n) => n.type === type && n.name === name);

const line = findByName("COMPONENT", LINE_COMPONENT);
if (!line) throw new Error(`Component "${LINE_COMPONENT}" not found — is this the WI-Map file?`);

const cornerSet = findByName("COMPONENT_SET", CORNER_SET);
if (!cornerSet) throw new Error(`Component set "${CORNER_SET}" not found.`);
const atom = {};
for (const variant of cornerSet.children) {
  const match = /^Type=([^,]+), Size=Small$/.exec(variant.name);
  if (match) atom[match[1]] = variant.id;
}
for (const needed of ["Convex", "None", "Fill-Left", "Fill-Top"]) {
  if (!atom[needed]) throw new Error(`Corner variant "Type=${needed}, Size=Small" not found.`);
}

if (!figma.variables) throw new Error("This file exposes no variables API — wrong file, or an old plugin build.");
const allVars = figma.variables.getLocalVariablesAsync
  ? await figma.variables.getLocalVariablesAsync()
  : figma.variables.getLocalVariables();
const variableNamed = (name) => {
  const found = allVars.find((v) => v.name === name);
  if (!found) throw new Error(`Variable "${name}" not found in this file.`);
  return found;
};
const pill = variableNamed("label/pill");
const none = variableNamed("radius/none");
const bg = variableNamed("bg/subtle");

const defs = line.componentPropertyDefinitions;
const key = (prefix) => {
  const found = Object.keys(defs).find((k) => k.split("#")[0] === prefix);
  if (!found) throw new Error(`"${LINE_COMPONENT}" has no property "${prefix}".`);
  return found;
};
const K = {
  text: key("Text"),
  tl: key("Corner Top Left"),
  tr: key("Corner Top Right"),
  br: key("Corner Bottom Right"),
  bl: key("Corner Bottom Left"),
};

// --- measure ---------------------------------------------------------------
// Padding is read off the component rather than hardcoded, so retuning the pill
// cannot silently shift where lines break.
const sample = line.findOne((n) => n.type === "TEXT");
await figma.loadFontAsync(sample.fontName);
const padding = line.paddingLeft + line.paddingRight;
const probe = figma.createText();
figma.currentPage.appendChild(probe);
probe.fontName = sample.fontName;
probe.fontSize = sample.fontSize;
probe.textAutoResize = "WIDTH_AND_HEIGHT";
const widthOf = (s) => {
  probe.characters = s;
  return probe.width + padding;
};

const lines = [];
for (const paragraph of TEXT.split("\n")) {
  let current = "";
  for (const word of paragraph.split(/\s+/).filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word;
    // A word wider than the cap gets its own over-long line rather than being
    // split: pills hug, so it renders wide instead of clipped, and hyphenation is
    // a typographic call this must not make silently.
    if (current && widthOf(candidate) > MAX_WIDTH) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
}
const widths = lines.map(widthOf);
probe.remove();

// --- build -----------------------------------------------------------------
const page = figma.currentPage;
const previous = page.children.find((c) => c.name === OUT_NAME);
const at = previous ? { x: previous.x, y: previous.y } : { x: 0, y: 0 };
if (previous) previous.remove();

const host = figma.createFrame();
host.name = OUT_NAME;
host.layoutMode = "VERTICAL";
host.itemSpacing = 0;
host.counterAxisAlignItems = "MIN";
host.paddingTop = host.paddingBottom = host.paddingLeft = host.paddingRight = 60;
host.fills = [figma.variables.setBoundVariableForPaint({ type: "SOLID", color: { r: 0, g: 0, b: 0 } }, "color", bg)];
page.appendChild(host);
host.layoutSizingHorizontal = "HUG";
host.layoutSizingVertical = "HUG";
host.x = at.x;
host.y = at.y;

// Both right-hand corners ask the same thing: is my neighbour on that side LONGER
// than me? Then my free edge sweeps out to land on it — Fill-Left. Top right looks
// up, bottom right looks down. Below one radius of difference a fillet cannot draw
// at all and collapses into a nick in the edge, so near-equal counts as flush.
// Same rule as packages/ui/src/lib/geometry/label-stack.ts.
const free = (neighbor, own) => {
  if (neighbor === undefined) return atom.Convex;
  if (Math.abs(neighbor - own) < RADIUS) return atom.None;
  return neighbor < own ? atom.Convex : atom["Fill-Left"];
};
const radiusFor = (type) => (type === atom.Convex ? pill : none);
const NAME = {};
NAME[atom.Convex] = "Convex";
NAME[atom.None] = "None";
NAME[atom["Fill-Left"]] = "Fill-Left";
NAME[atom["Fill-Top"]] = "Fill-Top";

const report = lines.map((content, i) => {
  const instance = line.createInstance();
  host.appendChild(instance);
  const isFirst = i === 0;
  const isLast = i === lines.length - 1;
  const tr = free(isFirst ? undefined : widths[i - 1], widths[i]);
  const br = free(isLast ? undefined : widths[i + 1], widths[i]);
  const tl = isFirst ? atom["Fill-Top"] : atom.None;
  const bl = isLast ? atom["Fill-Top"] : atom.None;
  instance.setProperties({ [K.text]: content, [K.tl]: tl, [K.tr]: tr, [K.br]: br, [K.bl]: bl });
  instance.setBoundVariable("topLeftRadius", radiusFor(tl));
  instance.setBoundVariable("topRightRadius", radiusFor(tr));
  instance.setBoundVariable("bottomRightRadius", radiusFor(br));
  instance.setBoundVariable("bottomLeftRadius", radiusFor(bl));
  return { width: Math.round(widths[i]), topRight: NAME[tr], bottomRight: NAME[br], text: content };
});

figma.currentPage.selection = [host];
figma.viewport.scrollAndZoomIntoView([host]);

log(`${report.length} lines at max ${MAX_WIDTH}px:`);
for (const row of report) log(`  ${String(row.width).padStart(5)}px  ${row.topRight}/${row.bottomRight}  ${row.text}`);
report;
