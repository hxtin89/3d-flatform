// Regenerates CSS from the committed tokens-raw.json snapshot into a temp dir and
// diffs it against what's committed in src/. Exits non-zero on any difference.
//
// This catches the two drift modes that don't need Figma access at all:
//   - someone hand-edited a generated .css file directly
//   - someone changed generate.mjs without re-running it
// It does NOT check whether tokens-raw.json itself still matches live Figma --
// see the provenance line below and README.md for what that would take and why
// it isn't automated here.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, "..", "src");
const repoRoot = join(__dirname, "..", "..", "..");

// ---- provenance: how old is the snapshot this check trusts, and from which file? ----
try {
  const ds = JSON.parse(readFileSync(join(repoRoot, "design-system.json"), "utf8"));
  const fileKey = ds.figma?.fileKey ?? "unknown";
  const lastRun = ds.sync?.lastRun ?? null;
  const ageDays = lastRun ? Math.floor((Date.now() - new Date(lastRun).getTime()) / 86400000) : null;
  console.log(
    `tokens-raw.json snapshot: figma file ${fileKey}, last confirmed ${lastRun ?? "unknown"}` +
      (ageDays !== null ? ` (${ageDays} day${ageDays === 1 ? "" : "s"} ago)` : "")
  );
} catch {
  console.log("tokens-raw.json snapshot: provenance unavailable (design-system.json missing or unreadable)");
}

// ---- regenerate into a temp dir, diff against committed src/ ----
const tmp = mkdtempSync(join(tmpdir(), "tokens-check-"));
try {
  execFileSync(process.execPath, [join(__dirname, "generate.mjs"), tmp], { stdio: "inherit" });

  const generated = readdirSync(tmp);
  const mismatched = [];
  for (const name of generated) {
    let committed;
    try {
      committed = readFileSync(join(srcDir, name), "utf8");
    } catch {
      mismatched.push(`${name} (missing from src/)`);
      continue;
    }
    const fresh = readFileSync(join(tmp, name), "utf8");
    if (committed !== fresh) mismatched.push(name);
  }

  if (mismatched.length) {
    console.error("\nDrift detected -- committed CSS does not match what generate.mjs produces from tokens-raw.json:");
    for (const name of mismatched) console.error(`  src/${name}`);
    console.error('Do NOT reflexively run "npm run build" -- regenerating overwrites the committed file,');
    console.error('and two of them here were hand-corrected AFTER generation:');
    console.error('  src/typography-semantic.css  drops a @media (min-width: 480px) ramp the generator still');
    console.error('                               emits. It keyed off DOCUMENT width while ScreenFrame keys off');
    console.error('                               CONTAINER width, so the two fought and double-shrank text on');
    console.error('                               a narrow phone.');
    console.error('  src/widget-accent.css        carries the verified Figma accent bindings, and the note on');
    console.error('                               which accents have no Figma binding at all.');
    console.error('Regenerating re-introduces that media-query bug and deletes both explanations.');
    console.error('');
    console.error('Decide which side is right, then make them agree:');
    console.error('  generator right  -> npm run build, commit');
    console.error('  committed right  -> port the fix INTO scripts/generate.mjs, then build');
    process.exit(1);
  }
  console.log(`OK -- ${generated.length} generated file(s) match tokens-raw.json.`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
