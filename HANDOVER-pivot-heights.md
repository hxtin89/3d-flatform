# Handover — navigation (pivot / pan) and real-world heights

Branch `sbb/pivot-on-canopy`, HEAD `7dd4a43`, **pushed and in sync with origin**.
The wrong height fix the previous handover warned about (`cd95ddc`, cloud ~270 m in the air)
is reverted by `200517d` and no longer the remote tip.

Repo: `C:\projects\WIDE_3d-flatform`, viewer at `viewer/`, entry `viewer/threejs-test.html`,
bulk of the logic in `viewer/src/threejs-test/main.ts` and `globe.ts`. Three.js r0.185,
WebGPU + TSL (node materials only — a GLSL `ShaderMaterial` is rejected). Dev server
`npm run dev` in `viewer/`, port 5177. Server: `sbb-prod`, path `/srv/projekte/wide/wi-dev`
— **still needs a re-pull to pick this branch up.**

## Status in one line

Navigation is done and verified. The height ruler and real-world elevations are not.

---

# 1. Navigation — the current design

The library (`GlobeControls` from 3DTilesRendererJS) is steered from two places: `main.ts`
decides what a press means, `globe.ts` owns the input plumbing and the pan mechanics. The
rules below are what the behaviour *is*; the "settled questions" section says which
alternatives were tried and rejected, so they are not re-attempted.

## What each gesture does

| Gesture | Behaviour |
|---|---|
| Right drag / two fingers | Rotate about the pivot, lifted onto the canopy |
| Left drag / one finger | Pan. **Never** rotates, under any circumstance |
| Left/right on the sky | Nothing at all |
| Press the controls refuse | Right → orbit the view centre; left → pan the view centre |

## Rotation

- **Canopy lift** (`canopyPivot`): ray-marches from the terrain hit up to the canopy top,
  three passes at widening radii `[20, 60, 180]`. Gated to rotation only — panning rides a
  surface through the pivot, so lifting it there would make pan speed depend on whether the
  cursor caught a tall tree or a clearing.
- **Sample-and-hold**: the pivot is sampled **once per press** (`beginGesture`) and restored
  every frame until *every pointer is up*. Keyed on pointers-down, never on the library's
  control state — that state drops out mid-gesture and every drop used to release the hold
  and let the next state re-sample the pivot. Verified 0.000 m drift under fast full-screen
  swings.
- **Rebase-aware**: the held pivot is a render-space point, so it is shifted on every
  floating-origin rebase. Without that the hold itself becomes the jump.
- **No distance rule on a press's own pivot.** Whatever the cursor grabbed is kept.

## Panning

- **Shallow grab → re-aimed to the view centre, in Y only.** The pivot becomes the point the
  scene shows at *(press x, centre y)* and `globe.setPanPointerShift` shifts the pointer the
  controls read by the Y offset. Your cursor still drives the pan 1:1; only the geometry it
  is solved against moves to a workable depth. The grabbed column is kept deliberately.
- **The threshold is the centre ray's own descent**, not a constant — self-tuning across
  pitch and fov. `panMinRayDescent` is only a floor for views so flat the centre is
  ill-conditioned too.
- **Re-aim requires real ground** under the target. A fabricated point sits near the camera's
  own altitude, and the globe pan then solves against a sphere the camera is barely outside
  of, where the near/far intersection can swap and the pan runs backwards.
- **Per-drag budget** (`10 × height above the survey floor`, min 250 m): net displacement
  from the press, rebase-aware, and it **outlives the drag into its coast** — a drag that
  ends under budget still hands its velocity to the damping.

## Input plumbing (`globe.ts`), mouse only — touch keeps the library's own handling

- **Pointer capture** on mouse press, so a drag survives leaving the window.
- **The window-edge `pointerleave` is suppressed while a button is held** (capture phase on
  window). Not `resetState` itself — see settled questions.
- **True button state**: a move reporting no buttons, or a window blur, ends the drag.
- **`adjustHeight` frozen while anything is held.** It re-reads the ground under the camera
  every frame and lifts camera *and* pivot by the difference; that height comes from whichever
  tiles are resident, so a tile landing mid-drag moved the pivot.

## Safety nets (independent of any pivot reasoning)

- **Per-frame displacement governor** — `max(2 × height, 30 m)`, applied between
  `controls.update()` and `tiles.update()`, zeroing inertia when it fires.
- **Floor clamp** cancels inertia only after 10 consecutive clamped frames, so a graze does
  not cut a coasting spin dead.
- **NaN containment**: `rebaseTo` refuses non-finite targets, bounds checks are written so
  NaN takes the safe branch, and a non-finite camera self-heals to the boot staging pose.
  `[nan-watch]` in the console names the first frame stage that broke it.

## Config knobs (`config.ts`, `navigation`)

```
pivotOnCanopy: true            pivotSampleRadiusM: 20      pivotMinRayDescent: 0.25
pivotMaxDistanceHeightFactor: 5    pivotMaxDistanceMinM: 400   (substitute pivots only)
panMinRayDescent: 0.3          (floor under the adaptive threshold)
maxPanPerDragHeightFactor: 10  maxPanPerDragMinM: 250
maxFrameMoveHeightFactor: 2    maxFrameMoveMinM: 30
pointerResponseMs: 50
```

## Settled questions — do not re-attempt

Each of these was implemented, measured and removed. The measurements are in the commit
messages and the source comments.

1. **Clamping the pivot's distance** to bound the pan. The globe pan solves against a sphere
   through the grabbed point; that sphere's radius is the Earth's, so a few hundred metres
   changes nothing. Reported as "panning very very fast" with the clamp in place.
2. **Clamping the pan ray's angle.** The clamp then absorbs all vertical cursor motion — the
   pan froze at 0.01 m/frame after a 52 m first-frame jump.
3. **Ego rotation (`FREE_ROTATE`) as a fallback.** Reads as a first-person camera in a scene
   being inspected from outside, and leaves the pivot marker with nothing to draw. The
   fallback is always a point in the scene.
4. **A far-pivot rule on rotation presses** (beyond a limit, hand the grab to the view
   centre). The governor already bounds the consequences, and moving the pivot off what the
   cursor grabbed cost more than it bought.
5. **Blocking `resetState` wholesale** to survive the window-edge leave. It also blocks the
   library's own escapes — when the cursor ray misses the globe sphere it does
   `resetState(); _updateInertia()`. With the reset swallowed the drag never ended and that
   escape re-fired every frame: 11 km travelled on one upward drag.
6. **The interrupted-spin coast rescue** (clearing `inertiaStableFrames`). Instrumented over
   the abnormal ends it can actually produce: the counter was never above 1. The abrupt stop
   it was written for was the floor clamp.

## How to measure this subsystem

- **Use absolute coordinates**: `camera.position + __wild.origin.position`. Render-space
  distances are meaningless across a floating-origin rebase — that error hid 8.5 km of travel
  and produced a fake "budget works" result.
- **Restore the camera between trials** (position + quaternion + zero all inertias), or
  earlier trials pollute later ones.
- **Nobody touches the page while measuring.** The Browser pane shows the agent's own tab, so
  human input and scripted events fight over one page.
- Live diagnostics: `__wild.pivotDebug` (why the last press did what it did),
  `__wild.navDebug` (governor clamp count and last numbers), `__wild.rebase()` (force a
  rebase), `__wild.heights` (the ruler's last readings).

---

# 2. Height ruler — open

Toggle `⇕ Heights` in the Pivot panel, **off by default**. Built lazily on first enable and
skipped entirely while hidden, so it costs nothing off; refreshes twice a second. Functions
in `main.ts`: `readHeightMarks()`, `buildHeightRuler()`, `heightRulerBar()`,
`updateHeightRuler()`, `updateHeightRulerReadout()`.

**The problem, confirmed by the user and still unfixed: it is hard to see.**

- Each mark is one 1-px line, 520 m long, along the ENU x axis only — invisible at a glance
  and edge-on when you look down x.
- The survey rows sit ~200 m *above* the camera at working altitude. They are genuinely
  off-screen, so no amount of fattening the lines helps.

**Agreed direction (analysed, not built): make the primary form a 2D screen-space column.**

- A vertical metres-above-sea-level axis pinned to the screen edge, auto-spanning the present
  marks, reusing the current colours (amber drape, blues for survey floor/canopy, greens for
  drawn floor/canopy), plus a live marker for the camera's own altitude.
- Show the −208 m offset as a bracket between the survey pair and the drawn pair. That bracket
  shrinking to zero is the whole story of section 3.
- Reasons: the marks span ~660 m of elevation while working altitude shows ~50 m of it;
  numbers and labels are free and crisp in HTML; and a screen-fixed instrument stays readable
  *while* navigating, where a world-space one swings with the camera.
- Keep in 3D only the mast plus the drawn floor/canopy bars — the two that are near the
  camera — because "where do these planes cut the scene" is a spatial question a HUD cannot
  answer. The far-off survey and drape bars should leave the 3D scene.
- The zero-cost switch already works and should stay: one boolean gates sampling, building
  and drawing.

---

# 3. Real-world heights — open, and the actual goal

## Measured (survey centre, from this session's live logs)

```
basemap drape   147.0 m   (LOD-dependent — see below)
survey floor    195.5 m   <- real-world elevation, as delivered
survey canopy   223.5 m
drawn floor     -12.9 m
drawn canopy     14.9 m
offset         -208.0 m = snap -228.0 + lift +20.0
```

195 m matches the Madre de Dios lowlands, so the survey elevations are genuine.

**The offset formula** (Jan's, from `fd6bd08`/`7a6ad37`), in `main.ts`:

```ts
zOffset = groundSnap ? -(areaMinZ + areaOriginHeight) + pointCloudLiftM : 0
```

**Why the drape moves:** MapTiler satellite has **no terrain** — it is an image draped on the
ellipsoid, and a coarse tile approximates that curved surface with flat triangles, so it sags.
Watched it climb −437 → −54 → +20 → +115 → +147 as imagery refined. That is why the readout
prints the tile count, and why a fresh boot can look like the cloud is flying: the *map* is
low and rises in steps as tiles land, so the cloud appears to sink to meet it.

**To represent the real world:** add terrain, then set `zOffset = 0` and the cloud stands at
its surveyed elevation on real ground. Until then the snap must stay — it is the only thing
making the cloud meet the map, and it is a deliberate lie about elevation. The 20 m lift
exists only because the snap aligns the bounding-box floor rather than the lowest ground,
which sank the river bed behind the flat drape.

**Route found but not attempted:** the installed `3d-tiles-renderer` already ships
`QuantizedMeshPlugin` (terrain geometry) and `ImageOverlayPlugin` (imagery draped onto it),
and MapTiler serves quantized-mesh terrain on the key already in `.env`. Suggested order:
spike behind `?terrain=1`, then `zOffset = 0`, then use the ruler as the acceptance test —
survey and drawn rows merge, and the drape row lands within terrain accuracy of the survey
floor. Budget for two risks: the WebGPU node-material replacement in `globe.ts`'s
`load-model` handler needs rework for the overlay plugin's materials, and a second tile source
costs MapTiler quota.

---

# 4. Next steps, in order

1. **Re-pull on `sbb-prod`** at `/srv/projekte/wide/wi-dev` — the branch is pushed but the
   server is still on the old tip.
2. **Rebuild the height ruler as a 2D HUD column** (section 2).
3. **Terrain spike** behind `?terrain=1`, then `zOffset = 0` (section 3).
4. **Strip the diagnostics before this ships**: `__wild.mask.*`, `probeMask`, `pivotDebug`,
   `navDebug`, `__wild.rebase`, the `[nan-watch]` logs and the splat log.

# House rules and environment

- **Answer in English**, always, including to German prompts.
- Commit messages: subject plus at most one sentence of body, understandable to a colleague,
  never a `Co-Authored-By` trailer.
- The browser pane throttles to 1–2 fps when backgrounded, which starves any frame-driven
  measurement; `python` needs `C:/` paths, not `/c/`; Git Bash `ssh` cannot reach the Windows
  agent pipe — use `/c/Windows/System32/OpenSSH/ssh.exe`.
- `vite.config.ts` honours a `PORT` env var, so a second (agent) dev server can run alongside
  yours without touching the 5177 default. `.claude/launch.json` keeps `viewer-dev` on 5177
  as the first entry.
