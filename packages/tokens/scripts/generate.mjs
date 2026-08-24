// Emits CSS custom properties from tokens-raw.json (a snapshot of Figma variables).
// Re-run after `token-sync-layer` refreshes tokens-raw.json from Figma.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(join(__dirname, "tokens-raw.json"), "utf8"));
const outDir = join(__dirname, "..", "src");
mkdirSync(outDir, { recursive: true });

const cssName = (name) =>
  "--" +
  name
    .replace(/\//g, "-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();

// unit inference by variable-name pattern
function unitFor(name) {
  if (name.startsWith("weight/") || name.startsWith("lineHeight/")) return "";
  if (name.startsWith("letterSpacing/")) return "em";
  return "px";
}

function colorToCss({ r, g, b, a = 1 }) {
  const to255 = (v) => Math.round(v * 255);
  return a >= 1
    ? `rgb(${to255(r)} ${to255(g)} ${to255(b)})`
    : `rgb(${to255(r)} ${to255(g)} ${to255(b)} / ${a.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")})`;
}

function findCollection(name) {
  const c = raw.collections.find((c) => c.name === name);
  if (!c) throw new Error(`collection not found: ${name}`);
  return c;
}

// resolve one variable's value for one mode into a CSS declaration.
// aliases become var(--referenced-name) so the cascade stays live, not baked-in.
function emitVar(name, value, type) {
  const unit = type === "COLOR" || type === "STRING" ? "" : unitFor(name);
  if (value && value.type === "VARIABLE_ALIAS") {
    const refName = raw.aliasNames[value.id];
    if (!refName) throw new Error(`unresolved alias: ${value.id} (for ${name})`);
    return `  ${cssName(name)}: var(${cssName(refName)});`;
  }
  if (type === "COLOR") return `  ${cssName(name)}: ${colorToCss(value)};`;
  if (type === "STRING") return `  ${cssName(name)}: "${value}";`;
  return `  ${cssName(name)}: ${value}${unit};`;
}

function block(selector, lines) {
  return `${selector} {\n${lines.join("\n")}\n}\n`;
}

// ---- 1. primitives.css: one flat :root ----
{
  const collNames = ["_Color/Primitive", "Spacing/Primitive", "_Radius/Primitive", "_Border/Primitive", "_Typography/Primitive"];
  const lines = [];
  for (const cn of collNames) {
    const c = findCollection(cn);
    const modeId = c.modes[0].id;
    for (const v of c.variables) {
      lines.push(emitVar(v.name, v.valuesByMode[modeId], v.type));
    }
  }
  writeFileSync(join(outDir, "primitives.css"), block(":root", lines));
}

// ---- 2. semantic.css: single-mode semantic collections (Radius/Semantic, Spacing/Semantic, Border/Semantic) ----
{
  const collNames = ["Spacing/Semantic", "Radius/Semantic", "Border/Semantic"];
  const lines = [];
  for (const cn of collNames) {
    const c = findCollection(cn);
    const modeId = c.modes[0].id;
    for (const v of c.variables) {
      lines.push(emitVar(v.name, v.valuesByMode[modeId], v.type));
    }
  }
  writeFileSync(join(outDir, "semantic.css"), block(":root", lines));
}

// ---- 3. color-semantic.css: Light in :root, Dark in prefers-color-scheme + [data-theme="dark"] ----
{
  const c = findCollection("Color/Semantic");
  const light = c.modes.find((m) => m.name === "Light").id;
  const dark = c.modes.find((m) => m.name === "Dark").id;
  const lightLines = c.variables.map((v) => emitVar(v.name, v.valuesByMode[light], v.type));
  const darkLines = c.variables.map((v) => emitVar(v.name, v.valuesByMode[dark], v.type));
  const out =
    block(":root", lightLines) +
    "\n@media (prefers-color-scheme: dark) {\n" +
    block(':root:not([data-theme="light"])', darkLines).split("\n").map((l) => (l ? "  " + l : l)).join("\n") +
    "}\n\n" +
    block(':root[data-theme="dark"]', darkLines);
  writeFileSync(join(outDir, "color-semantic.css"), out);
}

// ---- 4. typography-semantic.css: Mobile in :root (mobile-first), Desktop behind min-width ----
{
  const c = findCollection("Typography/Semantic");
  const desktop = c.modes.find((m) => m.name === "Desktop").id;
  const mobile = c.modes.find((m) => m.name === "Mobile").id;
  const mobileLines = c.variables.map((v) => emitVar(v.name, v.valuesByMode[mobile], v.type));
  const desktopLines = c.variables.map((v) => emitVar(v.name, v.valuesByMode[desktop], v.type));
  // 1080x1920 design frame = 360 logical px -> desktop breakpoint at the frame's own logical width
  const out =
    block(":root", mobileLines) +
    "\n@media (min-width: 480px) {\n" +
    block(":root", desktopLines).split("\n").map((l) => (l ? "  " + l : l)).join("\n") +
    "}\n";
  writeFileSync(join(outDir, "typography-semantic.css"), out);
}

// ---- 5. widget-accent.css: ONE stylesheet, [data-accent="..."] blocks + :root fallback ----
{
  const c = findCollection("Color/Widget Accent");
  const defaultMode = c.modes.find((m) => m.name === "Default").id;
  const defaultLines = c.variables.map((v) => emitVar(v.name, v.valuesByMode[defaultMode], v.type));
  let out = "/* Default mode as the fallback, so a widget with no data-accent still resolves. */\n";
  out += block(":root", defaultLines);
  for (const mode of c.modes) {
    const slug = mode.name.toLowerCase().replace(/\s+/g, "-");
    const lines = c.variables.map((v) => emitVar(v.name, v.valuesByMode[mode.id], v.type));
    out += "\n" + block(`[data-accent="${slug}"]`, lines);
  }
  writeFileSync(join(outDir, "widget-accent.css"), out);
}

// ---- 6. index.css: import order matters (primitives -> semantic -> color/typography -> accent) ----
// typography-styles.css is hand-authored (bundled Figma-style Font() shorthands
// composing the generated scale below), not regenerated from tokens-raw.json --
// still listed here so re-running this script doesn't drop the import.
{
  const out = [
    `@import "./primitives.css";`,
    `@import "./semantic.css";`,
    `@import "./color-semantic.css";`,
    `@import "./typography-semantic.css";`,
    `@import "./typography-styles.css";`,
    `@import "./widget-accent.css";`,
  ].join("\n") + "\n";
  writeFileSync(join(outDir, "index.css"), out);
}

console.log("Wrote packages/tokens/src/*.css");
