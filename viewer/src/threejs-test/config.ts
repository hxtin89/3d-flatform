// Product-facing viewer tuning. Keep values in metres and milliseconds.
export const EXPERIENCE_CONFIG = {
  flight: {
    // ENU offsets are relative to the full point-cloud centre.
    // The final approach passes just left and above the configured tower.
    destinationOffsetM: [120, -1_400, 320],
    overviewOffsetM: [0, -132_000, 92_000],
    overviewControl1OffsetM: [-8_000, -116_000, 19_000],
    overviewControl2OffsetM: [-700, -10_000, 1_600],
    autoDurationMs: 6_200,
    manualDurationMs: 5_200,
    reducedMotionDurationMs: 900,
    reducedMotionManualDurationMs: 700,
    // Double-click and marker approaches reuse the same Bézier flight machinery.
    dblClickDurationMs: 2_200,
    dblClickMinRangeM: 420,
    markerApproachDistanceM: 320,
    markerFlightDurationMs: 2_600,
    // Fraction of the entrance flight at which the point cloud appears and its
    // streamer resumes. Before that the cloud is a speck on the horizon that
    // buys nothing visually while its traversal, fetches and GPU uploads cost a
    // weak phone the whole frame budget. Keyed by the loader benchmark's
    // preset: 1 = only once the flight has landed.
    cloudRevealProgress: { strong: 0.55, medium: 0.85, constrained: 1 },
  },
  lod: {
    /**
     * The one fidelity control: how far apart the drawn points may sit on screen,
     * in CSS pixels.
     *
     * This is the renderer's `errorTarget`, and for this data it reads literally.
     * A tile's `geometricError` is `pointSize.geometricErrorScale * sqrt(area /
     * pointCount)` — a fixed multiple of its own mean point spacing in metres —
     * so the renderer's `geometricError / (distance * sseDenominator)` is that
     * spacing projected onto the image, times the same factor. A tile refines
     * while that projected figure is wider than this number.
     *
     * Mind the factor when reading this value as a pixel distance: at scale 2 a
     * tile sitting exactly on the target draws its points half this far apart,
     * so 4 here is a 2 px spacing. The two are only equal at scale 1.
     *
     * Because that quotient already contains the distance, one constant covers
     * every camera range: constant spacing on screen means near-constant point
     * count whether the camera is 80 m or 5 km out. The three-band ladder this
     * replaced (16 / 8 / 4 by camera range) counted distance a second time, which
     * only made far views coarser than the pixel budget required.
     *
     * 4 was the old detail band and matches the Cesium reference: measured on
     * desktop WebGPU it selects ~10M points at a held 60 fps, so the quad
     * expansion three.js needs (WebGPU has no sized point primitive) still fits
     * inside the frame budget.
     */
    sse: 4,
    // Camera ranges at which the One-LOD-Tree density ceiling opens up p10 and
    // p100 — the ?tree=one-lod comparison route only, where the tiers live in
    // separate documents and the error target alone cannot keep p100 dormant.
    // Named "Height" because the metric used to be plain altitude; it is the slant
    // range to the ground ahead (see maxTiltRangeFactor), so these are only heights
    // when looking straight down.
    detailMaxHeightM: 150,
    exploreMaxHeightM: 2_500,
    // Margin the ceiling keeps past an edge, so drift cannot flip the tier.
    bandHysteresis: 0.15,
    /**
     * Correct the screen-space error for the angle the ground is seen at — see
     * view-angle.ts for the geometry. Purely a function of camera and tile position,
     * so it cannot hunt the way a frame-time loop does.
     */
    viewAngleError: {
      enabled: false,
      /** Floor for the cosine, so grazing tiles stay loadable. */
      minCosine: 0.1,
    },
    /**
     * Measure a tile's range along the view axis rather than straight through space,
     * so the screen-space error matches the perspective divide that actually puts it
     * on screen — see view-depth.ts for the geometry.
     *
     * Unlike the correction above the geometry here is not in doubt — it is nil at the
     * centre of the frame and buys back roughly a level of detail at the corners, which
     * were being under-refined. It is off anyway, for the reason on `enabled`.
     */
    viewDepthError: {
      // Off by default, though the geometry it fixes is real. The correction scales with
      // the angle off the view axis, so wherever it lifts a tile across the refine
      // threshold it puts that boundary at a fixed angle in *screen* space — a detail
      // ring that slides over the terrain as the camera turns. A step that stays put on
      // the ground is the lesser artefact, so this waits until the point-size derivation
      // is hiding level boundaries again. Measured at 134 m nadir: the threshold is
      // 0.553 m against d5 at 0.456, so 1.21x flips it — reached at 34 degrees off axis,
      // inside the frame. Nadir views see almost none of it either way (factor ~1).
      enabled: false,
      /**
       * Ceiling of 1/0.5 = 2x on the correction. The frustum corner at 60° vertical
       * fov sits near cos 0.64, so this clears the whole visible frame and only
       * catches a large tile whose centre falls outside it.
       */
      minCosine: 0.5,
    },
    /**
     * Ceiling on how much the view angle may stretch the camera's reported range.
     *
     * The range is the slant distance to the ground ahead, altitude / sin(pitch),
     * which goes to infinity as the camera levels out. The raycast version of this
     * was dropped for exactly that reason — it swung kilometres per degree near the
     * horizon. Clamping the sine instead keeps the metric analytic and bounded: at 6
     * the range can reach six times the altitude and no further.
     *
     * Since the error target became a constant this feeds only the HUD readout and
     * the One-LOD density ceiling; the APH refinement path does not read it.
     */
    maxTiltRangeFactor: 6,
    // Foveated detail: redistribute the error target across the image instead of
    // raising it everywhere. The factors multiply whatever screen-space error is
    // set, so foveation only decides where inside the frame that budget lands. Off
    // by default until the position below is measured against real camera pitches.
    foveation: {
      enabled: false,
      // Below 1 buys detail in the core; 1 leaves the core exactly as it is today.
      centreFactor: 1,
      // Above 1 coarsens the far corner of the image. Measured from the staging view:
      // 3x drops a single tile because the periphery is mostly leaves, which carry
      // error 0 and can never be coarsened; 8x reaches the internal nodes above them
      // and takes 14% of the drawn points with no ring showing.
      edgeFactor: 8,
      // Half extents of the core, in half screen heights, so a height of 1 reaches
      // the top and bottom edges. Equal values give a round core; a wide, low pair
      // gives the horizontal band a tilted camera wants. Both default to the value
      // the circular core was measured at, so the old readings still reproduce.
      width: 0.35,
      height: 0.35,
      // How far past the core the blend to the corner factor takes, same unit.
      falloff: 1.25,
      // Fovea centre on the projected image: -1 bottom edge, 0 centre, +1 top. With
      // followTilt on this is a bias added to the tilt-driven position rather than the
      // position itself.
      offsetY: 0,
      /**
       * Slide the fovea toward the bottom edge as the camera tilts, reusing the
       * vignette's own pitch curve (design.vignettePosition.sideAngleDeg and
       * topAngleDeg) so the two features anchor alike.
       *
       * Looking down, what you are closest to is the middle of the frame. Looking
       * across the canopy it is the bottom edge — the top of the frame is kilometres
       * away. A fixed centre therefore spends the core budget on the far field exactly
       * when the near field needs it most.
       *
       * The vignette gets this for free because its anchor is a world point that blends
       * onto the camera itself, and a ground point at the camera lands at the bottom of
       * the screen. That anchor cannot simply be projected here: at zero forward offset
       * it sits *on* the camera, where the projection is degenerate. So the pitch curve
       * is shared instead of the anchor, which is also smoother — no term running to
       * infinity as the camera levels out.
       */
      followTilt: true,
      /**
       * How far down the fovea travels at full side view, in half screen heights.
       * 1 puts it on the bottom edge, 0.5 halfway there.
       */
      followAmount: 1,
    },
    /**
     * Drawn point size, derived per tile from that tile's own point spacing.
     *
     * `sse` above is a point spacing in CSS pixels, and three's `sizeNode` is a
     * diameter in CSS pixels, so the two share a unit: a dot as wide as the
     * spacing is a dot that exactly touches its neighbours. `coverage` is that
     * multiple, and the size is computed in the shader from the tile's spacing and
     * the point's own view depth — see point-cloud.ts.
     *
     * A single world size cannot serve this tree. `refine: ADD` puts every level in
     * the frame at once, so a d0 point covering ~30 m of ground and a d9 leaf
     * covering ~0.5 m are drawn in the same pass.
     *
     * This replaced a hand-tuned curve over *camera height* (3.9 px at 82 m down to
     * 2.5 px at 1088 m). Height is only a proxy for distance, so under tilt the
     * near and far edges of the frame were given the same pixel size.
     */
    pointSize: {
      /**
       * Floor and ceiling on the drawn diameter, as multiples of the spacing a tile
       * sitting exactly on the error target projects to (`sse / geometricErrorScale`,
       * 2.0 px at the shipped SSE 4). Relative rather than absolute so the window moves
       * with the fidelity setting instead of fighting it — at SSE 8 every drawn point is
       * twice as far apart and a fixed pixel clamp would bite twice as hard.
       *
       * The `Point size` slider multiplies both, so turning dots up widens the window
       * with them. It used to scale only the derived size against a fixed ceiling, which
       * meant that at 3x the slider 76% of all points were pinned flat.
       */
      floorFactor: 0.7,
      /**
       * 3x the target spacing — 6.3 px at SSE 4, which is where the absolute 6 px this
       * replaces already sat. The value barely moves; what changes is that it now scales
       * with the error target instead of being a fixed pixel count.
       *
       * It was set to 8x first, on the theory that the ceiling only ever existed to stop a
       * coarse ancestor painting the screen and that applyEffectiveSpacing had removed the
       * need. Measured at the arrival view, that is wrong. Sweeping the factor over the
       * same 2.76 M points:
       *
       *   factor   1     1.5    2     3     4     6     8     12
       *   ceiling  2.1   3.1    4.2   6.3   8.3   12.5  16.7  25.0  px
       *   overdraw 6.1   9.2    12.0  17.8  24.9  43.3  67.7  134.1 x
       *   clamped  38.8  22.9   16.5  12.8  11.7  10.7  10.3  9.8   % of points
       *
       * The clamped share stops falling. Past 4x the paint triples while barely 2% more
       * points come free, because the size goes as 1/depth and a tenth of the cloud sits
       * close enough to the camera that no finite ceiling releases it. The ceiling is not
       * a vestige of the ancestor problem, it is the bound on a divergent term.
       *
       * There is a second reason to keep it tight, and it is the more interesting one: the
       * spacing is a *horizontal* ground quantity, `sqrt(area / points)`, while a canopy is
       * a volume tens of metres deep. Looking into it, far more points share a pixel than
       * the ground spacing implies — the panel reads about 1 pt/px — so the rule over-asks
       * in the near field and the clamp is quietly correcting for it. Fixing that properly
       * means deriving the size from projected rather than horizontal density.
       */
      ceilFactor: 3,
      /** Used when a tile reports neither a geometric error nor a usable footprint. */
      fallbackSpacingM: 0.5,
      /**
       * What the pipeline multiplied the mean point spacing by before writing it
       * as `geometricError` — `--error-scale`, `DEFAULT_ERROR_SCALE = 2.0` in
       * build_adaptive_point_hierarchy.py. Divide it back out to recover the
       * spacing itself; see tileSpacingMetres.
       *
       * It has to be a constant because nothing publishes it: the value lives in
       * `cliProfile.errorScale` inside adaptive-point-hierarchy-report.json, which
       * is not deployed (the tile bucket 403s it), and neither the tileset
       * documents nor the node-diagnostics maps carry it.
       *
       * Verified against the deployed peru-b2-globe pack on 2026-09-07 rather
       * than trusted from the pipeline default: a full 2 km z0 cell publishes d0
       * with `geometricError` 14.605, and 2 * sqrt(4e6 / 75_000) = 14.606.
       */
      geometricErrorScale: 2,
    },
    /**
     * The primitive every point is drawn as — see dot-geometry.ts and
     * plans/plan-dot-geometry-ab.md. The triangle draws the same round dot as the quad
     * from 3 vertices instead of 4, and is the default since 2026-09-29: pulled, it measured
     * 12 % less cloud GPU time at nadir (lower in three of four passes) and 33 % less at a 40°
     * tilt (all four), and the two differ on 0.01-0.04 % of pixels, at dot rims. `?dot=quad`
     * boots on quads for the A/B, the panel flips it at runtime. The Square dot shape
     * always draws quads.
     */
    dotGeometry: {
      shape: 'triangle' as 'quad' | 'triangle',
      /** The triangle's inscribed circle in drawn diameters: the dot (0.5) plus 1 %. */
      triInradius: 0.505,
      /**
       * How the points reach the GPU. 'pulled', the default since 2026-09-29, draws without
       * instancing and reads each point from a per-tile data texture; 'instanced' is the
       * older path, kept for the A/B. Pixel-identical on WebGPU and WebGL2, and at the
       * landing view the cloud's GPU time fell from 20.4 to 2.6 ms (pulled triangles against
       * instanced quads). `?feed=inst` boots instanced, the panel flips it at runtime.
       */
      feed: 'pulled' as 'instanced' | 'pulled',
      /** Width of the per-tile point-data texture, a power of two. */
      textureWidth: 1024,
    },
    /**
     * The dome: two spheres standing on the basemap under the view centre, in metres.
     * The centre is the view-centre ray's hit on the ellipsoid, so it rides the ground
     * with the camera and keeps its size in metres at every zoom. The outer sphere is
     * to gate loading, the inner one rendering and a per-point size/height falloff
     * measured as true 3D distance from the centre; tile boxes are tested at exactly
     * these radii. See sphere-fade.ts. Radii, opacity and exponent are panel sliders.
     */
    sphereFade: {
      enabled: true,
      // Judged by eye on 2026-09-18 at the landing view.
      outerRadiusM: 1000,
      innerRadiusM: 450,
      // How far inside the inner radius the falloff begins, in metres. Inside that
      // every point is drawn whole; over the last `rampInsetM` metres to the rim the
      // size and height ramp to zero.
      rampInsetM: 140,
      // Shape of that ramp only, one exponent per end: `fadeIn` is how it leaves the
      // plateau (above 1 holds full size a while longer before dropping), `fadeOut`
      // how it lands on zero at the rim (above 1 lingers small before vanishing).
      // 1 and 1 is a straight line.
      fadeIn: 2,
      fadeOut: 0.5,
      debugOpacity: 0.05,
      showDebug: false,
      /**
       * Load the landing view first. While the loader is up, and then all through the
       * entrance flight, the streamer ignores the camera and refines the whole dome
       * around the flight's landing pose to the full error target — every tile whose
       * box reaches the outer sphere, judged by its distance from that pose as if the
       * camera already stood there looking in every direction. The Start button only
       * appears once that set has finished loading, and the normal camera-driven
       * traversal takes over the moment the camera arrives. The boot and flight brakes
       * are skipped for that flight, since the burst they exist to spread has already
       * been paid behind the loader. `false` restores the old boot: coarse SSE 256
       * behind the loader, the frustum-driven traversal from the first frame.
       */
      loadInitialPov: true,
      /**
       * Cap on that preload, in points. The whole dome at 1000 m measured 19 M points and
       * 272 MB — far more than a landing needs. The preload sphere is shrunk from the
       * outer radius until the tiles inside it, priced by the published per-node counts
       * and taken nearest first, fit under this; the rest arrives after landing through
       * the camera-driven traversal as usual.
       */
      initialPovMaxPoints: 3_000_000,
      // Grazing hits count as misses past this multiple of the camera height — the
      // same constant that bounds the refinement range, so the two agree.
      maxRangeFactor: 6,
      // The adaptive dome — see sphere-fade.ts. The inner radius is `growth` times the
      // camera's distance to the centre, between innerRadiusM and maxRadiusM; outer
      // radius and ramp scale with it. At 0.6 the dome reaches ~31° off the focus.
      // Measured 2026-09-23: from 1 km up the whole forest is under 1.4 ms with the dome
      // off, so the size up there is a matter of look, not of cost.
      growth: 0.6,
      // Reached around 5 km height looking down.
      maxRadiusM: 3000,
      // The focus spot slides this far below the middle of the screen at full side
      // view, in half screen heights — 0.4 is just above the lower third.
      focusDrop: 0.4,
      easeSeconds: 0.3,
      // Both off: inside the dome the resolution stays exactly what it is with the dome
      // off. Coarser detail and per-tile thinning in the band change density at tile
      // boundaries, which showed as rectangles (see the view-error wrapper in
      // streaming.ts); kept as sliders for experiments.
      rimDetailFactor: 1,
      bandThinning: 0,
    },
    // Base size when the per-tile spacing above is toggled off (Cesium comparison:
    // one fixed size like Cesium's pointSize, slider still multiplies).
    fixedPointSizePx: 2.5,
    // Horizontal slack on the pipeline's viewer request volumes, in multiples
    // of the chunk footprint. 1 = hug the chunk exactly, which leaves gaps the
    // camera can sit in without ever opening p10/p100.
    requestVolumeXyScale: 2.5,
    // While the fullscreen loader is up the camera already sits at its staging
    // position inside the detail band. Nothing of it is visible, so refinement
    // is held coarse until boot completes — otherwise the loader waits on tiles
    // nobody sees.
    bootSse: 256,
    // The entrance flight starts the moment the loader hides, which is exactly
    // when the boot brake above is released. It ends a few hundred metres above
    // the canopy, so without a floor the finest APH level streams in mid
    // animation. Kilometres out that detail is invisible anyway.
    flightSse: 64,
    // Back to the distance-driven density after landing, spread over this long
    // so the refill arrives gradually instead of in a single frame.
    flightSseRampMs: 1_000,
  },
  navigation: {
    // Metres above the point-cloud floor where zooming stops. Single knob: the
    // navigation floor, the orbit camera radius and its minimum pivot distance
    // all derive from this one number. Raised to the dataset's measured canopy
    // height if set below it, so the camera cannot end up inside the crowns —
    // the HUD shows the effective value and a console line reports the raise.
    // Keep lod.detailMaxHeightM above the effective stop, or the finest density
    // band stops engaging at full zoom.
    zoomStopHeightM: 80,
    // Lifts the whole point cloud above the draped basemap imagery. Ground
    // snapping lands the *bounding box* floor on the ellipsoid, and the box does not
    // reach the lowest terrain here — measured, the deepest points sit about 36 m
    // below where areaBbox puts the floor — so without a lift the river bed and the
    // gravel bars end up behind the imagery and invisible.
    //
    // 20 m, chosen by eye on the Lift slider. Clearing the imagery completely takes
    // about 46 m, but lifting that far floats the whole canopy with it, so this is a
    // deliberate middle: the banks come out, the deepest channel stays tucked under.
    // Adjustable live — see the Lift slider under Height offset.
    pointCloudLiftM: 20,
    // Only used for the canopy/cloud-deck shader heights
    fallbackCloudHeightM: 140,
    maximumOrbitDegrees: 72,
    minimumBoundsRadiusM: 2_500,
    surveyBoundsScale: 0.6,
    // Floating origin: how far the camera may drift from the render origin
    // before the whole world is shifted back under it. Scaled by viewing range
    // because pan/zoom speed is too (keyboard.panRangeFactor), so the rebase
    // rate stays roughly constant from the canopy to the overview. Even at the
    // 20 km ceiling the float32 step is 2.4 mm against metres per screen pixel.
    originRebaseMinM: 500,
    originRebaseMaxM: 20_000,
    originRebaseRangeFactor: 4,
    /**
     * Response time, in milliseconds, for easing the rotation pointer toward where the
     * mouse actually is. 0 disables it. Named to match keyboard.responseMs, which is
     * the same constant in the same expression on the other input.
     *
     * A mouse reports whole device pixels at roughly 125 Hz while the frame runs at
     * 120-160, so measured over a real drag: 699 pointer events across 2065 rotating
     * frames, every step exactly 0.8 CSS px (one device pixel at dpr 1.25), and a p90
     * angular jerk of 8.7e-3 rad against a per-pixel quantum of 6.4e-3. Two frames in
     * three the rotation does not move at all and the third jumps a whole step, which
     * is the one-pixel judder that only ever showed on mouse rotation and never on the
     * keyboard, which is time-based to begin with.
     *
     * The library's own damping does not cover this: inertia is applied only once the
     * drag is released, not during it. Keyboard navigation, by contrast, has always
     * eased its velocity with this very expression at 110 ms — see keyboard.responseMs,
     * which the slider marks on its own track for comparison. This closes a gap on the
     * mouse side rather than introducing anything new.
     */
    pointerResponseMs: 50,
    /**
     * Move the rotation pivot from the terrain up onto the canopy. Rotation only —
     * panning rides a horizontal plane through the pivot, so lifting it there would make
     * pan speed depend on the canopy height under the cursor.
     *
     * EnvironmentControls picks the pivot by raycasting the scene, and the only thing it
     * can hit is the draped basemap: the cloud's dot meshes hold no point positions
     * (pulled, the default, has no attributes at all; the instanced arm only four corner
     * offsets), and the carrier Points is parked at drawRange 0 — see
     * the comment on sampleGroundZ, which exists for the same reason. So the pivot lands
     * on the terrain while you are looking at a canopy 20 to 90 m above it, and orbiting
     * about a point that far below what you see sweeps the view out from under the
     * cursor. Measured at 18 degrees of pitch: 330 px of slide for a 48 px drag, against
     * 7 px at 70 degrees. It is parallax, and it scales as 1/sin(pitch).
     *
     * On means: the pivot goes on the first drawn dot under the cursor, or stays on the
     * map where the ground shows through a gap (cloud-pick.ts). The canopy lift the two
     * settings below tune is only the fallback for when no drawn cloud is there to pick.
     */
    pivotOnCanopy: true,
    /**
     * Footprint radius for the fallback lift's canopy height sample, in metres. Small
     * enough to follow a clearing edge, large enough that the percentile has support —
     * sampleGroundZ reports how many cells backed the answer.
     */
    pivotSampleRadiusM: 20,
    /**
     * Least steeply the click ray may descend, as a dot product against local up, for the
     * fallback canopy lift to run at all. Below this the pivot stays on the terrain hit.
     * The pick has no such limit: it meets the dot on the ray itself, at any angle.
     *
     * A shallow ray gains height only by travelling: recorded at 4.7 degrees, reaching a
     * canopy 65 m up took 793 m along the ray. The pivot then sat hundreds of metres
     * nearer than the treeline under the cursor, and moved unpredictably because the
     * result scales as 1/descent — a tall tree and a gap in the sample swing it by
     * hundreds of metres. An earlier attempt to contain that by clamping the pivot
     * distance made it worse: the final position became the difference of two large
     * opposing corrections. Declining to lift is the stable answer.
     *
     * 0.25 is about 14.5 degrees. Above it the measured lifts stay between 95 and 262 m.
     */
    pivotMinRayDescent: 0.25,
    /**
     * How far a *substitute* pivot may sit from the camera, as a multiple of the camera's
     * height above the survey floor, with a floor in metres.
     *
     * Only the fallback pivots are bounded by this — the point the scene shows at some
     * place on screen, used when a press cannot be served where it landed (see
     * screenPivot in main.ts). It is also the distance a sky-aimed fallback is placed at.
     *
     * A press's *own* pivot is deliberately not bounded: a rule here once handed a far
     * grab to the view centre, and testing settled against it — the per-frame
     * displacement governor already bounds what a far pivot can do to the camera, and
     * moving the pivot off what the cursor grabbed cost more than it bought.
     *
     * 5x clears the canopy lift's own acceptance bound (height ÷ 0.25 minimum descent =
     * 4x height), so any pivot the lift blesses is inside the limit as well.
     */
    pivotMaxDistanceHeightFactor: 5,
    pivotMaxDistanceMinM: 400,
    /**
     * Floor under the pan re-aim threshold, as a dot product against local up.
     *
     * The threshold itself is the *centre ray's* own descent, so it tracks pitch and fov
     * without tuning: a grab shallower than the middle of the screen is solved at the
     * middle of the screen. This value only takes over when the view is so flat that the
     * centre is ill-conditioned too.
     *
     * GlobeControls pans by intersecting the cursor ray with a sphere through the
     * grabbed point and rotating about the Earth's centre. Near the horizon the ray
     * meets that sphere at a grazing angle and a pixel of cursor motion sweeps an
     * enormous arc. Clamping how far the grabbed point sits from the camera cannot fix
     * it: the sphere's radius is the Earth's, so a few hundred metres changes nothing —
     * measured as "panning very very fast" with the clamp in place. The ray angle is the
     * only thing that bounds the gain, which goes as 1/descent.
     *
     * 0.3 is about 17 degrees, roughly the incidence of a mid-screen grab at working
     * pitch — so a grab near the horizon pans at about the speed the middle of the
     * screen would. The library's own equivalent guard sits at 0.05 (~3 degrees), which
     * still allows a 20x gain.
     */
    panMinRayDescent: 0.3,
    /**
     * How far one drag may pan the world, as a multiple of the camera's height above the
     * ellipsoid, and a floor for that in metres.
     *
     * Net displacement from where the drag started, so dragging out and back costs
     * nothing and only the distance actually covered is bounded. Even a pan re-aimed to
     * the middle of the screen can be pushed a long way by dragging the cursor on toward
     * the horizon — the shift is fixed for the drag, so the re-aimed pointer climbs into
     * the shallow region too. Rather than let the gesture run, it stops at the budget;
     * lifting the button and dragging again continues from there.
     *
     * 10x altitude is 800 m at the 80 m working height and 10 km from 1 km up, so the
     * bound scales with what the view can actually show. Halved from 20x, which let a
     * single drag cover the whole survey.
     */
    maxPanPerDragHeightFactor: 10,
    maxPanPerDragMinM: 250,
    /**
     * How far the controls may move the camera in a single frame, as a multiple of the
     * camera's height above the survey floor. The last line of defence against the
     * fly-away: mouse pan and rotation gains scale with the distance of the grabbed
     * point, and that distance is unbounded — a press near the horizon puts it
     * kilometres out, and one frame of input becomes a huge camera step (recorded:
     * 2,057 m in a single rotation frame at 150 m altitude). Whatever produced the bad
     * pivot, the step itself is what this clamps. Zoom is exempt — its own scaling is
     * already distance-proportional and clamped, and it is the one gesture that
     * legitimately covers ground fast.
     */
    maxFrameMoveHeightFactor: 2,
    /**
     * Floor for that per-frame cap, in metres, so navigation near the treetops —
     * where the height above the floor approaches zero — does not freeze.
     */
    maxFrameMoveMinM: 30,
  },
  keyboard: {
    // Speeds scale with camera range and remain frame-rate independent.
    minimumPanSpeedMps: 35,
    maximumPanSpeedMps: 6_000,
    panRangeFactor: 0.55,
    minimumZoomSpeedMps: 90,
    maximumZoomSpeedMps: 9_000,
    zoomRangeFactor: 0.8,
    responseMs: 110,
  },
  accessibility: {
    // CSS-pixel radius around the viewport centre for keyboard targeting.
    aimTolerancePx: 96,
  },
  markers: {
    // Keep demo hotspots slightly south of the survey centre.
    centreOffsetM: [0, -300],
    minimumSpreadM: 240,
    radialBase: 0.38,
    radialJitter: 0.08,
    outsideMaskOpacity: 0.5,
    maskEdgeFadeM: 90,
    // Where the four CANOPY stations stand, per dataset: the crown top under each, in
    // the survey's raw ENU metres (before the lift). Their x/y come from the seeded
    // layout in marker-layer.ts, so these belong to that layout and that dataset only;
    // a dataset without an entry keeps the old areaMinZ + 48..66 m band.
    //
    // Measured 2026-09-29 from the full-depth APH tiles: the 95th percentile of the
    // point heights within 4 m of each station. The old band put them 17–36 m above
    // these crowns, because areaMinZ is the floor of area-001's box, 4–6 km away.
    // CANOPY 03 stands in a clearing, so its "crown" is the ground there.
    canopyTopZM: {
      'peru-b2-globe': [211.6, 212.2, 193.0, 222.1],
    } as Readonly<Record<string, readonly [number, number, number, number]>>,
    // The FIELD FILM hotspot's crown, measured the same way at its spot (it draws no
    // random value, so the layout does not depend on it). Without an entry: areaMinZ + 58.
    mediaTopZM: {
      'peru-b2-globe': 221.2,
    } as Readonly<Record<string, number>>,
  },
  donationShape: {
    // Outline of the protected parcel. Resolved through BASE_URL so the
    // /livingdashboard/ build finds it; ?shape=<url> overrides it, and an
    // absolute URL is passed through untouched for a future booking API.
    sourcePath: 'gps-test-border.json',
    // Survey cell pitch. Only a starting guess — the real pitch per axis is
    // measured off the boundary, because a nominal 1 m² cell does not stay
    // square once the survey's UTM grid is reprojected into the local plane.
    cellSizeM: 1,
    // Organic form: 0 leaves the staircase alone, 1 rounds with a 1.25 m disc.
    // Rounding corners individually cannot work here — every edge is 1 m, so a
    // fillet is capped at 0.5 m and the staircase survives it.
    smoothness: 0.65,
    sdfPixelM: 0.05,
    defaultStyle: 'wall',
    defaultForm: 'exact',
    // Geometric separation from the ground, since WebGPU has no dependable
    // polygonOffset path.
    footprintLiftM: 0.08,
    // Used until the point-cloud probe reports the real canopy top.
    canopyFallbackM: 74,
    // The column is deliberately NOT tied to the canopy height. A 14 m parcel
    // seen from the navigation floor is a few pixels wide, so the vertical
    // volume is what carries the shape on screen — and a column far taller than
    // the 74 m canopy also stays readable while the ground probe is still
    // settling, or if it never gets enough points at all.
    columnHeightM: 200,
    // The low wall must still clear the crowns, or it is invisible from every
    // useful viewing height. It is sized from the measured canopy plus this
    // clearance and only falls back to the fixed value if nothing was measured.
    wallHeightM: 12,
    wallCanopyClearanceM: 9,
    // Intro-flight framing. The arc ends at the distance where the active
    // style's bounding box fills this fraction of the vertical field of view.
    // Note the hard limit: filling half the screen *width* with a 14 m parcel
    // needs ~18 m of camera distance, which is under the canopy and below the
    // navigation floor — hence the column.
    frameFillFraction: 0.82,
    approachPitchDeg: 18,
    minApproachDistanceM: 45,
    // The arc looks at this fraction up the volume rather than at the ground
    // centroid — aiming at the foot pushes a 200 m column straight out of the
    // top of the frame.
    lookHeightFraction: 0.42,
    // Switching style re-frames the camera. A flat footprint and a 200 m column
    // need very different distances, and without this the flat styles stay a
    // 40 × 12 px smudge at the distance the column was framed for.
    styleRefitDurationMs: 1_400,
    // The flat styles read against a bright canopy only with more fill than the
    // column needs, where the wall already carries the shape.
    flatFillBoost: 1.9,
    rimWidthM: 0.16,
    gridWidthM: 0.035,
    // Floors for the two widths above, in screen pixels. Without these the rim
    // is 0.8 px and the grid 0.17 px at the distance the intro flight ends at.
    rimMinPx: 3.4,
    gridMinPx: 1.3,
    labelLiftM: 4,
    colors: {
      fill: 0xd9f99d,
      fillOpacity: 0.34,
      rim: 0xf4ffd8,
      rimOpacity: 0.92,
      grid: 0xb7dd58,
      gridOpacity: 0.5,
      wall: 0xd9f99d,
      wallBottomOpacity: 0.55,
      wallTopOpacity: 0.0,
      xrayGhostOpacity: 0.3,
      mote: 0xf4ffd8,
    },
    moteCount: 32,
    moteRiseSeconds: 7,
    // Ground probe. Raycasting the cloud is impossible — streaming.ts parks the
    // carrier Points at drawRange 0 — so the height comes from a percentile
    // over the resident tiles' position buffers. A low percentile, never the
    // minimum: one stray point below the terrain would bury the parcel.
    // Wider than the parcel on purpose: at overview density there are only a few
    // dozen points inside a 14 m disc, far under probeMinSamples, and the probe
    // would never return anything. The terrain is flat enough over 60 m that the
    // low percentile is still this parcel's ground.
    probeRadiusM: 60,
    probeIntervalMs: 500,
    probeMinSamples: 400,
    probeMaxSamplesPerTile: 6_000,
    probeGroundPercentile: 0.02,
    probeCanopyPercentile: 0.95,
    probeSupportCells: 6,
    // Sanity band around the manifest floor. The published ENU bboxes are
    // tilted AABBs so they overstate the vertical range, but a probe further
    // out than this is a bad percentile, not terrain.
    probeMaxDeviationM: 400,
    probeSupportBandM: 1.5,
    probeSmoothingMs: 900,
    // The height locks once this many accepted probes agree within the spread
    // below — the median of them wins and is never revised. Anything that keeps
    // following the resident tiles makes the whole parcel bob while the camera
    // moves, because the percentile is taken over whatever happens to be loaded.
    probeLockSamples: 5,
    probeLockSpreadM: 0.5,
    probeTimeoutMs: 45_000,
    // Escape hatch when a site's canopy defeats the probe.
    groundZOverrideM: null as number | null,
  },
  environment: {
    // Peru has no daylight-saving change; the slider still uses the IANA zone.
    timeZone: 'America/Lima',
    // The scene opens on this Peru time. Live time is opt-in: the JETZT button
    // in the time dock switches to it, so the first impression is a fixed,
    // well-lit hour instead of whatever the field site happens to be doing.
    startPeruMinutes: 14 * 60,
    utcOffsetHours: -5,
    updateIntervalMs: 250,
    liveRefreshMs: 30_000,
    minimumSceneLight: 0.30,
    nightSky: 0x09243a,
    dawnSky: 0x769ab2,
    daySky: 0x8bc9ec,
    nightFog: 0x15394c,
    dayFog: 0x8bc9ec,
  },
  clouds: {
    // Cloud offsets are relative to the complete survey centre in local ENU.
    fields: [
      { offsetM: [-4_500, -71_000, 14_000], sizeM: [24_000, 11_000, 3_400] },
      { offsetM: [800, -35_000, 8_400], sizeM: [18_000, 9_000, 2_800] },
      { offsetM: [2_200, -12_000, 4_200], sizeM: [9_500, 5_800, 2_100] },
    ],
    textureSize: 64,
    textureSizeStrong: 96,
    raymarchSteps: 36,
    raymarchStepsStrong: 52,
    // Sun light-march inside the volume: taps toward the sun per density sample.
    lightSteps: 4,
    lightStepBoxFraction: 0.055,
    extinction: 22,
    hgG: 0.55,
    sunBoost: 2.0,
    ambientAmount: 0.85,
    stepAlpha: 0.16,
    coverage: [0.38, 0.62],
    softPuffsPerField: 14,
    windMps: [7.5, 2.2],
    // Sparse, slow, ephemeral clouds hovering directly over the survey so the
    // close zoom levels are not empty. They live only inside the survey radius
    // (outside, distance fog owns the mood) and stay above the flight floor.
    near: {
      count: 5,
      altitudeM: [420, 780],
      sizeXyM: [380, 780],
      sizeZM: [140, 220],
      radiusFraction: 0.8,
      driftMps: 1.5,
      fadeSeconds: 28,
      visibleSeconds: [120, 240],
      gapSeconds: [50, 140],
      maxOpacity: 0.7,
      raymarchSteps: 30,
    },
    closeFadeStartM: 8_000,
    closeFadeEndM: 2_200,
    fadeMs: 720,
    strongMinimumCores: 8,
    strongMinimumMemoryGb: 6,
    volumeFallbackFps: 50,
    disableFps: 45,
    lowFpsDurationMs: 3_000,
    // Recovery path for guard demotions: a single 3 s dip (tile-upload burst
    // after landing, OS compositor hitch) must not park a strong GPU on soft
    // clouds for the whole session. Promote back to volumetric once the frame
    // rate has held above promoteFps for promoteDurationMs; bounded attempts
    // so a genuinely borderline device cannot ping-pong.
    promoteFps: 57,
    promoteDurationMs: 12_000,
    maxPromotions: 2,
  },
  tower: {
    // Field asset offsets: x/y relative to the shifted hotspot centre, z relative to
    // groundZM below.
    //
    // Where the real canopy tower stands, from SBB's PortalCam scan of it
    // (260420_Peru_Tambopata_CanopyTower_…164137, gnss.csv): 3,175 fixes with hdop
    // under 5 cluster within ±4 m around lat −12.873473, lon −69.496417, i.e. raw ENU
    // (1197.7, −2410.2). The scanner was on the platform, so that point is the platform
    // centre; less the platform offset below (19.10, 2.16 m at this yaw and scale) the
    // model's origin lands at (1178.60, −2412.36). Until 2026-10-05 the model stood
    // where it had been placed by hand on 16 Jul, on the river bank 936 m WNW of here.
    positionM: [1_100.961, -2_458.812, -0.2],
    rotationRad: [Math.PI / 2, 0, -1.039],
    scale: 24,
    sensorHeightM: 112.138,
    // Where the platform centre sits in the tower's own horizontal plane, in model
    // units: the GLTF's x and −z, i.e. after the model's quarter turn and before yaw and
    // scale. The model's origin is a corner of its footprint, so without this the
    // TOWER 05 sensor hung over that corner, 19 m off the tower's axis. Read from
    // tower.gltf: the top section spans x 0.007..0.645 and z −1.655..0.192, and the
    // straight lattice puts the base centre in the same place.
    sensorOffsetUnits: [0.3262, 0.7315],
    // The floor the tower stands on, raw ENU metres (before the lift), measured from
    // the full-depth APH tiles under the four legs at the scan position. The forest
    // floor there returns few points through the canopy: the lowest steady returns
    // are 182.6 m under the west leg and 184.9 m under the east one, while the other
    // two only reach the undergrowth (192–195 m). 182.5 keeps every leg on or in the
    // ground rather than lifting any into the air. positionM z −0.2 lands the mesh's
    // lowest vertex (0.18 m above its origin) on this floor.
    groundZM: 182.5,
  },
  boat: {
    // z is relative to groundZM below.
    positionM: [644.068, -1_961.281, 1.43],
    rotationRad: [Math.PI / 2, 0, 0.039],
    scale: 7.046,
    // The water line, raw ENU metres. The river itself returns no lidar points; the
    // lowest returns at its edge beside the hull sit at 156.6 m (the draped imagery
    // under it is near 153.3). positionM z 1.43 puts the flat hull bottom (2.43 m under
    // the model origin) 1 m below this line; the stern gear reaches 1.8 m further.
    // Until 2026-09-29 the keel was at areaMinZ + 5, about 20 m above the water.
    groundZM: 156.6,
  },
  eagleBench: {
    // Loader eagle doubles as a point-rendering benchmark: density follows the
    // load progress, frame times are sampled, and the result picks the start
    // preset. The preset must hold the target frame rate while the scene runs
    // at full Detail p100 in motion, since density is no longer reduced — so
    // the bars sit higher than when the throttle could take points away.
    maxPoints: 2_500_000,
    maxPointsMobile: 900_000,
    targetFps: 60,
    // Highest density bucket that still holds ~target fps, as a fraction of
    // maxPoints: above strongFraction → strong, above mediumFraction → medium.
    strongFraction: 0.95,
    mediumFraction: 0.5,
    // Absolute proof-of-throughput gate for the strong preset: the stress mass
    // is clipped (vertex-only), so passing the mobile max of 900k points says
    // nothing about the fragment-bound real scene. Strong — and with it "no
    // vignette" — requires demonstrated desktop-class throughput.
    strongMinPoints: 2_400_000,
    minSamples: 60,
    pointSizePx: 2,
    /**
     * The primitive the hidden stress mass is drawn as. 'instanced-quad' is what the bars
     * above were tuned on (2026-07-21); 'pulled-triangle' is what the streamed tiles draw
     * by default since 2026-09-29 (lod.dotGeometry), built the same way. It stays on the
     * old one until those bars are re-measured against the new one on devices: pulled
     * triangles cost several times less per point, so switching alone would raise tiers
     * nobody has checked. `?benchstress=pulled|instanced` picks it for a calibration run,
     * and the console logs every stage's frame time at Start (applyBenchPreset).
     */
    stress: 'instanced-quad' as 'instanced-quad' | 'pulled-triangle',
  },
  pointLighting: {
    // Directional daylight cues for the (normal-less) point cloud. All three
    // cloud-shadow values are live in the design panel; strength goes through
    // the environment layer because it rides the daylight ramp there.
    /** Canopy cloud shadows on at startup — part of the look dialled in on 2026-09-29.
     * Off compiles them out of the point shader. The ground patch draws dark shapes
     * too; its mask-debug toggle shows which is which. */
    cloudShadowsEnabled: true,
    /** Base depth of the drifting canopy shadows, before the layer multiplies it
     * by daylight and halves it when the visible clouds are off. At 1 in full
     * daylight a shadow's core takes the canopy all the way to black. */
    cloudShadowStrength: 1,
    /** Metres per period of the shadow noise — the grain size. Smaller means
     * finer, busier dappling; larger means broad continental shadows. */
    cloudShadowScaleM: 2_700,
    /** Tightens the noise-to-shadow ramp around its midpoint. 0 is the original
     * wide 0.32–0.62 window (soft, washed); 1 is a near-binary edge, which reads
     * as hard-edged cloud gaps. */
    cloudShadowContrast: 0.76,
    cloudDeckHeightM: 3_600,
    goldenRimStrength: 0.5,
    warmRim: 0xffb268,
    nightGrade: 0x5f7ea6,
    goldenGradeBoost: 0.45,
  },
  audio: {
    // Browser-ready loops are generated from source-assets via npm run audio:prepare.
    dayFile: 'sounds/ambient-day.m4a',
    nightFile: 'sounds/night-ambient.m4a',
    rainFile: 'sounds/rain.m4a',
    masterVolume: 0.72,
    ambientVolume: 0.52,
    rainVolume: 0.38,
    toggleFadeSeconds: 0.9,
    weatherFadeSeconds: 1.5,
    daylightFadeSeconds: 2.8,
    nightBlendStartDeg: 2,
    nightBlendEndDeg: -8,
  },
  loader: {
    /** How long the loader waits for the first basemap tile after the point cloud
     * is ready, before starting the scene without it. The point cloud is the
     * payload and the basemap only context, so an unreachable tile provider —
     * rejected key, exhausted quota, no network — must not hold the app hostage.
     * Long enough that a slow-but-working provider still wins the race. */
    basemapGraceMs: 12_000,
  },
  atmosphere: {
    /** Distance fog (three's THREE.Fog) on at startup. Off while the level-of-detail
     * work is being judged: fog hides exactly the far-field density the sliders change.
     * The newer `haze` below ships on for the cinematic look; its 400 m clear zone keeps
     * the judged near tiles clear, and its switch takes it out for LOD A/Bs. */
    distanceFogEnabled: false,
    // Bring humid tropical and boreal haze into the mid-distance.
    minimumFarM: 24_000,
    maximumFarM: 650_000,
    fallbackRangeM: 120_000,
    farRangeMultiplier: 5.5,
    // Both are fractions of the current far plane, not metres, so the haze keeps
    // the same proportions at every viewing height — the design panel's
    // Distanz-Nebel card retunes these two. Near at 0 starts the haze right at
    // the camera, which is what carries the milky depth in the dialled-in look.
    fogNearFactor: 0,
    fogFarFactor: 0.42,
    // Per-frame with gentle smoothing: the former 8 Hz far-plane steps made
    // the globe's horizon edge flicker against the sky like z-fighting.
    updateIntervalMs: 0,
    distanceSmoothing: 0.06,
    // Since density is never reduced, weaker devices buy their frames by
    // shortening the view instead: the far plane shrinks and the fog closes in,
    // which culls distant tiles and shrinks the drawn set.
    farScaleByPreset: { strong: 1, medium: 0.72, constrained: 0.5 },
    /**
     * Aerial perspective (atmosphere-haze.ts): distance haze plus a graded sky, the
     * cinematic replacement for the flat sky band and the hard clipped horizon. While the
     * haze is on it takes over from the distance fog above; with both switches off
     * neither node exists and the frame is what it was before.
     */
    haze: {
      enabled: true,
      skyGradient: true,
      /** Metres from the camera before any haze: the near canopy stays clear. */
      startM: 400,
      /** e-folding distance beyond the start: at this distance the haze is ~63 % of
       *  `strength`. 9 km reads as humid rainforest air. */
      distanceM: 9_000,
      /** The most the haze covers before the far-plane wall takes over. */
      strength: 0.85,
      /** How far the horizon colour is pulled from the sky toward the sunlight: pale
       *  at noon, warm at golden hour. */
      horizonBlend: 0.55,
      /** Elevation (sine of the angle above the horizon) at which the sky reaches its
       *  zenith colour. 0.45 ≈ 27°. */
      zenithElevation: 0.45,
    },
  },
  /**
   * The physically based sky (sky-atmosphere.ts): Hillaire's atmosphere in four small lookup
   * tables, the sun disc drawn at full resolution, aerial perspective in place of the haze
   * curve, and the light the sun and sky cast on the scene. Off is the graded sky and haze of
   * atmosphere-haze.ts, the shaders as they were. `?sky=0|1` boots it off or on.
   */
  sky: {
    enabled: true,
    /** The air (atmosphere-model.ts). Aerosol optical depth 0.25 over a 1.6 km layer is the
     *  humid haze of the Amazon lowlands outside the fire season. */
    atmosphere: {
      aerosolDepth: 0.22,
      aerosolHeightKm: 1.6,
      aerosolAlbedo: 0.95,
      aerosolG: 0.72,
      angstrom: 1,
      rayleighScale: 1,
      ozoneScale: 0.88,
      groundAlbedo: [0.09, 0.13, 0.07] as [number, number, number],
    },
    /** Exposure on top of the physical anchor (a white surface under a clear 60° sun shows as
     *  1), and how far dim scenes are lifted toward it: 0 none, 1 all the way. */
    exposure: 1,
    adaptation: 0.6,
    adaptationMax: 4,
    /** The share of the clouds' darkening the exposure adapts to (0 = time of day only). */
    weatherAdaptation: 0.3,
    /** The sun disc: intensity, size against the real 0.53°, edge width in pixels, limb
     *  darkening, and an artistic glow on top of the haze's own halo. */
    sunIntensity: 1,
    sunSize: 1.6,
    sunSharpnessPx: 1.5,
    sunLimbDarkening: 0.85,
    sunGlow: 0.02,
    sunGlowSize: 0.3,
    sunTint: 0xffffff,
    /** Ceiling on the disc's displayed radiance (the frame is half float). */
    sunMaxRadiance: 60,
    /** The night sky's floor, linear. */
    nightSky: 0x02060c,
    /** Aerial perspective: the clear distance around the camera, and a multiplier on the
     *  air's optical depth (1 is the atmosphere above). */
    aerialStartM: 150,
    aerialDensity: 1,
    /** White balance to the noon sun (1), as a camera on daylight; 0 keeps the sun at the top
     *  of the air white. And an artistic multiplier on the sky's own radiance. */
    whiteBalance: 1,
    skyBrightness: 1.35,
    /** Under a full overcast the haze keeps this share of the clear sky's glow. */
    overcastGlow: 0.3,
    /**
     * The aerial perspective from a camera volume (sky-atmosphere.ts) instead of per pixel:
     * 32 × 32 froxels × 32 slices, drawn when the view moves. It reaches the far plane or
     * `horizonFactor` × the horizon distance, at least `minRangeM`. From a camera between
     * `anchorFromM` and `anchorToM` up the basemap hands over to the exact ground lookup; above
     * `fineAboveM` every slice takes substeps; the sun has to move `sunThresholdRad` to redraw.
     * `?apvol=0|1`.
     */
    aerialVolume: {
      enabled: true,
      horizonFactor: 1.1,
      minRangeM: 32_000,
      anchorFromM: 1000,
      anchorToM: 2000,
      fineAboveM: 1000,
      sunThresholdRad: 1e-5,
    },
    /**
     * The sun and sky as light on the point cloud and the basemap (point-cloud.ts sunLight):
     * the captured colours relit by the atmosphere's sun and sky instead of the daylight
     * grade. `sunIntensity` / `skyIntensity` scale the two; `sideLight` is how much of the sun
     * a normal-less point catches beyond flat ground (crowns are round); the tint colours the
     * sunlight. Night keeps the old floor: `nightLevel` × the night grade.
     */
    sunLight: {
      enabled: true,
      sunIntensity: 1,
      skyIntensity: 1,
      sideLight: 0.5,
      tint: 0xffffff,
      nightLevel: 0.3,
    },
  },
  /**
   * Soft sun shadows of the canopy (sun-shadows.ts): an additive optical-depth map of the
   * points seen from the sun, fitted to the sphere-fade dome, blurred in metres, read by the
   * points, the basemap and the volumetric fog. Needs the physical sky's sun light. `?shadows=0|1`.
   */
  sunShadows: {
    enabled: true,
    /** Texels per side; the dome-fitted map covers 1–6 km, so 1024 gives 1–6 m texels, plenty
     *  for soft blobs (each map is 1024² RGBA16F, ~11 MB with mips). */
    resolution: 1024,
    /** 1 or 2: an inner map over the dome's middle (`cascadeSplit` of the extent) for close-ups. */
    cascades: 1,
    cascadeSplit: 0.35,
    /** Optical depth one fully covered layer of points adds straight up. A rainforest canopy
     *  lets 5–10 % of the sun through (LAI ≈ 5, k ≈ 0.5); a few layers of 1 get there. */
    density: 1.4,
    strength: 1,
    /** Blur, metres (one standard deviation). Soft blobs, not crisp leaves. */
    softnessM: 1.5,
    /** Share of each tile's points drawn into the map; the rest is made up by the weight. */
    pointFraction: 0.2,
    splatScale: 0.7,
    minSplatTexels: 1.25,
    /** A point lifts itself this far toward the sun before it looks up its shadow. */
    selfOffsetM: 3,
    /** Floor on the occluders' height spread in one texel, metres. */
    minSpreadM: 1.5,
    /** Redraw the map at most every this many frames; never while nothing moved. */
    updateEvery: 2,
    /** The shadows fade in as the sun climbs from 2° to 8°. */
    fadeStartDeg: 2,
    fadeEndDeg: 8,
    /** Volumetric shadows in the fog's march: on, optical-depth multiplier and mip bias. */
    fog: true,
    fogStrength: 1,
    fogLodBias: 1,
  },
  /**
   * Clouds on the sky dome (sky-clouds.ts): one cloud field baked into a panorama from the
   * survey's centre — volumetric light transport, infinitely far geometry — and its shadows on
   * the ground, the points and inside the fog. Needs the physical sky. `?clouds=0|1|<preset>`.
   * Lengths in km.
   */
  skyClouds: {
    enabled: true,
    preset: 'fair',
    /** The clouds' shadows on the points and the basemap, and in the fog's march. */
    cloudShadows: true,
    fogCloudShadows: true,
    /** Panorama size (azimuth × elevation, rows packed toward the horizon), steps per ray, and
     *  the frames one bake is spread over. */
    bakeWidth: 2048,
    bakeHeight: 768,
    bakeSteps: 64,
    bakeFrames: 48,
    /** Seconds a new bake cross-fades over the old one. */
    fadeSeconds: 1.2,
    sunLight: 1,
    ambient: 1,
    multipleScattering: 3,
    powder: 0.4,
    /** Deep multiple scattering (two-stream diffusion): its strength against the octaves'
     *  phases, both normalised to 1 / 4π (2.2 is the look tuned when it was 4× that, at 0.55),
     *  and how fast it fades with the optical depth toward the sun. */
    diffuse: 2.2,
    /** The fall-off 2 / (2 + kτ) of the diffuse light inward: (1 − g) of the droplets is 0.15;
     *  a little steeper keeps fair-weather cumulus their grey bases. */
    diffusePenetration: 0.3,
    /** How strongly the cloud above a point hides the sky light from it: dark storm cores. */
    ambientOcclusion: 0.08,
    /** Share of the air's optical depth the clouds are hazed with: below 1 distant towers
     *  keep standing over the haze. */
    haze: 0.65,
    /** Cloud shadows: optical-depth multiplier (thick clouds are opaque; below 1 lets the
     *  diffuse light through) and the mip bias that softens them. */
    shadowStrength: 0.6,
    shadowSoftness: 1.5,
    weatherSize: 256,
    shapeSize: 64,
    /** Longest slant a ray marches through the layer, km: farther the haze hides it. */
    maxSlabKm: 40,
    rainDensityPerKm: 1.2,
    shadowSize: 512,
    shadowHalfExtentM: 16_000,
    /** The cloud-shadow map's march toward the sun: one step per this many km of the slant
     *  through the layer, at least 24, at most `shadowMaxSteps` (a 10° sun crosses 12 km of a
     *  2 km layer). Drawn once per bake. */
    shadowStepKm: 0.1,
    shadowMaxSteps: 96,
    /** Weather situations. Each carries its own haze (aerosol optical depth). */
    presets: {
      clear: {
        coverage: 0.04, cells: 0.6, type: 0.5, typeVariation: 0.3, baseKm: 1.2, thicknessKm: 1.5,
        densityPerKm: 25, erosion: 0.6, shapeScaleKm: 3, weatherScaleKm: 50, absorption: 0,
        precipitation: 0, anvil: 0, highCoverage: 0.25, highAltitudeKm: 9, highDepth: 0.15,
        offsetKm: [0, 0] as [number, number], aerosolDepth: 0.15,
      },
      fair: {
        coverage: 0.32, cells: 0.75, type: 0.5, typeVariation: 0.35, baseKm: 1.1, thicknessKm: 2.2,
        densityPerKm: 35, erosion: 0.55, shapeScaleKm: 2.6, weatherScaleKm: 40, absorption: 0.02,
        precipitation: 0, anvil: 0, highCoverage: 0.15, highAltitudeKm: 8, highDepth: 0.1,
        offsetKm: [3, 5] as [number, number], aerosolDepth: 0.2,
      },
      scattered: {
        coverage: 0.55, cells: 0.65, type: 0.6, typeVariation: 0.4, baseKm: 1, thicknessKm: 3.2,
        densityPerKm: 40, erosion: 0.5, shapeScaleKm: 3, weatherScaleKm: 45, absorption: 0.05,
        precipitation: 0.15, anvil: 0.1, highCoverage: 0.3, highAltitudeKm: 7, highDepth: 0.2,
        offsetKm: [11, -4] as [number, number], aerosolDepth: 0.25,
      },
      /** Low sun, scattered cumulus under a sheet of altocumulus (the RDR2 reference). */
      golden: {
        coverage: 0.38, cells: 0.7, type: 0.5, typeVariation: 0.35, baseKm: 1.2, thicknessKm: 2.4,
        densityPerKm: 32, erosion: 0.6, shapeScaleKm: 2.8, weatherScaleKm: 40, absorption: 0,
        precipitation: 0, anvil: 0, highCoverage: 0.55, highAltitudeKm: 4.5, highDepth: 0.35,
        offsetKm: [-7, 9] as [number, number], aerosolDepth: 0.18,
      },
      /** Low, misty stratus over the cloud forest (the second reference). */
      mist: {
        coverage: 0.95, cells: 0.2, type: 0.1, typeVariation: 0.15, baseKm: 0.35, thicknessKm: 2.4,
        densityPerKm: 30, erosion: 0.75, shapeScaleKm: 1.8, weatherScaleKm: 30, absorption: 0.12,
        precipitation: 0.1, anvil: 0, highCoverage: 0.6, highAltitudeKm: 3.5, highDepth: 0.8,
        offsetKm: [2, 2] as [number, number], aerosolDepth: 0.45,
      },
      /** Heavy grey overcast with rain shafts (the rainy river reference). */
      overcast: {
        coverage: 0.92, cells: 0.35, type: 0.3, typeVariation: 0.3, baseKm: 0.7, thicknessKm: 2.5,
        densityPerKm: 40, erosion: 0.5, shapeScaleKm: 3.5, weatherScaleKm: 50, absorption: 0.12,
        precipitation: 0.6, anvil: 0, highCoverage: 0.7, highAltitudeKm: 5, highDepth: 1,
        offsetKm: [-3, -8] as [number, number], aerosolDepth: 0.4,
      },
      /** Towering cells with anvils, dark bases and rain (the mountain storm reference). */
      storm: {
        coverage: 0.6, cells: 0.95, type: 0.8, typeVariation: 0.4, baseKm: 0.9, thicknessKm: 9,
        densityPerKm: 70, erosion: 0.4, shapeScaleKm: 4.5, weatherScaleKm: 60, absorption: 0.4,
        precipitation: 0.9, anvil: 1, highCoverage: 0.75, highAltitudeKm: 10, highDepth: 2.5,
        offsetKm: [6, -12] as [number, number], aerosolDepth: 0.35,
      },
    },
  },
  // Look grading exposed live by the DESIGN section of the panel. These are the
  // shipped defaults; the sliders write the same uniforms, so anything dialled in
  // here can be pasted back as a new default.
  design: {
    /** Mask mode the scene starts in: 0 = off, 2 = viewport vignette. Off by
     * default — the vignette is a look decision, not a performance lever, so the
     * loader benchmark no longer switches it on for weaker presets either. Set
     * this to 2 to restore the old behaviour of masking on medium/constrained. */
    maskMode: 0,
    /**
     * Flat ground under the point cloud: where the cloud has data the satellite
     * imagery is replaced by a solid colour, so the map is only visible where it
     * does not.
     *
     * Replacing, not hiding. The draped imagery is the only surface the globe has
     * there, so cutting it out would leave a hole with the sky showing through —
     * which is why this is a colour and not a switch to nothing.
     *
     * The shape comes from a rasterised coverage mask, not the survey bbox. The
     * bbox seemed like a fair stand-in and is not: this dataset spans 12.8 x 8.5 km
     * but fills it with 27 irregular cells, so a rectangle paints flat colour over
     * large empty areas. See ground-patch-mask.ts.
     *
     * Fog and the vignette still apply on top, so the patch sits in the same
     * atmosphere as the rest of the scene. Daylight grading deliberately does not:
     * the chosen colour stays the chosen colour around the clock.
     */
    groundPatch: {
      enabled: true,
      /** How much of the patch is applied at all. 1 = fully. */
      amount: 1,
      /** 0 = the basemap at `brightness` below, 1 = the flat `color`. Anything
       * between blends the two, so one control covers both requests: dim the map
       * only there, or replace it outright. */
      colorMix: 1,
      /** Brightness of the imagery inside the patch, relative to the map's own level: the
       * raw tile while design.colourMatch is off, the matched map while it is on. Independent
       * of mapBrightness/mapSaturation, fog and the vignette — the point being to see exactly
       * this, not this plus fog. */
      brightness: 0.3,
      /** Flat colour for colorMix 1. Dark by default: the cloud reads against it. */
      color: 0x0a1410,
      /**
       * Radius in metres the coverage is averaged over before the threshold cuts it.
       *
       * Blur and threshold are the two primitives the old shrink/fade pair was dressed
       * up as — that version derived the sampling radius from one control and the cut
       * level from the other, which coupled them, put a ceiling on the fade, and cost
       * two rounds of bugs. These two are independent.
       *
       * Bigger blurs smooth the outline and let the threshold move the edge further,
       * but a disc wider than a gap cannot see the gap: measured, a 240 m radius closed
       * the patch back over a ~100 m river. Keep it well under the narrowest feature
       * worth preserving — 40 m is comfortably clear of that here.
       */
      blurM: 40,
      /**
       * Cut level on the blurred coverage. 0.5 sits on the outline; above it the edge
       * erodes inward, below it dilates outward.
       *
       * 0.65 with a 40 m blur is a gentle erosion — enough to take the fringe off the
       * banks without eating into the footprint, now that the cloud is lifted clear of
       * the imagery and the patch no longer has to compensate for hidden points.
       */
      threshold: 0.65,
      /**
       * How deep to walk each cell's node hierarchy when bounding the mask. Only
       * the rectangle comes from the boxes — coverage comes from the points, which
       * are the only source fine enough for the river. The measured subtree bottoms
       * out at depth 7, so anything past that costs nothing and changes nothing.
       */
      maskMaxDepth: 16,
      /**
       * Pixels per mask cell edge. One cell costs cellPx^2 bytes — 512 is 256 kB —
       * and is also the unit that gets re-uploaded when coverage changes, which is
       * the expensive part. Smaller cells mean cheaper uploads and less waste around
       * the footprint's diagonal edge, at the cost of more index lookups.
       */
      maskCellPx: 512,
      /**
       * Ground resolution of the mask, held constant however large the surveyed area
       * grows — that independence is the whole point of tiling it. 5 m keeps the
       * river open: it runs about 30 m wide, so roughly 6 pixels across.
       *
       * The single-texture version had this as a consequence rather than a setting,
       * and it drifted with the extent: 6.9 x 4.6 m for Peru, and it would have gone
       * past the ~12 m where the river disappears as soon as more area was added.
       */
      maskMetresPerPixel: 5,
      /**
       * Cells that may hold data at once. The GPU texture is allocated at
       * maskCellPx^2 x this, so 512px x 32 is 8 MB. Cells are handed out only where
       * points actually land, and the Peru footprint is a diagonal strip, so it needs
       * far fewer than its bounding box suggests: its area boxes touch 18 cells (24 by
       * the survey box, 30 with the 200 m stray tolerance); Usk, Manu and Pantiacolla
       * need 4-8. `__wild.mask.stats().cellsUsed` shows the live count, and the console
       * warns once rather than failing if the budget runs out.
       */
      maskMaxCells: 32,
      /**
       * Edge length of the cell index map, and so the largest lattice addressable:
       * 64 cells is 164 km at the default cell size. Fixed at startup and never
       * resized, because the basemap materials bind the texture object. Costs
       * maskIndexSize^2 bytes.
       */
      maskIndexSize: 64,
      /**
       * Pixels each splatted point is grown by. Zero, and that matters more than it
       * looks.
       *
       * At 1 a single point marked 3x3 pixels — 225 m2 of "there is data here" from one
       * return. Over water that is badly wrong: the river and its gravel bars give
       * scattered returns off the surface, wet sand and driftwood, and a handful of
       * those made the whole area read as solid coverage. The patch then sat over the
       * river as an unbroken block while the point cloud drew almost nothing there.
       * That asymmetry — mask says full, render says empty — was the visible bug.
       *
       * The growth was there to fill Poisson gaps in the overview LOD's sampling, and
       * it is not needed for that any more: the shader averages coverage over a disc,
       * which fills those gaps itself.
       *
       * Measured cost, sampling full discs deep inside the footprint: the covered
       * fraction has a median of 0.98, a 5th percentile of 0.83, and 2-3% of interior
       * spots fall below the ramp and lose the patch. An acceptable place to pay it —
       * the interior patch sits under the canopy where thin spots barely show, while
       * the water is open to view. Set back to 1 if the interior has to be airtight
       * and the river does not matter.
       */
      maskSplatRadiusPx: 0,
      /**
       * Points splatted per frame — the cap on how much the mask can ever cost in
       * one frame. Measured at roughly 50 ns per point, so this is about 1 ms; the
       * ~3 M point overview then takes a couple of seconds of load to fill in, which
       * is invisible because the cloud covers that ground anyway.
       */
      maskPointsPerFrame: 20_000,
      /**
       * Shortest gap between mask uploads while coverage is still arriving. Each
       * upload sends only the cells that changed, 256 kB apiece, but a burst of tiles
       * usually touches the same few, so batching still pays. The final upload is
       * never delayed.
       */
      maskUploadIntervalMs: 400,
    },
    /** 1 = raw satellite colour, 0 = fully grey. While design.colourMatch is on the map is
     * matched at the field's basemapSaturation (0.6 for peru-b2-globe) across the whole globe,
     * and this multiplies on top of it. */
    mapSaturation: 1,
    /** Multiplies the basemap only — the point cloud keeps its own grading.
     * Pushed above 1 so the map reads as daylight ground where it shows through: the
     * river and the survey gaps are the whole point of the ground patch, and at the
     * old 0.1 they sat as near-black holes rather than as water and sand.
     * Rechecked under the `shoulder` tone curve: forest, river and sand render exactly
     * as before. At the default white point 1 everything up to full white does; only
     * sandbars and bright roofs (raw sRGB 220+ in full daylight) go past 1 and are scaled
     * down with their hue kept rather than clipped per channel, so 1.4 stays. With a
     * higher white point they roll off instead, from raw sRGB 199 up. The panel slider
     * runs to 2 for that case.
     *
     * Those thresholds hold with design.colourMatch off. With it on, the map's gain is
     * basemapGain × mapBrightness / colourMatch.referenceBrightness, per zoom: for
     * peru-b2-globe at 1.4 that is 5.0 / 4.7 / 3.4 at z15 and about 6.2 / 5.5 / 3.9 at
     * z16-19, so the knee is reached from about raw sRGB 110-125 in red. */
    mapBrightness: 1.4,
    /**
     * Point-cloud grade, applied to the decoded linear colour before daylight, shadow and
     * fog, so the look holds at every time of day. Contrast is a power curve on luma
     * around 0.18 linear (sRGB 118) with hue kept: most of the canopy sits below that
     * pivot, so contrast above 1 mostly deepens it. 1 = the captured colour. The panel
     * slider spans 0.5–1.5 and clamps a config value outside it at boot.
     */
    pointContrast: 1,
    /** 1 = captured saturation, 0 = grey, above 1 = more vivid. Panel range 0–2. */
    pointSaturation: 1,
    /** Off compiles the point grade out of the tile shaders whatever the sliders say. */
    pointGradeEnabled: true,
    /**
     * Colour match: the point cloud and the basemap share one colour at landscape scale.
     *
     * The survey was flown on several days under different skies, so its colour comes in
     * blocks with straight edges, brighter, bluer or greener than their neighbours —
     * 1.05 stops of drift measured over peru-b2-globe, with almost nothing in common with
     * the landscape (r = -0.10 against the satellite). `pipeline/build_colour_field.py`
     * turns that into a gain texture: the cloud-minus-satellite difference, smoothed with a
     * masked median over a 120 m disc, so the correction follows the block borders instead of
     * leaving a halo at them, and clearings the satellite shows as bare ground but the drone
     * saw green are not copied onto the cloud. Each point keeps its own texture; the
     * landscape-scale mismatch against the matched map falls from 0.21 to 0.04 stops (median)
     * in the builder's own measure. The same run gives the basemap its lift to the cloud's
     * level — per channel, per zoom (MapTiler's satellite changes colour between levels), and
     * at 60 % saturation so that bare soil does not turn orange; mapBrightness trims around it.
     *
     * Costs one bilinear lookup per point fragment into an 802×533 RGBA8 texture (1.7 MB on the
     * GPU, a 0.2 MB PNG download); its GPU time is measured in the Canopy Colour Matching
     * artifact. Off compiles it out of the tile shaders and puts the basemap back on
     * mapBrightness/mapSaturation alone. Cloud shadows and the golden-hour rim still act on the
     * points only.
     */
    colourMatch: {
      enabled: true,
      /** 0 = captured colour and today's basemap level, 1 = the full match. Blended in log light. */
      strength: 1,
      /** The mapBrightness the match is measured against. The field's basemapGain already
       * contains the map's level, so the map draws at basemapGain × mapBrightness / this:
       * mapBrightness (the config value, the slider, a Copy-values paste) stays a trim
       * around the match. Fixed, so that pasting a new mapBrightness cannot cancel it. */
      referenceBrightness: 1.4,
      /** Built per dataset into public/colour-field/; a dataset without one is left as captured. */
      fieldDir: 'colour-field/',
    },
    /**
     * The drone orthophoto (MapTiler custom tilesets from the wi-map prototype; secretForest
     * is served down to z20, about 15 cm a pixel here), painted into the satellite's own
     * tiles where it covers them — see ortho-composite.ts and ortho-upgrade.ts. Every tile
     * loads as plain satellite, so the basemap gets sharp as fast as with the ortho off; a
     * covered tile that has settled on screen is then upgraded in its own texture. It adds no
     * mesh, texture, draw call or shader code; it costs downloads, worker time and one in-place
     * upload per upgraded tile, which is what the zoom, density, link and settle gates below
     * limit. The ortho
     * tiles are lossless WebP of ~100-120 KB each, against 54 KB at z15 down to 14 KB at z19
     * for a satellite tile, so a covered tile downloads about 2x (z15) to 8x (z19) the
     * satellite's bytes at 'half' and about 9x to 30x at 'full'; over a landing view, mostly
     * z18-19 tiles, that is 6-8x and 22-30x. Colour-matched offline into the raw satellite's colour
     * (build_colour_field.py --ortho), so the colour match, fog and ground patch treat it as
     * satellite. Inside the dome the ground patch covers it where the cloud is; it shows in
     * the river and the gaps there, and everywhere beyond the dome, where the points have
     * melted away. It sits within about 3 m of the point cloud (the satellite: about 6 m).
     * The small plots (ireneJohn, danilo, cacao) are left out: their z21/22 detail cannot
     * show below basemapMaxZoom 19, and their hard 1-bit edges inside secretForest would be
     * seams.
     */
    droneOrtho: {
      enabled: true,
      /** Lowest satellite zoom the ortho goes into. z15 tiles are 1.2 km wide: far views
       *  keep the satellite, which the ortho is matched to anyway. */
      minZoom: 15,
      /** Per bench preset: 'full' = the four ortho tiles one zoom down per satellite tile (its
       *  full 512 px), 'half' = the one at the same zoom (256 px drawn up), 'off' = none.
       *  Decided before the ortho starts, so 'off' never runs the worker. The link caps it
       *  further where the browser reports one: Save-Data or 2g turns it off, 3g or a
       *  downlink under fullMinDownlinkMbps keeps 'full' at 'half'. */
      presets: { strong: 'full', medium: 'half', constrained: 'off' },
      /** A density that overrides the preset and the link, so the ortho can be seen on any
       *  device. null = follow them. The panel's Half and Full set it; ?ortho=half|full too. */
      force: null as null | 'half' | 'full',
      /** Chromium reports at most 10, so 10 means "the fastest it will say". */
      fullMinDownlinkMbps: 10,
      /** Per ortho request, from its turn, body included. A child that times out leaves its
       *  quadrant to the satellite for as long as the tile stays loaded; at 8 s, 8 of ~180 did
       *  through the dev proxy (six HTTP/1.1 sockets, a TLS connect per tile) at 'full'. */
      fetchTimeoutMs: 20000,
      composeTimeoutMs: 5000,
      /** Upgrades in flight at once; bounds the worker's scratch (~6 MB each) and the finished
       *  bitmaps waiting for their frame. */
      maxConcurrentComposes: 4,
      /** Ortho requests in flight once the basemap and the point stream are idle. One request
       *  takes ~70-250 ms, so the count, not the network, set the pace: measured 2026-10-07
       *  through the dev proxy, the tower hotspot's 14 tiles (56 requests at 'full') were all
       *  upgraded 16.8 s after the click at 2 requests and 2 upgrades, 9.3 s at 8 and 4. In dev
       *  all 8 can hold the proxy's six HTTP/1.1 sockets when a move starts; a tile that leaves
       *  the view aborts its requests, and the rest are done within a few hundred ms. */
      maxOrthoRequests: 8,
      /** Ortho requests in flight while the basemap or the point stream loads, so the ortho's
       *  downloads overlap theirs instead of waiting 2-5 s for them, and keep 4 of the dev proxy's
       *  6 sockets free for the satellite. 0 holds them back until both are idle. */
      busyOrthoRequests: 2,
      /** How long a covered tile must be the view's own detail on screen while the view moves
       *  before its ortho is fetched: intermediate zooms of a descent never are. In a view that
       *  has stood still for 300 ms a settled tile is fetched at once. Also how long the view
       *  must stand still before a composite goes in. A tile evicted and loaded again composes
       *  again, but its ortho tiles then come from the browser's HTTP cache (measured: 51 of 52
       *  repeats, no MapTiler request). */
      settleMs: 1000,
      /** A composite that has waited this long for a still view goes in at the next frame without
       *  a tile arrival anyway: one ~1 ms upload (0.7 ms median, 2.3 ms max measured). */
      maxSwapHoldMs: 3000,
      /** 401/403 answers after which a source is switched off for the session. */
      forbiddenLimit: 3,
    },
    /**
     * Screen-space error budget for the basemap, in pixels: the renderer keeps
     * refining imagery until a tile's projected error drops below this. 1 is what
     * the XYZ plugin's `useRecommendedSettings` picks — effectively pixel-perfect,
     * and the reason a single view needs so many tiles. Imagery is a quadtree, so
     * each halving costs another level; measured on one view: 23 visible tiles at
     * 1, 16 at 2, 9 at 4, 5 at 8. For scale, the point cloud itself runs at 8.
     *
     * Raise it to cut tile requests, but do so by eye. Earlier "extremely blurry
     * basemap" reports came from a different cause — tiles arriving too slowly and
     * a cache too small to hold the working set, fixed with more parallel
     * downloads and a bigger LRU. This value trades sharpness away permanently
     * rather than transiently, which at mapBrightness 0.1 under fog and
     * depth-of-field may well be invisible.
     */
    basemapErrorTarget: 1,
    /**
     * Deepest imagery zoom level to request. 19 matches the plugin's own default
     * (levels 20, maxLevel = levels - 1), so this value changes nothing — it
     * exists to hold the measurement below, because the obvious optimisation here
     * is a trap.
     *
     * MapTiler's satellite coverage for this part of the Amazon carries real
     * ground detail to about z16-z17 (~1-2 m per pixel). Beyond that it is
     * upscaled: down one tile column at the survey location, JPEG size falls once
     * interpolation starts — 52 kB at z16, then 33, 22, 15, 8.6 kB at z20. So
     * z18/z19 add no information, and at the 80 m zoom stop 68 of 127 requests go
     * to exactly those levels. Capping at 17 cuts them to ~12.
     *
     * That was tried and reverted, because "no new information" is not the same
     * as "looks the same". MapTiler's server-side resampling beats magnifying a
     * z17 texture on the GPU. Same ground patch, mean |Laplacian| as a detail
     * measure: 0.856 for z17 upscaled 4x, 1.405 for z19 as served — same content
     * (mean luminance differs by 1.94/255), visibly crisper. The canvas upscale
     * used for that measurement is sharper than GPU texture filtering, so in the
     * app the gap is if anything wider.
     *
     * So: lowering this saves requests at a real cost in sharpness. Only do it if
     * someone decides that trade is worth it, and expect a softer basemap. Raising
     * it past 19 only helps once better imagery exists — a drone or aerial
     * orthophoto of the survey area would be the obvious upgrade.
     *
     * Either way it cannot make the basemap sharp at close range: at 80 m
     * altitude a display pixel is ~0.1 m of ground, so 1-2 m source imagery stays
     * 10-20x coarser than the screen no matter what is configured here.
     */
    basemapMaxZoom: 19,
    /** Stochastic dissolve band at the vignette edge, as a fraction of the mask
     * radius. 0 reproduces the old hard circular cut. */
    maskFringe: 0.35,
    /** Exponent on the fringe keep-probability across the band. 1 is the linear
     * smoothstep ramp; >1 thins points out early (sparse, wide scatter), <1 holds
     * density until near the radius (tight, abrupt scatter). */
    maskFringeCurve: 1,
    /** Colour the surround takes: drives both the CSS overlay ring and the
     * in-shader tint, so the overlay and the geometry agree. */
    surroundColor: 0x02040a,
    /** Strength of the CSS overlay ring (screen-space gradient). */
    surroundOpacity: 1,
    /** How far the points and imagery themselves take surroundColor outside the
     * mask. 0 keeps the original fade-to-black. */
    surroundTint: 0,
    /** Where the vignette anchors as camera pitch changes. Looking down
     * (top-down), it stays the screen-centre ground hit — already centred.
     * Looking across the canopy (side view), that same raycast can swing
     * kilometres per degree of pitch, so it blends toward a point pinned to
     * the camera itself: the near field is always "inside" the mask, and only
     * the far field fades — through the distance haze (and groundFog when it is switched
     * on), not a hard mask edge. */
    vignettePosition: {
      /** Pitch (degrees below horizontal) at and below which the mask is
       * fully in side-view mode. */
      sideAngleDeg: 20,
      /** Pitch at and above which the mask is fully in top-down mode; the
       * anchor blends linearly-smoothed between this and sideAngleDeg. */
      topAngleDeg: 65,
      /** Metres ahead of the camera, along its horizontal look direction,
       * the side-view anchor sits. 0 pins it directly on the camera. */
      sideForwardOffsetM: 0,
      /** Floor on the mask radius while in side view, so being extremely
       * close to the canopy never shrinks the radius below arm's reach. */
      sideMinRadiusM: 150,
      /** Cap on vignetteStrength while fully in side view. Below the shader's
       * 0.95 discard threshold, side-view points are only dimmed/tinted toward
       * the surround and the far field is left to the haze (and groundFog). At 1 the threshold
       * is reached again, so the stochastic fringe discard is back in side view
       * too — which is what the dialled-in look uses. */
      sideMaxVignetteStrength: 1,
    },
    // Analytic exponential height fog: no raymarch, no extra pass, no texture —
    // a handful of ALU ops folded into the existing point and imagery colour
    // nodes. Nothing animates, so there is nothing to sample per frame.
    // The look dialled in on 2026-09-29 is a low warm mist rather than the wide
    // neutral slab this started as: it peaks 15 m above the area floor, below most
    // of the crowns, so it lies in the gaps and on low ground and leaves the crown
    // tops nearly clear. Note how the values work together: a very short density
    // distance (25 m) would normally fog the near field solid, but curve 4 pushes
    // almost all of that density out into the distance, and the 45 m lower fade
    // ends the band 30 m under the floor. Pinned to a warm cream instead of
    // following the daylight ramp, so it stays cream at night too.
    groundFog: {
      /** The analytic ground mist at startup; off since the volumetric fog carries the mist.
       * Off compiles it out of the point and imagery shaders; the panel switch brings it
       * back for A/Bs. */
      enabled: false,
      /** Final multiplier, so 0 is reliably off regardless of the other values.
       * The panel allows up to 3; the resulting coverage is clamped to 1, so past
       * 100% the fog saturates earlier rather than overshooting its colour. */
      strength: 1,
      /** Fog floor relative to the default area's bbox floor (not the terrain: the
       * river bend dips below it). Also the height the
       * band peaks at, since density decays upward from here and fadeBelowM
       * fades it out downward. */
      baseOffsetM: 15,
      /** e-folding height of the slab: density falls to 1/e at this height. */
      heightM: 10,
      /** Metres below the base over which the fog fades out downward. 0 is the
       * original one-sided slab that extends to the ground at full density; any
       * positive value turns it into a band with clear air underneath. Together
       * with heightM this sets the band's total thickness: roughly fadeBelowM below
       * the base, ~2x heightM above it — about 65 m here, a softer underside than
       * top. */
      fadeBelowM: 45,
      /** e-folding distance for a ray travelling along the fog base — smaller
       * values thicken the fog. Not a cutoff: opacity approaches 1 asymptotically.
       * Only this low because curve below banks the density into the distance. */
      efoldDistanceM: 25,
      /** Exponent shaping the accumulated opacity ramp. 1 is the physical
       * Beer-Lambert curve; >1 holds the near field clear and banks the density
       * into the distance, <1 brings fog on fast and flattens out early.
       * Applied to the integrated result, so the layering stays correct. */
      curve: 4,
      /** Custom fog colour, blended over the daylight-driven fog colour by
       * `tint` — 0 keeps the automatic day/night ramp, 1 pins this colour. */
      color: 0xfff2e0,
      tint: 1,
    },
  },
  // The output curve between the linear working colour and the sRGB canvas. It runs in
  // the output pass r185 already does for the sRGB encode, so it adds no pass — and it
  // sees the whole frame, sky and clouds included (see tone-mapping.ts).
  toneMapping: {
    /**
     * Master switch for the whole stage. Off removes it as if it had never been added —
     * no curve, no point grade, and the old pow(2.2) decode. With design.colourMatch off as
     * well (`?tonemap=off&colourmatch=off`) the shader is the one sbb-main ran and an fps A/B
     * against it is fair; the match corrects the capture and keeps its own switch.
     * `?tonemap=off` boots with the stage off.
     */
    enabled: true,
    /**
     * `film` is the default since the brief became cinematic rather than documentary: the
     * Film Warm grade picked on the Canopy Look Board, retuned by eye, see `film` below.
     * `shoulder` is the faithful curve it grades into, kept for when captured colour must be
     * exact — at exposure 1, see below.
     *
     * `shoulder` shares Khronos PBR Neutral's knee, hue-preserving peak scaling and pull
     * toward white, but drops its 0.04 dark offset and uses its own power curve that
     * reaches white exactly at `whitePoint`. It is the exact identity (at exposure 1)
     * while the brightest channel stays at or under 0.8 linear (sRGB 231), so captured
     * point RGB, satellite colour and picked panel colours render as authored. With
     * `whitePoint` above 1, everything from the knee up is compressed so the white point,
     * not 1, reaches white: in-range highlights too (at 1.5, sRGB 255 renders as 248 and
     * the fog colour 0xfff2e0 as about (248, 235, 218)), while the overbright basemap, lit
     * cloud tops and the donation parcel's additive overlays roll off instead of clipping.
     * On a measured frame 0.04 % of pixels sat above the knee.
     * Stock `neutral` darkens every unlit colour by that offset (all pixels, −16 levels
     * on average) and crushes the darks; `none` is the hard clip; `agx` greys and `aces`
     * yellows photo colour. Kept for comparison only. `?tonemap=` overrides this for an A/B.
     */
    mode: 'film' as 'none' | 'film' | 'shoulder' | 'neutral' | 'agx' | 'aces',
    /** Linear multiplier applied before the curve. Ignored by `none`. Panel range
     * 0.25–2; a config value outside it is clamped at boot. Shared by every curve, so
     * at the film look's 0.94 a `shoulder` A/B renders 6 % darker than captured (sRGB 128
     * as 124): set 1 for the exact reference. */
    exposure: 0.94,
    /** `shoulder` only: the linear peak that reaches full output (white for a grey).
     * 1, the default, means no roll-off and fidelity first: everything up to 1 passes
     * unchanged (to float precision above the knee), and brighter colours are scaled down
     * until their brightest channel is 1, keeping their hue, instead of being clipped per
     * channel. 1.5 keeps lit cloud tops and 1.4× sandbars graded instead, at the cost of
     * up to 7 levels off in-range whites. Panel range 1–3 in steps of 0.05. */
    whitePoint: 1,
    /**
     * `film` mode: Film Warm from the Look Board (contrast 1.25, saturation 0.9, split 1,
     * lift 0.012 at exposure 1), retuned by eye on 2026-09-29: no S-curve, more colour and
     * the split at full strength, so there is no neutral white — white renders as about
     * (250, 236, 214) and the ground-fog cream as (251, 223, 185). The 3D marker and parcel
     * colours are graded too and drift from the same hex in the DOM labels (lime #d9f99d
     * renders as (218, 242, 121)). Contrast is a power on luma in log space
     * around 18 % grey (1 = none); saturation mixes toward luma (1 = captured). The split
     * tints shadows cool and highlights warm (`split` 0–2 scales them); `lift` raises black
     * like a print stock; `vignette` darkens the corners by that fraction. `whitePoint` is
     * its own shoulder's: 2, so sand and cloud tops roll off softly — this is a look, not
     * a measurement. Each part (tone = contrast + saturation, split, lift, vignette) is a
     * build-time switch: off, or at its neutral value, compiles it out of the output pass
     * rather than running it at zero.
     */
    film: {
      toneEnabled: true,
      contrast: 1,
      saturation: 1.17,
      split: 2,
      splitEnabled: true,
      shadowTint: [0.93, 1, 1.08],
      highlightTint: [1.07, 1, 0.9],
      liftEnabled: true,
      lift: 0.01,
      vignette: 0.3,
      vignetteEnabled: true,
      whitePoint: 2,
    },
  },
  // The colour grade (the Design panel's Colour grade section, grade-editor.ts): a 3D LUT on
  // the frame as displayed — after the tone curve and the sRGB encode, in the final quad the
  // frame already goes through (grade-output.ts), so it adds no pass. Exposure and the film
  // vignette stay in toneMapping above. While the state is neutral, no look is set and the
  // section is closed, the grade is compiled out: viewers get the shader and the frame they got
  // before it existed. Measured with it on (2026-10-05, desktop): the tap ≤ 0.01 ms; switching
  // it in or out rebuilds the post materials once, a 12–16 ms frame with DoF and EDL on.
  grade: {
    /** Master switch, the panel's Grade button. Off compiles the tap out whatever the state
     *  says. `?grade=0|1` boots with it off or on. */
    enabled: true,
    /** The lattice the grade bakes without a look: 33³ nodes, the size Resolve and Photoshop
     *  exchange. Between nodes the tap interpolates; a strong grade on dark greens reads about
     *  2 levels off the exact maths at 33, half that at 65. The size costs nothing on the GPU
     *  (65³ measured +0.007 ms against 33³); a bigger one only bakes slower. */
    lutSize: 33,
    /** An imported 3D look of size N is baked on a k(N − 1) + 1 lattice, the smallest at or
     *  above lutSize, so trilinear reproduces the look's own trilinear exactly (21³ → 41³,
     *  32³ → 63³). Looks that would need more are resampled onto this size, with a "not 1:1"
     *  warning; 33 resamples every look that is not 9, 17 or 33. */
    maxLattice: 65,
    /** While a slider is dragged, bake every second node and fill the rest (a draft) only once
     *  the last full bake took longer than this. A desktop bakes 33³ in 5–8 ms, so it never sees
     *  a draft; a phone may. */
    draftWhenFinalOverMs: 8,
    /** Bake in a module worker (grade-bake.worker.ts). Off, or where workers fail, the bake runs
     *  on the main thread before the frame, at most one per frame. */
    worker: true,
    /** A .cube look applied before the controls: a file under public/grades/, fetched at boot,
     *  and its amount 0..1. The first frames show the grade without it. */
    look: null as null | { file: string; amount: number },
    /** Where the before/after split sits when Compare is switched on, as a share of the canvas
     *  width from the left; left of it shows the frame without the grade. */
    compareSplit: 0.5,
    /** The grade itself, as the panel's Copy values writes it (grade-model.ts GradeState, read
     *  through parseGradeState). These are the neutral values: every one changes nothing. */
    state: {
      version: 1,
      temperature: 0,
      tint: 0,
      lift: { y: 0, u: 0, v: 0 },
      gamma: { y: 0, u: 0, v: 0 },
      gain: { y: 1, u: 0, v: 0 },
      offset: { y: 0, u: 0, v: 0 },
      contrast: 1,
      pivot: 0.4614,
      saturation: 1,
      vibrance: 0,
      curves: { master: [[0, 0], [1, 1]], red: [[0, 0], [1, 1]], green: [[0, 0], [1, 1]], blue: [[0, 0], [1, 1]] },
      hueSat: [],
      hueLuma: [],
      tones: { shadows: { u: 0, v: 0 }, highlights: { u: 0, v: 0 }, balance: 0, blending: 0.5 },
      rollOff: 0,
    },
    /** How strongly each control acts at its end stop (grade-model.ts GradeTuning). Temperature
     *  +100 moves red up and blue down by tempStops stops; tint +100 moves green down by tintStops;
     *  a wheel's puck on its rim moves a channel by its *Chroma; the hue curves fade out under
     *  hueChromaGate chroma, so greys and haze never move; vibrance acts half at vibranceChroma;
     *  the soft gamut compression starts gamutThreshold below the brightest channel; roll-off 1
     *  drops the knee by rollOffKnee. Must equal DEFAULT_GRADE_TUNING (a test checks). */
    tuning: {
      tempStops: 0.5,
      tintStops: 0.4,
      liftChroma: 0.1,
      gammaChroma: 0.5,
      gainChroma: 0.25,
      offsetChroma: 0.1,
      toneChroma: 0.1,
      hueChromaGate: 0.05,
      vibranceChroma: 0.3,
      gamutThreshold: 0.8,
      rollOffKnee: 0.3,
    },
  },
  // Eye-dome lighting (eye-dome-lighting.ts): depth-edge shading, the standard point-cloud
  // aid for reading shape without normals. A screen pass like DoF and shares its pipeline;
  // off drops it from that pipeline, and with DoF also off the frame is drawn straight to
  // the canvas and no pass runs. Measured on: +0.2 ms at 1600×900.
  eyeDomeLighting: {
    /** On at startup, part of the look dialled in on 2026-09-29; `?edl=0` boots with it
     *  off, `?edl=1` on. Not gated by tier: every device pays it, the loader benchmark too. */
    enabled: true,
    /** Potree's response scale, applied to linear colour, so it reads about half as strong
     *  as the same Potree value. At 1 with the 0.8 floor almost every depth step reaches the
     *  floor — a sub-metre step at 300 m does — so the floor sets the look: crown rims, gaps
     *  and sprite edges inside a crown all get the same ×0.8, and strength only still grades
     *  the smallest steps. 0.5 floors the same rims and gaps but keeps some of that grading. */
    strength: 1,
    /** Neighbour distance in whole backbuffer pixels (CSS px × render pixel ratio);
     *  rounded, minimum 1. Larger = wider rims. */
    radiusPx: 1,
    /** Darkest shade EDL may apply, as a fraction of the original brightness: 0.8 linear is
     *  about −9 % on screen. It stops the gaps between points going black (without a floor
     *  6.5 % of a dense canopy frame went near-black at any strength); 0 is Potree's
     *  unbounded behaviour. */
    floor: 0.8,
    /** EDL fades out between these view distances (metres). Beyond a few kilometres the
     *  smooth ground's pixel-to-pixel depth steps read as edges and it would only darken
     *  the distance haze. */
    fadeStartM: 1_500,
    fadeEndM: 5_000,
  },
  // One of the two effects that cannot live inside a colour node (with eye-dome
  // lighting): a circle of confusion has to read neighbouring pixels, so DoF is a real post pass (see
  // depth-of-field.ts). Costs nine full- and half-resolution draws per frame, not yet
  // measured on this branch; nothing drops it on weak hardware automatically — the panel
  // toggle and `?dof=0` do.
  depthOfField: {
    /** On at startup, part of the look dialled in on 2026-09-29. With the values below it
     * is a distance blur: the canopy within ~500 m stays sharp, so point density there can
     * still be judged; switch it off to judge the far field. `?dof=0|1` overrides this. */
    enabled: true,
    /** Pin the focal plane to whatever the screen centre is aimed at, so the
     * near canopy stays sharp while the background falls away. With this off,
     * focusDistanceM becomes an absolute distance from the camera. */
    autoFocus: true,
    /** With autoFocus on: metres added to the measured ground range — negative
     * pulls focus in front of the aimed point. Off: the absolute distance.
     * The focus is clamped at 1 m, so −500 pins it there whenever the aimed point
     * is under ~500 m away — every close-up — and the effect is a pure distance
     * blur rather than a focal plane. Only wider views focus on the ground ahead. */
    focusDistanceM: -500,
    /** Metres either side of the focal plane at which content is fully out of
     * focus; the blur's blend is already full at half of it. At 4 km and a 1 m
     * focus: 0.3 px at 460 m, 1.25 px at 1 km, 4 px at 2 km, the full radius
     * from 4 km — the basemap softens, the canopy does not. */
    focalLengthM: 4_000,
    /** Largest blur radius, roughly in backbuffer pixels. The tap count is fixed
     * whatever the size, so it is not what the cost scales with; beyond ~8 the
     * bokeh disc undersamples. */
    bokehScale: 8,
    /** Per-frame lerp factor for the auto-focus. 1 is no smoothing: the focal plane
     * follows the aimed range every frame, which is stable over the canopy (the range
     * comes from a flat plane, not the points) but jumps in low side views near the
     * horizon, where the range changes by kilometres per degree. */
    focusSmoothing: 1,
  },
  /**
   * Volumetric ground fog (ground-fog.ts): mist ray-marched through a band just above the
   * forest floor, so it lies in the gaps between the crowns, is cut off by them, and sends
   * wisps up past the canopy — what the analytic `design.groundFog` can only fake as a
   * tint. A post pass between eye-dome lighting and depth of field; off removes it from
   * the pipeline. `?vfog=0|1` boots it off or on.
   *
   * Heights are metres above the default area's floor, the same floor the analytic fog
   * uses; the survey-centre ground sits ~22 m above it, the crown tops ~50 m.
   */
  volumetricFog: {
    enabled: true,
    // ---- fidelity and cost
    /** Fraction of the drawing buffer the march runs at; a depth-aware upsample brings it
     *  back to full resolution. 0.5 marches a quarter of the pixels. The cost goes with the
     *  marched pixels: measured 2026-09-30 with the defaults of 517dc5a (NVIDIA Ampere,
     *  2000×1125 buffer, 40 steps, '2d' noise, 9 km rays), +0.5 ms at 0.25, +2.4 ms at 0.5,
     *  +10 ms at 1. */
    resolutionScale: 0.5,
    /** A cap on the march's texels, as a share of what the scale gives on the 2000 × 1125
     *  buffer the presets were measured on: on a larger screen the march runs at
     *  min(scale, √(this × 2000 × 1125 × scale² / buffer pixels)), so its cost stops growing
     *  with the screen. 1.5 leaves today's look up to 1.5× that buffer's pixels (2560 × 1440
     *  marches at 0.48 of it, 4K at 0.32, both ½ asked for); 0 = no cap. */
    marchBudget: 1.5,
    /** Hold the fog off, without a rebuild, while the camera is farther from the band's box
     *  than `maxDistanceM` (no ray could reach it; the entrance flight's first seconds).
     *  false = always march, for an A/B. */
    visibilityGate: true as boolean,
    /** Samples per ray through the band. The main cost knob together with the resolution,
     *  about linear: +0.85 / +1.4 / +2.4 / +3.6 ms for 16 / 24 / 40 / 64 at half resolution
     *  (same measurement, same look; on it 24 looked all but the same as 40 and 16 showed
     *  grain). The look dialled in on 2026-09-30 runs 32, on the strong preset too. */
    steps: 32,
    /** How the samples crowd toward the camera in the dense segment of the ray (the mist
     *  and puffs; the sparse plume segment above is spaced evenly): 1 spaces them evenly,
     *  2 puts half of them in the nearest quarter, where detail is resolvable. */
    stepDistribution: 1.45,
    /** Rays stop here: nothing of the fog, the veil included, is drawn farther from the
     *  camera, and seen from higher than this plus the band's top there is no fog at all.
     *  Beyond, the distance haze carries the atmosphere on its own. */
    maxDistanceM: 6_000,
    /** Extra scattering orders in Wrenninge's approximation (0 = single scattering only).
     *  Costs nothing measurable. Rebuilds the shader. */
    multipleScattering: 3,
    /** Where the height detail comes from; coverage, billows and erosion always come from the
     *  2D texture. '3d' (the default): a fixed 64³ value-noise texture — the noise editor
     *  only previews it, and its B (wisps) layer goes unused. '2d': stacked slices of the 2D
     *  texture's B layer, editable in the noise editor; the same cost (measured with the
     *  defaults of 517dc5a), and 8× less memory per doubling. 'procedural': every layer
     *  evaluated in the shader, +9 ms over '2d', for the cost comparison. Rebuilds the
     *  shader. */
    noiseSource: '3d' as '2d' | '3d' | 'procedural',
    /** Height detail and plumes: the height noise (see `noiseSource`) that carves the mist
     *  into rounded puffs and wisps, and the columns rising out of the canopy. Off saves two
     *  3D reads per sample (three 2D reads with '2d', about 45 % of the fog's cost with the
     *  defaults of 517dc5a) and leaves flat-topped prisms; rebuilds the shader. */
    wisps: true,
    /** Weigh the four low-resolution neighbours by depth when upsampling, so fog does not
     *  bleed across crown silhouettes. Off = plain bilinear. Rebuilds the shader. */
    depthAwareUpsample: true,
    /** Temporal filter: blend every frame into the last, carried along with the camera, and
     *  move the march's jitter each frame, so its sampling error averages out rather than
     *  boiling while the camera moves (fog-temporal.ts). Rebuilds the shader. */
    temporal: true,
    /** Weight of the current frame, 0.02–1. Lower is smoother but lags behind a moving
     *  camera and fast-changing fog; 1 is no averaging. The default, the floor, dialled in on
     *  2026-09-30, averages about fifty frames: with so long a memory it is the clip
     *  (`temporalClip`) that keeps moving fog from trailing. Measured 2026-09-30 in a
     *  sideways move: 0.1 and 0.25 were about equally steady, 0.25 lagged less. */
    temporalBlend: 0.02,
    /** How far the carried-over fog may differ from the current frame's neighbourhood, in its
     *  standard deviations. Wider keeps more history (smoother, may trail at crown edges);
     *  narrower rejects it sooner (sharper, grainier). */
    temporalClip: 1.4,
    /** How much the surface behind a texel may have moved in depth since last frame, relative,
     *  before its history counts as another surface's and is left out of the fetch (a gap
     *  opening beside a crown). Smaller keeps the fog's outlines sharp in motion; large (10)
     *  switches the test off — steadier still, but the outlines smear, measured 4× further
     *  from the settled image in a sideways move. The default, 1, dialled in on 2026-09-30,
     *  keeps any history from nearer than the surface or up to twice as far behind it. */
    temporalOcclusion: 1,
    /** March each texel to the nearest surface among the full-resolution pixels it covers,
     *  so the sub-pixel holes between point splats cannot let rays through a crown into the
     *  mist below: bright specks that jump as the camera moves. Real gaps keep their mist.
     *  Only below full resolution; rebuilds the shader. */
    fillCanopyHoles: true,
    /** Picked by the loader benchmark, on top of the values above. Against a 60 fps frame,
     *  10 fps is 3.3 ms. Measured 2026-09-30 with the defaults of 517dc5a (strong then at 40
     *  steps): +2.5, +1.5 and +0.35 ms. Strong runs the 32 steps dialled in on 2026-09-30,
     *  which the same measurement puts at about +2 ms. */
    qualityByPreset: {
      strong: { resolutionScale: 0.5, steps: 32 },
      medium: { resolutionScale: 0.5, steps: 24 },
      constrained: { resolutionScale: 0.25, steps: 20 },
    },
    // ---- the band, metres above the area floor
    bottomM: 15,
    topM: 59,
    /** How far plumes rise above the puff layer (`puffCentreM`), whatever `topM` is. */
    plumeHeightM: 53,
    bottomSoftM: 16.5,
    topSoftM: 15,
    /** How far the band reaches past the survey's bounding box, fading out over it. The
     *  march never leaves the box: beyond the point cloud the bare map has no crowns to
     *  hide the band, and the haze carries the distance. */
    marginM: 900,
    /** Height above the floor of the crown surface the flat map stands for beyond the drawn
     *  point cloud; mist below it is hidden there. The survey-centre crowns top out ~50 m. */
    virtualCanopyM: 19,
    /** A ray whose scene surface lies below this height above the floor (metres; negative =
     *  under the floor) has landed on the bare map, not on the point cloud: a hole or the
     *  faded-out distance. Its march ends at the virtual canopy. The map drape sits 20 m under
     *  the floor; a positive value counts low point-cloud ground as map too. */
    mapBelowM: 20,
    /** Where the mist in a real gap ends, metres above the area floor; meant as the forest
     *  floor (~22 at the survey centre). A gap is a ray that met no crown inside the
     *  sphere-fade dome and landed on the map, which lies 20 m under the floor. Below
     *  `bottomM` the band's own bottom ends the mist instead. */
    groundLevelM: -20,
    /** Beyond this distance the points are too sparse to hide anything, whatever the dome
     *  says: the virtual canopy takes over. */
    pointsReachM: 1_200,
    /** The veil: a sheet of mist banks lying on the virtual canopy — what mist far away reads
     *  as, and all of it outside the sphere-fade dome (up to `maxDistanceM`). Visibility
     *  inside its densest banks (0 = off) and its thickness; over the drawn points it is kept
     *  to a third. */
    veilVisibilityM: 6_700,
    veilHeightM: 79,
    /** Plumes: columns of rising vapour. One candidate per square of this side, present by
     *  `plumeChance`, this wide at its foot (radius, metres; it flares to about twice that as
     *  it rises), leaning downwind. */
    plumeSpacingM: 250,
    plumeRadiusM: 17,
    plumeChance: 0.57,
    /** Puffs: flat, rounded clumps lying on the canopy, on billow clumps above `puffCut`,
     *  centred this high above the floor (the crown tops are ~50 m) and this thick at their
     *  strongest; taller puffs read as standing columns from above. 1 m is the least the
     *  shader takes. */
    puffCentreM: 45,
    puffHeightM: 1,
    puffCut: 0.38,
    puffAmount: 2.49,
    /** How much of the sky's colour the skylight on the mist keeps, at the back of the view
     *  (0 = white of the same brightness — with the daylight ramp, the daylight's own colour —
     *  1 = the sky's colour as it is). Humid forest air is pale. */
    skyTint: 0.56,
    /** The tint from front to back, so mist near the camera reads as white water vapour and
     *  the far field takes the colour of the haze and sky: the share of `skyTint` right at the
     *  camera (0 = white), the distance where all of it is reached, and the fade's curve
     *  between (1 even, above 1 white farther out, below 1 tinted sooner). */
    skyTintFront: 0.3,
    skyTintFadeM: 1500,
    skyTintCurve: 1,
    // ---- shape
    /** Visibility in the body of the mist (Koschmieder: extinction = 3.912 / visibility). The
     *  height detail carves it unevenly, and puffs and plume cores stack on top, so parts of
     *  it run denser than this. */
    visibilityM: 230,
    /** Share of the ground the mist pools over, and how soft the banks' edges are. */
    coverage: 1,
    coverageSoftness: 0.17,
    /** World size of one noise tile per layer, metres. */
    coverageScaleM: 3_200,
    billowScaleM: 420,
    erosionScaleM: 195,
    wispScaleM: 275,
    wispHeightM: 284,
    billowAmount: 0.47,
    erosionAmount: 0.66,
    wispAmount: 0.95,
    plumeAmount: 1.23,
    /** Drift with the breeze, and the rise of warm, moist air out of the canopy (m/s). */
    windMps: [3.06, -0.936] as [number, number],
    riseMps: 2.15,
    // ---- light
    /** Droplet diameter for the Mie phase fit (Jendersie & d'Eon 2023): radiation fog runs
     *  ~5–20 µm. Larger drops push the sunward glow into a tighter, brighter halo. */
    dropletDiameterUm: 14,
    /** Single-scattering albedo: the share of the light the droplets scatter rather than
     *  absorb. Water fog is ~0.995; lower values grey and darken the mist. */
    albedo: 0.735,
    sunStrength: 1.95,
    ambientStrength: 1.05,
    /** How much of the sky the crowns hide from mist low in the band (0 = none). */
    canopyOcclusion: 0.37,
    /** Rayleigh scattering by the air in the band, 1 = sea-level air. Physically a small
     *  bluish addition over these distances; the haze carries aerial perspective beyond. */
    rayleighScale: 1,
    /** With the physically based sky (sky-atmosphere.ts) the fog takes the atmosphere's sun
     *  and sky light instead of the daylight ramp; these scale it so the look the panel was
     *  tuned to at 14:00 carries over (the sun strength and ambient strength above still
     *  apply on top). */
    skySunScale: 1,
    skyAmbientScale: 1,
    /** Colour multiplied into the fog's light, for grading. */
    tint: 0xffffff,
    /** Tileable noise layers (fog-noise.ts); the noise editor rewrites these live. */
    noise: {
      size: 256,
      layers: [
        { kind: 'perlin', period: 4, octaves: 5, gain: 0.5, seed: 1, warp: 0.6, contrast: 1, invert: false },
        { kind: 'worley', period: 6, octaves: 3, gain: 0.45, seed: 7, warp: 0.35, contrast: 1.2, invert: false },
        { kind: 'perlin', period: 16, octaves: 4, gain: 0.55, seed: 13, warp: 1.1, contrast: 1, invert: false },
        { kind: 'worley', period: 12, octaves: 4, gain: 0.5, seed: 29, warp: 0, contrast: 1, invert: false },
      ],
    },
  },
  rain: {
    dryDurationMs: 10_000,
    activeDurationMs: 8_000,
    maximumRangeM: 2_800,
    rangeFadeM: 350,
    fadeInMs: 1_250,
    fadeOutMs: 900,
  },
} as const
