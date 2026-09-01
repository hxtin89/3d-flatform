// Each screen as the coordinates Figma actually holds, not as hand-written markup.
//
// Extracted from the "· 19.5:9" frames on the Bento Grid — Recreation page and
// kept in that shape on purpose: a screen is a list of things at authored
// positions, so writing it as data means the renderer is one small component and
// a divergence from Figma is a changed number rather than a changed layout.
//
// Every coordinate is Figma px against the 1080×2340 frame. ScreenFrame's stage
// applies the scale, so nothing here multiplies by a content scale.
import type { Corners, CornerType } from '@wi/ui'

/**
 * Figma carries BOTH a per-corner box radius and a Corner atom overlay; the code
 * side folds those into one corner type plus a single fillet radius. A rounded
 * box corner is a plain convex round whatever atom sits on it, so radius wins;
 * only a square corner defers to its atom.
 */
export function cornerFrom(radius: number, atom: 'none' | 'convex' | 'fill-left' | 'fill-top'): CornerType {
  return radius > 0 ? 'convex' : atom
}

export interface LabelItem {
  kind: 'label'
  x: number
  y: number
  text: string
  size: number
  /** Sora style name, mapped to a numeric weight by the renderer. */
  style: 'Light' | 'Regular' | 'SemiBold' | 'Bold'
  corners: Corners
  radius: number
}

export interface SubtitleItem {
  kind: 'subtitle'
  x: number
  y: number
  text: string
  size: number
  maxWidth: number
}

export interface LoadingItem {
  kind: 'loading'
  x: number
  y: number
  width: number
  text: string
  progress: number
}

export type ScreenItem = LabelItem | SubtitleItem | LoadingItem

const C = cornerFrom

/** Frame 9 — Step 1, "Enter the Wild". */
const ENTER: ScreenItem[] = [
  {
    kind: 'label', x: 523, y: 975, text: 'ENTER', size: 87, style: 'Bold', radius: 43,
    corners: [C(43, 'none'), C(43, 'none'), C(0, 'fill-left'), C(0, 'fill-left')],
  },
  {
    kind: 'label', x: 423, y: 1097, text: 'THE WILD', size: 87, style: 'Bold', radius: 43,
    corners: [C(43, 'none'), C(43, 'none'), C(43, 'none'), C(43, 'none')],
  },
  // Figma has an empty Label Line here carrying the arrow-right icon above it.
  // The pill is real; the icon is not in @wi/ui yet, so it is left out rather
  // than faked with a glyph that would not be the drawn one.
  {
    kind: 'label', x: 619, y: 1219, text: '', size: 87, style: 'Bold', radius: 43,
    corners: [C(0, 'fill-left'), C(0, 'fill-left'), C(43, 'none'), C(43, 'none')],
  },
]

/** Frame 10 — Step 2, loading as drama. */
const LOADING: ScreenItem[] = [
  { kind: 'loading', x: 240, y: 1130, width: 600, text: 'Loading...', progress: 0.35 },
]

/** Frame 7 — Step 9, arrival. Two stacks: the title top-right, nothing below yet. */
const ARRIVAL: ScreenItem[] = [
  {
    kind: 'label', x: 620, y: 115, text: 'Willkommen im', size: 49, style: 'Light', radius: 43,
    corners: [C(43, 'none'), C(0, 'fill-top'), C(0, 'none'), C(0, 'fill-left')],
  },
  {
    kind: 'label', x: 312, y: 192, text: 'SECRET FOREST', size: 87, style: 'Bold', radius: 43,
    corners: [C(43, 'none'), C(0, 'none'), C(0, 'fill-top'), C(43, 'convex')],
  },
]

/** Frame 7 again — Step 13, the same screen once the real-time line is on it. */
const REALTIME: ScreenItem[] = [
  ...ARRIVAL,
  {
    kind: 'label', x: 7, y: 1893, text: 'Im Secret Forest ist es gerade 4:50.', size: 37, style: 'Regular', radius: 33,
    corners: [C(0, 'fill-top'), C(33, 'convex'), C(0, 'fill-left'), C(0, 'convex')],
  },
  {
    kind: 'label', x: 7, y: 1950, text: 'Nur noch eine Stunde, dann beginnt der Dawn Chorus.', size: 37, style: 'Regular', radius: 33,
    corners: [C(0, 'fill-top'), C(33, 'convex'), C(33, 'convex'), C(0, 'fill-top')],
  },
]

/** Frame 11 — Step 11, the parcel confirmed. */
const PARCEL_TEXT: ScreenItem[] = [
  {
    kind: 'subtitle', x: 7, y: 1803, size: 48, maxWidth: 1010,
    text: 'Das sind die 52m², welche mit deiner Spende geschützt wurden.',
  },
]

export const SCREENS: Record<string, ScreenItem[]> = {
  enter: ENTER,
  loading: LOADING,
  arrival: ARRIVAL,
  realtime: REALTIME,
  'parcel-text': PARCEL_TEXT,
}
