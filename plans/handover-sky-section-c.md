# Handover: the sky line after the merge into sbb-main, section C next

Written 2026-10-07 at the end of the session that built the sky package, worked through the fog handover's sections A and B, and merged sky into sbb-main. The next session picks up from here.

## Where things stand

- **Branch and worktree:** `sky` in `.claude/worktrees/sky`. `sky` = `sbb-main` = `origin/sbb-main` = `ce09bb1`, apart from the commit that adds this file. The user's main folder `C:\projects\WIDE_3d-flatform` is on `ce09bb1` too and has had `npm ci`.
- **What sbb-main now holds:** the sky package (physical sky, sun light, canopy shadows, dome clouds and their shadows, camera-volume aerial perspective), the whole volumetric ground fog branch, and the fog handover's fixes below.
- **Packages:** vite 7.3.7 (the user's bump, `577923f`), `@vitejs/plugin-basic-ssl` 2.3.0 (`1a36b03`; 1.2 refused vite 7, so a plain `npm ci` failed), and `npm audit fix` (`ce09bb1`: postcss 8.5.29, nanoid 3.3.20, source-map-js 1.2.2; 0 vulnerabilities). A plain `npm ci` works. The sky worktree's `node_modules` is on vite 7.
- **Write-ups (living artifacts, update via their url, read the live version first, dated changelog on top):**
  - Canopy Sky: https://claude.ai/artifact/AvhuvZqkcA584V23YeXsAV (v9)
  - Canopy Ground Fog: https://claude.ai/artifact/QmtWY4jzrEABxfWBGS7unp (v5)
  - Neither mentions the merge into sbb-main yet.

## Rules from the user

- **Section C: ask the user before starting any item.** They are look decisions; she chooses which and in what order. My recommendation was C1 first.
- Work on `sky`, one commit per item. Commit messages: a subject plus at most one sentence, understandable to a colleague, never a Co-Authored-By trailer.
- Ask before every push to `sbb-main`, and fetch right before pushing (sbb-main moved under a tested merge once today).
- Answer in English, even to German prompts.

## The fog handover: what is done

The full list is `plans/handover-fog-fixes-for-sky.md`. Its line numbers are sky's at `4174e73` and have moved since; find places by symbol.

| Item | Commit | Result |
|---|---|---|
| A1 3D placeholder sampler | `38fc99a` | Linear + Repeat, the WGSL reads sample |
| A2 tile retry 408/429 | `536ec61` | files from 0ad8f9e, byte-identical |
| A3 one 2D bake at boot | `101b3bf` | in-flight request shared |
| A4 temporal comments | `2ae0720` | comments only |
| A5 WebGL2 fallback | none needed | no GL errors, converges still and in motion, about +0.7 ms at constrained |
| B1 march texel budget | `103053a` | −5.1 ms at 4K, 0 at 2000×1125; hole fill capped at 2×2 |
| B2 fog held behind the loader | `f9adf76` | −1.45 ms per loader frame |
| B3 visibility gate | `14e3379` | −0.15 ms while the camera is out of the fog's reach (first ~4.7 s of the entrance flight) |
| B4 skip mist multiplied by zero | `96225b0` | −0.13 ms oblique, −0.09 ms landing |
| B5 plume gate | dropped | −0.02 ms, under the 0.05 ms bar |
| B6 one-channel depth side passes | `00ae4a4` | −0.024 ms |
| B7 no air term under the physical sky | `dc6612b` | −0.06 ms, pixel-identical |

Then `dbc943d` merged the fog branch into sky, and `9635557` merged sky into sbb-main.

## Section C (the user decides each one)

Details are in section C of the fog handover. Current values in `config.ts`: `volumetricFog.steps: 32`, and `volumetricFog.qualityByPreset` strong `steps: 32`, medium `24`, constrained `20`, at `resolutionScale` 0.5 / 0.5 / 0.25. The step count is also a runtime slider ("Steps per ray"), so C1 can be compared without a rebuild.

- **C1 · 32 → 24 steps — done 2026-10-07 (c7c49e5)**, the user chose it: presets 24 / 18 / 16, plume share 0.25 → 0.35 (`SPARSE_SHARE`), so the plumes keep 8 samples. Measured −0.30 ms at the landing view and −0.11 ms at a low horizon view (strong, 1280 × 960); stills of the frozen fog no further apart than two at 32. Original note: (medium 24 → 18, constrained 20 → 16). Expected ~0.55–0.65 ms on sky. If adopted, protect the plumes: raise the sparse share (the quarter of the steps above `zSplit` in `marchNode`, `ground-fog.ts` near "Two segments, split where the ray crosses the top of the dense layer") to ~0.35, or crowd the sparse samples toward its lower end.
- **C2 · checkerboard march.** −0.6 to −0.9 ms, large effort; needs the reconstruction flag described there or crown edges smear for ~0.8 s.
- **C3 · one RG8 3D read.** −0.08 to −0.3 ms; changes the wisp pattern. Re-measure '3d' against '2d' first.
- **C4 · constrained preset with the fog off.** Only after a phone or iGPU reading shows the fog costs ≥ ~1 ms there.

Each C item needs a moving-camera visual A/B the user can judge (rain cycle off) plus a GPU-ms reading.

## Open after the merge (not started)

1. **Colour match under the sky's light — fixed 2026-10-07 (c89cd93).** Measured: the points rendered against the map under them (landing view, fog, canopy shadows, ground patch and DoF off) at 0.80 in the old daylight; under the sky 0.84 at 09:00 and 14:00 and 1.12 at 16:50, because the map took the sun by sin(elevation) alone and the points also by `sideLight`. The map now takes the same `mix(sin, 1, sideLight)`: 0.80 / 0.81 / 0.89. The points did not change; the far map is +0.6 % at 14:00 and +17 % at 16:50.
2. **Loader benchmark — measured 2026-10-07.** Two boots each, `?bgclock&gputime`, sky package on vs `?sky=0&shadows=0&clouds=0`: the sky adds about 100–180 ms of GPU work during the loader and 1–1.5 ms on its heavier frames (p90 3.7–4.3 vs 2.4–2.8 ms); time to the Start screen is network-bound (8.7–11.8 s) and shows no consistent difference; both verdicts strong. Frame times in the pane are not real, so the bench verdict itself needs the device session; calibrate with the sky on. Holding the first cloud bake while the benchmark times frames (released at its verdict) was tried the same day and dropped: the verdict comes at least 6 s into the Start screen (in the pane it had not come after 25 s), so for anyone who presses Start earlier the whole bake would move into the entrance flight, where the clouds would arrive visibly late, against 1–1.5 ms on the loader's heavier frames. Calibrate with the sky on instead.
3. **B8 texture leak with shadows on — passes, 2026-10-07.** 23 of 47 resident tiles (the oldest half, so the template owners) evicted with canopy shadows on (38 casters before and after): all 23 textures retired, one came back on the GPU at 1 × 1 (the known template signature, 16 bytes), no re-uploads.
4. **Fog handover section E** (docs, loose ends, tests): not done. The docs item belongs on the merged tip, which this now is. `viewer/CLAUDE.md` already has the sky, fog, grade, colour-match and ortho query params.
5. **Artifacts:** add the merge and its one behaviour change to both pages' changelogs.

## The merge, for reference

`9635557` (parents `577923f` + `dbc943d`). Seven files conflicted, all resolved as unions. One change beyond the conflicts: sbb-main's Start-screen gate `drawThisFrame` (`main.ts`) now also holds the sky package's own passes (sky tables, shadow map, cloud bake, fog update), which run outside `depthOfField.render()`. Measured on the idle Start screen: ~8 draws a second, no sky passes between them; after Start every frame draws. Side effect: a visitor waiting on the Start screen gets the first cloud bake finished in the flight's first frames. A line-count audit of base/ours/theirs/merged found nothing lost.

## How to test

- **Dev server:** start your own, in its own tab: `cd viewer` then `BROWSER=none NODE_OPTIONS=--no-network-family-autoselection npx vite --host --port 5197 --strictPort` (background), then `preview_start {url}`. The `sky-dev` entry on :5196 lives only in the old session's launch folder (`agitated-benz-6bb1dd/.claude/launch.json`, uncommitted). Ask the user before borrowing her pane tab.
- **Harness** (in `plans/sky-section-c/`): paste `harness.js` after every reload (boots, lands, rain off, defines `__pose`, `__cap`, `__bakeDone`, `__preset`, `__time`). `gpu-ab.js` runs interleaved rounds of whole-frame GPU time per arm, as `window.__job`, polled via `__gpuResult`. `capture_server.py 5231` receives `__cap` images.
- **URL:** `?bgclock&gputime`. The pane is hidden, so rAF runs at ~7 Hz under bgclock: GPU timestamps are valid, frame times are not. Resize the viewport before navigating (a 0×0 canvas otherwise). The javascript tool times out at 45 s: run long jobs as `window.__job` and poll.
- **Per-pass GPU ms:** timestamp pool keys look like `r:<call order>:<render target id>:f<frame>`. Group by the target id and average means (the timer steps at 0.065 ms). A rebuild gives the fog's targets new ids. WebGL times whole frames only.
- **Config A/B trap:** after vite has seen an edit, the app imports `config.ts?t=<stamp>`. Import the exact URL from `performance.getEntriesByType('resource')`, or the change lands in a different module. Build-time flags need a rebuild (toggling `#vfogDebug` rebuilds the fog).

## Traps met in this session

- **Worktree guard:** git commands must be plain and target this worktree; no `git -C`, no long pipelines. Run multi-step jobs from a Python script.
- **No network for git in the Bash tool** (ssh cannot resolve github.com); fetch and push from PowerShell.
- **TaskStop on a backgrounded `npx vite`** leaves its node processes running and holding the folder. Kill them by command line.
- **`npm ci` EBUSY:** in this worktree `node_modules/three/src` stayed locked by something that was neither vite nor VS Code, and npm stopped halfway. Workaround: `npm ci` in a scratch copy with identical package files, clear the worktree's node_modules except the held folder, `robocopy /E` the scratch install in.
- **Python on this machine writes CRLF** with `write_text`; use `newline=''` and check commit stats for whole-file churn.
- **MapTiler proxy errors** (`ECONNRESET`, 500) in the dev console come from the network; the tile retry handles them.
