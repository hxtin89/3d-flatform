# Handover: fog fixes and optimisations for the sky branch

Source: a read-only review of the fog on 2026-10-05. Four readers covered the march, the side passes, gating and integration, and open items, and a skeptic re-checked every claimed saving against the code and the measured numbers. It reviewed `sbb/volumetric-ground-fog` @ 6a7e140 and `sky` @ e366ae7. On 2026-10-06 it was re-anchored to `sky` @ 4174e73: **line numbers below are sky's at 4174e73**. `fog-temporal.ts` and `tile-retry.ts` are identical on both branches.

Work on `sky`, not on the fog branch: sky contains the fog and is the line that moves on. One commit per item. Don't merge into sbb-main.

Each performance item gets an A/B with the sky harness: `?bgclock&gputime`, own tab and port, nodeFrame stepped per render, rain cycle off. The user decides anything in section C.

**Saving estimates.** They come from the 2026-09-30 fog measurements:
- Ampere, 2000×1125 buffer; ≈0.057 ms per step at ½ res.
- Taken on the 517dc5a look: 40 steps, '2d' noise.
- Sky has since measured the march itself at **1.1 ms** in a 150 m oblique view (comment at `ground-fog.ts:772`).

Sky also found that reading the cloud shadow only where there is mist saved nothing, because the veil leaves almost no step empty. Expect the gate-style items (B4, B5) at the low end of their range: measure first, and drop anything under 0.05 ms.

## A. Fixes

**A1 · The 3D-noise placeholder compiles the wrong reads (bug, 3 lines).**
- Where: `ground-fog.ts:428-431`.
- Problem: `placeholder3d` is a `Data3DTexture` left at three's defaults: NearestFilter and ClampToEdge. WGSLNodeBuilder chooses the read instruction from the texture bound when the shader is generated. Nearest/Nearest counts as unfilterable (`isUnfilterable`, WGSLNodeBuilder.js:804), so it emits `textureLoad` on a clamped coordinate.
- Effect: a march compiled before the worker's 3D bake lands reads one edge texel. The height detail is then constant until the next graph rebuild. Swapping `noise3dNode.value` does not regenerate the WGSL.
- How often: a rare boot race. Any fog, EDL, DoF or haze toggle rebuilds the graph and heals it.
- Fix: `minFilter = magFilter = LinearFilter` and `wrapS = wrapT = wrapR = RepeatWrapping` on the placeholder, as `sun-shadows.ts` already does for its stand-ins. WebGL2 is not affected.
- Check: a WGSL dump with the placeholder bound shows `textureSampleLevel`.

**A2 · tile-retry gives up on 408 and 429.**
- Problem: the regex `/error code 4\d\d\b/` counts a timeout or rate limit as refused, so that tile never retries.
- Fix: take `viewer/src/threejs-test/tile-retry.ts` and `tile-retry.test.ts` from 0ad8f9e (sbb/colour-matching), using `git show 0ad8f9e:<path>`. Take only those two files, byte-identical. colour-matching added the file in its own commit, so identical bytes keep the later add/add merge clean.

**A3 · The 2D noise is baked twice at boot.**
- Problem: the layer and the panel block both call `setNoise` in the same task. The second request waits behind the 3D bake, so the real 2D noise lands after 2D + 3D + 2D instead of after 2D.
- Fix: return the in-flight promise only when its settings key matches and it is still the latest request (`pending.request === noiseRequest`). Check that before incrementing. Or drop the panel's boot call and draw its thumbnails from a promise the layer exposes.
- Gain: one bake at boot, nothing per frame.

**A4 · Stale comments in `fog-temporal.ts`.** Lines 16-20 and 220-225 describe a history rejected at a disocclusion. At the default `temporalOcclusion: 1`, the test `|before − now| ≤ now × occlusion` (:236) accepts any history from 0 to twice the surface depth, so beside a crown it is effectively off. That is the user's chosen trade; `config.ts` records the smear numbers. Fix the comments, not the value.

**A5 · The WebGL2 fallback of the temporal filter and hole fill has never run.**
- Boot `?webgl` with the fog on and check the console for GL errors.
- Check that the fog converges with the camera still and in motion.
- Take a `?webgl&gputime` reading at the preset the loader picks there.
- Reading the code finds no WebGL-specific hazard. The copies use copyTexSubImage2D from RGBA16F.

## B. Performance, no look change (measure each)

**B1 · Cap the march at a texel budget.** The biggest one, for large screens.
- Where: `setResolutionScale` and `applyPreset` (`ground-fog.ts:1102-1111`), `u.marchSize` (:1053), `u.pixelAngle`, and FogTemporalNode's `resolutionScale()` callback.
- Problem: march cost follows the drawing buffer.
- Change: effective scale = min(preset scale, √(budget / buffer pixels)). Strong's budget is the measured 562k texels, or 1.5× that (840k) to stay closer to today's look. Scale medium and constrained the same way.
- Feed one effective scale to both RTTs, `u.marchSize`, `u.pixelAngle` and the temporal node. Keep the panel's requested scale separate from the effective one.
- **Cap the hole-fill footprint at about 2×2 full-res pixels whatever the scale.** 4×4 is the blocky regime rejected on 2026-09-30.
- Saving: 0 at 2000×1125, −1.2 ms at 1440p with DPR 1, −4.8 ms at 4K with DPR 1. More on sky, where a step costs more.

**B2 · Fog off behind the loader.**
- Today: the loop starts at `main.ts:5616`. The fog updates ungated at :5061 and renders at the config defaults until `applyBenchPreset` (:424) runs at `onLoaderStart`. That costs ~2 ms per loader frame on the Ampere, unseen, while the eagle bench times frames on the same GPU.
- Change: render one frame so the pipelines compile. Then hold the fog off through B3's runtime gate, with no rebuild, until `onLoaderStart`.
- **Caveat:** this changes what the bench measures, and marginal devices move up a tier. Ship it together with B1. Then re-check the verdicts on a mid-range device: default versus `?vfog=0`, compare `pointsAtTarget`.
- Decide sky's own warm-up work (aerial volume, shadow map, cloud bake) separately.

**B3 · Runtime visibility gate.** B2 needs it, and a later "fog off on constrained" would too.
- Test: in `update()`, after `syncUniforms`, use the same ENU matrix and live values as the shader. Is the camera farther from the band box than `maxDistanceM`?
  - The box is the survey bbox ± `marginM`.
  - Its height runs from floor + bottom to floor + max(top, puffCentre + plumeHeight, virtualCanopy + veilHeight).
- Use hysteresis and no frustum test.
- When it fires:
  - set `marchTexture.autoUpdate = fogDepthTexture.autoUpdate = false`;
  - make `FogTemporalNode.updateBefore` return early, and call its unused `reset()` on re-entry;
  - add a composite uniform that skips the upsample taps.
- With temporal on, the march RTT is only triggered from the resolve material.
- Saving: 0 at the canopy, ~0.2 ms during the first ~4.6 s of the entrance flight.

**B4 · Skip the mist work that is multiplied by zero.**
- Gate on nearPoints: `nearPoints` (:755) depends only on t and p. Wrap puffs, body, wisps and plumes in `If(nearPoints > 0)`.
- Keep outside the If: the three 2D reads, the veil, and `puffTop`, because `localTop = max(localTop, puffTop)` feeds the veil's sun light.
- Add a fetch-free height bound: skip the two 3D reads and the carve when `hRel > max(top, puffCentre + 2·puffHeight)`.
- **TSL trap:** an If body is an isolated cache. Freeze the shared values (coverageRaw, billow, clump, coverage, lightTop, hRel, xy) with `.toVar()` before the If, or TSL builds them inside, or twice. Check the WGSL dump: no texture read may appear twice.
- Keep `density()` single, because the editor's density preview uses it; pass a needMist flag. 3D reads inside the If need `.level(0)`.
- Saving: estimated 0.15–0.45 ms, probably low on sky (see above). Measure in the 150 m oblique view and in the landing view.

**B5 · Gate the plume block.**
- Change: `If(hRel > puffCentre)`, then `If(present > 0)` (:556), and write `pow(x, 1.5)` as `x·sqrt(x)`.
- Same toVar trap as B4.
- Saving: 0.03–0.1 ms.
- Leave the sin hashes alone: an integer hash would re-roll the plume placement, which is a look change.

**B6 · Side-pass bytes, one commit.**
- Store the fog depth (`rtt` at :844) and `previousDepthTarget` (`fog-temporal.ts:77`) as RedFormat HalfFloat. Every reader takes `.x`.
- Optionally ping-pong the resolve with two fixed MRT targets and two materials instead of the two `copyTextureToTexture` calls (:137, :141). The composite must keep reading through `passTexture(this, …)`, or the temporal node drops out of the graph and the march stops rendering. A mixed-format MRT needs `textures[1].format` set.
- Saving: ≈0.05 ms together. It also removes two submits per frame, which helps weak CPUs.

**B7 · Sky only: compile out the air term under the physical sky.**
- Where: :806-811.
- Why: `rayleigh` is 0 there, so the term multiplies by zero but still runs every step: 3 exp plus ~12 ALU.
- Effect: pixel-identical, ≤0.1–0.2 ms.

## C. Look decisions for the user (moving-camera A/B, rain cycle off)

**C1 · 32 → 24 steps.** Retune the presets the same way: medium 24 → 18, constrained 20 → 16.
- Saving: −0.46 ms on the fog branch, ~0.55–0.65 ms on sky.
- Moving the dense/sparse split (:715, drop `+ u.topSoft`) saves nothing by itself. The 59–74 m stretch holds ~43 % of the visible plume optical depth.
- If 24 is adopted, protect the plumes: raise the sparse share to ~0.35, or crowd the sparse samples toward its lower end.

**C2 · Checkerboard march: half the march texels per frame, the rest from the resolve.**
- Saving: −0.6 to −0.9 ms. Large effort; a build option that needs temporal on.
- Required: a per-texel "history is a reconstruction" flag, e.g. the sign of the stored alpha, plus blend 1 on the next marched frame. Without it, crown edges smear for ~0.8 s in sideways moves.
- Derive the parity from the same uv-derived texel in the march, the resolve and the compact load.
- The compact RTT runs at scale 1 with an explicit ceil(Wm/2) × Hm.
- On sky, `hazeParts.aerial(…, st)` (:819) must get the full-march st.

**C3 · One 3D read instead of two.** Bake A and B′ into the two channels of one RG8 64³ texture.
- Saving: −0.08 to −0.3 ms.
- Look: B moves to a period-9 lattice, so the wisp pattern changes.
- Do it only after A1, and after a re-measure of '3d' against '2d'.

**C4 · Constrained preset "fog off" through B3's gate.** Only once a phone or iGPU reading shows the fog costs ≥ ~1 ms there.

## D. Refuted — don't spend time

Each of these is under 0.05 ms or misreads the code:
- merging the billow and erosion fetches;
- an RG8 128³ fetch for both octaves;
- hoisting per-ray invariants (the compiler already does it);
- SFU/exp trims;
- textureGather for the depth quads;
- reading cloud shadows per ray (sky measured it: no saving).

## E. Other open items

- **Docs.** `viewer/CLAUDE.md` lacks the temporal filter, tile retry, and the `?dot ?feed ?preset ?gputime ?diag ?freeorbit ?noorigin` params. It still says "main.ts ~1.5k lines" and names adaptive-quality.ts, which is deleted. Do this on the merged tip, because line 33 is one long line both branches edit. Mention `?tree=one-lod` only as a params-list entry.
- **Loose ends:**
  - `marchNode`'s `depth` parameter is unused.
  - `update()` allocates a Vector2 per frame.
  - Copy values writes `debugView`, and on sky also canopyShadows/cloudShadows, into the `volumetricFog` block.
  - "Rebake 3D texture" re-bakes the same fixed-seed volume: return the cached one, or relabel the button.
  - `groundLevelM` has no effect below `bottomM` 15. Reword its comment; don't set 22, which changes the user's look.
  - Dispose `placeholder3d`.
- **Tests:**
  - Pull the wrap-period factors into exported constants and assert they are whole: DRIFT_PERIOD 10 and RISE_PERIOD 16 against 2.3, 0.25, 0.5625, 0.625, 0.5.
  - Test the baker's job queue with a fake Worker.
  - Add a tsconfig that also type-checks `*.test.ts`.
- **Watch:** `fogDistanceOf` ignores the canopy clip. That is harmless at the defaults and only matters if `groundLevelM` is raised above `bottomM`, with a ≤9 m error, sub-texel.
- **Resolved, no action:**
  - the `AttributeNode: Vertex attribute "position" not found` warnings come from pulled dots and are harmless;
  - tile-retry wraps every TilesRenderer;
  - there are no TODO/FIXME markers.
