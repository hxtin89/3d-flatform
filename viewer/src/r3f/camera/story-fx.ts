// Scalar story effects on sequence.ts tracks: the descent drives the vignette
// blend and cloud reveal (cinematicFlightProgress), the arrival timeline the
// outline draw-on and the captions.
import { EXPERIENCE_CONFIG } from '../../threejs-test/config'
import { createCaptionLayer, fillTemplate, type CaptionContent } from '../../threejs-test/caption-layer'
import { evaluateTrack, trackEnd } from '../../threejs-test/sequence'
import { domTargets } from '../dom-targets'
import { frame } from '../state/frame'
import { useBootStore } from '../state/boot-store'
import { sceneState, useSceneStore } from '../state/scene-store'

let outlineDone = false

function captionLayer() {
  const existing = sceneState().captions
  if (existing) return existing
  if (!domTargets.captions) return null
  const layer = createCaptionLayer(domTargets.captions)
  useSceneStore.setState({ captions: layer })
  return layer
}

function captionContent(id: string): CaptionContent | null {
  const template = (EXPERIENCE_CONFIG.intro.captionText as unknown as Record<string, CaptionContent | undefined>)[id]
  if (!template) return null
  const values = {
    areaM2: Math.round(sceneState().donation?.info().areaM2 ?? 0),
    coordinates: useBootStore.getState().donationCoordinates ?? '—',
  }
  return {
    kicker: template.kicker,
    title: fillTemplate(template.title, values),
    body: template.body ? fillTemplate(template.body, values) : undefined,
    data: template.data?.map((entry) => ({ label: entry.label, value: fillTemplate(entry.value, values) })),
  }
}

/** @param descent 0 at the start pose … 1 when the springs settled.
 *  @param arrivalMs ms since arrival, null before. */
export function updateStoryFx(descent: number, arrivalMs: number | null): void {
  const fx = EXPERIENCE_CONFIG.story.fx
  frame.cinematicFlightProgress = descent
  const scene = sceneState()
  if (fx.descent.cloudOpacity.length) {
    scene.environment?.setCloudOpacity(evaluateTrack(fx.descent.cloudOpacity, (1 - descent) * 1000))
  }
  if (arrivalMs === null) {
    if (scene.donation && !outlineDone) scene.donation.setDrawProgress(0)
    return
  }
  const draw = fx.arrival.outlineDraw
  if (!outlineDone) {
    const value = evaluateTrack(draw, arrivalMs)
    scene.donation?.setDrawProgress(arrivalMs >= trackEnd(draw) ? null : value)
    if (arrivalMs >= trackEnd(draw)) outlineDone = true
  }
  const captions = captionLayer()
  if (!captions) return
  const active = fx.arrival.captions.find((entry) => arrivalMs >= entry.at && arrivalMs < entry.until)
  if (!active) { if (captions.currentId) captions.hide(); return }
  if (captions.currentId !== active.id) {
    const content = captionContent(active.id)
    if (content) captions.show(active.id, content)
  }
}

/** Story restarted: outline draws again, captions hide. */
export function resetStoryFx(): void {
  outlineDone = false
  sceneState().captions?.hide()
  sceneState().donation?.setDrawProgress(0)
}

/** User took over: leave the outline drawn and the captions as they are. */
export function releaseStoryFx(): void {
  frame.cinematicFlightProgress = 1
  if (!outlineDone) {
    sceneState().donation?.setDrawProgress(null)
    outlineDone = true
  }
}
