// Product-facing viewer tuning. Keep values in metres and milliseconds.
export const EXPERIENCE_CONFIG = {
  flight: {
    // ENU offsets are relative to the full point-cloud centre.
    destinationOffsetM: [0, -2_200, 1_500],
    overviewOffsetM: [0, -132_000, 92_000],
    overviewControl1OffsetM: [-8_000, -116_000, 19_000],
    overviewControl2OffsetM: [14_000, -34_000, 8_500],
    autoDurationMs: 6_200,
    manualDurationMs: 5_200,
    reducedMotionDurationMs: 900,
    reducedMotionManualDurationMs: 700,
  },
  navigation: {
    // Clearance grows with the dataset's measured vertical span.
    minimumClearanceM: 220,
    extraCloudClearanceM: 80,
    fallbackCloudHeightM: 140,
    minimumZoomDistanceM: 240,
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
  },
  environment: {
    // Peru has no daylight-saving change; the slider still uses the IANA zone.
    timeZone: 'America/Lima',
    utcOffsetHours: -5,
    updateIntervalMs: 250,
    liveRefreshMs: 30_000,
    minimumSceneLight: 0.38,
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
    raymarchSteps: 36,
    softPuffsPerField: 14,
    windMps: [7.5, 2.2],
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
    positionM: [80, -1_260, 4],
    rotationRad: [Math.PI / 2, 0, 0.25],
    scale: 24,
    sensorHeightM: 112,
  },
  boat: {
    positionM: [780, -1_450, 5],
    rotationRad: [Math.PI / 2, 0, -0.12],
    scale: 5.5,
  },
  parrots: {
    // The curve is relative to the shifted hotspot centre and uses Z-up ENU.
    pathM: [
      [-1_100, -1_000, 290],
      [-520, -640, 360],
      [140, -260, 330],
      [790, 160, 410],
      [1_280, 620, 350],
    ],
    modelRotationRad: [Math.PI / 2, 0, 0],
    modelScale: 0.14,
    strongCount: 12,
    balancedCount: 8,
    constrainedCount: 4,
    spreadM: [120, 75, 46],
    flightDurationMs: 16_500,
    pauseDurationMs: 8_000,
    animationSpeed: 0.72,
  },
  atmosphere: {
    // Bring humid tropical and boreal haze into the mid-distance.
    minimumFarM: 24_000,
    maximumFarM: 650_000,
    fallbackRangeM: 120_000,
    farRangeMultiplier: 5.5,
    fogNearFactor: 0.06,
    fogFarFactor: 0.52,
    updateIntervalMs: 125,
    distanceSmoothing: 0.22,
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
