# Handover: the grade editor (goal 4 of the colour brief)

Written 2026-10-05 at the end of the session that did the colour match and the drone ortho, so a
new session can pick up the grade editor without that history. Nothing of the grade editor is
built yet; the branch exists and the design workflow is ready to run.

## Where things are

- **Worktree:** `C:/projects/WIDE_3d-flatform/.claude/worktrees/sbb-colour-matching` (used only by
  this line of work; a branch switch here moves no other session).
- **Branch:** `sbb/grade-editor`, created at `2def41d`, no commits of its own yet. The stack under
  it, all **local and unpushed**:
  - `sbb/tone-mapping` 20f0219 (the film look, see below)
  - `sbb/colour-matching` 76f311f … 0ad8f9e: colour field (cloud ↔ basemap match), drone ortho,
    tile retry
  - `sbb/ortho-upgrade` 51f75e3, d7e06d7, 2def41d: the ortho moved off the basemap's refinement
    path (settled tiles are upgraded in their own texture)
- The user keeps this stack apart from `main` and `sbb-main`. Do not merge or push without asking.
- **Uncommitted on purpose:** `.claude/launch.json` has a `colour-dev` entry
  (`npm --prefix <worktree>/viewer run dev`, port 5177), because `viewer-dev` fails here with
  "'vite' is not recognized". Start the dev server with `preview_start {name: "colour-dev"}`.
  Port 5177 matters: the localhost MapTiler key only answers on listed ports.
- **Living write-up:** https://claude.ai/artifact/JjMNnLFjremEdsYPSSKqUg ("Canopy Colour
  Matching", version 5). Short summary at the top (what, how, why, what is open), a newest-first
  dated changelog under it. Update it by its URL (read it first), never publish a new one. Its
  "Plan → 4 · Grade editor" and "5 · The WI look" phases are the brief below.
- **Memory:** `colour-matching-branch`, `canopy-colour-matching-artifact`, `tone-mapping-branch`,
  `canopy-look-board` hold the background.
- **Old session transcript:** `C:\Users\krenz\.claude\projects\C--projects-WIDE-3d-flatform--claude-worktrees-sbb-colour-matching\afe295e8-4e48-48f6-abfc-34e8dffdc8d2.jsonl`.
  Its first user message has the SharePoint links to the WI CD manual and brand book.

## The brief

From the user's original request (goals 1–3 are done, see the artifact):

- **Goal 4:** a professional colour-grading editor (curves, contrast with pivot, etc.) for a
  high-fidelity cinematic look.
- **Goal 5, later:** a WI look from reference footage (still to be provided), the WI CD manual
  and the brand book. It should be recognisable as a WI product.
- **Hard constraint:** no or minimal performance loss.
- **Taste:** cinematic and immersive, explicitly not like a video game or a web app. The user
  picked "Film Warm" from a look board (ACES and AgX Punchy read as game-vivid).
- **WI brand:** tonality "Natural · Real · Wild · Modern · Sound · Vibrant", nature "undistorted
  and true to reality". All WI photos carry one Lightroom preset, **"Evergreen"** (not provided
  yet; an .xmp or a before/after photo pair is requested). Colours: Pine #004432, Mint #46b27a,
  Moss #13735f, May #94c24a, Light #8acbc1.

### The plan so far (in the artifact)

- The whole grade is baked on the CPU into a **33³ 3D LUT** whenever a control moves (~36 k
  evaluations, a few ms) and sampled once per pixel in the existing output pass. The number of
  controls does not change the GPU cost.
- **Controls:** exposure; contrast with pivot; lift / gamma / gain and offset per channel (colour
  wheels); temperature and tint; saturation and vibrance; curves (master, R, G, B); hue-vs-sat
  and hue-vs-luma; shadow and highlight split toning; highlight roll-off; vignette.
- **Interchange:** import and export `.cube`, so a grade made in DaVinci Resolve, Photoshop or
  Lightroom on a screenshot can be loaded as is.
- **Editor tools:** before/after split, snapshots, Copy values.
- **Cost:** one 3D texture tap per pixel. The grade must compile out entirely when off, like
  every other part, and work on the WebGL2 fallback (`?webgl`) and on phones.

## What the grade editor builds on

- **`viewer/src/threejs-test/tone-mapping.ts`** (212 lines): the `film` curve (Film Warm:
  log-space S-curve around 18 % grey, split toning, print-black lift, vignette, hue-kept
  shoulder), registered as a custom tone mapping.
  - Uniforms: `filmContrast`, `filmSaturation`, `filmSplit`, `filmLift`, `filmVignette`,
    `toneWhitePoint`.
  - Parts switch with `setFilmPart` / `isFilmPart` and compile out when off.
  - Install and modes: `installToneMapping`, `TONE_MAPPINGS`, `resolveToneMapping`,
    `parseToneMappingMode`.
- **`config.ts`:** `toneMapping` (~line 1264) and the film defaults (~1323): contrast 1,
  saturation 1.17, split 2, lift 0.01, vignette 0.3; the user's exposure is 0.94.
  `config.ts` is the single source of tuning.
- **Panel:** `threejs-test.html` → Design → "Tone & colour" (~line 1278, master switch
  `toneStageToggle`). The "⧉ Copy values" button `designCopy` (~1648; handler near main.ts:4091)
  dumps the panel state as config-shaped JSON. The binders in main.ts are `bindDesignSlider`,
  `bindSeg`, `bindEffectToggle`.
- **Other colour stages** (keep their order in mind):
  - the point grade (`point-cloud.ts`: pointContrast / pointSaturation);
  - the colour match (`colour-field.ts`, `design.colourMatch`);
  - distance haze and sky (`atmosphere-haze.ts`);
  - the post passes: depth of field and eye-dome lighting (`depth-of-field.ts`,
    `eye-dome-lighting.ts`).
- **Conventions:**
  - UI strings in English.
  - Every new boot switch (`?…`) documented in `viewer/CLAUDE.md`.
  - Layers follow the `createXxxLayer` → `update` / `dispose` shape.

## Open design questions

These are what the stopped design workflow was going to answer. The workflow is ready to run.

1. **Placement.**
   - **Display-referred, after the film output:** the LUT's input is what the screen shows, so
     a `.cube` made on a screenshot applies 1:1.
   - **One stage that absorbs the film parts:** needs a log shaper for HDR input, and makes the
     film look the editor's default preset.
2. **LUT storage.** 8-bit vs half-float, and banding in dark forest greens. 33³ texel-centre
   scaling. three r185's `Lut3DNode` / `lut3D` and `Data3DTexture` linear filtering on WebGPU
   and WebGL2.
3. **Grade model.** Exact formulas, ranges and defaults:
   - ASC CDL and the lift/gamma/gain mapping Resolve uses;
   - contrast with pivot, temperature/tint, saturation/vibrance;
   - monotone curves (Fritsch–Carlson, no overshoot) and periodic hue curves;
   - split toning and highlight roll-off.
   The default must be exactly identity.
4. **Editor UI.**
   - Widgets: curves with draggable points, lift/gamma/gain wheels, hue curves.
   - Tools: a before/after split with a draggable line, A/B snapshots, presets (the film look,
     neutral, later Evergreen), undo, Copy values that pastes back.
   - It has to work on phones (touch, narrow panel).
   - Bake on the main thread or in a worker; throttle the bake while dragging.
5. **Tests and measurements.**
   - node tests for the pure maths (bake, splines, wheels, `.cube` parse/serialize, identity
     detection).
   - GPU cost with the method below.
   - An identity check, and a `.cube` round trip with Resolve.

**To run it** (with ultracode on), call the Workflow tool with
`scriptPath: plans/grade-editor/design-workflow.js`. It is read-only: three readers (pipeline,
panel, maths), three designs (display LUT / unified stage / editor-first), two judges, and a
synthesised plan split into a first version and later steps. Read its plan, then implement on
`sbb/grade-editor`, then run an adversarial review workflow over the diff, as was done for the
ortho.

## How to test and measure here

- **Checks:**
  - `cd viewer && npm run bench:verify` runs `node --experimental-strip-types --test` over
    `src/threejs-test/*.test.ts`; 74 pass at 2def41d.
  - `npx tsc --noEmit -p .` must stay clean.
- **Strip-only TypeScript under node:** no constructor parameter properties, and imports with
  the `.ts` extension (`allowImportingTsExtensions` is on).
- **The browser pane is usually hidden.**
  - Boot with `?bgclock` (60 Hz clock from a MessageChannel) and emulate a viewport
    (`resize_window` 1280×800) or the canvas is 0×0.
  - Frame times are meaningless there (median ~250 ms); GPU timestamps are not.
  - Use a background tab (`tabs_create`), not the user's visible tab. Ask before a multi-minute
    run in the user's tab.
  - Turn the rain cycle off before any visual A/B.
- **GPU ms, the method that survived review (tone-mapping work):**
  1. Stop the renderer's animation loop.
  2. Before every manual render: `r.info.reset(); nodeFrame.update(); r.info.frame = nodeFrame.frameId`.
  3. Read that render's pass timestamps from the pool after its own resolve. Never group by rAF
     tick.
  4. Pin the size by shadowing `setSize`/`setPixelRatio`.
  5. Pair deltas against two identical baselines.

  Reference: the tone-stage parts cost 2–4 µs each, eye-dome lighting +0.18 ms.
- **Screenshots of the WebGPU canvas:** run `plans/grade-editor/capture_server.py` (binding the
  port needs the sandbox off). In the page, draw the canvas or a texture image to an
  OffscreenCanvas and POST the JPEG to `http://127.0.0.1:5213/<name>.jpg`. Files land in
  `<temp>/canopy-captures`.
- **Debug handles:**
  - `window.__three` (renderer, `globe` with `orthoStats()`, `setOrthoDensity()`);
  - `window.__wild` (`stream`, `controls.scene.tilesRenderer` = the basemap, `flightStarted`);
  - `window.__cost.report()` / `.reset()` (frame and upload probe, including an imagery bucket).
- **Loader:** the experience starts with the loader's Start button (`#loaderStart`); everything
  that waits for the device preset runs from there.

## Pitfalls met in this session

- **CRLF:** Python's `write_text` turned LF files into CRLF here. Write with
  `open(p, 'w', encoding='utf-8', newline='')` and assert `'\r\n' not in s`, or use the Edit tool.
- **Bash refusals:** in this worktree-isolated session, Bash refuses commands it considers too
  complex (heredocs, `cd … && git …`, variables in option positions). Put the script in a file
  and run it with one plain command; use `git -C <worktree>`.
- **Workflows across sessions:** a workflow cannot be resumed from another session (its journal
  is looked up elsewhere). If one dies mid-run (session limit), recover the finished agents'
  results from its `journal.jsonl` and pass them in as `args`. A finding with zero verdicts is
  unverified, not refuted.
- **Dev proxy:** it drops connections now and then (ECONNRESET, DNS failures; once all ortho
  requests failed with `getaddrinfo ENOTFOUND api.maptiler.com`). Check `preview_logs` before
  suspecting the code; `tile-retry.ts` retries tiles.
- **`3d-tiles-renderer` 0.4.28:** some properties the code relies on (`stats`, `FAILED`) are
  missing from its types; cast and leave a comment.

## Also still open (not the grade editor)

- Frame smoothness of the ortho swaps needs a run in a visible window.
- The ortho's streaming cost on a real phone is unmeasured.
- The ortho reads about 0.1 stops too red.
- **Requests to Andrea (Metashape):**
  - run Calibrate Colors;
  - re-export the ortho as lossy 512 px tiles, or provide the GeoTIFF;
  - add a per-point flight ID.
- **Waiting on WI / the user:** reference footage, the Evergreen preset, and whether derived
  tiles may be hosted.
