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
    // Distance at which each density band takes over. Named "Height" because the
    // metric used to be plain altitude; it is now the slant range to the ground ahead
    // (see maxTiltRangeFactor), so these edges are only heights when looking straight
    // down. At 45 degrees the detail edge below is reached at 106 m of altitude.
    // Distance alone decides density; frame rate is paid for elsewhere (vignette
    // mask, parrot count, cloud quality).
    // Must stay above navigation.zoomStopHeightM, otherwise the finest band is
    // unreachable: the camera never gets closer than the zoom stop.
    detailMaxHeightM: 150,
    exploreMaxHeightM: 2_500,
    // Screen-space error target per band, coarse to fine.
    overviewSse: 256,
    exploreSse: 124,
    detailSse: 64,
    // Same three bands against the Adaptive Point Hierarchy, whose nodes carry
    // far more points. These match the Cesium reference ladder (far 16 /
    // approach 8 / detail 4). Measured on desktop WebGPU: SSE 4 selects ~10M
    // points at a held 60 fps, so the quad expansion three.js needs (WebGPU has
    // no sized point primitive) still fits inside the frame budget. Weak devices
    // are handled by the pressure controller, not by a coarser ladder here.
    aphDetailSse: 4,
    aphExploreSse: 8,
    aphOverviewSse: 16,
    // Margin a band keeps past its edge, so drift cannot flip the level.
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
     * Ceiling on how much the view angle may stretch the refinement distance.
     *
     * The distance is the slant range to the ground ahead, altitude / sin(pitch),
     * which goes to infinity as the camera levels out. The raycast version of this
     * was dropped for exactly that reason — it swung kilometres per degree near the
     * horizon. Clamping the sine instead keeps the metric analytic and bounded: at 6
     * the range can reach six times the altitude and no further.
     */
    maxTiltRangeFactor: 6,
    /**
     * Pin the screen-space error target instead of taking it from the band ladder.
     * A testing aid: the ladder plus its hysteresis means the same camera height can
     * carry either 4 or 8 depending on which way you arrived, so two settings
     * compared across a band edge are not comparable at all. Locked, everything the
     * foveation factors multiply is a constant. The boot and flight brakes still
     * apply on top, and leaf loading still overrides both.
     */
    bandLock: {
      enabled: false,
      sse: 8,
    },
    // Foveated detail: redistribute the band above across the image instead of
    // raising it everywhere. The factors multiply whatever screen-space error the
    // adaptive controller has chosen, so the band still follows camera range and
    // foveation only decides where inside the frame that budget lands. Off by
    // default until the position below is measured against real camera pitches.
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
      // Fovea centre on the projected image: -1 bottom edge, 0 centre, +1 top.
      offsetY: 0,
    },
    // Drawn point size in CSS pixels as a continuous function of camera height
    // over the cloud floor — three fixed bands visibly stepped while zooming.
    // Anchors are measured preferences: zoom all the way in (~82 m, APH d6),
    // then count zoom-out presses. Interpolated linearly in log(height) and held
    // flat outside the range, so the far end never thins out into holes.
    pointSizeByHeightM: [
      [82, 3.9],
      [171, 4.0],
      [613, 3.0],
      [1088, 2.5],
    ] as const,
    // The one knob for overall point fatness. Everything above is multiplied by
    // it, the UI slider multiplies on top. Dialled in on the slider at 0.8x, which
    // lands the close-range size around 3.1 px.
    pointSizeMultiplier: 0.8,
    // Base size when the height curve above is toggled off (Cesium comparison:
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
    // Field asset offsets are relative to the shifted hotspot centre.
    positionM: [291.878, -1_988.147, 4],
    rotationRad: [Math.PI / 2, 0, -1.039],
    scale: 24,
    sensorHeightM: 112.138,
  },
  boat: {
    positionM: [644.068, -1_961.281, 5],
    rotationRad: [Math.PI / 2, 0, 0.039],
    scale: 7.046,
  },
  parrots: {
    // Each pass is sampled from the camera once, then remains fixed in world space.
    cameraDepthM: [650, 2_800],
    screenHeightRange: [-0.28, 0.34],
    edgeOverscan: 0.68,
    // The GLTF already uses +Z as forward and +Y as up.
    modelRotationRad: [0, 0, 0],
    modelScale: 0.28,
    strongCount: 12,
    balancedCount: 8,
    constrainedCount: 4,
    // Along-track spacing, lateral variation and minimal height variation.
    spreadM: [64, 16, 4],
    flightDurationMs: 18_000,
    passIntervalMs: 22_000,
    passIntervalJitterMs: 5_000,
    animationSpeed: 0.48,
    nightFadeMs: 1_200,
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
  },
  pointLighting: {
    // Directional daylight cues for the (normal-less) point cloud. All three
    // cloud-shadow values are live in the design panel; strength goes through
    // the environment layer because it rides the daylight ramp there.
    /** Base depth of the drifting canopy shadows, before the layer multiplies it
     * by daylight and halves it when the visible clouds are off. */
    /** Canopy cloud shadows on at startup. Off while the ground patch is being judged:
     * both draw dark shapes on the ground and they are easy to mistake for each other. */
    cloudShadowsEnabled: false,
    cloudShadowStrength: 1,
    /** Metres per period of the shadow noise — the grain size. Smaller means
     * finer, busier dappling; larger means broad continental shadows. */
    cloudShadowScaleM: 1_700,
    /** Tightens the noise-to-shadow ramp around its midpoint. 0 is the original
     * wide 0.32–0.62 window (soft, washed); 1 is a near-binary edge, which reads
     * as hard-edged cloud gaps. */
    cloudShadowContrast: 0.63,
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
    /** Distance haze on at startup. Off while the level-of-detail work is being
     * judged: the haze hides exactly the far-field density the sliders change. */
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
      /** 0 = the raw basemap at `brightness` below, 1 = the flat `color`. Anything
       * between blends the two, so one control covers both requests: dim the map
       * only there, or replace it outright. */
      colorMix: 1,
      /** Brightness of the raw imagery inside the patch, independent of the global
       * basemap grading — the point being to see exactly this, not this plus fog. */
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
       * Cells that may hold data at once — a ceiling on mask memory of
       * maskCellPx^2 x this, so 512px x 64 is 16 MB. Cells are handed out only where
       * points actually land, and the Peru footprint is a diagonal strip, so it needs
       * far fewer than its bounding box suggests. The console reports what was used;
       * it warns rather than fails if the budget runs out.
       */
      maskMaxCells: 64,
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
       * Shortest gap between mask uploads while coverage is still arriving. The
       * upload is the expensive half — the whole 4.2 MB texture, measured at 10.7 ms,
       * against ~1 ms of splatting — so batching it is what keeps the fill invisible.
       * The final upload is never delayed.
       */
      maskUploadIntervalMs: 400,
    },
    /** 1 = raw satellite colour, 0 = fully grey. */
    mapSaturation: 1,
    /** Multiplies the basemap only — the point cloud keeps its own grading.
     * Pushed above 1 so the map reads as daylight ground where it shows through: the
     * river and the survey gaps are the whole point of the ground patch, and at the
     * old 0.1 they sat as near-black holes rather than as water and sand. */
    mapBrightness: 1.4,
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
     * the far field fades — through groundFog, not a hard mask edge. */
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
       * the surround and the far field is left to groundFog. At 1 the threshold
       * is reached again, so the stochastic fringe discard is back in side view
       * too — which is what the dialled-in look uses. */
      sideMaxVignetteStrength: 1,
    },
    // Analytic exponential height fog: no raymarch, no extra pass, no texture —
    // a handful of ALU ops folded into the existing point and imagery colour
    // nodes. Nothing animates, so there is nothing to sample per frame.
    // The dialled-in look is a warm haze band sitting in the canopy rather than
    // the wide neutral slab this started as. Note how the values work together:
    // a very short density distance (25 m) would normally fog the near field
    // solid, but curve 4 pushes almost all of that density out into the distance,
    // and the 170 m lower fade keeps the air under the band clear. Pinned to a
    // warm cream instead of following the daylight ramp.
    groundFog: {
      /** Ground haze on at startup. Off for the same reason as the distance fog:
       * it sits over the canopy the density settings are being read from. */
      enabled: false,
      /** Final multiplier, so 0 is reliably off regardless of the other values.
       * The panel allows up to 3; the resulting coverage is clamped to 1, so past
       * 100% the fog saturates earlier rather than overshooting its colour. */
      strength: 0.75,
      /** Fog floor relative to the survey's lowest point. Also the height the
       * band peaks at, since density decays upward from here and fadeBelowM
       * fades it out downward. */
      baseOffsetM: 35,
      /** e-folding height of the slab: density falls to 1/e at this height. */
      heightM: 10,
      /** Metres below the base over which the fog fades out downward. 0 is the
       * original one-sided slab that extends to the ground at full density; any
       * positive value turns it into a band — a layer hanging in the canopy with
       * clear air underneath. Together with heightM this sets the band's total
       * thickness: roughly fadeBelowM below the base, ~2x heightM above it, so
       * this band is deliberately lopsided — a soft underside, a tight top. */
      fadeBelowM: 170,
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
  // The one effect that cannot live inside a colour node: a circle of confusion
  // has to read neighbouring pixels, so DoF is a real post pass (see
  // depth-of-field.ts). Costs a full-screen blur pyramid per frame — the panel
  // toggle exists so it can be dropped on weak hardware.
  depthOfField: {
    /** Off at startup: the blur makes the peripheral point density impossible to
     * judge, which is precisely what the foveation sliders are for. */
    enabled: false,
    /** Pin the focal plane to whatever the screen centre is aimed at, so the
     * near canopy stays sharp while the background falls away. With this off,
     * focusDistanceM becomes an absolute distance from the camera. */
    autoFocus: true,
    /** With autoFocus on: metres added to the measured ground range — negative
     * pulls focus in front of the aimed point. Off: the absolute distance.
     * Pulled 120 m forward so the near canopy, not the aimed ground point,
     * carries the sharp plane. */
    focusDistanceM: -120,
    /** Metres past the focal plane at which content is fully out of focus.
     * Small values give a shallow, cinematic band; large values keep almost
     * everything sharp. */
    focalLengthM: 1_075,
    /** Unitless bokeh size. Drives how wide the blur kernel spreads, so it is
     * also the main cost knob. */
    bokehScale: 2.5,
    /** Per-frame lerp factor for the auto-focus. Low values keep the focal
     * plane from snapping while the camera moves. */
    focusSmoothing: 0.08,
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
