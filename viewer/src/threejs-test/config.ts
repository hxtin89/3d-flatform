// Product-facing viewer tuning. Keep values in metres and milliseconds.
import type { Keyframe } from './sequence'

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
  // Donor intro (intro-sequence.ts). One choreography for every parcel: the
  // camera is keyframed as {azimuth, elevation, range} around the parcel
  // centre (camera-rig.ts), range in multiples of the distance that frames
  // the parcel, so the same numbers work for 14 m² and for 1 000 m². Times are
  // ms from the start button; ?scrub=1 shows a slider over the whole timeline,
  // ?intro=0 falls back to the plain entrance flight.
  intro: {
    enabled: true,
    durationMs: 72_000,
    phases: { flight: 0, settle: 7_000, draw: 8_200, caption: 9_800, orbit: 12_000 },
    // Once past `to` the clock wraps back by (to − from): the azimuth track
    // completes exactly one turn inside this window, so the orbit never ends.
    orbitLoop: { from: 12_000, to: 72_000 },
    rangeMaxM: 200_000,
    rig: {
      // 0 = from the south, as the survey flight always approached.
      azimuthDeg: [
        { t: 0, v: -30 }, { t: 7_000, v: 0, ease: 'smootherstep' },
        { t: 12_000, v: 0 }, { t: 72_000, v: 360, ease: 'linear' },
      ],
      elevationDeg: [{ t: 0, v: 32 }, { t: 7_000, v: 38 }],
      // 400 × ~250 m frame distance ≈ 100 km out; the floor solve steepens
      // the last metres if 38° would end under the navigation floor.
      range: [
        { t: 0, v: 400 }, { t: 7_000, v: 1, ease: 'easeOutExpo' },
        { t: 12_000, v: 1 }, { t: 42_000, v: 0.8, ease: 'easeInOutSine' },
        { t: 72_000, v: 1, ease: 'easeInOutSine' },
      ],
    },
    // Multiplier on the cloud layer's own range fade (environment-layer). Kept
    // at 1 until the fog reveal milestone; an empty list means "leave alone".
    cloudOpacity: [] as Keyframe[],
    // Outline draw-on, 0..1 along the parcel perimeter.
    outlineDraw: [{ t: 8_200, v: 0 }, { t: 9_600, v: 1, ease: 'easeInOutCubic' }],
    captions: [
      { id: 'parcel', at: 9_800, until: 20_000 },
      { id: 'life', at: 20_000, until: 32_000 },
    ],
    // {areaM2} and {coordinates} are filled from the donor's parcel.
    captionText: {
      parcel: {
        kicker: 'Personalized Proof of Protection',
        title: 'Das sind die {areaM2} m², die deine Spende schützt.',
        data: [
          { label: 'Koordinaten', value: '{coordinates}' },
          { label: 'Fläche', value: '{areaM2} m²' },
        ],
      },
      life: {
        kicker: 'Dein Stück Wald',
        title: '{areaM2} m² voller Leben.',
        body: 'Bäume, Boden, Pflanzen, Tiere und gespeichertes CO₂ – live, kein Video.',
      },
    },
    // Night → sunrise during the orbit (storyboard 13). Off until the live
    // weather milestone; the track is Peru minutes, evaluated once enabled.
    dayNight: {
      enabled: false,
      peruMinutes: [{ t: 20_000, v: 240 }, { t: 40_000, v: 390, ease: 'easeInOutSine' }],
    },
    takeover: {
      // Idle time after the last gesture before the orbit resumes, and how
      // long the blend from the user's view back onto the track takes.
      resumeIdleMs: 12_000,
      resumeBlendMs: 1_800,
    },
    reducedMotionRate: 6,
  },
  // Donor story for the React app (src/r3f/camera). One spring-driven camera
  // rig relative to the parcel's ground centroid: azimuth/elevation/log-range
  // offsets from the orbit decay on springs while the orbit itself already
  // turns, so the descent is the orbit — no flight-then-rotate seam. Range in
  // multiples of the framing distance, so every parcel size gets the same
  // choreography. Spring configs use react-spring units (mass/tension/friction).
  story: {
    enabled: true,
    // Where the descent starts relative to the orbit heading at t0.
    start: { azimuthDeg: -100, elevationDeg: 58, range: 400, lookHeightFraction: 0 },
    orbit: {
      elevationDeg: 30,
      range: 1,
      degPerSec: 4,
      // Look-at point this fraction up the parcel volume (a 200 m column
      // aimed at its foot leaves the frame at the top).
      lookHeightFraction: 0.42,
      // Orbit range is raised until the camera clears the navigation floor
      // at the orbit pitch — instead of steepening the pitch.
      floorMarginM: 4,
      breathing: { rangeAmp: 0.12, periodS: 34, fadeInS: 3 },
    },
    springs: {
      story: {
        azOffset: { mass: 1, tension: 0.55, friction: 1.55 },
        elOffset: { mass: 1, tension: 0.9, friction: 1.9 },
        logRangeOffset: { mass: 1, tension: 0.42, friction: 1.3 },
        lookOffset: { mass: 1, tension: 0.9, friction: 1.9 },
      },
      resume: { mass: 1, tension: 2.2, friction: 3.0 },
      flyTo: { mass: 1, tension: 4.0, friction: 4.0 },
      lookBlend: { mass: 1, tension: 6.0, friction: 4.9 },
    },
    // Scalar effects on sequence.ts tracks. descent: t = descent progress
    // × 1000 (1000 = start, 0 = orbit reached). arrival: ms after the springs
    // settled at the orbit.
    fx: {
      descent: {
        cloudOpacity: [] as Keyframe[],
      },
      arrival: {
        outlineDraw: [{ t: 400, v: 0 }, { t: 1_800, v: 1, ease: 'easeInOutCubic' }] as Keyframe[],
        captions: [
          { id: 'parcel', at: 2_000, until: 12_000 },
          { id: 'life', at: 12_000, until: 24_000 },
        ],
      },
    },
    takeover: {
      // 'button' shows "Tour fortsetzen" once the user took the camera;
      // 'idle' additionally resumes after resumeIdleMs without input.
      resume: 'button' as 'button' | 'idle',
      resumeIdleMs: 45_000,
      // Wait for the controls' inertia to die before blending back.
      settleMs: 400,
    },
    reducedMotion: { rate: 6 },
  },
  lod: {
    // Height over the point-cloud floor at which each density band takes over.
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
    // it, the UI slider multiplies on top. 1 = the measured preference.
    pointSizeMultiplier: 1.0,
    // Base size when the height curve above is toggled off (Cesium comparison:
    // one fixed size like Cesium's pointSize, slider still multiplies).
    fixedPointSizePx: 2.5,
    // Horizontal slack on the pipeline's viewer request volumes, in multiples
    // of the chunk footprint. 1 = hug the chunk exactly, which leaves gaps the
    // camera can sit in without ever opening p10/p100.
    requestVolumeXyScale: 2.5,
    // Distance cutoff for point tiles, scaled by camera height over the floor:
    // beyond D = clamp(height × factor, min, max) tiles are neither fetched nor
    // drawn, and the point shader discards what ancestors still cover. Up to
    // R = max(height × detailFactor, detailMin) tiles refine at full error;
    // beyond R the error is scaled by (R / d)², so the far field refines
    // shallower — the "foveation" that keeps a horizon view from tripling the
    // point count. Points shrink to nothing between fadeStart × D and D, so
    // the cutoff never shows as an edge; the scene fog stays on its own range
    // (the basemap must not turn into a wall of haze a few km out).
    distanceCutoffHeightFactor: 6,
    distanceCutoffMinM: 1_500,
    distanceCutoffMaxM: 12_000,
    distanceDetailHeightFactor: 3,
    distanceDetailMinM: 200,
    distanceFadeStart: 0.6,
    // Scene fog: far = height × cutoff factor (no ceiling), near = this fraction.
    distanceFogNearFraction: 0.45,
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
  // Frame-rate governor for the React app (src/r3f/state/perf-governor.ts).
  // The one stellgröße is view distance: the point cutoff (and with it the fog
  // that hides its edge) shrinks until the frame budget is met and grows back
  // when there is headroom. Density per distance is already handled by
  // distance-lod's quadratic taper; this closes the loop for the cases that
  // taper cannot know about — a flat horizon view, a weak GPU, a hot device.
  perf: {
    enabled: true,
    // Frame budget: the target rate, but never tighter than the display can
    // actually go — p10 of the recent frame times is the vsync period, so a
    // 60 Hz screen is not throttled for missing 120 Hz.
    targetFps: 120,
    budgetFactor: 1.15,
    // Above this the governor gives distance back.
    relaxFactor: 0.8,
    // A hitch (GC, shader compile, a burst of uploads) must not be read as a
    // steady overload: the decision runs on the median, and only a sustained
    // share of frames below 60 Hz counts as one.
    stutterMs: 16.7,
    stutterShareTighten: 0.06,
    stutterShareRelax: 0.03,
    // How fast the cutoff scale moves per second, tightening vs relaxing.
    tightenPerSecond: 0.9,
    relaxPerSecond: 0.09,
    scaleMin: 0.3,
    scaleMax: 1,
    // Never below this, whatever the frame rate — the parcel must stay framed.
    minCutoffM: 420,
    // Second stage: once view distance is spent, refinement gets coarser —
    // the error target is multiplied by up to this much.
    sseFactorMax: 3,
    ssePerSecond: 1.2,
    // Both stages are quantised and rate-limited: every change re-selects
    // tiles, and a continuously moving target keeps the streamer churning,
    // which costs exactly the frames the governor is trying to save.
    scaleStep: 0.08,
    sseSteps: [1, 1.5, 2, 3] as readonly number[],
    minChangeIntervalMs: 3_000,
    sampleWindow: 90,
    // Ignore the first frames after a rebuild/flight: uploads distort the median.
    warmupMs: 1_200,
  },
  // Flat views see a much longer wedge of forest than a nadir view at the same
  // height. Both the cutoff and the taper distance are scaled by how far the
  // camera looks down, so the horizon shot does not cost three times the points.
  foveation: {
    // Scale at a fully horizontal view … at a straight-down view.
    cutoffFlat: 0.45,
    cutoffDown: 1,
    detailFlat: 0.4,
    detailDown: 1,
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
    // snapping lands the cloud floor exactly on the ellipsoid, which reads as
    // sunk into the terrain wherever the imagery bulges. Second tuning knob
    // next to lod.pointSizeMultiplier; metres, 0 = pure ground snap.
    pointCloudLiftM: 8,
    // Only used for the canopy/cloud-deck shader heights
    fallbackCloudHeightM: 140,
    maximumOrbitDegrees: 72,
    // Mouse easing (pointer-easing.ts): a mouse reports whole pixels at ~125 Hz,
    // a 120–160 Hz display draws more frames than that, so drag rotation and pan
    // arrive as 0-or-1-pixel steps. The pointer position the controls read is
    // eased toward the real one with this time constant (ms). 0 = raw,
    // ?ease=<ms> overrides. Keyboard uses 110 ms and never felt slow.
    mouseOrbitEaseMs: 50,
    // Share of each raw mouse delta applied in the same frame; the rest eases.
    mouseImmediateShare: 0.35,
    // Orbit sensitivity: fraction of a full turn per drag across the viewport
    // height. Library default 1 = 360°, which at ~7 px per mouse report was
    // 290–820°/s in a recorded drag. ?rot=<n> overrides.
    mouseRotationSpeed: 0.75,
    // Whether a mouse drag keeps the library's momentum after release (stock
    // AMMOS behaviour, 0.15 s half-life). Touch always keeps it. ?inertia=0.
    mouseInertia: true,
    // Mouse right-drag pivot: 'center' orbits the point at the screen centre —
    // the same rule the arrow keys use — lifted to the navigation floor inside
    // the survey. 'cursor' is the library default (hit under the pointer, which
    // lands on the basemap under the canopy). ?pivot=cursor for A/B.
    mouseOrbitPivot: 'center' as 'center' | 'cursor',
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
    // Arrow keys: orbit around the screen-centre ground point (left/right) and
    // tilt (up/down), degrees per second, smoothed with the same responseMs.
    orbitDegPerS: 60,
    tiltDegPerS: 45,
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
    // Directional daylight cues for the (normal-less) point cloud.
    cloudShadowStrength: 0.34,
    cloudShadowScaleM: 9_000,
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
  atmosphere: {
    // Bring humid tropical and boreal haze into the mid-distance.
    minimumFarM: 24_000,
    maximumFarM: 650_000,
    fallbackRangeM: 120_000,
    farRangeMultiplier: 5.5,
    fogNearFactor: 0.06,
    fogFarFactor: 0.52,
    // Per-frame with gentle smoothing: the former 8 Hz far-plane steps made
    // the globe's horizon edge flicker against the sky like z-fighting.
    updateIntervalMs: 0,
    distanceSmoothing: 0.06,
    // Since density is never reduced, weaker devices buy their frames by
    // shortening the view instead: the far plane shrinks and the fog closes in,
    // which culls distant tiles and shrinks the drawn set.
    farScaleByPreset: { strong: 1, medium: 0.72, constrained: 0.5 },
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
