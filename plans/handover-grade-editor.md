# Handover: the grade editor (goal 4 of the colour brief)

Updated 2026-10-06. The grade editor is built, reviewed, measured and documented. What is left
needs the user's apps (Resolve, Photoshop), a real phone, or material from Wilderness
International. The earlier version of this file (state before anything was built) is in git
history at 81ccfab.

## Where things are

- **Worktree:** `C:/projects/WIDE_3d-flatform/.claude/worktrees/sbb-colour-matching`. Enter it with
  `EnterWorktree {path}`; nothing needs checking out.
- **Branch:** `sbb/grade-editor`, on top of `sbb/ortho-upgrade` → `sbb/colour-matching` →
  `sbb/tone-mapping`. **Merged into `sbb-main` on 2026-10-06** at the user's request, as
  `435b7c9` on `sbb/merge-grade-editor` (worktree `point-reorder-thinning-flicker-f48d6c`),
  on top of `sbb-main` `3e7d284` (quick wins, point-memory readout, real tower position). Seven
  files conflicted with the quick-wins work; how each was resolved is in that commit's message,
  the two that mattered: the cloud volumes keep the quick wins' shared far/near materials and
  get the haze variant through a per-material handle, and the ortho upgrade now checks a swap
  against the image size `globe.ts` records (`map.userData.imageSize`), because `sbb-main` closes
  every basemap image after upload (1.8). Checked: type check, 302 tests, build, and in the
  browser on WebGPU and WebGL2 (volume clouds with haze, 9 ortho swaps with 0 size mismatches,
  grade LUT stage compiled and baked, memory readout). Pushed only when the user says so.
- **Spec:** `plans/grade-editor/plan.txt`. It is corrected in place wherever the build differs.
  Section 7 holds every measurement, section 8 the commit plan, section 9 the later steps.
- **Living write-up:** https://claude.ai/artifact/JjMNnLFjremEdsYPSSKqUg ("DEV | Canopy Colour
  Matching", version 10). It has a panel guide that explains every control, a "Built so far"
  table and the banding check. Update it via its URL; never publish a new one.
- **Evergreen request for WI:** https://claude.ai/artifact/A9zgmqrEsogcHDGUcujX5T. Org artifacts
  can't be shared outside the organisation, so the user sends it as email text. Test image:
  `plans/grade-editor/evergreen/sbb-hald-8.png`.
- **Dev server:** `preview_start {name: "colour-dev"}`, port 4177 (autoPort). preview_start reads
  `.claude/launch.json` from the session's **launch** folder, not from the entered worktree: the
  entry must exist there. Both copies are uncommitted on purpose.

## Implemented (commits on sbb/grade-editor)

| Commit | What |
|---|---|
| 0908b38 | The design workflow's plan (3 designs, 2 judges, synthesis). |
| 17de849 | Drone ortho panel switch: Auto · Off · Half · Full. Half/Full force it on any device. |
| e64903e | C1, the pure maths: grade-model, grade-curves, grade-bake (33³ half-float LUT bake, drafts, refined lattices for imported cubes), cube-format, grade-state. Reviewed. |
| 6ded2c7, 3e7583f | C2, the output stage: `depth-of-field.ts` `setOutputStage`, `grade-output.ts` (one 3D-LUT tap after the tone curve and sRGB, in the existing final quad), the `__three.grade` console handle. Measured: the tap costs ≤ ~0.01 ms; it is exact to 1 level on WebGPU and WebGL2. |
| 564075c | C3, Design → Colour grade: sliders, Look tab (`.cube` import/export, Frame for grading), before/after split, A/B, undo, Copy/Paste values, worker bake, `?grade=0\|1`. |
| 92c3cff | C4: lift/gamma/gain/offset and shadow/highlight wheels, RGB curves, hue vs sat and hue vs luma, phone peek, keyboard. |
| fccfcd8 | `viewer/CLAUDE.md` documents it. |
| fd5e013 | Banding check (none, so no dither) and the HALD test image. |
| 395aeb3 | 15 review findings fixed: keys no longer stick, split clamp, single-step paste with look tickets, drafts of k=1 looks, watchdog, wheel slop, etc. |

Facts a new session should know:
- Neutral with the section closed, the grade is compiled out: today's shader, zero cost.
- A stage change costs 9 node builds with DoF and EDL on (a 12–16 ms CPU hitch), 1 without.
  Moving a control never recompiles.
- 246 node tests pass; `npx tsc --noEmit -p .` is clean.

## Still open

1. **Resolve and Photoshop round trips (plan M6).** These need the user's apps; the steps are in the
   panel's Look tab.
   - Frame for grading saves a PNG; grade it, export a 33-point `.cube`, import it.
   - Compare against the app's own render: mean ≤ 0.5 LSB, max ≤ 2–3.
   - And the reverse: our export applied in Resolve.
   - Record Resolve's interpolation and pivot.
2. **A real phone (M9, M12).**
   - GPU cost of the tap (≤ 0.3 ms, otherwise set maxLattice to 33).
   - Hitch when the grade compiles in (if > 100 ms, add a compileAsync pre-warm).
   - Touch usability of wheels, curves and split; WebGL2 vs WebGPU within 1 level.
   - Use `npm run dev:https` for WebGPU on a phone.
3. **Evergreen (goal 5).** Waiting on WI: the `.xmp`, the HALD TIFF, or before/after photos.
   - Nothing is built for it yet.
   - Next: a HALD-image → `.cube` converter (16-bit TIFF in, lattice out) and a presets select with
     "Evergreen" (plan §9.1). Store the result as `public/grades/evergreen.cube`.
   - Clarity, grain, vignette and Highlights/Shadows can't be in a LUT; rebuild them by eye if wanted.
4. **Later steps, plan §9:**
   - compare against a reference;
   - "export look for photos" (film + grade as one cube);
   - 1D/shaper `.cube` support;
   - scopes;
   - convenience: restore last session, drag-and-drop import, ASC CDL export;
   - a "Film" tab folding Tone & colour into the editor (needs the user's sign-off, since it touches
     Film Warm).
5. **Ortho leftovers (not the grade):**
   - frame smoothness of the swaps in a visible window;
   - streaming cost on a phone;
   - the ortho reads ~0.1 stops too red;
   - requests to Andrea: Calibrate Colors, lossy 512 px re-export or the GeoTIFF, a per-point flight ID.
6. **Merge and push** of the whole stack: only when the user says so.

## How to test here

- **Checks:** `cd viewer && npm run bench:verify` (246 tests), `npx tsc --noEmit -p .`.
- **Browser:**
  - Work in a background tab (`tabs_create`), never the user's tab.
  - Use `?bgclock` and `resize_window` 1280×800.
  - Press Start (`#loaderStart`), wait ~40 s for the entrance flight.
  - `__three.grade` (setStage, bake, setSplit, stats, editor) and `__poses.save/go` (horizon views).
- **GPU timing:** boot with `?gputime`.
  - Stop `renderer.setAnimationLoop(null)` **and** `renderer._animation.stop()`.
  - Per manual render: `r.info.reset(); nodeFrame.update(); r.info.frame = nodeFrame.frameId`.
  - Read `timestampQueryPool.render.timestamps` keys `r:<ctx>:<n>:f<frame>`; the canvas pass is the
    final quad.
  - Chrome quantises timestamps to 0.066 ms, so average many renders with paired baselines.
- **Exactness:** feed exact inputs through a test stage (a ramp from `screenUV` via the app's
  `three_tsl.js?v=…` module). An 8-bit capture amplifies under steep grades and reads 2–4 levels
  falsely.

## Pitfalls met

- **Hidden pane:** never runs ResizeObservers; the widgets now measure themselves on first use.
- **Synthetic double tap:** two presses within 300 ms and 12 px are a double tap, which resets a wheel.
- **Bash in this isolated session:** refuses `node -e` and commands with computed operands. Put
  scripts in files and use `git -C <worktree>`.
- **CRLF:** the Write tool and Python's `write_text` have both produced CRLF here. Check new files
  for `\r`.
- **Session limits:** they cut off workflows twice. A workflow can't be resumed from another
  session; rebuild from its journal (`subagents/workflows/<run>/journal.jsonl`) and pass results in.
- **Commit messages:** a subject plus at most one sentence, no Co-Authored-By trailer.
