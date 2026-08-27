/**
 * Which published point tileset the session streams, as one switchable route.
 *
 * There are two genuinely different ways of using this data, plus the three tiers
 * of the second one on their own:
 *
 * - **APH** — one continuous quadtree built straight from the `*.copc.laz` sources.
 *   Every node carries 75k points and the footprint quarters per level, so density
 *   quadruples on the way down to the d9 leaves, which are the original
 *   observations. `refine: ADD`, no request volumes: the error target alone decides.
 *
 * - **One LOD tree** — the p02 → p10 → p100 tiers chained into a single document
 *   through external tileset references, each hand-off `refine: REPLACE` and gated
 *   by a `viewerRequestVolume`. Tier selection is encoded in the *data*, not in the
 *   viewer: no distance logic here picks a tier. What the viewer must supply is
 *   ViewerRequestVolumePlugin, because 3d-tiles-renderer 0.4.x does not implement
 *   `viewerRequestVolume` — and without that gate the chain refines into p100
 *   everywhere at once. That is not a distance question but a spatial one ("is the
 *   camera inside this box"), and it is load-bearing for a second reason:
 *   `canUnconditionallyRefine` in the library returns true for any tile whose
 *   content is an external tileset, so the SSE target cannot stop the descent at a
 *   tier boundary by itself.
 *
 * - **One tier alone** (overview p02 / explore p10 / detail p100) — a single
 *   self-contained document. Plain SSE, no request volumes, no distance logic of
 *   any kind. These are the clean A/B baselines: they show what one tier actually
 *   holds, without the chain's hand-offs on top.
 *
 * Switching reloads the page rather than swapping the streamer in place. That is
 * deliberate for a comparison harness: the ground-patch lattice is built from the
 * active tileset's node boxes, foveation and the view-angle correction wrap
 * `calculateTileViewError`, and the LRU/GPU budgets differ per route — a live swap
 * would leave the previous route's cache warm and its mask in place, which is
 * exactly the state that makes two measurements incomparable. The camera pose is
 * carried across the reload instead (see readPose), so both routes are judged from
 * the same viewpoint with a cold cache.
 */

/** Route ids are the URL vocabulary (`?route=`), stable across pack renames. */
export type TilesetRouteId = 'aph' | 'one-lod' | 'overview' | 'explore' | 'detail'

export interface TilesetRoute {
  id: TilesetRouteId
  /** Pack id inside point-source.ts, which owns dataset paths and per-route limits. */
  packId: string
  label: string
  /** Segmented-button caption; kept short enough for the panel. */
  short: string
  note: string
}

export const TILESET_ROUTES: readonly TilesetRoute[] = [
  {
    id: 'aph',
    packId: 'tree:aph',
    label: 'Adaptive hierarchy',
    short: 'APH',
    note: 'One quadtree from the raw sources, d0–d9. Highest resolution — the d9 leaves are the original observations. ADD refinement, so every level is drawn at once',
  },
  {
    id: 'one-lod',
    packId: 'tree:one-lod',
    label: 'One LOD tree',
    short: 'Chain',
    note: 'p02 → p10 → p100 chained in one document, each hand-off REPLACE and gated by a viewer request volume. The data decides the tier, not the viewer',
  },
  {
    id: 'overview',
    packId: 'global:overview',
    label: 'Overview p02 only',
    short: 'p02',
    note: '2% of the points, whole survey, one tier on its own. What the chain starts from',
  },
  {
    id: 'explore',
    packId: 'area:explore',
    label: 'Explore p10 only',
    short: 'p10',
    note: '10% of the points, one area at a time — the area under the camera is resolved from the manifest',
  },
  {
    id: 'detail',
    packId: 'area:detail',
    label: 'Detail p100 only',
    short: 'p100',
    note: 'Every point, one area at a time. Same density as the APH leaves but with no hierarchy above it, so nothing coarse covers the gaps while it loads',
  },
]

export const DEFAULT_ROUTE: TilesetRouteId = 'aph'

export function routeById(id: string | null | undefined): TilesetRoute {
  return TILESET_ROUTES.find((route) => route.id === id)
    ?? TILESET_ROUTES.find((route) => route.id === DEFAULT_ROUTE)!
}

/**
 * Read the active route from the query string. `?tree=one-lod` is still honoured:
 * it was the only switch before this panel existed and it is in written-down
 * comparison notes.
 */
export function routeFromParams(params: URLSearchParams): TilesetRoute {
  const explicit = params.get('route')
  if (explicit) return routeById(explicit)
  if (params.get('tree') === 'one-lod') return routeById('one-lod')
  return routeById(DEFAULT_ROUTE)
}

/**
 * Camera pose carried across a route switch, in the survey's ENU frame.
 *
 * ENU rather than world space on purpose: the floating origin moves the render
 * frame under the camera, so a world-space position means nothing after a reload.
 * A position plus a look-at target reproduces the view the same way the boot
 * staging code does, without a quaternion whose frame would need reconstructing.
 */
export interface RoutePose {
  position: [number, number, number]
  target: [number, number, number]
}

const POSE_KEY = 'sbb.tilesetRoute.pose'

/** Stash the pose for the reload that immediately follows. */
export function writePose(pose: RoutePose): void {
  try {
    sessionStorage.setItem(POSE_KEY, JSON.stringify(pose))
  } catch {
    // Private windows and blocked site data: the switch still works, it just
    // starts from the usual staging position and entrance flight.
  }
}

/**
 * Take the stashed pose, if any. Consumed on read so a later plain reload starts
 * normally rather than silently inheriting a pose from an earlier comparison.
 */
export function takePose(): RoutePose | null {
  let raw: string | null = null
  try {
    raw = sessionStorage.getItem(POSE_KEY)
    if (raw !== null) sessionStorage.removeItem(POSE_KEY)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as RoutePose
    const ok = (v: unknown): v is [number, number, number] =>
      Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n))
    return ok(parsed?.position) && ok(parsed?.target) ? parsed : null
  } catch {
    return null
  }
}

/** The URL that switches to `id`, keeping every other parameter as it is. */
export function routeHref(id: TilesetRouteId, current: URL): string {
  const next = new URL(current.href)
  next.searchParams.set('route', id)
  // Would otherwise win over ?route= on the next read for anyone who still has it.
  next.searchParams.delete('tree')
  return next.href
}
