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
    // snapping lands the cloud floor exactly on the ellipsoid, which reads as
    // sunk into the terrain wherever the imagery bulges. Second tuning knob
    // next to lod.pointSizeMultiplier; metres, 0 = pure ground snap.
    pointCloudLiftM: 8,
    // Only used for the canopy/cloud-deck shader heights
    fallbackCloudHeightM: 140,
    maximumOrbitDegrees: 72,
    minimumBoundsRadiusM: 2_500,
    surveyBoundsScale: 0.6,
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
    /** 1 = raw satellite colour, 0 = fully grey. */
    mapSaturation: 1,
    /** Multiplies the basemap only — the point cloud keeps its own grading.
     * Dialled far down so the imagery sits back as a dark ground plane and the
     * canopy reads on top of it. */
    mapBrightness: 0.1,
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
    enabled: true,
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
