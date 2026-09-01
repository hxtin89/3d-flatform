// Subtitle Autowrap -- breaks a paragraph into lines and builds one hugging pill
// per line, with the corner types and radii solved from the resulting widths.
//
// This exists because a Figma component cannot do it: components run no code, and
// the Plugin API never exposes where a text node wrapped. So the break is computed
// here and each line is written as its own pill.
//
// Everything is looked up BY NAME, not by node id -- ids are per-file and go stale
// as soon as anything is duplicated, and a generator that silently targets the
// wrong node is worse than one that refuses to run.

var LINE_COMPONENT = 'Subtitle Line';
var CORNER_SET = 'Corner';
var OUT_NAME = 'Test: Subtitle (auto-wrapped)';
var RADIUS = 30;

figma.showUI(__html__, { width: 440, height: 440 });

// Tells the panel the sandbox is alive. Without it, a plugin that fails to load
// and one that loads but never answers look identical from the UI side.
figma.ui.postMessage({ type: 'status', message: 'Ready.' });

figma.ui.onmessage = async function (msg) {
  if (!msg || msg.type !== 'run') return;
  try {
    var report = await generate(msg.text, Number(msg.maxWidth));
    figma.ui.postMessage({ type: 'done', report: report });
  } catch (error) {
    // Surface the stack too: the useful part of a Figma plugin failure is almost
    // always the API call that threw, not the message.
    figma.ui.postMessage({
      type: 'error',
      message: String((error && error.message) || error),
      detail: error && error.stack ? String(error.stack).split('\n').slice(0, 3).join(' | ') : ''
    });
  }
};

function findByName(type, name) {
  return figma.root.findOne(function (n) { return n.type === type && n.name === name; });
}

async function variableNamed(name) {
  var all = await figma.variables.getLocalVariablesAsync();
  var found = null;
  for (var i = 0; i < all.length; i++) if (all[i].name === name) found = all[i];
  if (!found) throw new Error('Variable "' + name + '" not found in this file.');
  return found;
}

async function generate(text, maxWidth) {
  if (!text || !text.trim()) throw new Error('No copy given.');
  if (!(maxWidth > 0)) throw new Error('Max width must be a positive number.');

  figma.ui.postMessage({ type: 'status', message: 'Loading document...' });
  await figma.loadAllPagesAsync();

  var line = findByName('COMPONENT', LINE_COMPONENT);
  if (!line) throw new Error('Component "' + LINE_COMPONENT + '" not found.');

  var cornerSet = findByName('COMPONENT_SET', CORNER_SET);
  if (!cornerSet) throw new Error('Component set "' + CORNER_SET + '" not found.');
  var atom = {};
  for (var c = 0; c < cornerSet.children.length; c++) {
    var m = /^Type=([^,]+), Size=Small$/.exec(cornerSet.children[c].name);
    if (m) atom[m[1]] = cornerSet.children[c].id;
  }
  var needed = ['Convex', 'None', 'Fill-Left', 'Fill-Top'];
  for (var n = 0; n < needed.length; n++) {
    if (!atom[needed[n]]) throw new Error('Corner variant "Type=' + needed[n] + ', Size=Small" not found.');
  }

  var pill = await variableNamed('label/pill');
  var none = await variableNamed('radius/none');
  var bg = await variableNamed('bg/subtle');

  var defs = line.componentPropertyDefinitions;
  function key(prefix) {
    var names = Object.keys(defs);
    for (var i = 0; i < names.length; i++) if (names[i].split('#')[0] === prefix) return names[i];
    throw new Error('"' + LINE_COMPONENT + '" has no property "' + prefix + '".');
  }
  var K = {
    text: key('Text'),
    tl: key('Corner Top Left'),
    tr: key('Corner Top Right'),
    br: key('Corner Bottom Right'),
    bl: key('Corner Bottom Left')
  };

  // --- measure ------------------------------------------------------------
  // Against a scratch node in the pill's own font, so the number we break on is
  // the width the pill will actually have. Padding is read off the component
  // rather than hardcoded, so retuning the pill cannot silently shift breaks.
  figma.ui.postMessage({ type: 'status', message: 'Measuring...' });
  var sample = line.findOne(function (x) { return x.type === 'TEXT'; });
  await figma.loadFontAsync(sample.fontName);
  var padding = line.paddingLeft + line.paddingRight;
  var probe = figma.createText();
  figma.currentPage.appendChild(probe);
  probe.fontName = sample.fontName;
  probe.fontSize = sample.fontSize;
  probe.textAutoResize = 'WIDTH_AND_HEIGHT';
  function widthOf(s) { probe.characters = s; return probe.width + padding; }

  var lines = [];
  var paragraphs = text.split('\n');
  for (var p = 0; p < paragraphs.length; p++) {
    var words = paragraphs[p].split(/\s+/).filter(Boolean);
    var current = '';
    for (var w = 0; w < words.length; w++) {
      var candidate = current ? current + ' ' + words[w] : words[w];
      // A single word wider than the cap gets its own over-long line rather than
      // being split: pills hug, so it renders wide instead of clipped, and
      // hyphenation is a typographic call this must not make silently.
      if (current && widthOf(candidate) > maxWidth) { lines.push(current); current = words[w]; }
      else current = candidate;
    }
    if (current) lines.push(current);
  }
  var widths = lines.map(widthOf);
  probe.remove();

  // --- build --------------------------------------------------------------
  figma.ui.postMessage({ type: 'status', message: 'Building ' + lines.length + ' lines...' });
  var page = figma.currentPage;
  var previous = null;
  for (var i = 0; i < page.children.length; i++) {
    if (page.children[i].name === OUT_NAME) previous = page.children[i];
  }
  var at = previous ? { x: previous.x, y: previous.y } : { x: 0, y: 0 };
  if (previous) previous.remove();

  var host = figma.createFrame();
  host.name = OUT_NAME;
  host.layoutMode = 'VERTICAL';
  host.itemSpacing = 0;
  host.counterAxisAlignItems = 'MIN';
  host.paddingTop = host.paddingBottom = host.paddingLeft = host.paddingRight = 60;
  host.fills = [figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }, 'color', bg)];
  page.appendChild(host);
  host.layoutSizingHorizontal = 'HUG';
  host.layoutSizingVertical = 'HUG';
  host.x = at.x;
  host.y = at.y;

  // Both right-hand corners ask the same thing: is my neighbour on that side
  // LONGER than me? Then my free edge sweeps out to land on it -- Fill-Left. Top
  // right looks up, bottom right looks down. Below one radius of difference a
  // fillet cannot draw at all and collapses into a nick, so near-equal counts as
  // flush. Same rule as packages/ui/src/lib/geometry/label-stack.ts.
  function free(neighbor, own) {
    if (neighbor === undefined) return atom.Convex;
    if (Math.abs(neighbor - own) < RADIUS) return atom.None;
    return neighbor < own ? atom.Convex : atom['Fill-Left'];
  }
  function radiusFor(type) { return type === atom.Convex ? pill : none; }

  for (var j = 0; j < lines.length; j++) {
    var instance = line.createInstance();
    host.appendChild(instance);
    var isFirst = j === 0;
    var isLast = j === lines.length - 1;
    var tr = free(isFirst ? undefined : widths[j - 1], widths[j]);
    var br = free(isLast ? undefined : widths[j + 1], widths[j]);
    var tl = isFirst ? atom['Fill-Top'] : atom.None;
    var bl = isLast ? atom['Fill-Top'] : atom.None;
    var props = {};
    props[K.text] = lines[j];
    props[K.tl] = tl;
    props[K.tr] = tr;
    props[K.br] = br;
    props[K.bl] = bl;
    instance.setProperties(props);
    instance.setBoundVariable('topLeftRadius', radiusFor(tl));
    instance.setBoundVariable('topRightRadius', radiusFor(tr));
    instance.setBoundVariable('bottomRightRadius', radiusFor(br));
    instance.setBoundVariable('bottomLeftRadius', radiusFor(bl));
  }

  figma.currentPage.selection = [host];
  figma.viewport.scrollAndZoomIntoView([host]);
  return lines.map(function (content, i) {
    return { width: Math.round(widths[i]), text: content };
  });
}
