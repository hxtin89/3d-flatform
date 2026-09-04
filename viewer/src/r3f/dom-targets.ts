// DOM elements React renders that the imperative layers (markers, donation
// shape, captions, keyboard guide, audio) need as containers. Filled by ref
// callbacks; the scene mounts later (after the async renderer), so the
// elements exist by the time a layer asks for them.
export const domTargets = {
  vignette: null as HTMLDivElement | null,
  markerOverlay: null as HTMLDivElement | null,
  captions: null as HTMLDivElement | null,
  keyboardGuide: null as HTMLElement | null,
  keyboardGuideToggle: null as HTMLButtonElement | null,
  keyboardGuideClose: null as HTMLButtonElement | null,
  aimModeButton: null as HTMLButtonElement | null,
  soundToggle: null as HTMLButtonElement | null,
  audioStatus: null as HTMLElement | null,
  canvasHost: null as HTMLDivElement | null,
}

export type DomTargetKey = keyof typeof domTargets

export function bindTarget<K extends DomTargetKey>(key: K) {
  return (element: (typeof domTargets)[K]) => { domTargets[key] = element }
}
