export const meta = {
  name: 'grade-editor-design',
  description: 'Design the colour-grading editor: understand the output pass, panel and maths; three designs; two judges; one implementation plan',
  phases: [
    { title: 'Understand', detail: 'output pipeline, panel conventions, grading maths and the current film stage' },
    { title: 'Design', detail: 'three designs from different angles' },
    { title: 'Judge', detail: 'two judges score the designs' },
    { title: 'Synthesize', detail: 'one implementation plan' },
  ],
}

const WT = 'C:/projects/WIDE_3d-flatform/.claude/worktrees/sbb-colour-matching'
const PROBLEM = `
Worktree ${WT}, branch sbb/grade-editor (HEAD 2def41d). READ-ONLY: do not edit, commit, stash, checkout or reset. No dev servers, no browser. Small node/python scripts are fine (node --experimental-strip-types runs the repo's .ts tests).

THE APP (viewer/src/threejs-test/): a three.js r185 WebGPURenderer (WebGL2 fallback, ?webgl) immersive map of a rainforest survey for Wilderness International (WI): a streamed drone point cloud over a MapTiler satellite basemap with a drone ortho, volumetric clouds, distance haze and a sky, depth of field and eye-dome lighting as post passes. The output look lives in tone-mapping.ts: the 'film' curve (the user picked "Film Warm" from a look board: log-space S-curve around 18 % grey, split toning, print-black lift, vignette, hue-kept shoulder), registered as a custom tone mapping; every film part compiles out with its switch; Design → "Tone & colour" in threejs-test.html has the controls (film contrast 1, saturation 1.17, split 2, lift 0.01, exposure 0.94 are the user's defaults). The brief is cinematic and immersive, explicitly not like a video game or a web app; the WI brand book asks for "Natural, Real, Wild, Modern, Sound, Vibrant" and nature "undistorted and true to reality"; WI photos all carry one Lightroom preset, "Evergreen" (not yet provided; it will arrive as an .xmp or a before/after image pair). UI strings are English. config.ts is the single source of tuning. There is a "Copy values" button that dumps the panel state as config-shaped JSON.

THE TASK (goal 4 of the brief): a professional colour-grading editor for a high-fidelity cinematic look. The plan written earlier: bake the whole grade on the CPU into a 33^3 3D LUT whenever a control moves (~36k evaluations, a few ms) and sample it once per pixel in the existing output pass. Controls: exposure; contrast with pivot; lift / gamma / gain and offset per channel (colour wheels); temperature and tint; saturation and vibrance; curves (master, R, G, B); hue-vs-sat and hue-vs-luma; shadow and highlight split toning; highlight roll-off; vignette. Import and export .cube, so a grade made in DaVinci Resolve, Photoshop or Lightroom on a screenshot can be loaded as is. Before/after split, snapshots, Copy values. Cost: one 3D texture tap per pixel; the number of controls does not change it.
HARD CONSTRAINT: no or minimal performance loss (measured GPU method from earlier work: stop the renderer's animation loop, before every manual render do r.info.reset(); nodeFrame.update(); r.info.frame = nodeFrame.frameId, read the pass timestamps from the pool after its own resolve, pin the size, pair deltas against two identical baselines; the tone stage parts measured 2-4 microseconds each, EDL +0.18 ms). The grade must compile out entirely when off (identity), like the other parts. Must work on the WebGL2 fallback and on phones (touch, narrow panel). Pure maths (LUT bake, curve splines, colour wheels mapping, .cube parse/serialize, identity detection) must be testable under node --test.`

const UNDERSTAND = [
  { key: 'pipeline', prompt: 'Map the output pipeline facts: tone-mapping.ts in full (how the film curve and its parts are built in TSL, how they compile out, how it is registered as a tone mapping, which space each part works in: scene-linear before the curve or display after), how the final output is composed in main.ts / depth-of-field.ts / eye-dome-lighting.ts / atmosphere-haze.ts (RenderPipeline / PostProcessing, renderOutput, outputColorTransform, outputColorSpace, where tone mapping and the sRGB encode happen, whether there is one final pass where a node can be appended), and what three r185 offers for a 3D LUT (viewer/node_modules/three: Lut3DNode / lut3D TSL, Data3DTexture with linear filtering and its support on WebGPU and WebGL2, LUTCubeLoader in examples/jsm, how texture size 33 vs 32/64 behaves, half-float vs 8-bit storage and banding, the texel-centre scaling formula). Say exactly where a display-referred LUT (input = what the screen shows, so a .cube made on a screenshot applies 1:1) can sit, and what a scene-referred placement would need (a shaper). Quote file:line.' },
  { key: 'panel', prompt: 'Map the panel and UI conventions: threejs-test.html Design panel structure (details sections, rows, labels, notes, .act buttons, segmented controls, range inputs), CSS for the panel (widths, phone layout, colours, fonts), the binders in main.ts (bindDesignSlider, bindSeg, bindEffectToggle and how values flow into uniforms and config), how "Copy values" builds its JSON and whether pasting back exists, any existing localStorage use, how the Tone & colour section is wired today (every control and its uniform), file-input or download precedent in the app, and anything a canvas-based curves editor or colour wheel would need to fit (pointer events, touch, devicePixelRatio, redraw cost while dragging). Also: is there a hook for a before/after split (screen-space uniform) and a place for an on-screen histogram or scope if one were added. Quote file:line.' },
  { key: 'maths', prompt: 'Map the grading maths: the exact formulas the film stage uses today (tone-mapping.ts: curve, split toning, lift, saturation, exposure, vignette, shoulder) and the point grade in point-cloud.ts; then specify a professional grade in display-referred terms suitable for a CPU LUT bake: ASC CDL slope/offset/power and the lift/gamma/gain mapping DaVinci uses, contrast with pivot (in log or in display gamma), white balance temperature/tint (a Bradford or simple RGB-gain model and its sign conventions), saturation and vibrance (luma weights, which luma), curves (monotone cubic / Fritsch-Carlson so curves never overshoot), hue-vs-sat and hue-vs-luma (periodic splines over hue), shadow/highlight split toning, highlight roll-off, and the .cube format (LUT_3D_SIZE, DOMAIN_MIN/MAX, comment lines, R fastest ordering, what Resolve / Photoshop / Lightroom export and accept). Say which operations belong in the LUT and which cannot (vignette is spatial; anything that needs HDR input above 1 needs a shaper or must stay before the curve), how to keep the default identity exact, and what 33^3 at 8-bit vs half-float does to banding in dark forest greens. Quote file:line for the code.' },
]
const UNDERSTAND_SCHEMA = { type: 'object', properties: { facts: { type: 'string' }, risks: { type: 'string' } }, required: ['facts', 'risks'] }
const DESIGN_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' }, summary: { type: 'string' }, pipeline_placement: { type: 'string' },
    grade_model: { type: 'string' }, editor_ui: { type: 'string' }, files_and_changes: { type: 'string' },
    costs: { type: 'string' }, risks_and_mitigations: { type: 'string' }, tests_and_measurements: { type: 'string' },
  },
  required: ['name', 'summary', 'pipeline_placement', 'grade_model', 'editor_ui', 'files_and_changes', 'costs', 'risks_and_mitigations', 'tests_and_measurements'],
}
const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    scores: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, image_quality: { type: 'number' }, performance: { type: 'number' }, editor_usability: { type: 'number' }, interoperability: { type: 'number' }, simplicity: { type: 'number' }, total: { type: 'number' }, notes: { type: 'string' } }, required: ['name', 'total', 'notes'] } },
    winner: { type: 'string' }, graft: { type: 'string' }, blocking_issues: { type: 'string' },
  },
  required: ['scores', 'winner', 'graft', 'blocking_issues'],
}

phase('Understand')
const facts = await parallel(UNDERSTAND.map((u) => () => agent(`${PROBLEM}\n\nYOUR JOB (fact finding, no design yet): ${u.prompt}`, { label: `understand:${u.key}`, phase: 'Understand', schema: UNDERSTAND_SCHEMA })))
const FACTS = UNDERSTAND.map((u, i) => `## ${u.key}\n${facts[i] ? facts[i].facts + '\nRISKS: ' + facts[i].risks : '(reader failed)'}`).join('\n\n')
const failedReaders = UNDERSTAND.filter((u, i) => !facts[i]).map((u) => u.key)
if (failedReaders.length) log(`readers that failed: ${failedReaders.join(', ')}`)

phase('Design')
const ANGLES = [
  { key: 'display-lut', prompt: 'Angle: DISPLAY-REFERRED LUT AFTER THE EXISTING FILM OUTPUT. Keep tone-mapping.ts as it is; append one 33^3 LUT tap at the very end, in display space, so a .cube made on a screenshot applies 1:1. Every grade control is baked into it; vignette and the before/after split stay analytic. Smallest change to the render path.' },
  { key: 'unified', prompt: 'Angle: ONE GRADE STAGE THAT ABSORBS THE FILM PARTS. The film S-curve, split, lift and saturation become controls of the editor and are baked into the same LUT (with a log shaper so HDR input is covered), so the output pass gets simpler and the film look becomes the editor\'s default preset; the shoulder and exposure may stay analytic. Weigh what is gained (one place for the look, fewer ALU ops) against the risks (banding, HDR range, matching today\'s look exactly).' },
  { key: 'editor-first', prompt: 'Angle: THE EDITOR EXPERIENCE FIRST. A colourist-grade tool inside the Design panel and on phones: curves with draggable points, lift/gamma/gain wheels, hue curves, before/after split with a draggable line, snapshots A/B, .cube import/export round-trip, presets (the film look, a neutral, later Evergreen), undo, Copy values that pastes back, maybe a small luma histogram/RGB parade. Pick whichever pipeline placement serves that best, and say how the editor stays responsive (bake in a worker or on the main thread, throttling while dragging).' },
]
const designs = await parallel(ANGLES.map((a) => () => agent(`${PROBLEM}\n\nFACTS FROM THE READERS:\n${FACTS}\n\nDesign the grade editor. ${a.prompt} Be concrete: modules, functions, data structures, the TSL node code for the LUT tap, the bake loop, the UI widgets, what moves where, config keys, tests. Verify any three or app claim you rely on that the readers did not cover.`, { label: `design:${a.key}`, phase: 'Design', schema: DESIGN_SCHEMA })))
const DESIGNS = designs.map((d, i) => d ? { angle: ANGLES[i].key, ...d } : null).filter(Boolean)
log(`${DESIGNS.length} designs`)

phase('Judge')
const LENSES = [
  'Judge as a colourist and a performance engineer: image quality (banding in dark greens, exact identity, HDR highlights, match to today\'s film look), GPU and main-thread cost, .cube interoperability with Resolve / Photoshop / Lightroom.',
  'Judge as a reviewer hunting bugs and scope creep: correctness of every three r185 claim (check the code yourself), WebGL2 fallback, compile-out when off, phones and touch, testability, and what can be cut from a first version without losing the professional feel.',
]
const judgements = await parallel(LENSES.map((lens, i) => () => agent(`${PROBLEM}\n\nFACTS:\n${FACTS}\n\nDESIGNS:\n${JSON.stringify(DESIGNS, null, 1)}\n\n${lens} Score each design 1-10 on image_quality, performance, editor_usability, interoperability, simplicity; total = sum. Pick a winner, say what to graft from the others, and list blocking issues the winner must fix.`, { label: `judge:${i}`, phase: 'Judge', schema: JUDGE_SCHEMA })))

phase('Synthesize')
const plan = await agent(`${PROBLEM}\n\nFACTS:\n${FACTS}\n\nDESIGNS:\n${JSON.stringify(DESIGNS, null, 1)}\n\nJUDGEMENTS:\n${JSON.stringify(judgements.filter(Boolean), null, 1)}\n\nWrite the final implementation plan: start from the winner, graft the best of the others, fix every blocking issue the judges raised, and split it into a first version (what ships now, still professional) and later steps. Give: the pipeline placement and the exact TSL code for the LUT tap and the split; the grade model with every formula and its parameter ranges and defaults; per file the exact changes (new modules, functions, config keys, panel markup, binders, Copy values); the .cube parser and writer; the UI widgets (curves, wheels, before/after, snapshots, presets) and how they stay responsive; the tests (node --test) and the browser measurements (GPU cost with the method above, identity check, a .cube round-trip); the risks left. Plain text, precise.`, { label: 'synthesize', phase: 'Synthesize' })

return { plan, judgements: judgements.filter(Boolean), designs: DESIGNS.map((d) => ({ angle: d.angle, name: d.name, summary: d.summary })), failedReaders }
