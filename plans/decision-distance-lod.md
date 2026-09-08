# Decision: no distance taper, no far cutoff (for now)

**Date:** 2026-09-08
**Branch:** `sbb/tile-cache-floor`
**Status:** decided — not merged. Revisit after the two items under "What changes this".

## What was on offer

`jan-threejs-test` holds a different answer to the same streaming cost. Two commits,
both readable without merging anything:

| Commit | Date | Introduced |
|---|---|---|
| `76a6d04` "frustrum - arrow keys, fog" | 2026-08-26 | `distance-lod.ts`, the `setDistanceCutoff` hook in `streaming.ts`, the per-frame call and fog range in `main.ts`, the far-fade in `point-cloud.ts`, and the `lod.distance*` values in `config.ts` |
| `9a6525a` "stop tile streaming from hitching flight and orbit" | 2026-08-25 | queue serialisation in `DEFAULT_LIMITS`; flight SSE floor extended to cover gestures |

```
git show 76a6d04:viewer/src/threejs-test/distance-lod.ts
git log -1 9a6525a          # the frame-time measurements are in the message
```

`distance-lod.ts` wraps `calculateTileViewError` — the same hook we use for foveation,
view-angle and `view-depth.ts` — and is on by default. Two separable mechanisms:

- **Far cutoff.** Beyond `D = clamp(height*6, 1.5 km, 12 km)` a tile gets
  `inView = false`: not fetched, not refined, not drawn. Points fade from `0.6 D` and
  the scene fog is tuned to cover the edge.
- **Quadratic taper.** Beyond `R = max(height*3, 200 m)` the error is multiplied by
  `(R/d)²`.

## Decision

**The cutoff is defensible and not rejected on its merits.** A far plane for the point
cloud is an ordinary thing to want, and it answers a real complaint his own comment
states: at the horizon, screen-space error alone pulls every mid-depth tile of the
survey for a sliver of haze. Ancestors containing the camera report distance 0 and are
left alone. The fade and fog work is careful.

**The taper is rejected.** `config.lod.sse` already records why the three-band error
ladder was deleted: it "counted distance a second time, which only made far views
coarser than the pixel budget required". The error quotient divides by distance already
— that is the whole reason one constant covers every camera range. `(R/d)²` is that same
double count, continuous instead of banded, and steeper: at 4x the detail range a tile
is handed a sixteenth of its earned error. It also fights `f63fd4d` directly, since both
wrap the same function — one raising the error off-axis to fix an under-refinement, one
lowering it with range on purpose.

**The queue serialisation is not adopted, but its measurements are accepted.**
`maxParses` 2 -> 1, `maxProcesses` 4 -> 1, `maxTilesProcessed` 120 -> 1. His numbers,
from an entrance flight plus an 8 s scripted orbit:

| | before | after |
|---|---|---|
| flight, worst frame | 58 ms, 6 frames >32 ms | 25 ms, 0 frames >32 ms |
| orbit p50 / p95 | 16.7 / 33.9 ms | 8.3 / 9.0 ms |
| orbit frames >32 ms | 42 of 470 | 5 |

That is a real defect fixed, not noise. It is also the opposite direction from what the
loading-path audit wants (more download parallelism, not less), because it optimises
frame-time smoothness during motion while this branch is optimising fidelity and a
correct metric. Both readings are sound.

## What changes this

His own diagnosis is the reason to sequence rather than choose. He measured render time
tracking GPU uploads at roughly **4 ms per megabyte**, which is why four tiles landing
together cost a 62 ms frame. Two pieces of work attack that number instead of rationing
it:

1. **Share one material across tiles.** Removes a full TSL codegen, shader-module
   compile and pipeline build from every arriving tile — main-thread work in the same
   frame as the upload, invisible to a parse counter.
2. **Quantise positions in our own rebuild.** 1.1 MB -> ~0.66 MB per tile, so the same
   upload lands in ~2.6 ms instead of ~4.4.

If those land, the pile-up the serialisation defends against is a fraction of its
measured size, and the cutoff would be buying smoothness that no longer needs buying.
His mechanisms trade density for smoothness; these two buy smoothness without spending
density. Only one of those is free to reverse.

**Revisit this file** once 1 and 2 are in, and re-measure the orbit case before adopting
or rejecting the cutoff on its own.

## Not the reason

Not rejected for being someone else's work, and not rejected because the branches
conflict. They do conflict — `main.ts`, `globe.ts`, `point-cloud.ts`,
`environment-layer.ts`, `threejs-test.html` — but that is a consequence of both lines
touching the same areas, not an argument. Note also that merging `jan-threejs-test`
*into* this branch is what would adopt these mechanisms; a pull request in the other
direction adopts nothing.

Full write-up, with the loading-path audit it sits inside:
https://claude.ai/code/artifact/256b5293-bcef-428c-8ec7-93cae5ee28c4
