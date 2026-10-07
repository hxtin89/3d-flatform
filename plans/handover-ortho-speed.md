# Handover: drone ortho loading speed

Updated 2026-10-07. The user found the drone ortho "loading way too slow" and asked for its own
branch to analyse and speed it up. The analysis is done, the four fixes it pointed to are built,
tested, measured and merged into `sbb-main`. What is left is listed under "Still open".

## Where things are

- **Branch:** `sbb/ortho-speed`, cut from `sbb-main` at 1a36b03 (vite 7 + plugin-basic-ssl 2.3.0)
  in the worktree `C:/projects/WIDE_3d-flatform/.claude/worktrees/sbb-colour-matching`. That
  worktree's previous branch, `sbb/grade-editor`, is fully contained in `sbb-main`.
- **Merged into `sbb-main` on 2026-10-07** (`git log --merges --oneline -1 origin/sbb-main`).
- **Commits:**

| Commit | What |
|---|---|
| 35ab7a1 | The timing tool: `ortho-trace.ts`, `__three.orthoTrace`, `?orthocold`, `?orthoreq`, `?orthojobs`. |
| 931dbbb | The four fixes below, with tests and the config comments. |

- **Code:** `ortho-upgrade.ts` (when a tile is fetched and swapped), `ortho-composite.ts` (requests
  and worker), `ortho-plan.ts` (`createTurnGate`), `globe.ts` (`viewMovedAt`), config
  `design.droneOrtho`.
- **Dev server:** `preview_start {name}` reads `.claude/launch.json` from the session's launch
  folder, so start vite yourself in `viewer/`: `BROWSER=none npx vite --port 4177 --strictPort`,
  then `preview_start {url: "http://localhost:4177/threejs-test.html?…"}`. 4177 is on the local
  MapTiler key's port list. This worktree's `.claude/launch.json` change is uncommitted on purpose.

## What was slow, and why

**The network is not the wall.** Measured from this machine straight to api.maptiler.com
(scratchpad `ortho_net.py`, 12 random covered tiles and their 48 children):

| | Size | Cold | Warm (Cloudflare hit) |
|---|---|---|---|
| Ortho tile (z19/z20 WebP) | 104–116 KB | 210–230 ms | 75–81 ms |
| Satellite z19 (JPEG) | 14 KB | ~505 ms | 60 ms |

32 fresh ortho tiles (one landing at Full): 3.6 s at 2 in parallel, 1.1 s at 8, 0.8 s at 32.

**The waits were.** Before 931dbbb, in `ortho-upgrade.ts`, one after the other:
- nothing before the Start click or during a camera flight (unchanged, by design);
- the basemap had to be fully idle; one loading tile reset every tile's dwell and stopped the
  request pump, so even started upgrades stalled;
- a 1 s dwell per tile, also in a still view;
- requests waited for the point stream (8 s cap);
- 2 requests and 2 upgrades in flight, finished tiles holding upgrade slots;
- a finished tile went in only after 1 s without a basemap traversal, with no upper bound. Once,
  after a zoom out, 4 finished tiles waited 55 s that way in a view that did not move.
  Traversals also come from tiles loading and from `tile-retry.ts` nudges; that is the suspect,
  not confirmed (the console was lost).

## What changed (931dbbb)

1. `maxOrthoRequests` 2 → 8, `maxConcurrentComposes` 2 → 4.
2. A swap waits for the **camera** to stand still for `settleMs` (globe.ts compares the view
   matrix each frame, the same test UpdateOnChangePlugin makes), not for the basemap to stop
   traversing. After `maxSwapHoldMs` (3 s) a finished tile goes in at the next frame without an
   arrival anyway (`stats().swapsAfterHoldLimit` counts those).
3. Upgrades start while the basemap or the point stream still loads; requests then go out at
   `busyOrthoRequests` (2), all 8 once both are idle. `busyOrthoRequests: 0` holds them back
   again. The 8 s point-stream fallback is gone.
4. Once the camera has stood still for 300 ms, a settled tile starts at once; the 1 s dwell
   applies only in a moving view (it keeps the zooms a descent passes through from being
   fetched). The old "next to an upgraded tile" rule is gone, every tile gets this.

## Measured (dev proxy, `?bgclock`, 1280×800, `?ortho=full&orthocold`)

Seconds from the Start click or the move until the last tile shows its ortho:

| View | Tiles | Before | After, run 1 | After, run 2 |
|---|---|---|---|---|
| Landing after Start | 8 | 11.1 | 9.8 | 8.4 |
| Tower hotspot | 14 | 16.8 | 11.4 | 8.8 |
| Zoom out (12 wheel steps) | 16–20 | 11.5 | 7.2 | 6.5 |
| Zoom in (12 wheel steps) | 12 | 9.1 | 4.9 | 4.1 |

After the basemap finished loading, the ortho now takes 1–5 s (was 4–9 s). No failed requests,
no hold-limit swaps, upload 0.7–0.9 ms median, 2.7 ms max, worker 35–100 ms median per tile.

## Still open

1. **Arrival frames.** After the tower flight, finished tiles waited up to 3.3 s in total
   (`swapHeldByArrival`): one swap per frame, never in a frame where a point or basemap tile
   arrives. Next small step: let a tile held past `maxSwapHoldMs` into an arrival frame, or allow
   two swaps per frame.
2. **The basemap still comes first.** A tile is only "settled" once the satellite tile of its
   final zoom has loaded (2–7 s after a move), so its ortho cannot start earlier. Ideas:
   prepare the landing view's ortho behind the loader (the camera already sits there), or start
   on the tiles a flight's destination will need.
3. **The 55 s hold** was not reproduced. If finished tiles hang again, check
   `__three.globe.orthoStats().swapsAfterHoldLimit` and the `[globe] retrying` console lines.
4. **Real conditions.** All numbers are dev proxy on this machine. Measure on wi-dev (HTTP/2
   straight to MapTiler) and on a phone (Auto gives `half` on the medium preset, `off` on
   constrained). In dev, 8 ortho requests can hold all six HTTP/1.1 sockets to localhost when a
   move starts; watch whether satellite tiles lag after quick moves.
5. **Bytes.** A landing at Full downloads 3–5.5 MB of ortho, a zoomed-out view ~7 MB. A lossy
   512 px re-export from Andrea, or our own colour-corrected tiles on CloudFront, would cut that.
6. Older ortho leftovers from the grade-editor handover: the ~0.1 stop red cast, the other
   requests to Andrea, frame smoothness of the swaps in a visible window.

## How to test

- **Checks:** `cd viewer && npm run bench:verify` (326 tests), `npx tsc --noEmit -p .`.
- **The timeline:** `__three.orthoTrace.report()` gives milestones in seconds after the Start
  click (`allowed` = flight over, `basemapIdleAfterLanding`, `firstSeen`, `firstPick`,
  `firstRequest`, `firstSwap`), seconds per gate (`notAllowed`, `basemapBusy`, `requestsCapped`,
  `dwelling`, `working`, `swapHeldByArrival`, `swapHeldByMotion`), per-tile step times
  (`dwell`, `queue`, `network`, `worker`, `swapWait`, `settledToSwapped`) and request stats. To
  time a later move: `__three.orthoTrace.reset(); __three.orthoTrace.mark('start')`, then move.
- **The end of a view:** `orthoStats().lastSwapAt` once the basemap is idle and `pending`,
  `inFlight` and `waiting` have been 0 for 3 s.
- **Moves a script can make:** the TOWER 05 label's `click()` flies; wheel events on
  `__three.renderer.domElement` zoom (12 × `deltaY: ±400`, 60 ms apart).

## Pitfalls met

- The trace's `start` milestone is `0`: test it with `!== undefined`, or a poller keeps
  clicking Start.
- `landingComplete` marks the first moment nothing is pending. After a hotspot click it can fire
  at the end of the flight, before any tile has settled; use `lastSwapAt`.
- Only TOWER 05 flies from a synthetic click: the CANOPY labels and the 33 big-tree labels do
  not, FIELD FILM opens the video (and the ticks stop while it is open), and a synthetic canvas
  `dblclick` does not fly either. The page has 40 `.map-marker-label`s.
- `javascript_tool` gives up after 45 s while the pane is hidden: poll in chunks under 40 s.
- Windows `curl.exe` and Git's curl have no HTTP/2; the parallel numbers above are HTTP/1.1.
- The Bash tool in an isolated session refuses compound git commands: use `git -C <worktree>`,
  one command per call. Fetch and push from PowerShell.
- Commit messages: a subject plus at most one sentence, no Co-Authored-By trailer.
