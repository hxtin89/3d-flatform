# @wi/tokens

CSS custom properties generated from a snapshot of Figma variables. Plain CSS, no build step to consume.

## How it works

`scripts/generate.mjs` reads `scripts/tokens-raw.json` — a **manual JSON snapshot** of the Figma
file's variable collections — and writes the `.css` files in `src/`. `npm run build` runs it.

## What `tokens:validate` checks (and what it doesn't)

`npm run tokens:validate` runs `scripts/check-drift.mjs`, which:

1. Regenerates the CSS from the *currently committed* `tokens-raw.json` into a temp directory.
2. Diffs it byte-for-byte against the *currently committed* `src/*.css`.
3. Fails (non-zero exit) on any difference.

That catches two failure modes without needing Figma at all:

- Someone hand-edited a generated `.css` file directly (drifts from what the snapshot says).
- Someone changed `generate.mjs` without re-running it (drifts from what's committed).

It also prints a **provenance line** — which Figma file (`figma.fileKey`) the snapshot claims to be
from and when it was last confirmed current (`sync.lastRun`), both read from the repo-root
`design-system.json` — plus how many days old that confirmation is. That's a staleness signal for a
human to read, not a pass/fail condition; the check does not fail just because the snapshot is old.

**What it does NOT check: whether `tokens-raw.json` itself still matches live Figma.** There is no
automated pull from Figma in this repo. `generate.mjs` only ever reads the local snapshot file — it
has no network access and no opinion on whether that snapshot is current. So `tokens-raw.json` can
silently drift from the real Figma variables (someone changes a color in Figma and never re-syncs)
and this check will pass anyway, because it only verifies internal consistency between the snapshot
and the generated CSS, not the snapshot against Figma itself.

Why not automate that too: a live pull needs either a `FIGMA_ACCESS_TOKEN` (REST API — and this
file's plan may not expose the Variables API) or the interactive desktop bridge plugin. Neither runs
unattended in CI, so there's no honest way to make "is the snapshot still right" a CI gate today.

## Refreshing the snapshot (manual, by a human)

1. Pull the current variables from the Figma file at `figma.fileKey` in `design-system.json`
   (`6VZRVUlLaIDwv3lMSIPdDm` as of writing) — via the `token-sync-layer` skill, the desktop bridge
   plugin, or the REST Variables API if the plan supports it.
2. Overwrite `scripts/tokens-raw.json` with the result.
3. Run `npm run build` and review the diff in `src/*.css`.
4. Update `sync.lastRun` (and `sync.note`) in the repo-root `design-system.json` to the current
   timestamp, so the provenance line above reflects reality again.
5. Commit snapshot, generated CSS, and `design-system.json` together.

## Known state

`typography-semantic.css` and `widget-accent.css` in `src/` currently do **not** match what
`generate.mjs` produces from `tokens-raw.json` — they were deliberately hand-edited (see the WHY
comments at the top of each file) to fix things the snapshot/generator gets wrong (e.g. aliasing
colors to existing primitives, removing a media-query breakpoint that fought with the app's own
container-based scaling). `tokens:validate` will report this as drift until either the hand-edits are
folded back into `generate.mjs`'s logic or the snapshot/generator catch up some other way — that
reconciliation is unstarted, tracked here rather than silently passed over.
